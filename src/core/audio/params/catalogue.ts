/**
 * Automatable-parameter catalogue — spec §7.8, §8.5.2, §8.5.10, §8.5.11. The registry
 * next door owns the address *grammar*; this owns the question every picker actually
 * asks, which is "what can I automate on this thing right now". Both the Grid's
 * automation lane picker and the XYFX axis pickers read from here, so neither can offer
 * an address the registry would refuse and the two can never drift apart.
 *
 * Pure and DOM-free: it takes the live store data as arguments rather than reading the
 * stores, so it is trivially unit-testable (spec §2.5) and callable from an offline
 * render.
 *
 * Every path is built through the registry's own builders and gated through
 * {@link isAutomatable}, never hand-formatted (spec §13.6 naming freeze).
 */
import type { ChannelStrip, Program, Range } from '@/core/project/schemas';
import { EFFECT_PARAM_RANGES } from '@/core/audio/inserts/effectParams';
import {
  channelLevelPath,
  channelPanPath,
  channelSendPath,
  insertParamPath,
  isAutomatable,
  programParamPath,
  PROGRAM_PARAM_RANGES,
  targetRange,
  targetUnit,
  type ParamTarget,
} from './registry';

/** One offerable address: the canonical §7.8 path and the words a picker shows for it. */
export interface AutomatableParam {
  readonly path: string;
  readonly label: string;
}

/** Send taps per channel (spec §1.3.1: 4 returns). */
const SEND_COUNT = 4;

function offer(list: AutomatableParam[], path: string, label: string): void {
  // The registry is the gate, not this list (spec §7.8) — an address it does not know
  // never reaches a picker, so no picker can create a point the store would refuse.
  if (isAutomatable(path)) list.push({ path, label });
}

/**
 * Every automatable address on one mixer channel (spec §7.8): its level, pan and four
 * sends, plus the parameters of whatever effects occupy its insert slots. Empty slots
 * contribute nothing — an address for a slot holding no effect resolves to no
 * `AudioParam`, so offering it would be a dead control (spec §3.4).
 *
 * `channelName` is what the user calls the channel; the raw `track:<uuid>` id is
 * unreadable, and a picker of forty rows of UUID is not a picker.
 */
export function channelAutomatableParams(
  channelId: string,
  strip: ChannelStrip,
  channelName: string,
): AutomatableParam[] {
  const params: AutomatableParam[] = [];
  offer(params, channelLevelPath(channelId), `${channelName} · level`);
  offer(params, channelPanPath(channelId), `${channelName} · pan`);
  for (let index = 0; index < SEND_COUNT; index += 1) {
    offer(params, channelSendPath(channelId, index), `${channelName} · send ${index + 1}`);
  }
  strip.inserts.forEach((slot, slotIndex) => {
    if (slot.effectType === null) return;
    // Slots are addressed 1-based in the §7.8 grammar (`slot2`).
    const slotNumber = slotIndex + 1;
    const names = [...Object.keys(EFFECT_PARAM_RANGES[slot.effectType])];
    // Every insert exposes the wrapper's own dry/wet mix (spec §5.7), which the
    // per-effect table only lists for the effects whose own params include one.
    if (!names.includes('mix')) names.push('mix');
    for (const param of names) {
      offer(
        params,
        insertParamPath(channelId, slotNumber, param),
        `${channelName} · ${slot.effectType} ${slotNumber} ${param}`,
      );
    }
  });
  return params;
}

/**
 * Every automatable sound-design address on a drum program's assigned pads (spec §6,
 * §7.8). Keygroup programs carry the same surface at *program* scope rather than per pad,
 * and §7.8's address grammar has no program-scope form for it, so they contribute nothing
 * here rather than being addressed through a pad index they do not have.
 */
export function programAutomatableParams(program: Program): AutomatableParam[] {
  if (program.type !== 'drum') return [];
  const params: AutomatableParam[] = [];
  for (const pad of [...program.pads].sort((a, b) => a.padIndex - b.padIndex)) {
    const padName = pad.name || `Pad ${pad.padIndex + 1}`;
    for (const leaf of Object.keys(PROGRAM_PARAM_RANGES)) {
      offer(params, programParamPath(program.id, pad.padIndex, leaf), `${padName} · ${leaf}`);
    }
  }
  return params;
}

/**
 * The value range a target actually holds, resolved against the live mixer (spec §7.8).
 *
 * {@link targetRange} alone cannot answer for an insert parameter: its bounds belong to the
 * EFFECT in the slot (spec §5.7), and passing no `effectType` returns null for every insert
 * param but `mix`. A caller that then falls back to 0..1 draws and clamps a delay time of
 * 1–2000 ms into a range it can never leave — so the lookup lives here, once, and every
 * picker and editor calls it rather than re-deriving the slot each time.
 */
export function resolveTargetRange(
  target: ParamTarget,
  channels: Record<string, ChannelStrip>,
): Range | null {
  if (target.kind !== 'insertParam') return targetRange(target);
  // Slots are addressed 1-based in the §7.8 grammar (`slot2`).
  const effectType = channels[target.channelId]?.inserts[target.slot - 1]?.effectType;
  return targetRange(target, effectType ?? undefined);
}

/**
 * The unit a target's value is read in, resolved against the live mixer (spec §8.2) — the
 * sibling of {@link resolveTargetRange}, and it exists for the same reason: an insert
 * parameter's unit belongs to the EFFECT in the slot, so a caller holding only the address
 * cannot answer. A picker resolving the range here and the unit somewhere else would be one
 * edit away from drawing a delay time in milliseconds and announcing it as a fraction
 * (issue #35).
 */
export function resolveTargetUnit(target: ParamTarget, channels: Record<string, ChannelStrip>): string {
  if (target.kind !== 'insertParam') return targetUnit(target);
  // Slots are addressed 1-based in the §7.8 grammar (`slot2`).
  const effectType = channels[target.channelId]?.inserts[target.slot - 1]?.effectType;
  return targetUnit(target, effectType ?? undefined);
}
