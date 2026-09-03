/**
 * The transport tempo/swing mirror (spec §4.2, §7.9 — issue #93).
 *
 * §4.2 calls `useTransportStore.bpm` the "effective tempo (follows the active sequence)", and
 * the same holds for `swingAmount`/`swingDivision`: the truth is the `sequences` row (§9.3),
 * and the transport store holds a copy so the bar, the scheduler and the graph can read one
 * value without every consumer resolving the active sequence themselves.
 *
 * A copy only stays true if something re-derives it. Hydration set it once, and nothing did
 * afterwards — so an undo restored the row while the bar kept showing the undone tempo, and
 * switching to another sequence played it at the previous sequence's tempo. This subscriber
 * is the one place that recomputes it, which is why the derivation cannot also live in
 * `updateSequence` or in `setActiveSequenceId`: two places drift, and the one that gets
 * forgotten is whichever a later feature adds.
 *
 * It is deliberately NOT part of `syncLayer/` (spec §4.3), which exists for store → audio
 * graph. This is store → store, and mixing the two would blur the rule that the sync layer is
 * the only code allowed to touch audio nodes.
 */
import { combineUnsubscribers, type Unsubscribe } from '../syncLayer/bridge';
import { useProjectStore } from '../useProjectStore';
import { useSequenceStore } from '../useSequenceStore';
import { useTransportStore } from '../useTransportStore';

/**
 * Recompute the mirror from the active sequence, falling back to the project default
 * (spec §9.3: a NULL `sequences.tempo` means `projects.bpm_default`).
 *
 * Swing has no project-level default in §9.3, so with no active sequence the last mirrored
 * value stands rather than being reset to something no row describes.
 */
function applyMirror(): void {
  const { activeSequenceId } = useTransportStore.getState();
  const sequence = activeSequenceId ? useSequenceStore.getState().sequences[activeSequenceId] : undefined;
  const transport = useTransportStore.getState();

  transport.setBpm(sequence?.tempo ?? useProjectStore.getState().bpmDefault);
  if (sequence) transport.setSwing(sequence.swingAmount, sequence.swingDivision);
}

/**
 * Keep the transport mirror derived from its source. Call the returned disposer on session
 * teardown (spec §3.5 lens 5).
 *
 * Registration applies it once, matching the "initial full resync then narrow diffs" shape
 * `subscribeSequencerSync` established.
 */
export function subscribeTransportMirror(): Unsubscribe {
  applyMirror();
  return combineUnsubscribers([
    useTransportStore.subscribe((state) => state.activeSequenceId, applyMirror),
    useSequenceStore.subscribe((state) => state.sequences, applyMirror),
    useProjectStore.subscribe((state) => state.bpmDefault, applyMirror),
  ]);
}
