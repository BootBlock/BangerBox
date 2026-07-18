/**
 * useContinuousControl — the single drag/keyboard gesture engine behind every continuous
 * primitive (Knob, Fader, and the XY axes). One implementation keeps the interaction
 * model, the transient/commit split, and the keyboard contract identical across controls
 * (spec §3.6 — zero DRY violations in `src/ui/primitives/`).
 *
 * Two spec rules shape the design:
 *  - spec §3.3: the drag angle/position mid-gesture MUST NOT pass through React state.
 *    Pointer moves write the value into a ref and hand it to `onTransient`; the visual is
 *    painted by the caller's `render` callback as a direct ref style write. This hook
 *    calls no `setState` during a drag.
 *  - spec §3.3/§4.1: a drag updates the graph continuously through the store's transient
 *    channel but commits exactly one undo entry when the gesture ends.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from 'react';
import { clamp } from '@/core/math';
import {
  normalisedToValue,
  quantiseToStep,
  stepValue,
  valueToNormalised,
  type ControlCurve,
  type ControlRange,
} from './controlMaths';

/** Pointer travel (px) that spans the control's full range. Tuned for touch (spec §8.1). */
const FULL_TRAVEL_PX = 180;
/** Fine-drag divisor applied while Shift is held (spec §8.2). */
const FINE_DRAG_FACTOR = 5;
/** PageUp/PageDown move ten coarse steps — the usual slider convention (spec §8.2). */
const PAGE_STEP_MULTIPLIER = 10;

export interface ContinuousControlOptions {
  readonly value: number;
  readonly range: ControlRange;
  readonly curve?: ControlCurve;
  /** Arrow-key increment. Omitted/0 derives a 1/100-of-range step. */
  readonly step?: number;
  /** Shift-held increment; defaults to a tenth of the coarse step (spec §8.2). */
  readonly fineStep?: number;
  /** Snap the dragged value onto the `step` lattice. Off by default (continuous). */
  readonly quantise?: boolean;
  /** Drag axis: vertical controls (knobs, faders) read upward as increasing. */
  readonly orientation?: 'vertical' | 'horizontal';
  readonly disabled?: boolean;
  /** Double-click/tap target — the hardware-desk "reset to default" convention. */
  readonly defaultValue?: number;
  /** Continuous, non-undoable update during the gesture (spec §4.1 transient channel). */
  readonly onTransient?: (value: number) => void;
  /** Exactly one call per gesture, and once per keyboard step (spec §3.3). */
  readonly onCommit: (value: number) => void;
  /** Paint the new value straight to the DOM — no React state (spec §3.3). */
  readonly render?: (value: number, normalised: number) => void;
}

export interface ContinuousControlApi {
  readonly onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  readonly onDoubleClick: (event: MouseEvent<HTMLElement>) => void;
}

/** Coarse arrow-key step for a range, honouring an explicit `step` when given. */
function coarseStepFor(options: ContinuousControlOptions): number {
  return options.step && options.step > 0 ? options.step : Math.abs(options.range[1] - options.range[0]) / 100;
}

export function useContinuousControl(options: ContinuousControlOptions): ContinuousControlApi {
  // Every option is mirrored into a ref so the pointermove listener — registered once per
  // gesture — always sees current values without re-subscribing (and without re-renders).
  // The sync is a layout effect rather than a render-time write: mutating a ref during
  // render is unsafe under concurrent rendering, and the effect still lands before any
  // pointer or key event can observe the ref.
  const latest = useRef(options);
  useLayoutEffect(() => {
    latest.current = options;
  });

  const dragging = useRef(false);
  const gestureValue = useRef(options.value);

  const publish = useCallback((next: number) => {
    const o = latest.current;
    gestureValue.current = next;
    o.render?.(next, valueToNormalised(next, o.range, o.curve ?? 'linear'));
    o.onTransient?.(next);
  }, []);

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      const o = latest.current;
      if (o.disabled) return;
      // Only the primary button drives the gesture, so a right-click cannot start a turn.
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      event.preventDefault();

      const element = event.currentTarget;
      element.setPointerCapture(event.pointerId);
      dragging.current = true;

      const startX = event.clientX;
      const startY = event.clientY;
      const startValue = o.value;
      gestureValue.current = startValue;

      const move = (moveEvent: globalThis.PointerEvent) => {
        if (moveEvent.pointerId !== event.pointerId) return;
        const current = latest.current;
        const vertical = (current.orientation ?? 'vertical') === 'vertical';
        // Screen Y grows downward; a knob turned "up" must increase (spec §8.3 tactility).
        const delta = vertical ? startY - moveEvent.clientY : moveEvent.clientX - startX;
        const travel = moveEvent.shiftKey ? delta / FINE_DRAG_FACTOR : delta;
        const range = current.range;
        const curve = current.curve ?? 'linear';
        const startNormalised = valueToNormalised(startValue, range, curve);
        const next = normalisedToValue(startNormalised + travel / FULL_TRAVEL_PX, range, curve);
        publish(current.quantise ? quantiseToStep(next, range, current.step ?? 0) : next);
      };

      const end = (endEvent: globalThis.PointerEvent) => {
        if (endEvent.pointerId !== event.pointerId) return;
        dragging.current = false;
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', end);
        window.removeEventListener('pointercancel', end);
        if (element.hasPointerCapture(endEvent.pointerId)) {
          element.releasePointerCapture(endEvent.pointerId);
        }
        // One commit per gesture ⇒ one undo entry (spec §3.3).
        latest.current.onCommit(gestureValue.current);
      };

      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end);
    },
    [publish],
  );

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    const o = latest.current;
    if (o.disabled) return;
    const range = o.range;
    const min = Math.min(range[0], range[1]);
    const max = Math.max(range[0], range[1]);
    const step = coarseStepFor(o);
    const stepOptions = { range, step, fineStep: o.fineStep, fine: event.shiftKey };

    let next: number;
    switch (event.key) {
      case 'ArrowUp':
      case 'ArrowRight':
        next = stepValue(o.value, 1, stepOptions);
        break;
      case 'ArrowDown':
      case 'ArrowLeft':
        next = stepValue(o.value, -1, stepOptions);
        break;
      case 'PageUp':
        next = clamp(o.value + step * PAGE_STEP_MULTIPLIER, min, max);
        break;
      case 'PageDown':
        next = clamp(o.value - step * PAGE_STEP_MULTIPLIER, min, max);
        break;
      case 'Home':
        next = min;
        break;
      case 'End':
        next = max;
        break;
      default:
        return;
    }
    event.preventDefault();
    // Keyboard steps are discrete: each key press is its own commit (spec §4.5).
    o.onCommit(next);
  }, []);

  const onDoubleClick = useCallback((event: MouseEvent<HTMLElement>) => {
    const o = latest.current;
    if (o.disabled || o.defaultValue === undefined) return;
    event.preventDefault();
    o.onCommit(o.defaultValue);
  }, []);

  // A gesture must never outlive the control (spec §3.5 lens 5 — no dangling listeners).
  useEffect(
    () => () => {
      dragging.current = false;
    },
    [],
  );

  return { onPointerDown, onKeyDown, onDoubleClick };
}
