/**
 * Sample assignment (spec §8.5.7 drag-to-pad, §8.5.5, §8.5.4 "slices assign to pads or new
 * program"). The one place that turns "this sample belongs on that pad or zone" into store
 * commits, so the wording of every success and refusal is written once rather than restated
 * at the Browser, Program Edit and Sample Edit call sites.
 *
 * The single-sample entry points are thin over the {@link useProgramStore} actions, which own
 * the §6 validation. What lives here instead is the reporting — an assignment is a change the
 * user cannot see if their focus is on the sample list rather than the pad grid, so it raises a
 * toast, and `ToastViewport` announces that toast through the single §8.2 announcer. Announcing
 * here as well said it twice, in two regions at once (issue #34).
 *
 * The chop entry points are the reason this module exists rather than the UI calling the store
 * directly: a chop lands dozens of samples, and §4.5 gives the user one Ctrl+Z for the one
 * action they took, not one per slice.
 */
import type { SampleRow } from '@/core/storage/repositories';
import {
  createDefaultDrumProgram,
  createDefaultPad,
  createDefaultVelocityLayer,
  PAD_INDEX_RANGE,
  type DrumProgram,
  type Pad,
} from '@/core/project/schemas';
import { commitAsOne } from '@/store/commit';
import { useProgramStore, useUIStore, type AssignResult } from '@/store';

/** Where a single sample is being assigned (spec §6 — a program has pads or zones, never both). */
export type AssignTarget = { readonly kind: 'pad'; readonly padIndex: number } | { readonly kind: 'zone' };

/**
 * Report an assignment to the user as a toast, which the §8.2 announcer then speaks — because
 * the pad grid they just changed may be off screen or unfocused. Refusals carry the store's own
 * sentence, which names the §6 rule that refused.
 */
function report(result: AssignResult, success: string): boolean {
  const { pushToast } = useUIStore.getState();
  if (!result.ok) {
    pushToast(result.reason, 'warning');
    return false;
  }
  pushToast(success, 'success');
  return true;
}

/**
 * Assign one sample to a pad or as a keygroup zone (spec §8.5.7, §8.5.5). Returns whether it
 * landed, so a caller can close its dialog only on success and leave it open on a refusal.
 */
export function assignSampleToTarget(programId: string, sample: SampleRow, target: AssignTarget): boolean {
  const store = useProgramStore.getState();
  if (target.kind === 'zone') {
    return report(
      store.addKeygroupZone(programId, sample.id, sample.root_note),
      `${sample.name} assigned as a key zone.`,
    );
  }
  return report(
    store.addPadLayer(programId, target.padIndex, sample.id),
    `${sample.name} assigned to pad ${target.padIndex + 1}.`,
  );
}

/** Replace one pad's layers with a single layer playing `sample` (the §8.5.4 chop shape). */
function padPlayingOnly(existing: Pad | undefined, padIndex: number, sample: SampleRow): Pad {
  const base = existing ?? createDefaultPad(padIndex);
  // The slice's own name, so a chopped break reads as its slices rather than as "Pad 1..16".
  return { ...base, name: sample.name, layers: [createDefaultVelocityLayer(sample.id)] };
}

/**
 * Lay chop slices out across consecutive pads from `firstPadIndex` (spec §8.5.4). Each slice
 * REPLACES its pad's layers rather than stacking on top: a chop divides one sound into many,
 * so slice 3 velocity-layered under slice 2 would be nonsense. Slices past pad 128 are
 * dropped, and the count returned says how many landed so the caller can say so.
 *
 * One undo entry for the whole lot (spec §4.5) — the user chopped once.
 */
export function assignSlicesToPads(
  programId: string,
  firstPadIndex: number,
  slices: readonly SampleRow[],
): number {
  const program = useProgramStore.getState().programs[programId];
  if (program?.type !== 'drum') {
    const reason = 'Chop slices need a drum program to land on.';
    useUIStore.getState().pushToast(reason, 'warning');
    return 0;
  }
  const start = Math.max(PAD_INDEX_RANGE[0], Math.trunc(firstPadIndex));
  const placed = slices.filter((_, offset) => start + offset <= PAD_INDEX_RANGE[1]);
  if (placed.length === 0) return 0;

  commitAsOne('Assign chop slices', () => {
    const store = useProgramStore.getState();
    placed.forEach((sample, offset) => {
      const padIndex = start + offset;
      // Re-read each time: every upsertPad commits, so the previous slice's pad must be
      // visible to this one or the last write would carry a stale pad list.
      const current = useProgramStore.getState().programs[programId];
      const existing =
        current?.type === 'drum'
          ? current.pads.find((candidate) => candidate.padIndex === padIndex)
          : undefined;
      store.upsertPad(programId, padPlayingOnly(existing, padIndex, sample));
    });
  });

  const message =
    placed.length === slices.length
      ? `${placed.length} slices assigned from pad ${start + 1}.`
      : `${placed.length} of ${slices.length} slices assigned from pad ${start + 1}; the rest ran past pad 128.`;
  useUIStore.getState().pushToast(message, placed.length === slices.length ? 'success' : 'warning');
  return placed.length;
}

/**
 * Build a new drum program whose pads are the chop slices in order, add it, and make it
 * active (spec §8.5.4 "slices assign to … new program"). The program is assembled complete
 * before it reaches the store, so the whole thing is one "Add program" undo entry.
 *
 * Returns the new program's id, or null when nothing could be placed.
 */
export function createProgramFromSlices(name: string, slices: readonly SampleRow[]): string | null {
  const placed = slices.slice(0, PAD_INDEX_RANGE[1] - PAD_INDEX_RANGE[0] + 1);
  if (placed.length === 0) return null;
  const base = createDefaultDrumProgram(name);
  const program: DrumProgram = {
    ...base,
    pads: placed.map((sample, index) => padPlayingOnly(undefined, index, sample)),
  };
  const store = useProgramStore.getState();
  store.addProgram(program);
  store.setActiveProgram(program.id);
  store.setActivePad(0);
  const message = `${placed.length} slices assigned to a new program, ${name}.`;
  useUIStore.getState().pushToast(message, 'success');
  return program.id;
}
