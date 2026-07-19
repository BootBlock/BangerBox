/**
 * Graphical velocity-layer lane for a drum pad (spec §8.5.5: "per-pad layers (drag ranges)").
 *
 * The numeric `velocityStart`/`velocityEnd` spinners in `LayersEditor` can express any set of
 * layers, but they cannot show you the two things that actually go wrong: two layers claiming
 * the same velocity (both fire, so the pad doubles) and a velocity no layer claims (the pad is
 * silent at that strike). Both are properties of the layers *together*, so all of them are drawn
 * against one shared 0..127 axis — one row per layer, plus a coverage strip that colours every
 * velocity by how many layers cover it. Overlap and silence are then visible without reading a
 * single number.
 *
 * The canvas is an addition, not a replacement (spec §8.2): the spinners beside it remain the
 * keyboard-operable form of the same state, exactly as `WaveformEditor` keeps its numeric
 * selection fields. What the canvas adds for a non-visual reader is the diagnosis rather than the
 * picture, so the summary of gaps and overlaps is carried in the `aria-label` and in visible text
 * below the lane.
 *
 * Dragging follows the shared transient/commit split in `./canvasDrag` (spec §3.3, §4.5): the
 * gesture writes to refs and repaints from them, and `onChange` fires exactly once on release, so
 * one drag is one undo entry rather than one per frame.
 */
import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { clampInt } from '@/core/math';
import type { VelocityLayer } from '@/core/project/schemas';
import { handleAtX, localPoint, readToken, trackPointer, useCanvasPainter } from './canvasDrag';

/** MIDI velocity is 0..127 inclusive, so the lane is divided into this many equal cells. */
export const VELOCITY_COUNT = 128;
/** Highest velocity a layer edge may take. */
export const VELOCITY_MAX = VELOCITY_COUNT - 1;

/** Row height per layer in CSS pixels, and the coverage strip below them. */
const ROW_PX = 18;
const STRIP_PX = 10;

// --- Geometry and range maths (pure — testable without a 2D context, spec §2.5) ---------

/** The pair of fields this component moves; widened from {@link VelocityLayer} so the maths is testable alone. */
export interface VelocityRange {
  readonly velocityStart: number;
  readonly velocityEnd: number;
}

/** Which part of a range a gesture grabbed. */
export type RangeDragMode = 'start' | 'end' | 'body';

/**
 * Boundary `velocity` → pixel column. Takes a *boundary* in 0..128, not a velocity: a layer
 * covering only velocity 64 still has to be drawn with some width, so its cell spans
 * `boundaryX(64)` to `boundaryX(65)` and an inclusive range never collapses to nothing.
 */
export function boundaryX(boundary: number, width: number): number {
  return (boundary / VELOCITY_COUNT) * width;
}

/** Pixel column → the velocity whose cell contains it, clamped into 0..127. */
export function xToVelocity(x: number, width: number): number {
  if (width <= 0) return 0;
  return clampInt(Math.floor((x / width) * VELOCITY_COUNT), 0, VELOCITY_MAX);
}

/** Left and right pixel edges of a range's cells. */
export function rangeSpanX(range: VelocityRange, width: number): { x0: number; x1: number } {
  return { x0: boundaryX(range.velocityStart, width), x1: boundaryX(range.velocityEnd + 1, width) };
}

/**
 * Every draggable edge, flattened so `handleAtX` can hit-test them in one pass: index `2i` is
 * layer `i`'s start edge and `2i + 1` its end edge.
 */
export function edgeHandleXs(ranges: readonly VelocityRange[], width: number): number[] {
  return ranges.flatMap((range) => {
    const { x0, x1 } = rangeSpanX(range, width);
    return [x0, x1];
  });
}

/**
 * The layer whose range contains `velocity`, searched from the last drawn backwards so a press
 * inside an overlap grabs the row nearest the pointer's own reading order — the same "topmost
 * wins" rule the rows are painted in. Returns −1 when nothing covers that velocity.
 */
