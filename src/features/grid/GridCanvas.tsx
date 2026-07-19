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
import type { AutomationPoint, MidiEvent } from '@/core/project/schemas';
import { PPQN } from '@/core/constants';
import { getAudioEngine } from '@/core/project/session';
import { secondsToTicks } from '@/core/sequencer/ppqn';
import { useTransportStore } from '@/store';
import {
  automationBounds,
  automationPolyline,
  automationValueToY,
  cellsAlongSegment,
  eventAtCell,
  eventAtPoint,
  eventsInTickSpan,
  nearestEventToTick,
  noteToRow,
  resizeHandleAtPoint,
  rowToNote,
  rowToY,
  snapTick,
  tickToX,
  TOUCH_RESIZE_HANDLE_PX,
  velocityAtLaneY,
  xToTick,
  yToRow,
  type GridViewport,
} from './gridGeometry';

/** Height of the velocity lane strip beneath the note grid (spec §8.5.2 velocity lane). */
const VELOCITY_LANE_HEIGHT = 64;

/**
 * Height of the automation lane drawn beneath the velocity lane when one is selected
 * (spec §8.5.2 per-track automation lane selector). Shorter than the velocity lane: it is
 * a read-out of the lane's shape, not a drag target, so it costs the notes less room.
 */
const AUTOMATION_LANE_HEIGHT = 48;

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
  /**
   * The automation lane to draw beneath the velocity lane, or null for none (spec §8.5.2,
   * §7.8). Read-only: the selector picks which lane is visible, and the lane's points are
   * shown against the same timeline as the notes so their shape can be read in context.
   */
  automation: { readonly label: string; readonly points: readonly AutomationPoint[] } | null;
  selectedIds: readonly string[];
  onSelect: (ids: readonly string[]) => void;
  /** `coalesceKey` is set while dragging, so the whole gesture is one undo entry. */
  onDraw: (note: number, tickStart: number, durationTicks: number, coalesceKey?: string) => void;
  onErase: (id: string, coalesceKey?: string) => void;
  /** Seals a drag's undo entry on pointer release (spec §3.3 gesture end). */
  onGestureEnd: () => void;
  /**
   * Rolls back the edit a drag had already written, called when a second finger turns that
   * drag into a two-finger pan/zoom (issue #43). The finger that starts a pan has usually
   * drawn or moved a note first, and leaving that behind would make panning destructive.
   * Only fires for a drag that actually wrote something, so it never eats an earlier edit.
   */
  onGestureCancel: () => void;
  onMove: (id: string, note: number, tickStart: number, coalesceKey?: string) => void;
  onResize: (id: string, durationTicks: number, coalesceKey?: string) => void;
  /**
   * Set one velocity across a batch of notes. A batch rather than a single id because a
   * sideways drag crosses several bars between two pointer samples, and they must land in
   * one write — sequential single-note writes would each read the same pre-drag events and
   * clobber one another.
   */
  onSetVelocity: (ids: readonly string[], velocity: number, coalesceKey?: string) => void;
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
/** Move/resize drags coalesce the same way: one drag is one undo step, not one per frame. */
const MOVE_GESTURE = 'grid-move';
const RESIZE_GESTURE = 'grid-resize';
/** A velocity drag likewise: one gesture is one undo entry, not one per pointer sample. */
const VELOCITY_GESTURE = 'grid-velocity';

/**
 * How far the pointer may wander and still count as a tap rather than a drag. Without
 * it the hand-jitter of a tap on a note reads as a zero-distance move, and the toggle
 * in issue #92 never fires.
 */
const TAP_SLOP_PX = 4;

/**
 * Below this finger separation the pinch ratio is dominated by noise — two touches almost
 * on top of each other can double their spread with a millimetre of tremor, which would
 * read as a violent zoom. Panning still applies; only the zoom half is held back.
 */
const MIN_PINCH_SPREAD_PX = 24;

