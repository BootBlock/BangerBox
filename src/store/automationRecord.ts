/**
 * Automation capture from live gestures — spec §7.8 "Record automation: Q-Link/knob
 * movements while recording write points, thinned by minimum tick spacing + value
 * epsilon".
 *
 * The tap sits at the transient/commit channel (spec §4.1), not in any one mode: a
 * Q-Link encoder (spec §10.3), an XYFX drag (spec §8.5.10) and an on-screen knob or fader
 * all reach the graph through the same two store actions, so one tap there catches every
 * gesture §7.8 names and no mode has to remember to opt in.
 *
 * The playhead comes from the scheduler SAB the same way the canvases read it (spec
 * §7.1.4), published here by the engine on start — this module never imports the engine,
 * which imports the stores that import this.
 */
import { AUTOMATION_MIN_TICK_SPACING, AUTOMATION_VALUE_EPSILON } from '@/core/constants';
import { parseParamTarget, targetRange } from '@/core/audio/params/registry';
import type { PlayheadReading } from '@/core/sequencer';
import { mergeRecordedPoint, shouldRecordSample, type RecordedSample } from '@/core/sequencer/automation';
import { automationLaneKey, type AutomationPoint } from '@/core/project/schemas';
import { endUndoGesture } from './undo';
import { useSequenceStore } from './useSequenceStore';
import { useTransportStore } from './useTransportStore';

/** What the recorder needs from the running engine: the current playhead reading. */
export type AutomationClock = () => PlayheadReading;

let clock: AutomationClock | null = null;

/**
 * The last sample each lane's in-flight pass accepted. It is both what the next sample is
 * thinned against and the lower bound of the span {@link mergeRecordedPoint} overwrites,
 * and it resets to null when the playhead wraps — so a second lap rewrites what the first
 * laid down rather than being refused for running backwards.
 */
const passes = new Map<string, RecordedSample | null>();

/** The engine publishes its playhead reader here on start, and null on teardown. */
export function setAutomationClock(next: AutomationClock | null): void {
  clock = next;
  if (next === null) passes.clear();
}

/**
 * Forget every in-flight pass. Called when the transport stops or record-arm drops, so
 * the next pass opens with its own first point instead of thinning against the last one.
 */
export function resetAutomationRecording(): void {
  passes.clear();
}

/**
 * Value epsilon for a target, scaled from the §2.6 fraction by the parameter's own
 * registered range (spec §7.8). An unregistered address never reaches here — the caller
 * has already parsed it — but a registered one with no resolvable range (an insert param
 * whose slot the recorder cannot see) falls back to the fraction itself, which is the
 * right order of magnitude for the 0..1 params that case covers.
 */
function epsilonFor(path: string): number | null {
  const target = parseParamTarget(path);
  if (target === null) return null;
  const range = targetRange(target);
  if (range === null) return AUTOMATION_VALUE_EPSILON;
  return AUTOMATION_VALUE_EPSILON * Math.abs(range[1] - range[0]);
}

/**
 * Record one sample of a live parameter gesture, if the transport is capturing (spec
 * §7.8). Called from the store actions that own the transient/commit channel; a no-op
 * whenever nothing is recording, which is the overwhelmingly common case, so the cost on
 * an ordinary fader drag is one SAB read.
 *
 * `phase` is `'move'` for a transient update and `'end'` for the gesture's commit. The
 * end phase writes the released value and seals the undo entry, so one recorded gesture
 * is one Ctrl+Z on top of the parameter's own commit (spec §3.3).
 */
export function recordParamGesture(path: string, value: number, phase: 'move' | 'end'): void {
  const reading = clock?.();
  if (!reading?.isCapturing) return;

  // Recorded points are SEQUENCE-scoped, owned by the sequence being recorded into: a
  // pass captures a performance over the pattern, and it must loop with that pattern the
  // way the notes captured in the same pass do (spec §7.8 two scopes). Track scope spans
  // the arrangement and is the Grid's to author deliberately, not a capture default.
  const ownerId = useTransportStore.getState().activeSequenceId;
  if (ownerId === null) return;

  const epsilon = epsilonFor(path);
  if (epsilon === null) return; // unregistered address — never recorded (spec §7.8 gate)

  const key = automationLaneKey('sequence', ownerId, path);
  const tick = Math.max(0, Math.round(reading.currentTick));
  let previous = passes.get(key) ?? null;

  // A wrap rewinds the playhead behind the last sample: open a fresh sweep at the new
  // position rather than refusing every sample for the rest of the take.
  if (previous !== null && tick < previous.tick) previous = null;

  const limits = { minTickSpacing: AUTOMATION_MIN_TICK_SPACING, valueEpsilon: epsilon };
  if (phase === 'move') {
    if (!shouldRecordSample(previous, tick, value, limits)) return;
  } else {
    // The gesture's end is worth a point wherever the playhead has since moved on: it is
    // the value the user settled on, and thinning it away would leave the lane short of
    // where the encoder actually stopped. A pass that never accepted a sample wrote
    // nothing to close.
    if (previous === null || tick <= previous.tick) {
      passes.delete(key);
      return;
    }
  }

  const point: AutomationPoint = {
    id: crypto.randomUUID(),
    scope: 'sequence',
    ownerId,
    targetPath: path,
    tick,
    value,
    // A captured sweep is a continuous move, so its segments interpolate (spec §7.8).
    curve: 'linear',
  };
  const existing = useSequenceStore.getState().automation[key] ?? [];
  const merged = mergeRecordedPoint(existing, point, previous?.tick ?? null);
  const result = useSequenceStore.getState().setAutomationLane('sequence', ownerId, path, merged, key);
  if (!result.ok) return;

  if (phase === 'end') {
    // Seal the pass's undo entry; the next gesture on this lane starts a new one.
    passes.delete(key);
    endUndoGesture();
    return;
  }
  passes.set(key, { tick, value });
}
