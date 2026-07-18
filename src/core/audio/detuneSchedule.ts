/**
 * Detune schedule integration — spec §5.4 end-of-voice declick, issue #87.
 *
 * A voice consumes its buffer at `2^(detune/1200)` seconds of buffer per second of wall
 * clock. When `detune` is constant the moment the region runs out is one division; when a
 * §6 modulator varies it — pitch envelope, keygroup mono glide, or a pitch-routed LFO —
 * the rate is a curve and the true end is the time `t` at which
 *
 *   ∫ 2^(detune(τ)/1200) dτ  from the voice's start to t  =  the region's length.
 *
 * This module models the same detune contour the voice pool writes onto `source.detune`
 * (piecewise-linear breakpoints) plus the oscillators summed into it (LFO routes), and
 * solves that integral so the declick fade can be laid where the buffer actually ends.
 *
 * Accuracy is bounded by the step resolution rather than by the modulation depth: the
 * varying window is integrated with the midpoint rule at {@link STEPS_PER_CYCLE} steps per
 * LFO cycle, and the constant-base tail is advanced a whole LFO period at a time so a long
 * sample costs no more than a short one.
 */

/** Steps per cycle of the fastest oscillation — midpoint-rule resolution. */
const STEPS_PER_CYCLE = 32;
/** Ceiling on steps for one integrated span, so a pathological rate pair cannot stall a note-on. */
const MAX_STEPS = 8192;
/** Largest cycle count searched when looking for a period both oscillations share. */
const MAX_HARMONIC = 32;
/** Most the base contour may move across one integration step, in cents. */
const MAX_CENTS_PER_STEP = 10;
/** Relative agreement required to call two cycle counts a common period. */
const PERIOD_TOLERANCE = 1e-6;
/** Safety bound on tail windows, so an unsolvable integral degrades instead of hanging. */
const MAX_TAIL_WINDOWS = 64;

/** One point on the piecewise-linear detune contour written to `source.detune`, in cents. */
export interface DetuneBreakpoint {
  readonly time: number;
  readonly cents: number;
}

/** An oscillator summed into `source.detune` by a §6 pitch mod route. */
export interface DetuneOscillation {
  /** Native oscillator type, as wired (`custom` is treated as a sine). */
  readonly wave: OscillatorType;
  readonly rateHz: number;
  /** Signed peak excursion in cents — the mod gain feeding `source.detune`. */
  readonly amplitudeCents: number;
  /** Context time the oscillator started, i.e. where its phase is zero. */
  readonly since: number;
}

/**
 * The detune contour of one live voice: a piecewise-linear base (held flat before the
 * first breakpoint and after the last) plus any oscillations summed onto it. Breakpoints
 * are mutable because a live retune appends to them; oscillations are fixed at voice build.
 */
export interface DetuneSchedule {
  breakpoints: DetuneBreakpoint[];
  readonly oscillations: readonly DetuneOscillation[];
}

/** The base detune in cents at `time`, interpolating between breakpoints (spec §6). */
export function baseDetuneAt(schedule: DetuneSchedule, time: number): number {
  const points = schedule.breakpoints;
  if (points.length === 0) return 0;
  const first = points[0]!;
  if (time <= first.time) {
    // Breakpoints may share a time (an instant attack, or a retune's step). The AudioParam
    // takes the last event scheduled at a given time, so this must too.
    let value = first.cents;
    for (const point of points) {
      if (point.time !== first.time) break;
      value = point.cents;
    }
    return value;
  }
  for (let i = 1; i < points.length; i++) {
    const previous = points[i - 1]!;
    const next = points[i]!;
    if (time >= next.time) continue;
    const span = next.time - previous.time;
    if (span <= 0) return next.cents; // a retune's step discontinuity: take the later value
    return previous.cents + ((next.cents - previous.cents) * (time - previous.time)) / span;
  }
  return points[points.length - 1]!.cents;
}

/** Total detune in cents at `time` — base contour plus every oscillation summed onto it. */
export function detuneAt(schedule: DetuneSchedule, time: number): number {
  let cents = baseDetuneAt(schedule, time);
  for (const osc of schedule.oscillations) {
    cents += osc.amplitudeCents * waveValue(osc.wave, phaseOf(osc, time));
  }
  return cents;
}

