/**
 * KeyZoneEditor (spec §8.5.5 "keygroup zone editor with keyboard range drag") — the graphical
 * half of keygroup zone editing: a piano keyboard with each zone laid over it as a draggable key
 * range, so a musician can see where a zone sits, which notes two zones fight over and which
 * notes nothing plays. The numeric fields beside it answer "what is `lowNote`?"; only the picture
 * answers "is there a hole at C4?".
 *
 * The canvas is an *addition*, never the only way in (spec §8.2): `KeygroupEditor`'s spinners
 * remain the keyboard-operable form of the same state, and the canvas carries an `aria-label`
 * describing the zones in note names for anyone who cannot see it.
 *
 * A drag writes to refs and repaints from them, committing upward exactly once on release
 * (spec §3.3, §4.5) — one drag has to be one undo entry, not one per frame. The canvas plumbing
 * is `canvasDrag.ts`, shared with the other §8.5.5 graphical editors; the geometry is
 * `keyZoneLayout.ts`, which is where the drag rules (including what happens when a drag would
 * invert a zone) are defined and tested.
 */
import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { NOTE_RANGE, type KeygroupZone } from '@/core/project/schemas';
import { noteName } from '@/features/pad-perform/scales';
import {
  BLACK_KEY_HEIGHT_RATIO,
  coverageByNote,
  describeZones,
  dragZoneEdge,
  editorMetrics,
  keyLayout,
  keyRect,
  laneAtY,
  laneRect,
  moveZoneRange,
  noteAtX,
  noteSpanX,
  type KeyRect,
  type ZoneEditorMetrics,
} from './keyZoneLayout';
import {
  HANDLE_GRAB_PX,
  handleAtX,
  localPoint,
  readToken,
  trackPointer,
  useCanvasPainter,
} from './canvasDrag';

const LOW = NOTE_RANGE[0];
const HIGH = NOTE_RANGE[1];

/** What the current gesture is doing to one zone. `null` between gestures. */
type Gesture = { index: number; edge: 'low' | 'high' } | { index: number; anchorNote: number };

export interface KeyZoneEditorProps {
  readonly zones: readonly KeygroupZone[];
  /** Called once per gesture, on release — the parent commits this as a single undoable edit. */
  readonly onChange: (zones: KeygroupZone[]) => void;
  readonly selectedIndex?: number;
  readonly onSelect?: (index: number) => void;
}