export function rangeAtVelocity(ranges: readonly VelocityRange[], velocity: number): number {
  for (let i = ranges.length - 1; i >= 0; i--) {
    const range = ranges[i]!;
    if (velocity >= range.velocityStart && velocity <= range.velocityEnd) return i;
  }
  return -1;
}

/**
 * The range a drag has moved the grabbed one to.
 *
 * An edge dragged past its partner **clamps against it** rather than inverting or swapping the
 * pair: the range collapses to the single velocity it is being pushed onto and re-opens as the
 * pointer comes back. Swapping would hand the finger a different edge mid-gesture, and inverting
 * would produce a `velocityStart > velocityEnd` layer the §6 schema accepts but the voice
 * allocator can never match — so the invariant holds at every intermediate frame, not just at
 * commit.
 *
 * A body drag translates the range without resizing it, so it stops at the ends of the lane with
 * its width intact; `grabOffset` is how far into the range the press landed, which keeps the
 * grabbed velocity under the pointer.
 */
export function applyRangeDrag(
  origin: VelocityRange,
  mode: RangeDragMode,
  velocity: number,
  grabOffset = 0,
): VelocityRange {
  if (mode === 'start') {
    return { ...origin, velocityStart: clampInt(velocity, 0, origin.velocityEnd) };
  }
  if (mode === 'end') {
    return { ...origin, velocityEnd: clampInt(velocity, origin.velocityStart, VELOCITY_MAX) };
  }
  const span = origin.velocityEnd - origin.velocityStart;
  const velocityStart = clampInt(velocity - grabOffset, 0, VELOCITY_MAX - span);
  return { velocityStart, velocityEnd: velocityStart + span };
}

/** A run of consecutive velocities sharing a coverage count. */
export interface VelocitySpan {
  readonly start: number;
  readonly end: number;
}

/** Where the layers double up and where they leave the pad silent (spec §8.5.5). */
export interface VelocityCoverage {
  /** How many layers cover each velocity, indexed 0..127. */
  readonly counts: readonly number[];
  readonly gaps: readonly VelocitySpan[];
  readonly overlaps: readonly VelocitySpan[];
}

export function velocityCoverage(ranges: readonly VelocityRange[]): VelocityCoverage {
  const counts = new Array<number>(VELOCITY_COUNT).fill(0);
  for (const range of ranges) {
    const lo = clampInt(Math.min(range.velocityStart, range.velocityEnd), 0, VELOCITY_MAX);
    const hi = clampInt(Math.max(range.velocityStart, range.velocityEnd), 0, VELOCITY_MAX);
    for (let v = lo; v <= hi; v++) counts[v]!++;
  }
  return { counts, gaps: runsWhere(counts, (n) => n === 0), overlaps: runsWhere(counts, (n) => n > 1) };
}

function runsWhere(counts: readonly number[], predicate: (count: number) => boolean): VelocitySpan[] {
  const runs: VelocitySpan[] = [];
  let start = -1;
  for (let v = 0; v < VELOCITY_COUNT; v++) {
    const inRun = predicate(counts[v]!);
    if (inRun && start < 0) start = v;
    if (!inRun && start >= 0) {
      runs.push({ start, end: v - 1 });
      start = -1;
    }
  }
  if (start >= 0) runs.push({ start, end: VELOCITY_MAX });
  return runs;
}

/**
 * The sentence a screen reader hears and the caption reads (spec §8.2) — the diagnosis the
 * picture gives sighted users, in words.
 */