/**
 * Fold a live retune into the schedule (spec §10.2 pitch bend, §6 pad detune).
 *
 * The pool retunes with `setTargetAtTime`, which Web Audio renders only while it is the
 * *last* automation event on the param. A voice whose pitch envelope or glide ramp is
 * still pending already has later events queued, and the pending
 * `linearRampToValueAtTime` interpolates from the value at the preceding event's time —
 * so the retune never renders at all for those voices. Modelling that faithfully (rather
 * than assuming the retune lands) is what keeps the integrated end time honest.
 */
export function applyRetune(schedule: DetuneSchedule, time: number, cents: number): void {
  const points = schedule.breakpoints;
  const last = points[points.length - 1];
  if (last && time < last.time) return; // superseded by a pending ramp — never rendered
  const held = baseDetuneAt(schedule, time);
  schedule.breakpoints = [
    ...points.filter((point) => point.time < time),
    { time, cents: held }, // terminate the outgoing segment…
    { time, cents }, // …then step to the retuned value
  ];
}

/** Buffer seconds a voice consumes between two context times under this schedule. */
export function consumedBetween(schedule: DetuneSchedule, from: number, to: number): number {
  let total = 0;
  let cursor = from;
  for (const boundary of segmentBoundaries(schedule, from, to)) {
    total += integrateSpan(schedule, cursor, boundary, Infinity).consumed;
    cursor = boundary;
  }
  return total + integrateSpan(schedule, cursor, to, Infinity).consumed;
}

/**
 * The context time at which `remainingSeconds` of buffer run out, starting from `from`.
 *
 * Breakpoint-bounded segments are integrated in order; once the base detune has settled,
 * an unmodulated voice closes in one division and a modulated one advances whole
 * oscillation periods before integrating the final partial period at full resolution.
 */
export function regionEndTime(schedule: DetuneSchedule, from: number, remainingSeconds: number): number {
  let remaining = remainingSeconds;
  let cursor = from;

  for (const boundary of segmentBoundaries(schedule, from, Infinity)) {
    const result = integrateSpan(schedule, cursor, boundary, remaining);
    if (result.endTime !== null) return result.endTime;
    remaining -= result.consumed;
    cursor = boundary;
  }

  // Past the last breakpoint the base is flat; only the oscillations still move the rate.
  const oscillations = activeOscillations(schedule);
  if (oscillations.length === 0) {
    const rate = playbackRate(detuneAt(schedule, cursor));
    return rate > 0 ? cursor + remaining / rate : cursor;
  }

  const period = commonPeriod(oscillations);
  const perPeriod = integrateSpan(schedule, cursor, cursor + period, Infinity).consumed;
  if (perPeriod > 0) {
    const whole = Math.floor(remaining / perPeriod);
    remaining -= whole * perPeriod;
    cursor += whole * period;
  }
  return exhaustTail(schedule, cursor, remaining, period);
}

// --------------------------------------------------------------- internals ---

/** Buffer-consumption rate for a detune in cents — 1200 cents doubles the rate (spec §6). */
function playbackRate(detuneCents: number): number {
  return 2 ** (detuneCents / 1200);
}

function activeOscillations(schedule: DetuneSchedule): readonly DetuneOscillation[] {
  return schedule.oscillations.filter((osc) => osc.amplitudeCents !== 0 && osc.rateHz > 0);
}

/** Breakpoint times strictly inside `(from, to)`, so no integrated span crosses a corner. */
function segmentBoundaries(schedule: DetuneSchedule, from: number, to: number): number[] {
  return schedule.breakpoints
    .map((point) => point.time)
    .filter((time) => time > from && time < to)
    .sort((a, b) => a - b);
}

/** Oscillator phase in [0, 1) at `time`. */
function phaseOf(osc: DetuneOscillation, time: number): number {
  const cycles = (time - osc.since) * osc.rateHz;
  return cycles - Math.floor(cycles);
}

/**
 * Native oscillator shapes as Web Audio renders them from phase zero: a sine starts at
 * zero rising, a sawtooth ramps 0 → +1, wraps to −1 and returns to 0, a triangle peaks at
 * a quarter period, and a square holds +1 for its first half.
 */
function waveValue(wave: OscillatorType, phase: number): number {
  switch (wave) {
    case 'square':
      return phase < 0.5 ? 1 : -1;
    case 'sawtooth':
      return phase < 0.5 ? 2 * phase : 2 * phase - 2;
    case 'triangle':
      if (phase < 0.25) return 4 * phase;
      return phase < 0.75 ? 2 - 4 * phase : 4 * phase - 4;
    default:
      return Math.sin(2 * Math.PI * phase); // sine, and `custom` (never wired here)
  }
}

