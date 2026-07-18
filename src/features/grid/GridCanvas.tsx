/**
 * GridCanvas — the note editor surface (spec §8.5.2, §8.4). Notes, grid lines, the
 * velocity lane, and the playhead all render on `<canvas>` in a single rAF loop; React
 * never re-renders per frame (spec §3.3), and the loop parks itself when the canvas is
 * off-screen (spec §8.4 offscreen-culled idle state).
 *
 * The playhead reads `currentTick` from the scheduler SAB each frame and subtracts
 * `audioContext.outputLatency` so the drawn position matches what is *audible* rather than
 * what has merely been scheduled (spec §7.1.4).
 *
 * Editing gestures (draw/erase/move/resize) are pointer-driven and commit through the
 * sequence store, so every edit is undoable (spec §4.5) — the canvas holds no note state.
 */
import { useEffect, useLayoutEffect, useRef } from 'react';
import type { MidiEvent } from '@/core/project/schemas';
import { PPQN } from '@/core/constants';
import { getAudioEngine } from '@/core/project/session';
import { secondsToTicks } from '@/core/sequencer/ppqn';
import { useTransportStore } from '@/store';
import {
  cellsAlongSegment,
  eventAtCell,
  eventAtPoint,
  noteToRow,
  resizeHandleAtPoint,
  rowToNote,
  rowToY,
  snapTick,
  tickToX,
  xToTick,
  yToRow,
  type GridViewport,
} from './gridGeometry';

/** Height of the velocity lane strip beneath the note grid (spec §8.5.2 velocity lane). */
export const VELOCITY_LANE_HEIGHT = 64;

export type GridTool = 'draw' | 'erase' | 'select';

export interface GridCanvasProps {
  events: readonly MidiEvent[];
  viewport: Omit<GridViewport, 'width' | 'height'>;
  tool: GridTool;
  /** Snap grid in ticks; 0 = snap off (spec §8.5.2 "grid snap selector incl. off"). */
  snapTicks: number;
  /** Note a drawn event takes when the row is a drum pad rather than a pitch. */
  defaultDurationTicks: number;
  /** Row labels shown at the left — pad names for drums, note names for keygroups. */
  rowLabel: (note: number) => string;
  selectedIds: readonly string[];
  onSelect: (ids: readonly string[]) => void;
  /** `coalesceKey` is set while painting, so the whole stroke is one undo entry. */
  onDraw: (note: number, tickStart: number, durationTicks: number, coalesceKey?: string) => void;
  onErase: (id: string, coalesceKey?: string) => void;
  /** Seals a paint stroke's undo entry on pointer release (spec §3.3 gesture end). */
  onGestureEnd: () => void;
  onMove: (id: string, note: number, tickStart: number) => void;
  onResize: (id: string, durationTicks: number) => void;
  onSetVelocity: (id: string, velocity: number) => void;
  onScroll: (deltaTicks: number, deltaRows: number) => void;
  onZoom: (factor: number) => void;
}

const MAX_VELOCITY = 127;
const LABEL_GUTTER_PX = 56;

/**
 * Undo coalesce keys for the paint gestures (spec §3.3): every note a single drag adds
 * or erases folds into one undo entry, sealed on pointer release.
 */
const DRAW_GESTURE = 'grid-draw';
const ERASE_GESTURE = 'grid-erase';

