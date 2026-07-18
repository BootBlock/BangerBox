/**
 * Program sync subscriber (spec §4.3). Selecting a program publishes its per-pad §6 mixer
 * values as channel strips (spec §4.2), which is what makes the Mixer mode's "pads" tab
 * live: from that point a fader move is an ordinary mixer commit, flowing store → sync
 * layer → graph like any other channel (spec §3.1), rather than a value only readable
 * from the program payload.
 *
 * Strips are published only for pads that do not already have one, so re-selecting a
 * program never discards mixer edits made since it was opened.
 */
import { useMixerStore } from '../useMixerStore';
import { useProgramStore } from '../useProgramStore';
import type { SyncBridge, Unsubscribe } from './bridge';
import { padStripsForProgram } from './padStrips';

/** Publish the active program's pad strips into the mixer store (spec §4.2). */
function publishPadStrips(programId: string | null): void {
  if (programId === null) return;
  const program = useProgramStore.getState().programs[programId];
  const strips = padStripsForProgram(program);
  if (strips.length === 0) return;
  const existing = useMixerStore.getState().channels;
  for (const strip of strips) {
    if (existing[strip.id]) continue; // never clobber live mixer edits
    useMixerStore.getState().upsertChannel(strip);
  }
}

export function subscribeProgramSync(bridge: SyncBridge): Unsubscribe {
  return useProgramStore.subscribe(
    (state) => state.activeProgramId,
    (value) => {
      publishPadStrips(value);
      bridge.onActiveProgramChanged(value);
    },
  );
}