/**
 * A period every oscillation shares, so the tail can be advanced in whole cycles.
 *
 * Whole cycles of the slowest oscillation are searched for the one that leaves the others
 * closest to a whole number of cycles too — usually exact, since LFO rates are typically
 * simple multiples of each other, and otherwise the best rational approximation available.
 * Candidates too long to resolve within {@link MAX_STEPS} are skipped: a period integrated
 * coarsely would poison every jump made with it.
 */
function commonPeriod(oscillations: readonly DetuneOscillation[]): number {
  const slowest = Math.min(...oscillations.map((osc) => osc.rateHz));
  const fastest = Math.max(...oscillations.map((osc) => osc.rateHz));
  if (oscillations.length < 2) return 1 / slowest;

  let best = 1 / slowest;
  let bestSlip = Infinity;
  for (let cycles = 1; cycles <= MAX_HARMONIC; cycles++) {
    const candidate = cycles / slowest;
    if (candidate * fastest * STEPS_PER_CYCLE > MAX_STEPS) break;
    const slip = Math.max(
      ...oscillations.map((osc) => {
        const turns = candidate * osc.rateHz;
        return Math.abs(turns - Math.round(turns));
      }),
    );
    if (slip < bestSlip) {
      best = candidate;
      bestSlip = slip;
    }
    if (slip <= PERIOD_TOLERANCE) break;
  }
  return best;
}

/**
 * Steps to integrate a span with: enough to resolve the fastest oscillation, and enough
 * that the base contour moves only {@link MAX_CENTS_PER_STEP} across each one — a sloped
 * segment needs subdividing even with no LFO on it, because the rate curve is exponential
 * in the detune and a single midpoint would understate it.
 */
function stepCount(schedule: DetuneSchedule, from: number, to: number): number {
  const oscillations = activeOscillations(schedule);
  let steps = 1;
  if (oscillations.length > 0) {
    const fastest = Math.max(...oscillations.map((osc) => osc.rateHz));
    steps = Math.ceil((to - from) * fastest * STEPS_PER_CYCLE);
  }
  const swing = Math.abs(baseDetuneAt(schedule, to) - baseDetuneAt(schedule, from));
  steps = Math.max(steps, Math.ceil(swing / MAX_CENTS_PER_STEP));
  return Math.min(MAX_STEPS, Math.max(1, steps));
}

interface SpanResult {
  /** Buffer seconds consumed across the span (or up to `remaining`, if it ran out). */
  readonly consumed: number;
  /** Context time the region ran out, or null if it survived the span. */
  readonly endTime: number | null;
}

/**
 * Midpoint-rule integration of one span, stopping early if `remaining` runs out inside it.
 * The step count is capped: a very slow LFO against a very fast one coarsens resolution
 * rather than costing unbounded work on the audio thread's note-on path.
 */
function integrateSpan(schedule: DetuneSchedule, from: number, to: number, remaining: number): SpanResult {
  const span = to - from;
  if (!(span > 0)) return { consumed: 0, endTime: null };
  const steps = stepCount(schedule, from, to);
  const step = span / steps;
  let consumed = 0;
  for (let i = 0; i < steps; i++) {
    const rate = playbackRate(detuneAt(schedule, from + (i + 0.5) * step));
    const chunk = rate * step;
    if (consumed + chunk >= remaining) {
      const within = rate > 0 ? (remaining - consumed) / rate : 0;
      return { consumed: remaining, endTime: from + i * step + within };
    }
    consumed += chunk;
  }
  return { consumed, endTime: null };
}

/** Integrate the final partial period, falling back to the settled rate if it overruns. */
function exhaustTail(schedule: DetuneSchedule, from: number, remaining: number, window: number): number {
  let cursor = from;
  let left = remaining;
  for (let i = 0; i < MAX_TAIL_WINDOWS && left > 0; i++) {
    const result = integrateSpan(schedule, cursor, cursor + window, left);
    if (result.endTime !== null) return result.endTime;
    if (result.consumed <= 0) break;
    left -= result.consumed;
    cursor += window;
  }
  const rate = playbackRate(baseDetuneAt(schedule, cursor));
  return rate > 0 ? cursor + left / rate : cursor;
}
