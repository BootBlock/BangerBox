/**
 * The mapping between a §6 program's own mixer values and its §4.2 channel strips, in both
 * directions (spec §4.2, §6, §8.5.6). §6 stores those values inside the program payload —
 * per pad for a drum program, once at PROGRAM scope for a keygroup — while the Mixer mode
 * edits *channel strips*. This is the single place that translates, so §8.5.6's Pads tab,
 * the §9.3 `programs.payload` and the graph agree on the channel id form
 * (`pad:<programId>:<padIndex>`) and on the values.
 *
 * Both directions live here deliberately: a write-back is the forward mapping run the other
 * way, and splitting the two is how the pair drifts as §6 or §4.2 gains a field.
 *
 * **A keygroup projects onto exactly ONE strip**, at {@link KEYGROUP_PAD_INDEX} (issue
 * #139). Its `mixer` and `inserts` have the same §6 shape a pad's do and its voices have
 * always merged into `pad:<programId>:0`, so this is the same projection of a
 * different §6 record rather than a second rule — which is why {@link withStripEdit} is one
 * function over both.
 *
 * Pure — no store or audio access — so the mapping is unit-testable (spec §2.5).
 */
import { KEYGROUP_PAD_INDEX, programChannelId } from '@/core/audio/programVoice';
import type { ChannelStrip, InsertSlotState, Pad, Program, SendLevels } from '@/core/project/schemas';

/**
 * The §6 record a §4.2 strip projects from: a drum {@link Pad}, or a whole keygroup
 * program. §6 gives both the same two members, which is what lets one mapping serve them.
 */
type StripSource = Pick<Pad, 'mixer' | 'inserts'>;

/** One §4.2 strip over a §6 record's mixer values (spec §4.2). */
function stripOf(channelId: string, source: StripSource): ChannelStrip {
  return {
    id: channelId,
    level: source.mixer.level,
    pan: source.mixer.pan,
    // §6 defines no `mute` or `solo` for either record, so both are session state on the
    // strip — see the module note in `padStripMirror`.
    mute: false,
    solo: false,
    sendLevels: [...source.mixer.sendLevels] as SendLevels,
    inserts: source.inserts,
  };
}

/**
 * Channel strips for a program's own §5.2 channels: one per assigned pad of a drum program,
 * or the single program-scope strip of a keygroup (spec §4.2, §6).
 */
export function padStripsForProgram(program: Program | undefined): ChannelStrip[] {
  if (!program) return [];
  if (program.type === 'keygroup') {
    return [stripOf(programChannelId(program.id, KEYGROUP_PAD_INDEX), program)];
  }
  return program.pads.map((pad) => stripOf(programChannelId(program.id, pad.padIndex), pad));
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
 * `mute` and `solo` are absent from the result because §6 has no field for them on either
 * record — see the module note in `padStripMirror`.
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

/**
 * Apply a {@link PadStripEdit} to the §6 record that owns the values, returning the SAME
 * record when nothing moves.
 *
 * One function over both §6 shapes rather than one each, because it is one rule: a drum
 * {@link Pad} and a keygroup program carry the same `mixer` and `inserts` members, so a
 * second copy could only ever drift from this one (issue #139).
 */
export function withStripEdit<T extends StripSource>(source: T, edit: PadStripEdit): T {
  const level = edit.level ?? source.mixer.level;
  const pan = edit.pan ?? source.mixer.pan;
  const sendLevels = edit.sendLevels ?? source.mixer.sendLevels;
  const inserts = edit.inserts ?? source.inserts;
  if (
    level === source.mixer.level &&
    pan === source.mixer.pan &&
    sendLevels === source.mixer.sendLevels &&
    inserts === source.inserts
  ) {
    return source;
  }
  return { ...source, mixer: { level, pan, sendLevels }, inserts };
}
