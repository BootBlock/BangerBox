/**
 * The pad mixer-strip mirror (spec §4.2, §6, §8.5.6 — issue #133).
 *
 * §6 keeps a drum pad's level, pan, sends and insert slots inside the program payload, which
 * is what §9.3 `programs.payload` persists. §4.2 keeps the same values as a `pad:<programId>:
 * <padIndex>` channel strip, which is what §8.5.6's Pads tab edits and what the §4.3 sync
 * layer pushes to the graph. The strip is a PROJECTION of the payload, and a projection only
 * stays true if something maintains it in both directions:
 *
 *  - **§6 → §4.2.** Publish the active program's pads as strips. Without this the Pads tab is
 *    dead on a freshly loaded project — `resolvePath` finds no strip, so `setTransient` and
 *    `commit` both return before they write anything, and every fader, pan knob, send dial and
 *    slot picker on the tab does nothing at all until the user happens to switch program and
 *    back.
 *  - **§4.2 → §6.** Write an edited strip back into the pad. Without this `flushProgram`
 *    serialises a program the edit never reached, so the save reports success and stores the
 *    values the pad had before — issue #133 as filed.
 *
 * It is deliberately NOT part of `syncLayer/` (spec §4.3), which exists for store → audio
 * graph. This is store → store, exactly as `transportMirror` is, and mixing the two would
 * blur the rule that the sync layer is the only code allowed to touch audio nodes. The
 * publish half used to sit in `syncLayer/programSync` for want of anywhere else; it is here
 * now, so one module owns both directions of one mapping and neither can be forgotten when
 * §6 or §4.2 gains a field.
 *
 * **Only what each side changed is written.** `program:<id>.pad:<idx>.amp` and
 * `mixer.pad:<id>:<idx>.level` are two registered §7.8 addresses for one value, and a
 * mirror that copied whole strips would let the stale half of that pair revert the other.
 * `padStripEdit` reports the moved fields and nothing else, which is the rule `transportMirror`
 * states for the §4.2 tempo mirror.
 *
 * **`mute` and `solo` are not mirrored**, because §6's `Pad.mixer` defines no field for them
 * (level, pan and sendLevels are the whole of it). They stay session state on a pad strip,
 * where a track's own mute persists in the §9.3 `tracks.mixer` column. Adding them would be a
 * §6 schema change and a §13.6 halt, not a mirror change.
 *
 * **A keygroup program is out of scope by the same reading.** §6 gives it one program-scope
 * `mixer` and `inserts` rather than per-pad ones, `padStripsForProgram` publishes no strip for
 * it and §8.5.6 renders none, so there is no edit to lose — its strip is unreachable rather
 * than unpersisted, which is a different defect (issue #139).
 */
import { padStripEdit, padStripsForProgram } from '../padStrips';
import { combineUnsubscribers, type Unsubscribe } from '../syncLayer/bridge';
import { useMixerStore } from '../useMixerStore';
import { useProgramStore } from '../useProgramStore';
import type { ChannelStrip } from '@/core/project/schemas';

/** The program and pad a `pad:<programId>:<padIndex>` channel id addresses (spec §4.2). */
const PAD_CHANNEL_ID = /^pad:(.+):(\d+)$/;

function padChannelTarget(channelId: string): { programId: string; padIndex: number } | null {
  const match = PAD_CHANNEL_ID.exec(channelId);
  if (match === null) return null;
  return { programId: match[1]!, padIndex: Number(match[2]) };
}

/**
 * Publish the active program's pad strips (spec §4.2), never clobbering one already there.
 *
 * The guard is what makes re-running this free: a strip that exists is the live one, and
 * replacing it would discard the edit the other direction has just written back. It also
 * bounds the re-entrancy — an `upsertChannel` here re-enters through the `channels`
 * subscription below, finds every strip present and writes nothing.
 */
function publishPadStrips(): void {
  const { activeProgramId, programs } = useProgramStore.getState();
  if (activeProgramId === null) return;
  const strips = padStripsForProgram(programs[activeProgramId]);
  if (strips.length === 0) return;
  const mixer = useMixerStore.getState();
  const existing = mixer.channels;
  for (const strip of strips) {
    if (existing[strip.id]) continue;
    mixer.upsertChannel(strip);
  }
}

/** Write every strip edit back into the §6 pad that owns it (spec §6, §9.3). */
function writeBackPadStrips(
  channels: Record<string, ChannelStrip>,
  previous: Record<string, ChannelStrip>,
): void {
  const programs = useProgramStore.getState();
  for (const [channelId, strip] of Object.entries(channels)) {
    const before = previous[channelId];
    if (before === strip) continue; // unchanged reference — nothing moved
    const edit = padStripEdit(strip, before);
    if (edit === null) continue;
    const target = padChannelTarget(channelId);
    if (target === null) continue;
    programs.applyPadStripEdit(target.programId, target.padIndex, edit);
  }
}

/**
 * Keep the §6 payload and the §4.2 pad strips derived from each other. Call the returned
 * disposer on session teardown (spec §3.5 lens 5).
 *
 * Registration publishes once, matching the "initial full resync then narrow diffs" shape
 * `subscribeSequencerSync` and `subscribeTransportMirror` established.
 *
 * The publish is driven from the MIXER side as well as the program side, and that is not
 * belt-and-braces. §4.4 hydration calls `setPrograms` before `setChannels`, so a
 * program-side publish alone would write the new project's strips into the outgoing channel
 * map and `setChannels` would then wipe them; and `loadProject` on the project already open
 * re-selects the same `activeProgramId`, which a `subscribeWithSelector` selector does not
 * report as a change at all. Watching the map that has to hold the strips answers both.
 */
export function subscribePadStripMirror(): Unsubscribe {
  publishPadStrips();
  return combineUnsubscribers([
    useMixerStore.subscribe(
      (state) => state.channels,
      (channels, previous) => {
        writeBackPadStrips(channels, previous);
        publishPadStrips();
      },
    ),
    // A pad assigned while its program is already active gains a strip here (spec §8.5.7);
    // `programs` takes a new identity on every program write, including the §4.4 hydrate.
    useProgramStore.subscribe((state) => state.programs, publishPadStrips),
    useProgramStore.subscribe((state) => state.activeProgramId, publishPadStrips),
  ]);
}
