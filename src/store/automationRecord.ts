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
import { parseParamTarget } from '@/core/audio/params/registry';
import type { PlayheadReading } from '@/core/sequencer';
import { mergeRecordedPoint, shouldRecordSample, type RecordedSample } from '@/core/sequencer/automation';
import { automationLaneKey, type AutomationPoint, type Range } from '@/core/project/schemas';
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
  if (next === null) resetAutomationRecording();
}

/**
 * Forget every in-flight pass. Called when the transport stops or record-arm drops, so
 * the next pass opens with its own first point instead of thinning against the last one.
 *
 * Sealing the undo gesture is half the job, not an afterthought: a pass writes its points
 * under one coalesce key (spec §3.3), and leaving that key open would fold the NEXT take
 * on the same lane into the previous take's single undo entry.
 */
export function resetAutomationRecording(): void {
  const hadOpenPass = passes.size > 0;
  passes.clear();
  if (hadOpenPass) endUndoGesture();
}

/**
 * Value epsilon for a target, scaled from the §2.6 fraction by the parameter's own
 * registered range (spec §7.8). A fraction rather than an absolute, because a lane may
 * hold a gain in 0..1.2, a pan in -1..1 or a cutoff in 20..20 000 Hz.
 *
 * The range is supplied by the caller, not looked up here: the store that owns the
 * parameter has already resolved it to clamp the value, and for an insert parameter it is
 * the only layer that can — the bounds belong to the effect in the slot (spec §5.7), which
 * this module would have to reach into another store to see.
 */
function epsilonFor(range: Range): number {
  return AUTOMATION_VALUE_EPSILON * Math.abs(range[1] - range[0]);
}

/**
 * Record one sample of a live parameter gesture, if the transport is capturing (spec
 * §7.8). Called from the store actions that own the transient/commit channel; a no-op
 * whenever nothing is recording, which is the overwhelmingly common case, so the cost on
 * an ordinary fader drag is one SAB read.
 *
 * `phase` is `'move'` for a transient update and `'end'` for the gesture's commit, and
 * `range` is the parameter's registered bounds, which the caller has already resolved. A
 * gesture may be all `'end'` and no `'move'` — a keyboard step is one — and that still
 * writes a point.
 *
 * **Call the `'end'` phase BEFORE the parameter's own `commit()`, never after.** The pass
 * writes its points under one coalesce key; an unkeyed commit in between closes that run,
 * and the closing point would then land as a third undo entry of its own (spec §3.3).
 */
export function recordParamGesture(path: string, value: number, phase: 'move' | 'end', range: Range): void {
  const reading = clock?.();
  if (!reading?.isCapturing) return;

  // Recorded points are SEQUENCE-scoped, owned by the sequence being recorded into: a
  // pass captures a performance over the pattern, and it must loop with that pattern the
  // way the notes captured in the same pass do (spec §7.8 two scopes). Track scope spans
  // the arrangement and is the Grid's to author deliberately, not a capture default.
  const ownerId = useTransportStore.getState().activeSequenceId;
  if (ownerId === null) return;

  // Unregistered addresses are never recorded (spec §7.8 gate). The legacy bare mixer form
  // (`master.level`) lands here too, and refusing it is right: `setAutomationLane` would
  // refuse the lane anyway, so a point written under it could never be scheduled.
  if (parseParamTarget(path) === null) return;

  const key = automationLaneKey('sequence', ownerId, path);
  const tick = Math.max(0, Math.round(reading.currentTick));
  let previous = passes.get(key) ?? null;

  // A wrap rewinds the playhead behind the last sample: open a fresh sweep at the new
  // position rather than refusing every sample for the rest of the take.
  if (previous !== null && tick < previous.tick) previous = null;

  const limits = { minTickSpacing: AUTOMATION_MIN_TICK_SPACING, valueEpsilon: epsilonFor(range) };
  if (phase === 'move') {
    if (!shouldRecordSample(previous, tick, value, limits)) return;
  } else if (previous !== null && tick <= previous.tick) {
    // The gesture's end is worth a point wherever the playhead has since moved on: it is
    // the value the user settled on, and thinning it away would leave the lane short of
    // where the encoder actually stopped. Where it has not moved on, the pass has nothing
    // left to write but still has its coalesce run to seal.
    passes.delete(key);
    endUndoGesture();
    return;
  }
  // A `previous` of null on the end phase is a gesture with NO move phase — an arrow-key
  // step of a knob or fader, or a double-click reset, which `useContinuousControl` sends
  // straight to `onCommit` (spec §4.5 "keyboard steps are discrete"). §7.8 asks for knob
  // movements, and that is one; it opens and closes its pass in a single sample.

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
