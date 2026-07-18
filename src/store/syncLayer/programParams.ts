/**
 * Program-parameter sync (spec §4.3). Sound-design leaves (§6 filter, pad tune, amp/pan)
 * live inside the *voice*, not on a mixer channel, so an edit to a pad's data has to be
 * pushed to the voices currently sounding on that pad — otherwise a Q-Link turn or a
 * Program Edit knob would only be heard on the *next* hit (spec §10.3, §7.8).
 *
 * The diff is pure and lives here so it is unit-testable without a store or a graph
 * (spec §2.5), and it is address-based: it emits the same §7.8 registry paths the
 * automation engine uses, so both routes converge on one application path (spec §4.3).
 */
import { programParamPath } from '@/core/audio/params/registry';
import type { Pad, Program } from '@/core/project/schemas';
import { useProgramStore } from '../useProgramStore';
import type { SyncBridge, Unsubscribe } from './bridge';

/**
 * The §7.8 leaves that live *inside the voice* and so must be pushed to sounding voices.
 * `amp` and `pan` are deliberately absent: they belong to the pad's mixer channel (see
 * `voiceParams.isPerVoiceTarget`), which `useMixerStore` owns and already syncs. Pushing
 * them from here as well would move the graph while the mixer strip showed the old value.
 */
const SYNCED_LEAVES = ['filter.cutoff', 'filter.resonance', 'pitch'] as const;

export interface ParamChange {
  readonly targetPath: string;
  readonly value: number;
}

/** Read one synced leaf off a pad (mirrors the store's own leaf mapping, spec §6). */
function leafValue(pad: Pad, leaf: (typeof SYNCED_LEAVES)[number]): number {
  switch (leaf) {
    case 'filter.cutoff':
      return pad.filter.cutoff;
    case 'filter.resonance':
      return pad.filter.resonance;
    // Pad tune is stored per layer but moves as one pad value (spec §5.5).
    case 'pitch':
      return pad.layers[0]?.tuneSemitones ?? 0;
  }
}

/**
 * The registered parameter changes between two program maps (spec §4.3 diff-based).
 * Programs are replaced immutably per edit, so unchanged programs and pads are skipped by
 * reference before any field is compared.
 *
 * Envelope times are deliberately absent: an AHDSR is applied when a voice starts (spec
 * §6), so changing attack or release affects the next hit rather than a sounding one.
 */
export function changedPadLeaves(
  previous: Record<string, Program>,
  next: Record<string, Program>,
): ParamChange[] {
  const changes: ParamChange[] = [];
  for (const [programId, program] of Object.entries(next)) {
    const before = previous[programId];
    if (before === program || program.type !== 'drum' || before?.type !== 'drum') continue;
    const beforePads = new Map(before.pads.map((pad) => [pad.padIndex, pad]));
    for (const pad of program.pads) {
      const previousPad = beforePads.get(pad.padIndex);
      if (previousPad === undefined || previousPad === pad) continue;
      for (const leaf of SYNCED_LEAVES) {
        const value = leafValue(pad, leaf);
        if (value === leafValue(previousPad, leaf)) continue;
        changes.push({ targetPath: programParamPath(programId, pad.padIndex, leaf), value });
      }
    }
  }
  return changes;
}

export function subscribeProgramParamSync(bridge: SyncBridge): Unsubscribe {
  return useProgramStore.subscribe(
    (state) => state.programs,
    (next, previous) => {
      for (const change of changedPadLeaves(previous, next)) {
        bridge.applyParam(change.targetPath, change.value);
      }
    },
  );
}
