/**
 * WaveformEditor (spec §8.5.4) — the interactive waveform behind Sample Edit: zoom and scroll
 * down to sample level, drag a selection for the region tools, and place/drag/remove the manual
 * chop markers.
 *
 * Interaction never routes through React state (spec §3.3/§8.4). A gesture writes to refs and
 * schedules a canvas repaint; only when the gesture ends is the result committed upward, the
 * same transient/commit split `XYSurface` uses. The repaint is a one-shot `requestAnimationFrame`
 * rather than a standing loop — unlike a meter or a playhead this picture changes only when the
 * user moves, so a permanent loop would burn the §11.5 frame budget redrawing a still image. The
 * canvas is DPR-aware, resizes via `ResizeObserver` and parks while off-screen (spec §8.4).
 *
 * The canvas is not the only way to operate this (spec §8.2): the zoom buttons, the numeric
 * selection fields and the marker list below it are the accessible representation of the same
 * state, and are the reason the component is fully usable with no pointer at all.
 */
import { useCallback, useEffect, useRef } from 'react';
import { enforceMinSpacing, type SliceRegion } from '@/core/audio/chop';
import type { PeakPyramid } from '@/core/audio/peakPyramid';
import {
  clampView,
  fullView,
  markerAtX,
  scrollView,
  selectionFromDrag,
  xToFrame,
  zoomView,
  type WaveformView,
} from '@/core/audio/waveformView';
import { Button } from './Button';
import { drawMarkers, drawSelection, drawWaveform, readWaveformTokens } from './waveformDraw';

/** Grab radius for a marker flag, in CSS pixels — a touch-sized target at every zoom level. */
const MARKER_GRAB_PX = 8;
/** Wheel-notch zoom step; a shallow ratio so trackpad momentum does not overshoot. */
const ZOOM_STEP = 1.2;
/** Zoom factor for one press of the zoom buttons — coarser, since a press is deliberate. */
const ZOOM_BUTTON_STEP = 2;

export interface WaveformEditorProps {
  readonly pyramid: PeakPyramid | null;
  readonly totalFrames: number;
  readonly sampleRate: number;
  /** What a drag on the canvas does: sweep a selection, or place and move chop markers. */
  readonly interaction: 'select' | 'markers';
  readonly selection: SliceRegion | null;
  readonly onSelectionChange: (selection: SliceRegion | null) => void;
  readonly markers: readonly number[];
  readonly onMarkersChange: (markers: number[]) => void;
  /** Closest two markers may sit, so a chop can never produce a zero-length slice (§8.5.4). */
  readonly minSpacingFrames: number;
  readonly ariaLabel?: string;
}

