/**
 * EnvelopeGraph (spec §8.5.5 "AHDSR envelope graphs (draggable handles on canvas)") — the shape
 * of an {@link AhdsrEnvelope}, drawn as it will actually sound and editable by dragging its
 * joints. It replaces reading five numbers and imagining the result, and on a touch tablet it is
 * the difference between an editable envelope and five spinner arrows.
 *
 * A drag never passes through React state (spec §3.3/§4.5): the gesture writes to a ref and
 * schedules a repaint through {@link useCanvasPainter}, and `onChange` fires exactly once on
 * release. Committing per frame would push a hundred entries onto the undo stack for one drag.
 *
 * The canvas is not the operable form of this control (spec §8.2). Following the `WaveformEditor`
 * precedent, it is `role="img"` carrying a description of the current envelope, and the numeric
 * fields it is rendered above — `EnvelopeEditor` in `soundDesign.tsx` — remain the keyboard path
 * to the same state. It must not be rendered as the only editor for an envelope.
 */
import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { clamp01 } from '@/core/math';
import type { AhdsrEnvelope } from '@/core/project/schemas';
import { handleAtX, localPoint, readToken, trackPointer, useCanvasPainter } from './canvasDrag';
import {
  describeEnvelope,
  envelopeJoints,
  envelopePolyline,
  envelopeScale,
  timeFromDrag,
  TIMED_STAGES,
  type EnvelopeScale,
  type Point,
  type TimedStage,
} from './envelopeGraphMaths';

/** Radius of a drawn joint, in CSS pixels. The grab radius is larger — see `HANDLE_GRAB_PX`. */
const HANDLE_RADIUS_PX = 4;
/** Inset so the origin and the final silence handle are not clipped by the canvas edge. */
const PADDING_PX = 8;

/** Which joint each draggable handle sits on, and which joint its stage measures from. */
const HANDLE_JOINT = [1, 2, 3, 5] as const;
const SEGMENT_START_JOINT = [0, 1, 2, 4] as const;
/** The decay handle is also the sustain corner, so a vertical drag there sets the level. */
const SUSTAIN_HANDLE = 2;

