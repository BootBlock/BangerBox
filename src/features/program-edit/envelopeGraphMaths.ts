/**
 * AHDSR graph geometry (spec §8.5.5 "AHDSR envelope graphs (draggable handles on canvas)").
 *
 * Split out from `EnvelopeGraph` for the reason `waveformView.ts` is split out of
 * `WaveformEditor`: §3.3 forbids routing a drag through React state, so the component redraws
 * from refs and the interesting arithmetic — the time taper, the segment allocation, and the
 * inverse a drag needs — would otherwise be locked inside a canvas jsdom cannot render. Here it
 * is dependency-free and directly testable (spec §2.5).
 */
import { clamp, clamp01, normalisedToValue, valueToNormalised, type ControlRange } from '@/core/math';
import type { AhdsrEnvelope } from '@/core/project/schemas';

/** Envelope times span 0..20 s — the range the §8.5.5 numeric fields already use. */
export const MAX_TIME_MS = 20_000;

/**
 * Time axis taper.
 *
 * A linear 0..20000 ms axis is unusable: a 1 ms attack and a 20 s release differ by four orders
 * of magnitude, so the attack would occupy a twenty-thousandth of the width and could never be
 * dialled in next to the release. The shared taper in `@/core/math` is the right curve but its
 * `'log'` mode needs both ends strictly positive, and 0 ms is a legal (and common) envelope time.
 * So the range is shifted by a small offset and read through that same helper rather than a
 * second curve implementation (spec §3.6 ZERO DRY): the result is a log1p taper,
 * `ln(1 + ms/OFFSET) / ln(1 + 20000/OFFSET)`, which is logarithmic over most of the span but
 * stays finite and linear-ish as it approaches zero.
 *
 * 5 ms is the offset because it spreads the musically interesting decade sensibly: 1 ms lands at
 * 2% of the axis, 20 ms at 19%, 100 ms at 37%, 1 s at 64%. Short times get room without the long
 * tail collapsing into the last few pixels.
 */
const TIME_TAPER_OFFSET_MS = 5;
const TIME_TAPER_RANGE: ControlRange = [TIME_TAPER_OFFSET_MS, MAX_TIME_MS + TIME_TAPER_OFFSET_MS];

/** Milliseconds → 0..1 along the tapered time axis. */
export function timeToSpan(ms: number): number {
  return valueToNormalised(clamp(ms, 0, MAX_TIME_MS) + TIME_TAPER_OFFSET_MS, TIME_TAPER_RANGE, 'log');
}

/** The exact inverse of {@link timeToSpan}, rounded to whole milliseconds as the fields are. */
export function spanToTime(span: number): number {
  const ms = normalisedToValue(clamp01(span), TIME_TAPER_RANGE, 'log') - TIME_TAPER_OFFSET_MS;
  return clamp(Math.round(ms), 0, MAX_TIME_MS);
}

/**
 * Every timed segment is allocated this much span on top of its own, so a zero-length stage still
 * has a handle the finger can find and pull out. Without it a fresh envelope with `hold: 0` would
 * stack two handles on the same pixel.
 */
const SEGMENT_FLOOR_SPAN = 0.05;
/** The sustain plateau has no duration to draw, so it takes a fixed slice of the width. */
const PLATEAU_FRACTION = 0.16;

/** The four timed stages, in draw order. `sustain` is a level, so it is not one of them. */
export const TIMED_STAGES = ['attack', 'hold', 'decay', 'release'] as const;
export type TimedStage = (typeof TIMED_STAGES)[number];

export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * The horizontal scale a graph is drawn at: pixels per unit of tapered span, plus the plateau's
 * width. A drag freezes these at pointer-down and redraws through them, so the grabbed joint
 * tracks the finger exactly instead of rubber-banding as the re-normalised allocation shifts the
 * segments it is not touching.
 */
export interface EnvelopeScale {
  readonly pxPerSpan: number;
  readonly plateauPx: number;
}