export function KeyZoneEditor({ zones, onChange, selectedIndex = -1, onSelect }: KeyZoneEditorProps) {
  /** Live gesture state the rAF repaint reads — never React state (spec §3.3). */
  const liveZones = useRef<readonly KeygroupZone[]>(zones);
  const gesture = useRef<Gesture | null>(null);
  /** Whether this gesture actually moved a note. A press that only selects must not commit. */
  const moved = useRef(false);
  const selection = useRef(selectedIndex);
  const tokens = useRef<Tokens | null>(null);

  const draw = useCallback(
    (context: CanvasRenderingContext2D, size: { width: number; height: number; dpr: number }) => {
      tokens.current ??= readTokens(context.canvas);
      paintZoneEditor(context, {
        zones: liveZones.current,
        selected: selection.current,
        active: gesture.current?.index ?? -1,
        width: size.width,
        height: size.height,
        dpr: size.dpr,
        tokens: tokens.current,
      });
    },
    [],
  );

  const { canvasRef, scheduleDraw } = useCanvasPainter(draw);

  // Committed props are the source of truth between gestures — undo, or a spinner edit next door.
  useEffect(() => {
    liveZones.current = zones;
    scheduleDraw();
  }, [zones, scheduleDraw]);
  useEffect(() => {
    selection.current = selectedIndex;
    scheduleDraw();
  }, [selectedIndex, scheduleDraw]);

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = event.currentTarget;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0 || liveZones.current.length === 0) return;
    event.preventDefault();

    const point = localPoint(canvas, event.clientX, event.clientY);
    const metrics = editorMetrics(rect.height);
    const count = liveZones.current.length;
    const lane = laneAtY(point.y, count, metrics);
    // Below the lanes the keyboard itself is a picker: tapping a key selects a zone that plays it,
    // which is how you reach a zone hidden under another one's lane.
    const index = lane >= 0 ? lane : zoneAtNote(liveZones.current, noteAtX(point.x, LOW, HIGH, rect.width));
    if (index < 0) return;

    selection.current = index;
    onSelect?.(index);

    const zone = liveZones.current[index]!;
    const span = noteSpanX(zone.lowNote, zone.highNote, LOW, HIGH, rect.width);
    const edgeHit = lane >= 0 ? handleAtX([span.left, span.right], point.x, HANDLE_GRAB_PX) : -1;
    gesture.current =
      edgeHit >= 0
        ? { index, edge: edgeHit === 0 ? 'low' : 'high' }
        : { index, anchorNote: noteAtX(point.x, LOW, HIGH, rect.width) };
    moved.current = false;
    scheduleDraw();

    trackPointer(
      event,
      (movePoint) => {
        const active = gesture.current;
        if (!active) return;
        const width = canvasRef.current?.getBoundingClientRect().width ?? rect.width;
        const note = noteAtX(movePoint.x, LOW, HIGH, width);
        const current = liveZones.current[active.index]!;
        const next =
          'edge' in active
            ? dragZoneEdge(current, active.edge, note, NOTE_RANGE)
            : moveZoneRange(current, note - active.anchorNote, NOTE_RANGE);
        // A body drag re-anchors each frame, so the zone tracks the pointer note-for-note even
        // once it has been clamped against an end of the keyboard.
        if (!('edge' in active)) active.anchorNote = note;
        if (next.lowNote === current.lowNote && next.highNote === current.highNote) return;
        moved.current = true;
        liveZones.current = liveZones.current.map((existing, i) =>
          i === active.index ? { ...existing, ...next } : existing,
        );
        scheduleDraw();
      },
      () => {
        gesture.current = null;
        scheduleDraw();
        // Exactly one commit per gesture (spec §3.3) — and none at all for a press that only
        // selected a zone, which would otherwise put a no-op edit on the undo stack (spec §4.5).
        if (moved.current) onChange([...liveZones.current]);
      },
    );
  };

  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label={describeZones(zones, LOW, HIGH)}
      data-testid="key-zone-editor"
      className="block h-28 w-full touch-none rounded-bb-sm border border-bb-line bg-bb-surface"
      onPointerDown={onPointerDown}
    />
  );
}

/** The topmost zone that plays `note`, or -1. Later zones win, matching the drawing order. */
function zoneAtNote(zones: readonly KeygroupZone[], note: number): number {
  for (let i = zones.length - 1; i >= 0; i--) {
    const zone = zones[i]!;
    if (note >= zone.lowNote && note <= zone.highNote) return i;
  }
  return -1;
}

// --- Painting --------------------------------------------------------------------

interface Tokens {
  readonly surface: string;
  readonly raised: string;
  readonly line: string;
  readonly text: string;
  readonly muted: string;
  readonly accent: string;
  readonly ok: string;
  readonly warn: string;
  readonly focus: string;
}

/** Literals are jsdom fallbacks only; they mirror `src/styles/index.css` (spec §3.6). */
function readTokens(canvas: HTMLCanvasElement): Tokens {
  return {
    surface: readToken(canvas, '--color-bb-surface', '#1c1b21'),
    raised: readToken(canvas, '--color-bb-raised', '#26242c'),
    line: readToken(canvas, '--color-bb-line', '#37343f'),
    text: readToken(canvas, '--color-bb-text', '#ececf1'),
    muted: readToken(canvas, '--color-bb-muted', '#a3a1ad'),
    accent: readToken(canvas, '--color-bb-accent', '#f5a524'),
    ok: readToken(canvas, '--color-bb-ok', '#57d98a'),
    warn: readToken(canvas, '--color-bb-warn', '#e8c249'),
    focus: readToken(canvas, '--color-bb-focus', '#61b8ff'),
  };
}

interface PaintOptions {
  readonly zones: readonly KeygroupZone[];
  readonly selected: number;
  readonly active: number;
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
  readonly tokens: Tokens;
}