export function EnvelopeGraph({
  envelope,
  onChange,
  label = 'Envelope',
}: {
  envelope: AhdsrEnvelope;
  onChange: (envelope: AhdsrEnvelope) => void;
  label?: string;
}) {
  /** The live envelope the repaint reads — the committed prop between gestures (spec §3.3). */
  const live = useRef(envelope);
  const activeHandle = useRef(-1);
  /**
   * Frozen at pointer-down so the grabbed joint tracks the finger rather than rubber-banding as
   * the re-normalised allocation shifts the segments the drag is not touching. Held in CSS
   * pixels, the space the pointer arrives in; the repaint scales it by the device ratio.
   */
  const dragScale = useRef<EnvelopeScale | null>(null);

  const draw = useCallback(
    (
      context: CanvasRenderingContext2D,
      { width, height, dpr }: { width: number; height: number; dpr: number },
    ) => {
      const canvas = context.canvas;
      const tokens = {
        bg: readToken(canvas, '--color-bb-surface', '#1c1b21'),
        line: readToken(canvas, '--color-bb-line', '#37343f'),
        accent: readToken(canvas, '--color-bb-accent', '#f5a524'),
        focus: readToken(canvas, '--color-bb-focus', '#61b8ff'),
        muted: readToken(canvas, '--color-bb-muted', '#a3a1ad'),
      };

      context.fillStyle = tokens.bg;
      context.fillRect(0, 0, width, height);

      const padding = PADDING_PX * dpr;
      const plotWidth = Math.max(1, width - padding * 2);
      const plotHeight = Math.max(1, height - padding * 2);
      const frozen = dragScale.current;
      const scale = frozen
        ? { pxPerSpan: frozen.pxPerSpan * dpr, plateauPx: frozen.plateauPx * dpr }
        : envelopeScale(live.current, plotWidth);
      const joints = envelopeJoints(live.current, scale, plotHeight);
      const at = (point: Point) => ({ x: padding + point.x, y: padding + point.y });
      const baseline = padding + plotHeight;

      // Peak and silence rails, so the drawn sustain level is read against something.
      context.strokeStyle = tokens.line;
      context.lineWidth = dpr;
      for (const y of [padding, baseline]) {
        context.beginPath();
        context.moveTo(padding, y);
        context.lineTo(width - padding, y);
        context.stroke();
      }

      const polyline = envelopePolyline(live.current, joints).map(at);
      const trace = () => {
        context.beginPath();
        polyline.forEach((point, index) => {
          if (index === 0) context.moveTo(point.x, point.y);
          else context.lineTo(point.x, point.y);
        });
      };

      // A wash under the curve, then the curve itself — the fill reads as level at a glance
      // where a bare line through a thin decay would not. Two passes, because the fill needs the
      // path closed down to the baseline and the stroke must not draw those closing edges.
      trace();
      context.lineTo(polyline[polyline.length - 1]!.x, baseline);
      context.lineTo(padding, baseline);
      context.closePath();
      context.save();
      context.globalAlpha = 0.18;
      context.fillStyle = tokens.accent;
      context.fill();
      context.restore();

      trace();
      context.strokeStyle = tokens.accent;
      context.lineWidth = 2 * dpr;
      context.stroke();

      HANDLE_JOINT.forEach((jointIndex, handle) => {
        const point = at(joints[jointIndex]!);
        context.fillStyle = handle === activeHandle.current ? tokens.focus : tokens.muted;
        context.beginPath();
        context.arc(point.x, point.y, HANDLE_RADIUS_PX * dpr, 0, Math.PI * 2);
        context.fill();
      });
    },
    [],
  );

  const { canvasRef, scheduleDraw } = useCanvasPainter(draw);

  // Committed props are the source of truth between gestures: undo, a preset load or an edit
  // made in the numeric fields must all reach the picture (spec §3.4).
  useEffect(() => {
    live.current = envelope;
    scheduleDraw();
  }, [envelope, scheduleDraw]);

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    const canvas = event.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const plotWidth = Math.max(1, rect.width - PADDING_PX * 2);
    const plotHeight = Math.max(1, rect.height - PADDING_PX * 2);
    const scale = envelopeScale(live.current, plotWidth);
    const joints = envelopeJoints(live.current, scale, plotHeight);

    const start = localPoint(canvas, event.clientX, event.clientY);
    const handle = handleAtX(
      HANDLE_JOINT.map((jointIndex) => PADDING_PX + joints[jointIndex]!.x),
      start.x,
    );
    // A press in open space is not an edit: an envelope has no meaning for "the point I tapped",
    // unlike a waveform selection, so a miss does nothing rather than snapping the nearest joint.
    if (handle < 0) return;

    activeHandle.current = handle;
    dragScale.current = scale;
    const stage: TimedStage = TIMED_STAGES[handle]!;
    const segmentStartX = PADDING_PX + joints[SEGMENT_START_JOINT[handle]!]!.x;
    scheduleDraw();

    trackPointer(
      event,
      (point) => {
        const next: AhdsrEnvelope = {
          ...live.current,
          [stage]: timeFromDrag(point.x, segmentStartX, scale),
        };
        if (handle === SUSTAIN_HANDLE) {
          // `fy` spans the whole element; the plot is inset by the padding at both ends.
          const top = PADDING_PX / rect.height;
          const span = Math.max(1e-6, plotHeight / rect.height);
          next.sustain = clamp01(1 - (point.fy - top) / span);
        }
        live.current = next;
        scheduleDraw();
      },
      () => {
        activeHandle.current = -1;
        dragScale.current = null;
        scheduleDraw();
        onChange(live.current);
      },
    );
  };

  return (
    <div className="space-y-1">
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={describeEnvelope(envelope, label)}
        data-testid="envelope-graph"
        className="block h-28 w-full cursor-pointer touch-none rounded-bb-sm border border-bb-line bg-bb-surface"
        onPointerDown={onPointerDown}
      />
      {/* The visible echo of the aria label: the graph's state in words, for anyone who cannot
          read a shape off a canvas and is not on the numeric fields beside it (spec §8.2). */}
      <p className="text-bb-micro tabular-nums text-bb-muted" data-testid="envelope-graph-readout">
        A {envelope.attack} · H {envelope.hold} · D {envelope.decay} ms · S{' '}
        {Math.round(clamp01(envelope.sustain) * 100)}% · R {envelope.release} ms
      </p>
    </div>
  );
}
