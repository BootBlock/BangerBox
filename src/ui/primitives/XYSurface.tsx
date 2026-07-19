/**
 * XYSurface — the two-axis touch canvas behind XYFX mode (spec §8.5.10). The crosshair and
 * its motion trail render on `<canvas>` in a rAF loop, and the touch position never passes
 * through React state (spec §3.3/§8.4). The canvas is DPR-aware and resizes via
 * `ResizeObserver`; the loop parks itself when the surface is off-screen so an unfocused
 * XYFX mode costs nothing (spec §8.4 offscreen-culled idle state).
 *
 * Both axes expose ARIA slider semantics through a paired hidden control, so the surface
 * is fully operable and readable without a pointer (spec §8.2).
 */
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { clamp01 } from '@/core/math';
import { formatValueText, normalisedToValue, valueToNormalised, type ControlRange } from './controlMaths';
import { useContinuousControl } from './useContinuousControl';

/** Trail length in points; a short tail reads as momentum without smearing (spec §8.3). */
const TRAIL_LENGTH = 24;

export interface XYAxis {
  readonly label: string;
  readonly value: number;
  readonly range: ControlRange;
  readonly unit?: string;
}

export interface XYSurfaceProps {
  x: XYAxis;
  y: XYAxis;
  /** Continuous movement — transient store updates, recordable as automation (§8.5.10). */
  onTransient: (xValue: number, yValue: number) => void;
  /** Gesture end. With latch off, the caller returns the axes to their resting values. */
  onCommit: (xValue: number, yValue: number) => void;
  /**
   * Gesture start, by *either* modality — pointer press, or the first key that moves an
   * axis. Latch is decided against the values the axes rested at when this fires, so it
   * must not be tied to pointer input alone (spec §8.2 keyboard/pointer equivalence).
   */
  onGestureStart?: () => void;
  disabled?: boolean;
  /**
   * Fill the height available instead of holding a 16:10 box — for the full-screen XYFX
   * surface (spec §8.5.10), which sizes to the mode rather than the other way round.
   */
  fill?: boolean;
  'data-testid'?: string;
}

