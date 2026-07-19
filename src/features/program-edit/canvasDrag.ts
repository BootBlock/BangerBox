/**
 * Shared canvas + pointer-drag plumbing for the Program Edit graphical editors (spec §8.5.5:
 * "AHDSR envelope graphs (draggable handles on canvas) … per-pad layers (drag ranges) …
 * keygroup zone editor with keyboard range drag"). All three need the same three things, so
 * they share one implementation rather than three near-copies:
 *
 *   1. A DPR-aware canvas that resizes with `ResizeObserver`, parks while off-screen and
 *      coalesces every repaint request in a frame into one `requestAnimationFrame` (spec §8.4).
 *      A standing render loop would burn the §11.5 frame budget redrawing a still picture —
 *      these graphs change only when the user moves.
 *   2. A pointer gesture that writes to refs and repaints from them, committing upward exactly
 *      once on release (spec §3.3) — the same transient/commit split `XYSurface` and
 *      `WaveformEditor` use, so a drag produces one undo entry rather than one per frame.
 *   3. A grab test that treats a handle as a touch-sized target rather than its drawn size.
 *
 * The canvases these helpers drive are never the only way to operate a control (spec §8.2):
 * each editor keeps its numeric fields as the keyboard-operable form of the same state.
 */
import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';

/** Grab radius for a drag handle, in CSS pixels — a touch-sized target regardless of the drawn size. */
export const HANDLE_GRAB_PX = 10;

/** Canvas dimensions in device pixels, with the ratio the caller needs to scale line widths by. */
export interface CanvasSize {
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
}

/**
 * Drive a DPR-aware canvas that repaints on demand. `draw` should be a `useCallback` so the
 * observers are not torn down every render; it is called with a context already sized to the
 * element's device pixels.
 */
export function useCanvasPainter(draw: (context: CanvasRenderingContext2D, size: CanvasSize) => void) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameHandle = useRef(0);
  const visible = useRef(true);

  const paint = useCallback(() => {
    frameHandle.current = 0;
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context || !visible.current) return;

    const dpr = globalThis.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    context.clearRect(0, 0, width, height);
    draw(context, { width, height, dpr });
  }, [draw]);

  /** Coalesce every repaint request in a frame into one paint (spec §8.4). */
  const scheduleDraw = useCallback(() => {
    if (frameHandle.current === 0) frameHandle.current = requestAnimationFrame(paint);
  }, [paint]);

  useEffect(() => {
    scheduleDraw();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resizeObserver = new ResizeObserver(() => scheduleDraw());
    resizeObserver.observe(canvas);
    const intersectionObserver = new IntersectionObserver(
      (entries) => {
        const nowVisible = entries.some((entry) => entry.isIntersecting);
        const becameVisible = nowVisible && !visible.current;
        visible.current = nowVisible;
        if (becameVisible) scheduleDraw();
      },
      { threshold: 0 },
    );
    intersectionObserver.observe(canvas);
    return () => {
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      if (frameHandle.current !== 0) cancelAnimationFrame(frameHandle.current);
      frameHandle.current = 0;
    };
  }, [scheduleDraw]);

  return { canvasRef, scheduleDraw };
}

/** Pointer position in CSS pixels relative to the element's top-left corner. */
export interface LocalPoint {
  readonly x: number;
  readonly y: number;
  /** Fraction across the element, clamped to 0..1 — what most range drags actually want. */
  readonly fx: number;
  /** Fraction down the element, clamped to 0..1. Note 0 is the *top*. */
  readonly fy: number;
}

/** Convert a client-space point into element-local CSS pixels and 0..1 fractions. */
export function localPoint(element: Element, clientX: number, clientY: number): LocalPoint {
  const rect = element.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  return {
    x,
    y,
    fx: rect.width > 0 ? clamp01(x / rect.width) : 0,
    fy: rect.height > 0 ? clamp01(y / rect.height) : 0,
  };
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * Follow one pointer to release. `onMove` runs for every move of that pointer with the point
 * in element-local space; `onEnd` runs exactly once, and is where the caller commits upward.
 * Listeners go on `window` (not the element) so a drag that leaves the canvas keeps tracking,
 * and `pointercancel` ends the gesture the same way `pointerup` does — a cancelled touch must
 * still commit rather than leave the editor mid-drag.
 */
export function trackPointer(
  event: ReactPointerEvent<HTMLElement>,
  onMove: (point: LocalPoint) => void,
  onEnd: () => void,
): void {
  const element = event.currentTarget;
  element.setPointerCapture(event.pointerId);

  const move = (moveEvent: globalThis.PointerEvent) => {
    if (moveEvent.pointerId !== event.pointerId) return;
    onMove(localPoint(element, moveEvent.clientX, moveEvent.clientY));
  };
  const end = (endEvent: globalThis.PointerEvent) => {
    if (endEvent.pointerId !== event.pointerId) return;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
    if (element.hasPointerCapture(endEvent.pointerId)) element.releasePointerCapture(endEvent.pointerId);
    onEnd();
  };

  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
}

/**
 * Index of the handle nearest `x` within the grab radius, or -1. Ties go to the earlier
 * handle, which matters when two range edges sit on top of each other: the drag then grabs
 * the left-hand one and the pair can always be pulled apart again.
 */
export function handleAtX(handleXs: readonly number[], x: number, grabPx = HANDLE_GRAB_PX): number {
  let best = -1;
  let bestDistance = grabPx;
  handleXs.forEach((handleX, index) => {
    const distance = Math.abs(handleX - x);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  });
  return best;
}

/** Read a CSS custom property off an element, with a fallback for jsdom (spec §3.6 tokens). */
export function readToken(element: Element, name: string, fallback: string): string {
  const value = getComputedStyle(element).getPropertyValue(name).trim();
  return value === '' ? fallback : value;
}