export function GridCanvas({
  events,
  viewport,
  tool,
  snapTicks,
  defaultDurationTicks,
  rowLabel,
  selectedIds,
  onSelect,
  onDraw,
  onErase,
  onGestureEnd,
  onMove,
  onResize,
  onSetVelocity,
  onScroll,
  onZoom,
}: GridCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  /** Live props for the rAF loop — reading these avoids restarting the loop per render. */
  const latest = useRef({ events, viewport, selectedIds, rowLabel });
  // Synced in a layout effect rather than during render: mutating a ref mid-render is
  // unsafe under concurrent rendering, and the effect still lands before the next frame.
  useLayoutEffect(() => {
    latest.current = { events, viewport, selectedIds, rowLabel };
  });
  const visible = useRef(true);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;

    // Colours come from the design tokens, never literals (spec §3.6).
    const styles = getComputedStyle(canvas);
    const token = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
    const colours = {
      line: token('--color-bb-line', '#37343f'),
      surface: token('--color-bb-surface', '#1c1b21'),
      raised: token('--color-bb-raised', '#26242c'),
      accent: token('--color-bb-accent', '#f5a524'),
      accentStrong: token('--color-bb-accent-strong', '#e08700'),
      text: token('--color-bb-text', '#ececf1'),
      muted: token('--color-bb-muted', '#a3a1ad'),
      focus: token('--color-bb-focus', '#61b8ff'),
    };

    let dpr = window.devicePixelRatio || 1;
    const resize = () => {
      dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
    };
    resize();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);

    const intersectionObserver = new IntersectionObserver(
      (entries) => {
        visible.current = entries.some((entry) => entry.isIntersecting);
      },
      { threshold: 0 },
    );
    intersectionObserver.observe(canvas);

    let frame = 0;
    const draw = () => {
      frame = requestAnimationFrame(draw);
      if (!visible.current) return;

      const { events: liveEvents, viewport: box, selectedIds: selection, rowLabel: label } = latest.current;
      const cssWidth = canvas.width / dpr;
      const cssHeight = canvas.height / dpr;
      const gridHeight = Math.max(0, cssHeight - VELOCITY_LANE_HEIGHT);
      const view: GridViewport = { ...box, width: cssWidth - LABEL_GUTTER_PX, height: gridHeight };

      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, cssWidth, cssHeight);

      // --- Row backgrounds + labels -------------------------------------------------
      const rowCount = Math.ceil(gridHeight / view.rowHeight);
      for (let row = 0; row < rowCount; row += 1) {
        const note = rowToNote(row, view);
        const y = rowToY(row, view);
        // Alternate shading marks the black keys of each octave, aiding orientation.
        const isAccidental = [1, 3, 6, 8, 10].includes(((note % 12) + 12) % 12);
        context.fillStyle = isAccidental ? colours.surface : colours.raised;
        context.fillRect(LABEL_GUTTER_PX, y, view.width, view.rowHeight);

        context.fillStyle = colours.muted;
        context.font = '10px ui-sans-serif, system-ui, sans-serif';
        context.textBaseline = 'middle';
        context.fillText(label(note), 4, y + view.rowHeight / 2, LABEL_GUTTER_PX - 8);

        context.strokeStyle = colours.line;
        context.lineWidth = 0.5;
        context.beginPath();
        context.moveTo(LABEL_GUTTER_PX, y + 0.5);
        context.lineTo(cssWidth, y + 0.5);
        context.stroke();
      }

      // --- Vertical grid lines (beats emphasised over subdivisions) ------------------
      const beatTicks = PPQN;
      const firstBeat = Math.floor(view.scrollTicks / beatTicks) * beatTicks;
      const lastTick = view.scrollTicks + view.width * view.ticksPerPixel;
      for (let tick = firstBeat; tick <= lastTick; tick += beatTicks) {
        const x = LABEL_GUTTER_PX + tickToX(tick, view);
        if (x < LABEL_GUTTER_PX) continue;
        // Bar lines (every 4 beats at 4/4) read stronger than beat lines.
        const isBar = tick % (beatTicks * 4) === 0;
        context.strokeStyle = colours.line;
        context.lineWidth = isBar ? 1.5 : 0.5;
        context.beginPath();
        context.moveTo(x + 0.5, 0);
        context.lineTo(x + 0.5, gridHeight);
        context.stroke();
      }

      // --- Notes --------------------------------------------------------------------
      for (const event of liveEvents) {
        const row = noteToRow(event.note, view);
        if (row < 0 || row >= rowCount) continue;
        const x = LABEL_GUTTER_PX + tickToX(event.tickStart, view);
        const width = event.durationTicks / view.ticksPerPixel;
        if (x + width < LABEL_GUTTER_PX || x > cssWidth) continue;
        const y = rowToY(row, view);
        const selected = selection.includes(event.id);

        // Velocity drives fill intensity, so dynamics are legible at a glance (spec §8.3).
        context.globalAlpha = 0.35 + (event.velocity / MAX_VELOCITY) * 0.65;
        context.fillStyle = selected ? colours.accentStrong : colours.accent;
        context.fillRect(x, y + 1, Math.max(2, width), view.rowHeight - 2);
        context.globalAlpha = 1;

        if (selected) {
          context.strokeStyle = colours.focus;
          context.lineWidth = 1.5;
          context.strokeRect(x, y + 1, Math.max(2, width), view.rowHeight - 2);
        }
      }

      // --- Velocity lane ------------------------------------------------------------
      context.fillStyle = colours.surface;
      context.fillRect(0, gridHeight, cssWidth, VELOCITY_LANE_HEIGHT);
      context.strokeStyle = colours.line;
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(0, gridHeight + 0.5);
      context.lineTo(cssWidth, gridHeight + 0.5);
      context.stroke();

      context.fillStyle = colours.muted;
      context.font = '10px ui-sans-serif, system-ui, sans-serif';
      context.fillText('Velocity', 4, gridHeight + VELOCITY_LANE_HEIGHT / 2);

      for (const event of liveEvents) {
        const x = LABEL_GUTTER_PX + tickToX(event.tickStart, view);
        if (x < LABEL_GUTTER_PX || x > cssWidth) continue;
        const height = (event.velocity / MAX_VELOCITY) * (VELOCITY_LANE_HEIGHT - 8);
        context.fillStyle = selection.includes(event.id) ? colours.accentStrong : colours.accent;
        context.fillRect(x, gridHeight + VELOCITY_LANE_HEIGHT - 4 - height, 3, height);
      }

      // --- Playhead (spec §7.1.4 — SAB tick, latency-compensated) -------------------
      const engine = getAudioEngine();
      if (engine) {
        const bpm = useTransportStore.getState().bpm;
        // Subtract output latency so the line matches what is audible, not merely scheduled.
        const latencySeconds = engine.context.outputLatency || 0;
        const playTick = Math.max(0, engine.playheadTick() - secondsToTicks(latencySeconds, bpm));
        const x = LABEL_GUTTER_PX + tickToX(playTick, view);
        if (x >= LABEL_GUTTER_PX && x <= cssWidth) {
          context.strokeStyle = colours.text;
          context.lineWidth = 1.5;
          context.beginPath();
          context.moveTo(x + 0.5, 0);
          context.lineTo(x + 0.5, cssHeight);
          context.stroke();
        }
      }
    };
    frame = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
    };
  }, []);

  /** Canvas-relative pointer position, with the label gutter removed from x. */
  const pointFrom = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: event.clientX - rect.left - LABEL_GUTTER_PX,
      y: event.clientY - rect.top,
      gridHeight: rect.height - VELOCITY_LANE_HEIGHT,
      width: rect.width - LABEL_GUTTER_PX,
    };
  };

  /**
   * Run a paint stroke: visit the cell under the pointer, then every cell the pointer
   * crosses until release (issue #91 — one tap per cell was the old cost). Cells are
   * visited once per stroke, so re-entering one after wandering off does not double up,
   * and the segment between two pointer samples is walked so a fast swipe skips nothing.
   */
  const paintStroke = (
    pointerEvent: React.PointerEvent<HTMLCanvasElement>,
    view: GridViewport,
    visit: (note: number, tick: number) => void,
  ) => {
    const canvas = pointerEvent.currentTarget;
    const painted = new Set<string>();
    const visitOnce = (note: number, tick: number) => {
      const key = `${note}:${tick}`;
      if (painted.has(key)) return;
      painted.add(key);
      visit(note, tick);
    };

    let previous = pointFrom(pointerEvent);
    visitOnce(rowToNote(yToRow(previous.y, view), view), snapTick(xToTick(previous.x, view), snapTicks));

    canvas.setPointerCapture(pointerEvent.pointerId);
    const move = (moveEvent: globalThis.PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const next = { x: moveEvent.clientX - rect.left - LABEL_GUTTER_PX, y: moveEvent.clientY - rect.top };
      // Painting stays in the note grid; the velocity lane below is a different gesture.
      if (next.y >= rect.height - VELOCITY_LANE_HEIGHT) return;
      for (const cell of cellsAlongSegment(previous, next, view, snapTicks)) {
        visitOnce(cell.note, cell.tick);
      }
      previous = { ...previous, ...next };
    };
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      // Seal the stroke so the next one is a separate undo entry (spec §3.3).
      if (painted.size > 0) onGestureEnd();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };

  const handlePointerDown = (pointerEvent: React.PointerEvent<HTMLCanvasElement>) => {
    const point = pointFrom(pointerEvent);
    const view: GridViewport = { ...viewport, width: point.width, height: point.gridHeight };

    // --- Velocity lane: drag a note's velocity (spec §8.5.2 velocity lane) -----------
    if (point.y >= point.gridHeight) {
      const laneY = point.y - point.gridHeight;
      const velocity = Math.round(
        Math.min(1, Math.max(0, 1 - (laneY - 4) / (VELOCITY_LANE_HEIGHT - 8))) * MAX_VELOCITY,
      );
      const tick = xToTick(point.x, view);
      // Nearest note start within a small tick window owns the velocity bar.
      const tolerance = 8 * viewport.ticksPerPixel;
      const hit = events.find((candidate) => Math.abs(candidate.tickStart - tick) <= tolerance);
      if (hit) onSetVelocity(hit.id, Math.max(1, velocity));
      return;
    }

    const tick = xToTick(point.x, view);

    if (tool === 'erase') {
      // Erase paints too: dragging wipes every note the pointer crosses (issue #91).
      paintStroke(pointerEvent, view, (strokeNote, strokeTick) => {
        const hit = eventAtCell(latest.current.events, strokeNote, strokeTick);
        if (hit) onErase(hit.id, ERASE_GESTURE);
      });
      return;
    }

    // Resize takes precedence over move, so the tail of a note is grabbable (spec §8.5.2).
    const resizeTarget = resizeHandleAtPoint(events, point.x, point.y, view);
    if (resizeTarget) {
      pointerEvent.currentTarget.setPointerCapture(pointerEvent.pointerId);
      const move = (moveEvent: globalThis.PointerEvent) => {
        const rect = pointerEvent.currentTarget.getBoundingClientRect();
        const moveTick = xToTick(moveEvent.clientX - rect.left - LABEL_GUTTER_PX, view);
        // A note is at least one tick long (spec §7.7 min duration 1 tick).
        onResize(resizeTarget.id, Math.max(1, snapTick(moveTick, snapTicks) - resizeTarget.tickStart));
      };
      const end = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', end);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', end);
      return;
    }

    const hit = eventAtPoint(events, point.x, point.y, view);
    if (hit) {
      onSelect([hit.id]);
      // Drag to move: the grab offset keeps the note under the pointer.
      const grabOffsetTicks = tick - hit.tickStart;
      pointerEvent.currentTarget.setPointerCapture(pointerEvent.pointerId);
      const move = (moveEvent: globalThis.PointerEvent) => {
        const rect = pointerEvent.currentTarget.getBoundingClientRect();
        const moveX = moveEvent.clientX - rect.left - LABEL_GUTTER_PX;
        const moveY = moveEvent.clientY - rect.top;
        const nextTick = Math.max(0, snapTick(xToTick(moveX, view) - grabOffsetTicks, snapTicks));
        onMove(hit.id, rowToNote(yToRow(moveY, view), view), nextTick);
      };
      const end = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', end);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', end);
      return;
    }

    if (tool === 'draw') {
      // Drag to paint a run of notes rather than tapping each cell (issue #91).
      paintStroke(pointerEvent, view, (strokeNote, strokeTick) => {
        // Never stack a second note on a cell that already holds one.
        if (eventAtCell(latest.current.events, strokeNote, strokeTick)) return;
        onDraw(strokeNote, strokeTick, defaultDurationTicks, DRAW_GESTURE);
      });
    } else {
      onSelect([]);
    }
  };

  /** Wheel scrolls; Ctrl+wheel zooms — the usual editor convention (spec §8.5.2). */
  const handleWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    if (event.ctrlKey) {
      onZoom(event.deltaY > 0 ? 1.15 : 1 / 1.15);
      return;
    }
    if (event.shiftKey) onScroll(event.deltaY * viewport.ticksPerPixel, 0);
    else onScroll(event.deltaX * viewport.ticksPerPixel, Math.sign(event.deltaY));
  };

  return (
    <div ref={containerRef} className="min-h-0 flex-1">
      <canvas
        ref={canvasRef}
        data-testid="grid-canvas"
        onPointerDown={handlePointerDown}
        onWheel={handleWheel}
        // The canvas is a pointer surface; the accessible editing path is the note list
        // beside it (spec §8.2 — canvases are not keyboard-operable by themselves).
        aria-hidden="true"
        className="block h-full w-full touch-none rounded-bb-sm bg-bb-bg"
      />
    </div>
  );
}