export function envelopeScale(envelope: AhdsrEnvelope, width: number): EnvelopeScale {
  const totalSpan = TIMED_STAGES.reduce(
    (sum, stage) => sum + timeToSpan(envelope[stage]) + SEGMENT_FLOOR_SPAN,
    0,
  );
  const plateauPx = width * PLATEAU_FRACTION;
  return { pxPerSpan: Math.max(0, width - plateauPx) / totalSpan, plateauPx };
}

/**
 * The six joints of the envelope, left to right: origin, peak (attack end), hold end, sustain
 * level (decay end), plateau end, and silence (release end). `y` is in canvas space, so 0 is the
 * top and `height` is silence.
 */
export function envelopeJoints(envelope: AhdsrEnvelope, scale: EnvelopeScale, height: number): Point[] {
  const widthOf = (stage: TimedStage) => (timeToSpan(envelope[stage]) + SEGMENT_FLOOR_SPAN) * scale.pxPerSpan;
  const sustainY = height * (1 - clamp01(envelope.sustain));
  const x1 = widthOf('attack');
  const x2 = x1 + widthOf('hold');
  const x3 = x2 + widthOf('decay');
  const x4 = x3 + scale.plateauPx;
  return [
    { x: 0, y: height },
    { x: x1, y: 0 },
    { x: x2, y: 0 },
    { x: x3, y: sustainY },
    { x: x4, y: sustainY },
    { x: x4 + widthOf('release'), y: height },
  ];
}

/**
 * Pointer x → the time of the stage being dragged, given the joint the stage starts from. The
 * segment's own floor is removed before untapering, so dropping the handle back onto its start
 * yields 0 ms rather than the floor's worth of time.
 */
export function timeFromDrag(x: number, segmentStartX: number, scale: EnvelopeScale): number {
  if (scale.pxPerSpan <= 0) return 0;
  return spanToTime((x - segmentStartX) / scale.pxPerSpan - SEGMENT_FLOOR_SPAN);
}

/**
 * Progress shaping along one segment. Linear is the identity; exponential is the analogue
 * envelope's shape — fast at the start, easing into the target — so an exponential decay
 * visibly plunges and tails rather than looking like a straight line with a label on it.
 */
const EXPONENTIAL_K = 4.5;
export function shapeProgress(t: number, curve: AhdsrEnvelope['curve']): number {
  const clamped = clamp01(t);
  if (curve === 'linear') return clamped;
  return (1 - Math.exp(-EXPONENTIAL_K * clamped)) / (1 - Math.exp(-EXPONENTIAL_K));
}

/**
 * The polyline to stroke, at `samplesPerSegment` points across each curved stage. Hold and the
 * plateau are flat, so they contribute their endpoints only; sampling them would just add points
 * along a line the canvas can draw in one `lineTo`.
 */
export function envelopePolyline(
  envelope: AhdsrEnvelope,
  joints: readonly Point[],
  samplesPerSegment = 24,
): Point[] {
  const [origin, peak, holdEnd, sustainStart, plateauEnd, end] = joints as [
    Point,
    Point,
    Point,
    Point,
    Point,
    Point,
  ];
  const curved = (from: Point, to: Point): Point[] => {
    const points: Point[] = [];
    for (let i = 1; i <= samplesPerSegment; i++) {
      const t = i / samplesPerSegment;
      points.push({
        x: from.x + (to.x - from.x) * t,
        y: from.y + (to.y - from.y) * shapeProgress(t, envelope.curve),
      });
    }
    return points;
  };
  return [
    origin,
    ...curved(origin, peak),
    holdEnd,
    ...curved(holdEnd, sustainStart),
    plateauEnd,
    ...curved(plateauEnd, end),
  ];
}

/** Screen-reader description of the whole envelope (spec §8.2). */
export function describeEnvelope(envelope: AhdsrEnvelope, label: string): string {
  return (
    `${label}: attack ${envelope.attack} ms, hold ${envelope.hold} ms, decay ${envelope.decay} ms, ` +
    `sustain ${Math.round(clamp01(envelope.sustain) * 100)}%, release ${envelope.release} ms, ` +
    `${envelope.curve} curve`
  );
}
