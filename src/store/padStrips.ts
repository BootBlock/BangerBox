/**
 * The mapping between a §6 pad and its §4.2 channel strip, in both directions (spec §4.2,
 * §6, §8.5.6). A drum program stores each pad's mixer values and insert slots inside its §6
 * payload; the Mixer mode edits *channel strips*. This is the single place that translates,
 * so the Mixer's "pads" tab, the §9.3 `programs.payload` and the graph agree on the channel
 * id form (`pad:<programId>:<padIndex>`) and on the values.
 *
 * Both directions live here deliberately: a write-back is the forward mapping run the other
 * way, and splitting the two is how the pair drifts as §6 or §4.2 gains a field.
 *
 * Pure — no store or audio access — so the mapping is unit-testable (spec §2.5).
 */
import type { ChannelStrip, InsertSlotState, Pad, Program, SendLevels } from '@/core/project/schemas';

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
    sendLevels: [...pad.mixer.sendLevels] as SendLevels,
    inserts: pad.inserts,
  }));
}

/**
 * The §6 fields one strip edit moved — the reverse of {@link padStripsForProgram}.
 *
 * An absent field means *the strip did not move it*, never *the strip holds nothing*. The
 * distinction is the whole of the rule: `program:<id>.pad:<idx>.amp` and
 * `mixer.pad:<id>:<idx>.level` are two registered §7.8 addresses for one value (spec §7.8),
 * and only one of them is republished into the other's store. A write-back that copied every
 * field would therefore undo a program-side edit the strip has not seen, on the next
 * unrelated touch of that strip's pan. Reporting only what changed is the same rule
 * `transportMirror` follows for the §4.2 tempo mirror and `mixerSync` for the graph.
 *
 * `mute` and `solo` are absent from the result because §6's `Pad.mixer` has no field for
 * them — see the module note in `padStripMirror`.
 */
export interface PadStripEdit {
  readonly level?: number;
  readonly pan?: number;
  readonly sendLevels?: SendLevels;
  readonly inserts?: InsertSlotState[];
}

/**
 * What `strip` changed since `previous`, or null when it changed nothing §6 records.
 *
 * A strip with no `previous` has just ENTERED the store — published by the mirror or restored
 * by a §4.4 hydrate — so it carries no edit at all, and returning one would write the
 * projection straight back over the payload it came from.
 */
export function padStripEdit(strip: ChannelStrip, previous: ChannelStrip | undefined): PadStripEdit | null {
  if (previous === undefined || previous === strip) return null;
  const edit: {
    level?: number;
    pan?: number;
    sendLevels?: SendLevels;
    inserts?: InsertSlotState[];
  } = {};
  if (previous.level !== strip.level) edit.level = strip.level;
  if (previous.pan !== strip.pan) edit.pan = strip.pan;
  if (strip.sendLevels.some((level, index) => previous.sendLevels[index] !== level)) {
    edit.sendLevels = [...strip.sendLevels] as SendLevels;
  }
  // Identity, exactly as `mixerSync` diffs the same field: every §8.5.6 slot action writes a
  // new array, and `withCompleteInserts` hands the same one back when it filled nothing in.
  if (previous.inserts !== strip.inserts) edit.inserts = [...strip.inserts];
  return Object.keys(edit).length === 0 ? null : edit;
}

/** Apply a {@link PadStripEdit} to a §6 pad, returning the same pad when nothing moves. */
export function padWithStripEdit(pad: Pad, edit: PadStripEdit): Pad {
  const level = edit.level ?? pad.mixer.level;
  const pan = edit.pan ?? pad.mixer.pan;
  const sendLevels = edit.sendLevels ?? pad.mixer.sendLevels;
  const inserts = edit.inserts ?? pad.inserts;
  if (
    level === pad.mixer.level &&
    pan === pad.mixer.pan &&
    sendLevels === pad.mixer.sendLevels &&
    inserts === pad.inserts
  ) {
    return pad;
  }
  return { ...pad, mixer: { level, pan, sendLevels }, inserts };
}
