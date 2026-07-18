/**
 * Pad mixer-strip derivation (spec §4.2, §8.5.6). A drum program stores each pad's mixer
 * values inside its §6 payload; the Mixer mode edits *channel strips*. This is the single
 * mapping between the two, so the Mixer's "pads" tab and the graph agree on both the
 * channel id form (`pad:<programId>:<padIndex>`) and the values.
 *
 * Pure — no store or audio access — so the mapping is unit-testable (spec §2.5).
 */
import type { ChannelStrip, Program } from '@/core/project/schemas';

/**
 * Channel strips for every assigned pad of a drum program. Keygroup programs have a single
 * program-scope mixer rather than per-pad strips (spec §6), so they contribute none.
 */
export function padStripsForProgram(program: Program | undefined): ChannelStrip[] {
  if (!program || program.type !== 'drum') return [];
  return program.pads.map((pad) => ({
    id: `pad:${program.id}:${pad.padIndex}`,
    level: pad.mixer.level,
    pan: pad.mixer.pan,
    mute: false,
    solo: false,
    sendLevels: [...pad.mixer.sendLevels] as ChannelStrip['sendLevels'],
    inserts: pad.inserts,
  }));
}