export function WaveformEditor({
  pyramid,
  totalFrames,
  sampleRate,
  interaction,
  selection,
  onSelectionChange,
  markers,
  onMarkersChange,
  minSpacingFrames,
  ariaLabel = 'Sample waveform',
}: WaveformEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const view = useRef<WaveformView>(fullView(totalFrames));
  /** Live gesture values the rAF repaint reads — never React state (spec §3.3). */
  const liveSelection = useRef<SliceRegion | null>(selection);
  const liveMarkers = useRef<readonly number[]>(markers);
  const activeMarker = useRef(-1);
  const frameHandle = useRef(0);
  const visible = useRef(true);
  const tokens = useRef<ReturnType<typeof readWaveformTokens> | null>(null);

  const draw = useCallback(() => {
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
    tokens.current ??= readWaveformTokens(canvas);
    const shared = { view: view.current, width, height, tokens: tokens.current };
    drawWaveform(context, { ...shared, pyramid });
    drawSelection(context, liveSelection.current, shared);
    drawMarkers(context, liveMarkers.current, activeMarker.current, shared);
  }, [pyramid]);

  /** Coalesce every repaint request in a frame into one paint (spec §8.4). */
  const scheduleDraw = useCallback(() => {
    if (frameHandle.current === 0) frameHandle.current = requestAnimationFrame(draw);
  }, [draw]);

  // A new sample resets the viewport; keeping the old window would open a short sample zoomed
  // into a region it does not have.
  useEffect(() => {
    view.current = fullView(totalFrames);
    activeMarker.current = -1;
    scheduleDraw();
  }, [totalFrames, pyramid, scheduleDraw]);

  // Committed props are the source of truth between gestures (undo, or the panel clearing
  // the selection after a destructive edit).
  useEffect(() => {
    liveSelection.current = selection;
    scheduleDraw();
  }, [selection, scheduleDraw]);
  useEffect(() => {
    liveMarkers.current = markers;
    scheduleDraw();
  }, [markers, scheduleDraw]);

  useEffect(() => {
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

  /** CSS-pixel offset within the canvas → frame, at the current zoom. */
  const frameAt = (clientX: number): number => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return xToFrame(clientX - rect.left, view.current, rect.width);
  };

  const applyZoom = (factor: number, anchorFrame: number) => {
    view.current = zoomView(view.current, totalFrames, factor, anchorFrame);
    scheduleDraw();
  };

  const onWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    if (totalFrames <= 0) return;
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      applyZoom(event.deltaY > 0 ? ZOOM_STEP : 1 / ZOOM_STEP, frameAt(event.clientX));
      return;
    }
    // Plain wheel scrolls by a fraction of the window, so the pan speed follows the zoom.
    const delta = Math.sign(event.deltaY || event.deltaX) * view.current.visibleFrames * 0.15;
    view.current = scrollView(view.current, totalFrames, delta);
    scheduleDraw();
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (totalFrames <= 0) return;
    event.preventDefault();
    const canvas = event.currentTarget;
    canvas.setPointerCapture(event.pointerId);
    const rect = canvas.getBoundingClientRect();
    const startFrame = frameAt(event.clientX);

    if (interaction === 'markers') {
      const hit = markerAtX(
        liveMarkers.current,
        event.clientX - rect.left,
        view.current,
        rect.width,
        MARKER_GRAB_PX,
      );
      // Alt-click removes; otherwise a hit grabs that marker and a miss places a new one.
      if (hit >= 0 && (event.altKey || event.button === 2)) {
        commitMarkers(liveMarkers.current.filter((_, i) => i !== hit));
        return;
      }
      const next = hit >= 0 ? [...liveMarkers.current] : [...liveMarkers.current, Math.round(startFrame)];
      const index = hit >= 0 ? hit : next.length - 1;
      liveMarkers.current = next;
      activeMarker.current = index;
      dragMarker(event, index);
      return;
    }
    dragSelection(event, startFrame);
  };

  /** Follow the pointer, redrawing from refs; commit once on release (spec §3.3). */
  const trackPointer = (
    event: React.PointerEvent<HTMLCanvasElement>,
    onMove: (frame: number) => void,
    onEnd: () => void,
  ) => {
    const canvas = event.currentTarget;
    const move = (moveEvent: globalThis.PointerEvent) => {
      if (moveEvent.pointerId !== event.pointerId) return;
      onMove(frameAt(moveEvent.clientX));
      scheduleDraw();
    };
    const end = (endEvent: globalThis.PointerEvent) => {
      if (endEvent.pointerId !== event.pointerId) return;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      if (canvas.hasPointerCapture(endEvent.pointerId)) canvas.releasePointerCapture(endEvent.pointerId);
      onEnd();
      scheduleDraw();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };

  const dragSelection = (event: React.PointerEvent<HTMLCanvasElement>, anchorFrame: number) => {
    liveSelection.current = null;
    scheduleDraw();
    trackPointer(
      event,
      (frame) => {
        liveSelection.current = selectionFromDrag(anchorFrame, frame, totalFrames);
      },
      () => onSelectionChange(liveSelection.current),
    );
  };

  const dragMarker = (event: React.PointerEvent<HTMLCanvasElement>, index: number) => {
    scheduleDraw();
    trackPointer(
      event,
      (frame) => {
        const next = [...liveMarkers.current];
        next[index] = Math.max(0, Math.min(Math.round(frame), totalFrames));
        liveMarkers.current = next;
      },
      () => {
        activeMarker.current = -1;
        commitMarkers([...liveMarkers.current]);
      },
    );
  };

  /**
   * Sort and thin the markers before committing, so no two sit closer than a slice's minimum
   * length — dropping one marker onto another would otherwise chop out an empty sample.
   */
  const commitMarkers = (next: readonly number[]) => {
    const cleaned = enforceMinSpacing(
      next.filter((marker) => marker > 0 && marker < totalFrames),
      Math.max(1, minSpacingFrames),
    );
    liveMarkers.current = cleaned;
    activeMarker.current = -1;
    onMarkersChange(cleaned);
  };

  const secondsOf = (frames: number) => (sampleRate > 0 ? frames / sampleRate : 0);
  /**
   * Anchor for the button zooms — read at click time, never during render. The viewport lives
   * in a ref rather than state (spec §3.3), which is also why "Zoom out" and "Fit" stay enabled
   * at full zoom rather than mirroring the window into React just to grey themselves out: both
   * clamp to the whole sample, so pressing them there is a no-op.
   */
  const centreFrame = () => view.current.startFrame + view.current.visibleFrames / 2;

  return (
    <div className="space-y-1.5">
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={ariaLabel}
        data-testid="waveform-editor"
        className={`block h-32 w-full touch-none rounded-bb-sm border border-bb-line ${
          interaction === 'markers' ? 'cursor-crosshair' : 'cursor-text'
        }`}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onContextMenu={(event) => event.preventDefault()}
      />

      <div className="flex flex-wrap items-center gap-1.5 text-xs text-bb-muted">
        <Button
          size="sm"
          label="Zoom in"
          onClick={() => applyZoom(1 / ZOOM_BUTTON_STEP, centreFrame())}
          disabled={totalFrames <= 0}
        />
        <Button
          size="sm"
          label="Zoom out"
          onClick={() => applyZoom(ZOOM_BUTTON_STEP, centreFrame())}
          disabled={totalFrames <= 0}
        />
        <Button
          size="sm"
          label="Fit"
          onClick={() => {
            view.current = clampView(fullView(totalFrames), totalFrames);
            scheduleDraw();
          }}
          disabled={totalFrames <= 0}
        />
        {interaction === 'markers' && (
          <Button
            size="sm"
            label="Add marker"
            onClick={() => commitMarkers([...liveMarkers.current, Math.round(centreFrame())])}
            disabled={totalFrames <= 0}
          />
        )}
      </div>

      {/* The keyboard-operable form of the selection the canvas drag produces (spec §8.2). */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <SelectionField
          label="Sel start"
          value={selection?.startFrame ?? 0}
          max={totalFrames}
          onChange={(startFrame) =>
            onSelectionChange(selectionFromDrag(startFrame, selection?.endFrame ?? totalFrames, totalFrames))
          }
        />
        <SelectionField
          label="Sel end"
          value={selection?.endFrame ?? totalFrames}
          max={totalFrames}
          onChange={(endFrame) =>
            onSelectionChange(selectionFromDrag(selection?.startFrame ?? 0, endFrame, totalFrames))
          }
        />
        <span className="text-bb-muted" data-testid="waveform-selection">
          {selection
            ? `${(selection.endFrame - selection.startFrame).toLocaleString()}f · ${secondsOf(
                selection.endFrame - selection.startFrame,
              ).toFixed(3)}s`
            : 'Whole sample'}
        </span>
        {selection && <Button size="sm" label="Clear selection" onClick={() => onSelectionChange(null)} />}
      </div>

      {interaction === 'markers' && markers.length > 0 && (
        <ul className="flex flex-wrap gap-1.5 text-xs" aria-label="Chop markers">
          {markers.map((marker, index) => (
            <li key={marker}>
              <button
                type="button"
                onClick={() => commitMarkers(markers.filter((_, i) => i !== index))}
                className="rounded-bb-sm border border-bb-line bg-bb-raised px-1.5 py-0.5 tabular-nums"
                aria-label={`Remove marker at ${secondsOf(marker).toFixed(3)} seconds`}
              >
                {secondsOf(marker).toFixed(3)}s ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface SelectionFieldProps {
  label: string;
  value: number;
  max: number;
  onChange: (value: number) => void;
}
function SelectionField({ label, value, max, onChange }: SelectionFieldProps) {
  return (
    <label className="flex items-center gap-1">
      {label}
      <input
        type="number"
        min={0}
        max={max}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-24 rounded-bb-sm border border-bb-line bg-bb-raised px-1 py-0.5 tabular-nums"
      />
    </label>
  );
}