export function GridCanvas({
  events,
  viewport,
  tool,
  snapTicks,
  defaultDurationTicks,
  rowLabel,
  automation,
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
  onGestureCancel,
}: GridCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  /** Live props for the rAF loop — reading these avoids restarting the loop per render. */
  const latest = useRef({ events, viewport, selectedIds, rowLabel, automation });
  // Synced in a layout effect rather than during render: mutating a ref mid-render is
  // unsafe under concurrent rendering, and the effect still lands before the next frame.
  useLayoutEffect(() => {
    latest.current = { events, viewport, selectedIds, rowLabel, automation };
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

      const {
        events: liveEvents,
        viewport: box,
        selectedIds: selection,
        rowLabel: label,
        automation: lane,
      } = latest.current;
      const cssWidth = canvas.width / dpr;
      const cssHeight = canvas.height / dpr;
      const laneHeight = lane ? AUTOMATION_LANE_HEIGHT : 0;
      const gridHeight = Math.max(0, cssHeight - VELOCITY_LANE_HEIGHT - laneHeight);
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

      // --- Automation lane (spec §7.8, §8.5.2) --------------------------------------
      if (lane) {
        const laneTop = gridHeight + VELOCITY_LANE_HEIGHT;
        context.fillStyle = colours.surface;
        context.fillRect(0, laneTop, cssWidth, laneHeight);
        context.strokeStyle = colours.line;
        context.lineWidth = 1;
        context.beginPath();
        context.moveTo(0, laneTop + 0.5);
        context.lineTo(cssWidth, laneTop + 0.5);
        context.stroke();

        const bounds = automationBounds(lane.points);
        context.fillStyle = colours.muted;
        context.font = '10px ui-sans-serif, system-ui, sans-serif';
        context.fillText(lane.label, 4, laneTop + laneHeight / 2, LABEL_GUTTER_PX - 8);

        // Clip to the lane so the line cannot bleed into the velocity lane above, and to
        // the gutter so it never runs under the lane's own label.
        context.save();
        context.beginPath();
        context.rect(LABEL_GUTTER_PX, laneTop, cssWidth - LABEL_GUTTER_PX, laneHeight);
        context.clip();

        const line = automationPolyline(lane.points, view, bounds, laneHeight);
        if (line.length > 0) {
          context.strokeStyle = colours.focus;
          context.lineWidth = 1.5;
          context.beginPath();
          line.forEach((sample, index) => {
            const x = LABEL_GUTTER_PX + sample.x;
            const y = laneTop + sample.y;
            if (index === 0) context.moveTo(x, y);
            else context.lineTo(x, y);
          });
          context.stroke();

          // Breakpoints are marked so a lane of two points is not mistaken for a ramp
          // drawn between somewhere and somewhere else.
          context.fillStyle = colours.focus;
          for (const point of lane.points) {
            const x = LABEL_GUTTER_PX + tickToX(point.tick, view);
            const y = laneTop + automationValueToY(point.value, bounds, laneHeight);
            context.beginPath();
            context.arc(x, y, 2.5, 0, Math.PI * 2);
            context.fill();
          }
        }
        context.restore();
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

  /**
   * Touch pointers currently down, in client coordinates. Two of them are a pan/zoom
   * gesture rather than an edit (spec §8.5.2 "zoom/scroll (pinch + drag)", issue #43).
   */
  const touchPoints = useRef(new Map<number, { x: number; y: number }>());
  /** The in-flight edit drag, if any, so a second finger can take the gesture over. */
  const activeDrag = useRef<{ cancel: () => void } | null>(null);
  const pinching = useRef(false);

  // Forget lifted touches even when no gesture is listening — a finger that goes down and
  // up without dragging would otherwise stay in the map and make the *next* single tap
  // look like the second half of a pinch.
  useEffect(() => {
    const forget = (event: globalThis.PointerEvent) => {
      touchPoints.current.delete(event.pointerId);
    };
    window.addEventListener('pointerup', forget);
    window.addEventListener('pointercancel', forget);
    return () => {
      window.removeEventListener('pointerup', forget);
      window.removeEventListener('pointercancel', forget);
    };
  }, []);

  /**
   * Attach a drag's window listeners and register it as the in-flight gesture. Window
   * rather than element listeners so a drag survives the pointer leaving the canvas; the
   * element is captured so it also survives the pointer leaving the window.
   *
   * `cancel` runs instead of `end` when a second finger takes the gesture over; it
   * defaults to `end` for a drag with nothing to roll back.
   */
  const beginDrag = (
    canvas: HTMLCanvasElement,
    pointerId: number,
    handlers: {
      move: (event: globalThis.PointerEvent) => void;
      end: () => void;
      cancel?: () => void;
    },
  ) => {
    canvas.setPointerCapture(pointerId);
    const detach = () => {
      window.removeEventListener('pointermove', handlers.move);
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
      if (activeDrag.current === entry) activeDrag.current = null;
    };
    const release = () => {
      detach();
      handlers.end();
    };
    const entry = {
      cancel: () => {
        detach();
        (handlers.cancel ?? handlers.end)();
      },
    };
    window.addEventListener('pointermove', handlers.move);
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    activeDrag.current = entry;
  };

  /** Centre and separation of the two live touches, or null while there are not two. */
  const pinchMetrics = () => {
    const [first, second] = [...touchPoints.current.values()];
    if (!first || !second) return null;
    return {
      centreX: (first.x + second.x) / 2,
      centreY: (first.y + second.y) / 2,
      spread: Math.hypot(first.x - second.x, first.y - second.y),
    };
  };

  /**
   * Two-finger pan and pinch-zoom (spec §8.5.2). The centre of the two touches drives the
   * scroll and their separation drives the zoom, both as deltas against the previous
   * sample, so the two run together the way they do on a map.
   */
  const beginPinch = (canvas: HTMLCanvasElement, pointerId: number) => {
    if (pinching.current) return;
    pinching.current = true;
    canvas.setPointerCapture(pointerId);
    let previous = pinchMetrics();
    // Vertical scroll is quantised to whole rows, so sub-row travel is banked rather than
    // discarded — otherwise a slow drag would never accumulate enough to move a row.
    let rowRemainder = 0;

    const move = (moveEvent: globalThis.PointerEvent) => {
      if (!touchPoints.current.has(moveEvent.pointerId)) return;
      touchPoints.current.set(moveEvent.pointerId, { x: moveEvent.clientX, y: moveEvent.clientY });
      const next = pinchMetrics();
      if (!previous || !next) return;

      const { ticksPerPixel, rowHeight } = latest.current.viewport;
      rowRemainder += previous.centreY - next.centreY;
      const rows = Math.trunc(rowRemainder / rowHeight);
      rowRemainder -= rows * rowHeight;
      // Fingers moving left drag the content left, which advances the viewport right.
      onScroll((previous.centreX - next.centreX) * ticksPerPixel, rows);

      if (previous.spread >= MIN_PINCH_SPREAD_PX && next.spread >= MIN_PINCH_SPREAD_PX) {
        // Spreading the fingers zooms in, i.e. fewer ticks per pixel.
        onZoom(previous.spread / next.spread);
      }
      previous = next;
    };

    const end = (endEvent: globalThis.PointerEvent) => {
      touchPoints.current.delete(endEvent.pointerId);
      // A third finger lifting leaves two behind: re-baseline and carry on rather than
      // ending, so the gesture does not jump when the remaining pair takes over.
      if (touchPoints.current.size >= 2) {
        previous = pinchMetrics();
        return;
      }
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      pinching.current = false;
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };

  /**
   * How much of the canvas the lanes below the note grid take. The automation lane only
   * exists while one is selected, so the note grid reclaims its height when it is not.
   */
  const lanesHeight = () => VELOCITY_LANE_HEIGHT + (automation ? AUTOMATION_LANE_HEIGHT : 0);

  /** Canvas-relative pointer position, with the label gutter removed from x. */
  const pointFrom = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: event.clientX - rect.left - LABEL_GUTTER_PX,
      y: event.clientY - rect.top,
      gridHeight: rect.height - lanesHeight(),
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

    const move = (moveEvent: globalThis.PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const next = { x: moveEvent.clientX - rect.left - LABEL_GUTTER_PX, y: moveEvent.clientY - rect.top };
      // Painting stays in the note grid; the lanes below are a different gesture.
      if (next.y >= rect.height - lanesHeight()) return;
      for (const cell of cellsAlongSegment(previous, next, view, snapTicks)) {
        visitOnce(cell.note, cell.tick);
      }
      previous = { ...previous, ...next };
    };
    beginDrag(canvas, pointerEvent.pointerId, {
      move,
      // Seal the stroke so the next one is a separate undo entry (spec §3.3).
      end: () => {
        if (painted.size > 0) onGestureEnd();
      },
      cancel: () => {
        if (painted.size === 0) return;
        onGestureEnd();
        onGestureCancel();
      },
    });
  };

  const handlePointerDown = (pointerEvent: React.PointerEvent<HTMLCanvasElement>) => {
    const touch = pointerEvent.pointerType === 'touch';
    if (touch) {
      touchPoints.current.set(pointerEvent.pointerId, {
        x: pointerEvent.clientX,
        y: pointerEvent.clientY,
      });
      // A second finger reclassifies the gesture: whatever the first one had started
      // editing is rolled back and the pair pans and zooms instead (issue #43).
      if (touchPoints.current.size >= 2) {
        activeDrag.current?.cancel();
        beginPinch(pointerEvent.currentTarget, pointerEvent.pointerId);
        return;
      }
    }

    const point = pointFrom(pointerEvent);
    const view: GridViewport = { ...viewport, width: point.width, height: point.gridHeight };

    // --- Automation lane: a read-out, not a drag target — a press on it does nothing
    // rather than falling through to the velocity lane above it and pinning a note to
    // velocity 1 (spec §8.5.2).
    if (automation && point.y >= point.gridHeight + VELOCITY_LANE_HEIGHT) return;

    // --- Velocity lane: drag a note's velocity (spec §8.5.2 velocity lane) -----------
    if (point.y >= point.gridHeight) {
      // Bars are 3 px wide, so the press grabs the nearest bar within a small window.
      const tolerance = 8 * viewport.ticksPerPixel;
      const pressTick = xToTick(point.x, view);
      const anchor = nearestEventToTick(events, pressTick, tolerance);
      if (!anchor) return;

      const apply = (ids: readonly string[], laneY: number) => {
        if (ids.length > 0) {
          onSetVelocity(ids, velocityAtLaneY(laneY, VELOCITY_LANE_HEIGHT), VELOCITY_GESTURE);
        }
      };
      apply([anchor.id], point.y - point.gridHeight);

      // Hold the element, not the React event: React nulls `currentTarget` once the
      // handler returns, so reading it from a later listener throws — and from a window
      // listener the throw never reaches the console, it just looks inert.
      const canvas = pointerEvent.currentTarget;
      let previousTick = pressTick;
      const move = (moveEvent: globalThis.PointerEvent) => {
        const rect = canvas.getBoundingClientRect();
        const moveTick = xToTick(moveEvent.clientX - rect.left - LABEL_GUTTER_PX, view);
        const laneY = moveEvent.clientY - rect.top - (rect.height - lanesHeight());
        // Every bar the segment swept takes the pointer's current height, so dragging
        // sideways shapes a run of notes in one gesture. Reading live events keeps notes
        // drawn mid-gesture visible; the anchor covers a purely vertical drag, where the
        // swept span is a point and catches nothing.
        const swept = eventsInTickSpan(latest.current.events, previousTick, moveTick);
        const ids = new Set(swept.map((event) => event.id));
        ids.add(anchor.id);
        apply([...ids], laneY);
        previousTick = moveTick;
      };
      beginDrag(canvas, pointerEvent.pointerId, {
        move,
        // One drag is one undo step, however many frames it spanned (spec §3.3).
        end: onGestureEnd,
        // The press itself already set a velocity, so an aborted drag has one to undo.
        cancel: () => {
          onGestureEnd();
          onGestureCancel();
        },
      });
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
    // A finger gets a much wider handle than a mouse pointer (issue #43): at 6 px it is
    // neither deliberately hittable nor reliably avoidable by touch.
    const resizeTarget = resizeHandleAtPoint(
      events,
      point.x,
      point.y,
      view,
      touch ? TOUCH_RESIZE_HANDLE_PX : undefined,
    );
    if (resizeTarget) {
      // Hold the element, not the React event: React nulls `currentTarget` once the
      // handler returns, so reading it from a later listener throws.
      const canvas = pointerEvent.currentTarget;
      let resized = false;
      const move = (moveEvent: globalThis.PointerEvent) => {
        const rect = canvas.getBoundingClientRect();
        const moveTick = xToTick(moveEvent.clientX - rect.left - LABEL_GUTTER_PX, view);
        resized = true;
        // A note is at least one tick long (spec §7.7 min duration 1 tick).
        onResize(
          resizeTarget.id,
          Math.max(1, snapTick(moveTick, snapTicks) - resizeTarget.tickStart),
          RESIZE_GESTURE,
        );
      };
      beginDrag(canvas, pointerEvent.pointerId, {
        move,
        // One drag is one undo step, however many frames it spanned (spec §3.3).
        end: onGestureEnd,
        cancel: () => {
          if (!resized) return;
          onGestureEnd();
          onGestureCancel();
        },
      });
      return;
    }

    // The rect test is pixel-exact, but snapping can start a note just right of where it
    // was tapped, leaving the pointer outside its own note. Fall back to the snapped cell
    // so the same tap that drew a note also grabs it — the test the paint stroke uses.
    const hit =
      eventAtPoint(events, point.x, point.y, view) ??
      eventAtCell(events, rowToNote(yToRow(point.y, view), view), snapTick(tick, snapTicks));
    if (hit) {
      onSelect([hit.id]);
      // Drag to move: the grab offset keeps the note under the pointer.
      const grabOffsetTicks = tick - hit.tickStart;
      // As above: capture the element before the synthetic event is recycled.
      const canvas = pointerEvent.currentTarget;
      const originX = pointerEvent.clientX;
      const originY = pointerEvent.clientY;
      let dragged = false;
      const move = (moveEvent: globalThis.PointerEvent) => {
        // Inside the slop radius the gesture is still a tap, so no move is committed.
        if (
          !dragged &&
          Math.abs(moveEvent.clientX - originX) <= TAP_SLOP_PX &&
          Math.abs(moveEvent.clientY - originY) <= TAP_SLOP_PX
        ) {
          return;
        }
        dragged = true;
        const rect = canvas.getBoundingClientRect();
        const moveX = moveEvent.clientX - rect.left - LABEL_GUTTER_PX;
        const moveY = moveEvent.clientY - rect.top;
        const nextTick = Math.max(0, snapTick(xToTick(moveX, view) - grabOffsetTicks, snapTicks));
        onMove(hit.id, rowToNote(yToRow(moveY, view), view), nextTick, MOVE_GESTURE);
      };
      beginDrag(canvas, pointerEvent.pointerId, {
        move,
        end: () => {
          // Tapping a note with the draw tool toggles it off (issue #92); the select tool
          // keeps the tap as a plain selection, and a drag is a move either way.
          if (!dragged && tool === 'draw') onErase(hit.id);
          // A move drag is one undo step, however many frames it spanned (spec §3.3).
          onGestureEnd();
        },
        // A first finger that never left the slop radius wrote nothing, and must not be
        // treated as the tap-to-delete either — panning is not a way to erase a note.
        cancel: () => {
          if (!dragged) return;
          onGestureEnd();
          onGestureCancel();
        },
      });
      return;
    }

    if (tool === 'draw') {
      // Drag to paint a run of notes rather than tapping each cell (issue #91).
      paintStroke(pointerEvent, view, (strokeNote, strokeTick) => {
        // Drawing toggles: a cell that already holds a note is cleared rather than
        // stacked on (issue #92). Both halves share DRAW_GESTURE, so a stroke that
        // mixes adds and erases still undoes as a single entry (spec §3.3).
        const occupant = eventAtCell(latest.current.events, strokeNote, strokeTick);
        if (occupant) onErase(occupant.id, DRAW_GESTURE);
        else onDraw(strokeNote, strokeTick, defaultDurationTicks, DRAW_GESTURE);
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
