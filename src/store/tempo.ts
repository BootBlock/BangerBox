/**
 * Tempo and swing edits — the commands that put a transport-bar knob, or a §10.3 Q-Link
 * encoder, onto the row that actually owns the value (spec §9.3, §7.9 — issue #93).
 *
 * §9.3 puts `tempo`, `swing_amount` and `swing_division` on the SEQUENCE, and §4.2 documents
 * `useTransportStore.bpm` as "effective tempo (follows the active sequence)" — the derived
 * mirror, not the truth. Writing the mirror and stopping there is what made a tempo edit
 * vanish on reload: the row never moved, autosave was never armed, and the unsaved dot never
 * lit to warn anyone.
 *
 * These live outside both stores rather than inside either. `useTransportStore` may not own
 * the write, because that would make the mirror authoritative and contradict §7.9;
 * `useSequenceStore` should not have to know which sequence the transport happens to be on.
 * The command is the one place that knows both, and it is what every surface calls.
 *
 * The transient/commit split mirrors §4.1's channel: a knob drag or a Q-Link turn moves the
 * mirror continuously so the readout and the scheduler follow the gesture, and the commit at
 * the end of it writes the row once, as one undo entry (spec §3.3).
 */
import { clamp } from '@/core/math';
import { BPM_RANGE, SWING_RANGE } from '@/core/project/schemas';
import { useProjectStore } from './useProjectStore';
import { useSequenceStore } from './useSequenceStore';
import { useTransportStore, type SwingDivision } from './useTransportStore';

/** Move the transport mirror only — a gesture still in flight (spec §4.1). */
export function setTempoTransient(bpm: number): void {
  useTransportStore.getState().setBpm(bpm);
}

/** Move the transport mirror only — a gesture still in flight (spec §4.1). */
export function setSwingTransient(amount: number, division?: SwingDivision): void {
  useTransportStore.getState().setSwing(amount, division);
}

/**
 * Commit a tempo to the row that owns it (spec §9.3).
 *
 * With an active sequence that is `sequences.tempo`, through `updateSequence` so the edit is
 * undoable and marks the sequence dirty like every other persisted control. With none, §9.3's
 * NULL-means-project-default makes `projects.bpm_default` the owner instead, so the edit goes
 * there — a tempo the user set has to land somewhere, and silently moving only the mirror is
 * the defect this closes.
 */
export function commitTempo(bpm: number): void {
  const tempo = clamp(bpm, BPM_RANGE[0], BPM_RANGE[1]);
  const { activeSequenceId } = useTransportStore.getState();
  if (activeSequenceId !== null && useSequenceStore.getState().sequences[activeSequenceId]) {
    useSequenceStore.getState().updateSequence(activeSequenceId, { tempo });
  } else {
    useProjectStore.getState().setBpmDefault(tempo);
  }
  // The mirror follows immediately rather than waiting for the derive subscriber, which is
  // registered by the project session and absent in tests and headless boots (spec §3.4).
  useTransportStore.getState().setBpm(tempo);
}

/**
 * Commit a swing setting to the sequence that owns it (spec §9.3, §7.4).
 *
 * Unlike tempo there is no project-level fallback: §9.3 gives swing to `sequences` only. With
 * no active sequence the value has nowhere durable to go, so it moves the mirror and no more
 * — which is honest, since there is no arrangement for it to belong to yet.
 */
export function commitSwing(amount: number, division?: SwingDivision): void {
  const swingAmount = clamp(amount, SWING_RANGE[0], SWING_RANGE[1]);
  const { activeSequenceId } = useTransportStore.getState();
  const sequence = activeSequenceId ? useSequenceStore.getState().sequences[activeSequenceId] : undefined;
  if (activeSequenceId !== null && sequence) {
    useSequenceStore.getState().updateSequence(activeSequenceId, {
      swingAmount,
      swingDivision: division ?? sequence.swingDivision,
    });
  }
  useTransportStore.getState().setSwing(swingAmount, division);
}
