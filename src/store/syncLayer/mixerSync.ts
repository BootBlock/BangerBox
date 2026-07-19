/**
 * Mixer sync subscriber (spec §4.3). Watches the channel-strip record and forwards
 * only the fields that actually changed to the graph bridge (diff-based, spec §4.3).
 * Solo is forwarded as a flag here; the audio bridge is what evaluates solo-in-place
 * as computed mutes across the whole mixer (spec §5.2).
 */
import { useMixerStore } from '../useMixerStore';
import type { SyncBridge, Unsubscribe } from './bridge';

export function subscribeMixerSync(bridge: SyncBridge): Unsubscribe {
  return useMixerStore.subscribe(
    (state) => state.channels,
    (channels, previous) => {
      for (const [id, strip] of Object.entries(channels)) {
        const before = previous[id];
        if (before === strip) continue; // unchanged reference — nothing to apply
        if (before === undefined || before.level !== strip.level) bridge.setChannelLevel(id, strip.level);
        if (before === undefined || before.pan !== strip.pan) bridge.setChannelPan(id, strip.pan);
        if (before === undefined || before.mute !== strip.mute) bridge.setChannelMute(id, strip.mute);
        if (before === undefined || before.solo !== strip.solo) bridge.setChannelSolo(id, strip.solo);
        for (let i = 0; i < strip.sendLevels.length; i++) {
          if (before === undefined || before.sendLevels[i] !== strip.sendLevels[i]) {
            bridge.setChannelSend(id, i, strip.sendLevels[i]!);
          }
        }
        if (before === undefined || before.inserts !== strip.inserts) {
          bridge.setChannelInserts(id, strip.inserts);
        }
      }
      // A strip that has left the record belongs to a deleted entity (spec §5.3); its
      // graph nodes go with it, or they stay wired to master for the rest of the session.
      for (const id of Object.keys(previous)) {
        if (!(id in channels)) bridge.removeChannel(id);
      }
    },
  );
}