export function XYSurface({
  x,
  y,
  onTransient,
  onCommit,
  onGestureStart,
  disabled = false,
  fill = false,
  'data-testid': testId,
}: XYSurfaceProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  /** Live normalised position — the rAF loop's only input (no React state, spec §3.3). */
  const position = useRef({ x: 0.5, y: 0.5 });
  const trail = useRef<{ x: number; y: number }[]>([]);
  const visible = useRef(true);

  // Mirror committed values into the ref between gestures so the crosshair reflects the
  // current store value on mount and after undo/automation (spec §3.4).
  const xNorm = valueToNormalised(x.value, x.range, 'linear');
  const yNorm = valueToNormalised(y.value, y.range, 'linear');
  useEffect(() => {
    position.current = { x: xNorm, y: yNorm };
  }, [xNorm, yNorm]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;

    // Colours come from the design tokens, never literals (spec §3.6).
    const styles = getComputedStyle(canvas);
    const token = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
    const accent = token('--color-bb-accent', '#f5a524');
    const line = token('--color-bb-line', '#37343f');

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
    };
    resize();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);

    // Park the loop's drawing work while the surface is scrolled out of view (spec §8.4).
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
      const { width, height } = canvas;
      context.clearRect(0, 0, width, height);

      // Quadrant guides.
      context.strokeStyle = line;
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(width / 2, 0);
      context.lineTo(width / 2, height);
      context.moveTo(0, height / 2);
      context.lineTo(width, height / 2);
      context.stroke();

      // Canvas Y grows downward; the surface's Y axis reads upward (spec §8.5.10).
      const px = position.current.x * width;
      const py = (1 - position.current.y) * height;

      trail.current.push({ x: px, y: py });
      if (trail.current.length > TRAIL_LENGTH) trail.current.shift();

      // Trail: older points fade out (spec §8.5.10 crosshair + trail rendering).
      context.strokeStyle = accent;
      context.lineWidth = 2;
      for (let i = 1; i < trail.current.length; i += 1) {
        const from = trail.current[i - 1]!;
        const to = trail.current[i]!;
        context.globalAlpha = (i / trail.current.length) * 0.6;
        context.beginPath();
        context.moveTo(from.x, from.y);
        context.lineTo(to.x, to.y);
        context.stroke();
      }
      context.globalAlpha = 1;

      // Crosshair.
      context.strokeStyle = accent;
      context.beginPath();
      context.moveTo(px, 0);
      context.lineTo(px, height);
      context.moveTo(0, py);
      context.lineTo(width, py);
      context.globalAlpha = 0.35;
      context.stroke();
      context.globalAlpha = 1;

      context.fillStyle = accent;
      context.beginPath();
      context.arc(px, py, Math.max(4, width * 0.012), 0, Math.PI * 2);
      context.fill();
    };
    frame = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
    };
  }, []);

  /** Map a pointer event to normalised axis values and publish them (spec §3.3). */
  const publishFromPointer = useCallback(
    (clientX: number, clientY: number, commit: boolean) => {
      const rect = surfaceRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0 || rect.height === 0) return;
      const nx = clamp01((clientX - rect.left) / rect.width);
      const ny = clamp01(1 - (clientY - rect.top) / rect.height);
      position.current = { x: nx, y: ny };
      const xValue = normalisedToValue(nx, x.range, 'linear');
      const yValue = normalisedToValue(ny, y.range, 'linear');
      if (commit) onCommit(xValue, yValue);
      else onTransient(xValue, yValue);
    },
    [onCommit, onTransient, x.range, y.range],
  );

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    event.preventDefault();
    // Close any open keyboard gesture first, so the pointer gesture's resting values are
    // captured from the restored position rather than mid-keyboard-move.
    endKeyboardGesture();
    onGestureStart?.();
    const element = event.currentTarget;
    element.setPointerCapture(event.pointerId);
    trail.current = [];
    publishFromPointer(event.clientX, event.clientY, false);

    const move = (moveEvent: globalThis.PointerEvent) => {
      if (moveEvent.pointerId !== event.pointerId) return;
      publishFromPointer(moveEvent.clientX, moveEvent.clientY, false);
    };
    const end = (endEvent: globalThis.PointerEvent) => {
      if (endEvent.pointerId !== event.pointerId) return;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      if (element.hasPointerCapture(endEvent.pointerId)) element.releasePointerCapture(endEvent.pointerId);
      publishFromPointer(endEvent.clientX, endEvent.clientY, true);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };

  // Keyboard operation runs through the shared control engine, one slider per axis, so the
  // surface is usable without a pointer (spec §8.2 full keyboard operation).
  //
  // A pointer gesture has an obvious span — press to release — and latch is resolved at the
  // end of it. Keyboard input has no release, so the axis sliders synthesise one: the first
  // arrow/Home/End press opens the gesture, further presses move the axes *transiently*, and
  // the gesture closes when focus leaves the sliders or Escape is pressed. Without this the
  // per-press commits would resolve latch against a gesture that never began, and every
  // axis would hold its new value — latch permanently on for keyboard users (spec §8.2).
  const keyboardGesture = useRef(false);
  const keyboardValues = useRef({ x: x.value, y: y.value });

  const stepAxis = useCallback(
    (axis: 'x' | 'y', value: number) => {
      if (!keyboardGesture.current) {
        keyboardGesture.current = true;
        // Seed from the resting values so the untouched axis is carried through unchanged.
        keyboardValues.current = { x: x.value, y: y.value };
        onGestureStart?.();
      }
      keyboardValues.current = { ...keyboardValues.current, [axis]: value };
      onTransient(keyboardValues.current.x, keyboardValues.current.y);
    },
    [onGestureStart, onTransient, x.value, y.value],
  );

  const endKeyboardGesture = useCallback(() => {
    if (!keyboardGesture.current) return;
    keyboardGesture.current = false;
    // One commit for the whole keyboard gesture ⇒ one undo entry, as for a drag (§3.3).
    onCommit(keyboardValues.current.x, keyboardValues.current.y);
  }, [onCommit]);

  // A keyboard gesture must not outlive the surface: unmounting mid-gesture would strand a
  // transient value in the graph with no commit behind it (spec §3.5 lens 5).
  const endKeyboardGestureRef = useRef(endKeyboardGesture);
  useLayoutEffect(() => {
    endKeyboardGestureRef.current = endKeyboardGesture;
  });
  useEffect(() => () => endKeyboardGestureRef.current(), []);

  const xControl = useContinuousControl({
    value: x.value,
    range: x.range,
    orientation: 'horizontal',
    disabled,
    onCommit: (value) => stepAxis('x', value),
  });
  const yControl = useContinuousControl({
    value: y.value,
    range: y.range,
    disabled,
    onCommit: (value) => stepAxis('y', value),
  });

  return (
    <div className={`flex flex-col gap-2 ${fill ? 'h-full min-h-0' : ''}`}>
      <div
        ref={surfaceRef}
        data-testid={testId}
        onPointerDown={handlePointerDown}
        className={`relative w-full touch-none overflow-hidden rounded-bb-md border border-bb-line bg-bb-bg ${
          fill ? 'min-h-0 flex-1' : 'aspect-[16/10]'
        } ${disabled ? 'opacity-40' : 'cursor-crosshair'}`}
      >
        <canvas ref={canvasRef} aria-hidden="true" className="block h-full w-full" />
      </div>
      {/* The two axis sliders are the accessible representation of the surface (§8.2). */}
      {/* Focus leaving the pair releases the keyboard gesture — the keyboard's "pointer up".
          Moving between the two sliders stays inside one gesture. */}
      <div
        className="flex gap-2"
        onBlur={(event) => {
          if (event.currentTarget.contains(event.relatedTarget)) return;
          endKeyboardGesture();
        }}
      >
        {(
          [
            { axis: x, control: xControl, orientation: 'horizontal' as const },
            { axis: y, control: yControl, orientation: 'vertical' as const },
          ] satisfies readonly {
            axis: XYAxis;
            control: ReturnType<typeof useContinuousControl>;
            orientation: 'horizontal' | 'vertical';
          }[]
        ).map(({ axis, control, orientation }) => (
          <div
            key={orientation}
            role="slider"
            tabIndex={disabled ? -1 : 0}
            aria-label={axis.label}
            aria-orientation={orientation}
            aria-valuemin={axis.range[0]}
            aria-valuemax={axis.range[1]}
            aria-valuenow={axis.value}
            aria-valuetext={formatValueText(axis.value, axis.unit ?? '')}
            onKeyDown={(event) => {
              // Escape releases without moving focus — the explicit end of a keyboard gesture.
              if (event.key === 'Escape') {
                event.preventDefault();
                endKeyboardGesture();
                return;
              }
              control.onKeyDown(event);
            }}
            className="flex-1 rounded-bb-sm border border-bb-line bg-bb-raised px-2 py-1 text-bb-micro text-bb-muted"
          >
            {axis.label}:{' '}
            <span className="font-mono tabular-nums text-bb-text">
              {formatValueText(axis.value, axis.unit ?? '')}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