function paintZoneEditor(context: CanvasRenderingContext2D, options: PaintOptions): void {
  const { zones, selected, active, width, height, dpr, tokens } = options;
  const metrics = editorMetrics(height);
  const keys = keyLayout(LOW, HIGH, width);
  const coverage = coverageByNote(zones, LOW, HIGH);

  context.fillStyle = tokens.surface;
  context.fillRect(0, 0, width, height);

  // Coverage ribbon: one stripe per note, so a silent stretch and a fought-over one are legible
  // at a glance without having to compare the zone bands above by eye.
  keys.forEach((key) => {
    const count = coverage[key.note - LOW] ?? 0;
    context.fillStyle = count === 0 ? tokens.line : count === 1 ? tokens.ok : tokens.warn;
    context.fillRect(key.x, metrics.ribbonTop, key.width, metrics.ribbonHeight);
  });

  drawKeyboard(context, keys, metrics, coverage, dpr, tokens);

  zones.forEach((zone, index) => {
    const lane = laneRect(index, zones.length, metrics);
    const span = noteSpanX(zone.lowNote, zone.highNote, LOW, HIGH, width);
    const isSelected = index === selected || index === active;

    context.save();
    context.globalAlpha = isSelected ? 0.5 : 0.28;
    context.fillStyle = isSelected ? tokens.focus : tokens.accent;
    context.fillRect(
      span.left,
      lane.top + 1 * dpr,
      span.right - span.left,
      Math.max(1, lane.height - 2 * dpr),
    );
    context.restore();

    context.strokeStyle = isSelected ? tokens.focus : tokens.accent;
    context.lineWidth = (isSelected ? 2 : 1) * dpr;
    context.strokeRect(
      span.left,
      lane.top + 1 * dpr,
      span.right - span.left,
      Math.max(1, lane.height - 2 * dpr),
    );

    // Edge grips, drawn at the touch size the hit test uses so what you can grab is what you see.
    context.fillStyle = isSelected ? tokens.focus : tokens.accent;
    const gripWidth = Math.min(3 * dpr, (span.right - span.left) / 2);
    context.fillRect(span.left, lane.top, gripWidth, lane.height);
    context.fillRect(span.right - gripWidth, lane.top, gripWidth, lane.height);

    // The root note: the one pitch in the zone that plays back untransposed (spec §6).
    const root = keyRect(zone.rootNote, LOW, HIGH, width);
    if (root) {
      context.fillStyle = tokens.text;
      context.fillRect(root.x, lane.top, Math.max(1 * dpr, root.width), lane.height);
    }

    if (isSelected && lane.height > 10 * dpr) {
      context.fillStyle = tokens.text;
      context.font = `${Math.round(9 * dpr)}px sans-serif`;
      context.textBaseline = 'middle';
      context.fillText(
        `${noteName(zone.lowNote)}–${noteName(zone.highNote)} · root ${noteName(zone.rootNote)}`,
        span.left + 5 * dpr,
        lane.top + lane.height / 2,
      );
    }
  });
}

/** Whites first, then blacks over the joins — the order the overlap in {@link keyLayout} implies. */
function drawKeyboard(
  context: CanvasRenderingContext2D,
  keys: readonly KeyRect[],
  metrics: ZoneEditorMetrics,
  coverage: readonly number[],
  dpr: number,
  tokens: Tokens,
): void {
  const top = metrics.keyboardTop;
  const full = metrics.keyboardHeight;

  for (const key of keys) {
    if (key.black) continue;
    context.fillStyle = tokens.text;
    context.fillRect(key.x, top, key.width, full);
    context.strokeStyle = tokens.line;
    context.lineWidth = 1;
    context.strokeRect(key.x, top, key.width, full);
    // An uncovered white key is washed out rather than outlined: silence should read as absence.
    if ((coverage[key.note - LOW] ?? 0) === 0) {
      context.save();
      context.globalAlpha = 0.72;
      context.fillStyle = tokens.raised;
      context.fillRect(key.x, top, key.width, full);
      context.restore();
    }
    // C labels are the landmark the whole keyboard is read from, so they are the only text here.
    if (key.note % 12 === 0 && key.width > 7 * dpr) {
      context.fillStyle = tokens.muted;
      context.font = `${Math.round(8 * dpr)}px sans-serif`;
      context.textBaseline = 'alphabetic';
      context.fillText(noteName(key.note), key.x + 1 * dpr, top + full - 2 * dpr);
    }
  }

  for (const key of keys) {
    if (!key.black) continue;
    const height = full * BLACK_KEY_HEIGHT_RATIO;
    const uncovered = (coverage[key.note - LOW] ?? 0) === 0;
    context.fillStyle = uncovered ? tokens.line : tokens.surface;
    context.fillRect(key.x, top, key.width, height);
    context.strokeStyle = tokens.line;
    context.lineWidth = 1;
    context.strokeRect(key.x, top, key.width, height);
  }
}