export function describeCoverage(ranges: readonly VelocityRange[], coverage: VelocityCoverage): string {
  if (ranges.length === 0) return 'No velocity layers.';
  const parts = ranges.map(
    (range, index) => `layer ${index + 1} covers ${range.velocityStart} to ${range.velocityEnd}`,
  );
  const spans = (runs: readonly VelocitySpan[]) =>
    runs.map((run) => (run.start === run.end ? `${run.start}` : `${run.start} to ${run.end}`)).join(', ');
  if (coverage.overlaps.length > 0) parts.push(`overlap at ${spans(coverage.overlaps)}`);
  if (coverage.gaps.length > 0) parts.push(`no layer at ${spans(coverage.gaps)}`);
  return `${parts.join('; ')}.`;
}

// --- Component -------------------------------------------------------------------------

export interface VelocityRangeBarProps {
  readonly layers: readonly VelocityLayer[];
  /** Committed once per gesture, never per frame (spec §3.3). */
  readonly onChange: (layers: VelocityLayer[]) => void;
  readonly selectedIndex?: number;
  readonly onSelect?: (index: number) => void;
}

export function VelocityRangeBar({ layers, onChange, selectedIndex, onSelect }: VelocityRangeBarProps) {
  /** Live layer ranges the rAF repaint reads — never React state (spec §3.3). */
  const live = useRef<readonly VelocityLayer[]>(layers);
  const activeIndex = useRef(-1);
  const tokens = useRef<Tokens | null>(null);

  const draw = useCallback(
    (context: CanvasRenderingContext2D, size: { width: number; height: number; dpr: number }) => {
      const canvas = context.canvas;
      tokens.current ??= readTokens(canvas);
      drawLane(context, {
        ranges: live.current,
        selectedIndex: selectedIndex ?? -1,
        activeIndex: activeIndex.current,
        tokens: tokens.current,
        ...size,
      });
    },
    [selectedIndex],
  );

  const { canvasRef, scheduleDraw } = useCanvasPainter(draw);

  // Committed props are the source of truth between gestures — undo and the spinners both
  // arrive this way.
  useEffect(() => {
    live.current = layers;
    scheduleDraw();
  }, [layers, scheduleDraw]);

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = event.currentTarget;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || live.current.length === 0) return;
    event.preventDefault();

    const point = localPoint(canvas, event.clientX, event.clientY);
    const velocity = xToVelocity(point.x, rect.width);
    const ranges = live.current;

    const handle = handleAtX(edgeHandleXs(ranges, rect.width), point.x);
    const index = handle >= 0 ? handle >> 1 : rangeAtVelocity(ranges, velocity);
    if (index < 0) return;
    const mode: RangeDragMode = handle >= 0 ? (handle % 2 === 0 ? 'start' : 'end') : 'body';
    const origin = ranges[index]!;
    const grabOffset = velocity - origin.velocityStart;

    onSelect?.(index);
    activeIndex.current = index;
    scheduleDraw();

    trackPointer(
      event,
      (movePoint) => {
        const next = applyRangeDrag(origin, mode, xToVelocity(movePoint.x, rect.width), grabOffset);
        live.current = ranges.map((layer, i) => (i === index ? { ...layer, ...next } : layer));
        scheduleDraw();
      },
      () => {
        activeIndex.current = -1;
        scheduleDraw();
        onChange([...live.current]);
      },
    );
  };

  const coverage = velocityCoverage(layers);
  const description = describeCoverage(layers, coverage);
  const laneHeight = Math.max(ROW_PX, layers.length * ROW_PX) + STRIP_PX;

  return (
    <div className="space-y-1">
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={`Velocity layers, 0 to 127: ${description}`}
        data-testid="velocity-range-bar"
        style={{ height: `${laneHeight}px` }}
        className="block w-full touch-none rounded-bb-sm border border-bb-line"
        onPointerDown={onPointerDown}
      />
      <p
        data-testid="velocity-range-summary"
        className={`text-xs ${coverage.gaps.length > 0 || coverage.overlaps.length > 0 ? 'text-bb-warn' : 'text-bb-muted'}`}
      >
        {description}
      </p>
    </div>
  );
}

// --- Painting --------------------------------------------------------------------------

