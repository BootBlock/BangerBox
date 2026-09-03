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

/** What the §9.3 rows say the mirror should hold right now. */
interface Derived {
  readonly bpm: number;
  readonly swingAmount: number | null;
  readonly swingDivision: 8 | 16 | null;
}

/**
 * Read the mirror's value out of the rows (spec §9.3: a NULL `sequences.tempo` means
 * `projects.bpm_default`).
 *
 * Swing has no project-level default in §9.3, so with no active sequence there is nothing to
 * derive and the last mirrored value stands rather than being reset to something no row
 * describes — hence the nulls rather than a fabricated 50.
 */
function derive(): Derived {
  const { activeSequenceId } = useTransportStore.getState();
  const sequence = activeSequenceId ? useSequenceStore.getState().sequences[activeSequenceId] : undefined;
  return {
    bpm: sequence?.tempo ?? useProjectStore.getState().bpmDefault,
    swingAmount: sequence?.swingAmount ?? null,
    swingDivision: sequence?.swingDivision ?? null,
  };
}

/**
 * Keep the transport mirror derived from its source. Call the returned disposer on session
 * teardown (spec §3.5 lens 5).
 *
 * Registration applies it once, matching the "initial full resync then narrow diffs" shape
 * `subscribeSequencerSync` established. After that it writes only what actually changed in the
 * rows, so a gesture holding the mirror ahead of its row is left alone.
 */
export function subscribeTransportMirror(): Unsubscribe {
  let last = derive();
  const transport = () => useTransportStore.getState();
  transport().setBpm(last.bpm);
  if (last.swingAmount !== null && last.swingDivision !== null) {
    transport().setSwing(last.swingAmount, last.swingDivision);
  }

  /**
   * Write back only what the ROWS changed.
   *
   * Re-deriving both values on every source change looked equivalent and was not: a §4.1
   * transient gesture holds the mirror ahead of its row on purpose, and an unrelated edit to
   * the same row — another Q-Link encoder committing swing during a tempo turn — snapped the
   * mirror back mid-gesture, so the turn's own commit then persisted a tempo nobody chose.
   * Comparing against the last derived value confines the mirror to changes that really came
   * from the source, and a genuine tempo change still overrides a gesture, which is right:
   * the mirror is a mirror, and the row moved.
   */
  const applyMirror = (): void => {
    const next = derive();
    if (next.bpm !== last.bpm) transport().setBpm(next.bpm);
    if (
      next.swingAmount !== null &&
      next.swingDivision !== null &&
      (next.swingAmount !== last.swingAmount || next.swingDivision !== last.swingDivision)
    ) {
      transport().setSwing(next.swingAmount, next.swingDivision);
    }
    last = next;
  };

  return combineUnsubscribers([
    useTransportStore.subscribe((state) => state.activeSequenceId, applyMirror),
    useSequenceStore.subscribe((state) => state.sequences, applyMirror),
    useProjectStore.subscribe((state) => state.bpmDefault, applyMirror),
  ]);
}
