/**
 * Groove extraction (spec §7.5) — pure functions turning detected transients (from the
 * `transientDetect` WASM kernel) into a **groove template**: a per-grid-position timing offset
 * and velocity scale. A template is stored per project (spec §9.3 payload) and applied to any
 * track either non-destructively at schedule time (like swing, §7.4 — {@link grooveShiftAtTick})
 * or baked as a destructive edit ({@link applyGrooveToEvents}). Dependency-free (spec §2.5).
 */
import { PPQN } from '@/core/constants';
import { clamp } from '@/core/math';

/** A detected onset: its frame index in the analysed sample and its relative strength. */
export interface Transient {
  readonly frame: number;
  readonly magnitude: number;
}

/** One grid position's groove: a signed tick offset and a velocity multiplier. */
export interface GroovePoint {
  readonly gridTick: number;
  readonly offsetTicks: number;
  readonly velocityScale: number;
}

/** A groove template covering `lengthTicks` at a fixed subdivision (spec §7.5). */
export interface GrooveTemplate {
  readonly ppqn: number;
  readonly lengthTicks: number;
  readonly division: 8 | 16;
  readonly points: GroovePoint[];
}

export interface GrooveExtractOptions {
  readonly bpm: number;
  readonly sampleRate: number;
  readonly lengthTicks: number;
  readonly division?: 8 | 16;
}

/** Musical tick of a sample frame at a given tempo (spec §7.2 secondsPerTick inverse). */
function frameToTick(frame: number, bpm: number, sampleRate: number): number {
  const seconds = frame / sampleRate;
  return seconds * (bpm / 60) * PPQN;
}

/**
 * Build a groove template from detected transients (spec §7.5). Each grid position takes the
 * offset of the nearest transient within half a grid step, and a velocity scale from that
 * transient's magnitude relative to the mean. Positions with no nearby transient stay neutral
 * (offset 0, scale 1).
 */
export function grooveFromTransients(
  transients: readonly Transient[],
  { bpm, sampleRate, lengthTicks, division = 16 }: GrooveExtractOptions,
): GrooveTemplate {
  const stepTicks = (PPQN * 4) / division; // ticks per subdivision in 4/4
  const gridCount = Math.max(1, Math.round(lengthTicks / stepTicks));
  const meanMagnitude =
    transients.length > 0 ? transients.reduce((sum, t) => sum + t.magnitude, 0) / transients.length : 1;

  const onsets = transients.map((t) => ({
    tick: frameToTick(t.frame, bpm, sampleRate),
    magnitude: t.magnitude,
  }));

  const points: GroovePoint[] = [];
  for (let i = 0; i < gridCount; i++) {
    const gridTick = i * stepTicks;
    let nearest: { tick: number; magnitude: number } | null = null;
    let nearestDistance = stepTicks / 2;
    for (const onset of onsets) {
      const distance = Math.abs(onset.tick - gridTick);
      if (distance <= nearestDistance) {
        nearest = onset;
        nearestDistance = distance;
      }
    }
    if (nearest) {
      points.push({
        gridTick,
        offsetTicks: Math.round(nearest.tick - gridTick),
        velocityScale: meanMagnitude > 0 ? clamp(nearest.magnitude / meanMagnitude, 0, 2) : 1,
      });
    } else {
      points.push({ gridTick, offsetTicks: 0, velocityScale: 1 });
    }
  }
  return { ppqn: PPQN, lengthTicks: gridCount * stepTicks, division, points };
}

/** The groove point whose grid tick is nearest `tick` (wrapped into the template length). */
function nearestPoint(template: GrooveTemplate, tick: number): GroovePoint {
  const wrapped = ((tick % template.lengthTicks) + template.lengthTicks) % template.lengthTicks;
  let best = template.points[0]!;
  let bestDistance = Infinity;
  for (const point of template.points) {
    const distance = Math.abs(point.gridTick - wrapped);
    if (distance < bestDistance) {
      best = point;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Schedule-time groove lookup (spec §7.5, applied like swing §7.4): the timing offset and
 * velocity scale for a note landing on `tick`, from the nearest grid position.
 */
export function grooveShiftAtTick(
  template: GrooveTemplate,
  tick: number,
): {
  offsetTicks: number;
  velocityScale: number;
} {
  const point = nearestPoint(template, tick);
  return { offsetTicks: point.offsetTicks, velocityScale: point.velocityScale };
}

/**
 * Destructively bake a groove template into events (spec §7.5): shift each event's start tick
 * by the nearest grid offset and scale its velocity, clamped to the valid 1..127 range. Pure —
 * returns new event objects, preserving every other field.
 */
export function applyGrooveToEvents<T extends { tickStart: number; velocity: number }>(
  events: readonly T[],
  template: GrooveTemplate,
): T[] {
  return events.map((event) => {
    const shift = grooveShiftAtTick(template, event.tickStart);
    return {
      ...event,
      tickStart: Math.max(0, Math.round(event.tickStart + shift.offsetTicks)),
      velocity: clamp(Math.round(event.velocity * shift.velocityScale), 1, 127),
    };
  });
}