interface Tokens {
  readonly bg: string;
  readonly line: string;
  readonly layer: string;
  readonly selected: string;
  readonly gap: string;
  readonly overlap: string;
}

/** Literals are jsdom fallbacks only; they mirror `src/styles/index.css` (spec §3.6). */
function readTokens(canvas: HTMLCanvasElement): Tokens {
  return {
    bg: readToken(canvas, '--color-bb-surface', '#1c1b21'),
    line: readToken(canvas, '--color-bb-line', '#37343f'),
    layer: readToken(canvas, '--color-bb-accent', '#f5a524'),
    selected: readToken(canvas, '--color-bb-focus', '#61b8ff'),
    gap: readToken(canvas, '--color-bb-danger', '#f0564a'),
    overlap: readToken(canvas, '--color-bb-warn', '#e8c249'),
  };
}

interface LaneOptions {
  readonly ranges: readonly VelocityRange[];
  readonly selectedIndex: number;
  readonly activeIndex: number;
  readonly tokens: Tokens;
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
}

function drawLane(context: CanvasRenderingContext2D, options: LaneOptions): void {
  const { ranges, selectedIndex, activeIndex, tokens, width, height, dpr } = options;
  context.fillStyle = tokens.bg;
  context.fillRect(0, 0, width, height);

  const stripTop = height - STRIP_PX * dpr;
  const coverage = velocityCoverage(ranges);

  // Gaps and overlaps wash the full height, not just the strip, so the eye finds them without
  // having to compare rows.
  context.save();
  context.globalAlpha = 0.16;
  for (const [runs, colour] of [
    [coverage.gaps, tokens.gap],
    [coverage.overlaps, tokens.overlap],
  ] as const) {
    context.fillStyle = colour;
    for (const run of runs) {
      const x0 = boundaryX(run.start, width);
      context.fillRect(x0, 0, boundaryX(run.end + 1, width) - x0, height);
    }
  }
  context.restore();

  // Velocity gridlines every 32 — enough to read a value off the lane, few enough not to
  // compete with the layer edges.
  context.strokeStyle = tokens.line;
  context.lineWidth = dpr;
  for (let v = 32; v < VELOCITY_COUNT; v += 32) {
    const x = boundaryX(v, width);
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, stripTop);
    context.stroke();
  }

  const rowHeight = ranges.length > 0 ? stripTop / ranges.length : stripTop;
  ranges.forEach((range, index) => {
    const { x0, x1 } = rangeSpanX(range, width);
    const top = index * rowHeight;
    const inset = Math.max(1, dpr);
    const colour = index === selectedIndex || index === activeIndex ? tokens.selected : tokens.layer;

    context.save();
    context.globalAlpha = index === activeIndex ? 0.55 : 0.34;
    context.fillStyle = colour;
    context.fillRect(x0, top + inset, x1 - x0, rowHeight - inset * 2);
    context.restore();

    context.strokeStyle = colour;
    context.lineWidth = dpr;
    context.strokeRect(x0, top + inset, x1 - x0, rowHeight - inset * 2);

    // Solid bars at both edges: the drawn grab targets for the two edge drags.
    context.fillStyle = colour;
    const grip = 2 * dpr;
    context.fillRect(x0, top + inset, grip, rowHeight - inset * 2);
    context.fillRect(x1 - grip, top + inset, grip, rowHeight - inset * 2);
  });

  // Coverage strip: one bar across the whole axis, coloured by how many layers claim each
  // velocity. Reading it left to right is reading the pad's velocity response.
  for (let v = 0; v < VELOCITY_COUNT; v++) {
    const count = coverage.counts[v]!;
    context.fillStyle = count === 0 ? tokens.gap : count === 1 ? tokens.layer : tokens.overlap;
    const x0 = boundaryX(v, width);
    context.fillRect(x0, stripTop, boundaryX(v + 1, width) - x0, height - stripTop);
  }
}
