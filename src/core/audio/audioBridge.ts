/**
 * Audio-graph bridge — the real {@link SyncBridge} (spec §4.3), the ONLY code that
 * touches audio nodes in response to store state (spec §3.1). Mixer changes ramp the
 * matching graph channel's params (spec §4.3 dezipper); mute/solo are evaluated as
 * solo-in-place computed mutes across the whole mixer (spec §5.2, {@link
 * computeEffectiveMutes}). Transport methods are effectively no-op for audio until the
 * scheduler worker lands (Phase 4, §7.1.3). Inserts rebuild the channel's serial chain
 * from slot state (spec §5.7).
 */
import { useMixerStore } from '@/store';
import type { InsertSlotState } from '@/core/project/schemas';
import type { SyncBridge } from '@/store/syncLayer';
import { parseParamTarget } from './params/registry';
import type { ChannelHandle } from './factory';
import type { MixerGraph } from './graph';
import { createInsert } from './inserts/insert';
import { computeEffectiveMutes } from './solo';

interface BridgeTarget {
  readonly graph: MixerGraph;
  readonly context: BaseAudioContext;
}

/** A bridge that can also flush the full current mixer state to the graph (start-up). */
export type AudioBridge = SyncBridge & {
  resyncAll: () => void;
  /** Apply a scheduled automation ramp to a registered target (spec §7.8). */
  applyAutomation: (targetPath: string, value: number, when: number, rampEnd: number) => void;
};

function applyInserts(context: BaseAudioContext, channel: ChannelHandle, inserts: readonly InsertSlotState[]): void {
  const handles = inserts
    .filter((slot) => slot.effectType !== null)
    .map((slot) => {
      const handle = createInsert(context, slot.effectType!, slot.params);
      handle.setEnabled(slot.enabled);
      return handle;
    });
  channel.setInserts(handles);
}

export function createAudioBridge({ graph, context }: BridgeTarget): AudioBridge {
  /** Re-evaluate solo-in-place and apply the resulting mutes to every graph channel. */
  const applyEffectiveMutes = (): void => {
    const mutes = computeEffectiveMutes(useMixerStore.getState().channels);
    const now = context.currentTime;
    for (const [id, muted] of Object.entries(mutes)) graph.getChannel(id)?.setMuted(muted, now);
  };

  return {
    setChannelLevel: (id, level) => graph.getChannel(id)?.setLevel(level, context.currentTime),
    setChannelPan: (id, pan) => graph.getChannel(id)?.setPan(pan, context.currentTime),
    // Any mute/solo change re-derives every channel's effective mute (spec §5.2).
    setChannelMute: () => applyEffectiveMutes(),
    setChannelSolo: () => applyEffectiveMutes(),
    setChannelSend: (id, index, level) =>
      graph.getChannel(id)?.setSendGain(index, level, context.currentTime),
    setChannelInserts: (id, inserts) => {
      const channel = graph.getChannel(id);
      if (channel) applyInserts(context, channel, inserts);
    },

    setTransportPlaying: () => {}, // scheduler worker — Phase 4 (spec §7.1.3)
    setTransportRecording: () => {},
    setBpm: () => {}, // synced-delay tempo map — Phase 4 (spec §7.9)
    onActiveProgramChanged: () => {}, // pad mixer-strip population — Phase 5 (spec §4.2)
    onQLinkModeChanged: () => {}, // Q-Link runtime — Phase 8 (spec §10.3)

    // Automation dispatch (spec §7.8): resolve the registered target and ramp its param.
    // `when` starts the dezipper ramp; native/insert params ramp identically to live edits.
    applyAutomation: (targetPath, value, when) => {
      const target = parseParamTarget(targetPath);
      if (!target) return;
      if (target.kind === 'programParam') {
        // STUB(phase-7): per-voice program-parameter automation (spec §6/§7.8) applies with
        // the Program mixer/automation surface; the address grammar is registered now (§7.8).
        return;
      }
      const channel = graph.getChannel(target.channelId);
      if (!channel) return;
      switch (target.kind) {
        case 'channelLevel':
          channel.setLevel(value, when);
          return;
        case 'channelPan':
          channel.setPan(value, when);
          return;
        case 'channelSend':
          channel.setSendGain(target.sendIndex, value, when);
          return;
        case 'insertParam':
          channel.setInsertParam(target.slot, target.param, value, when);
          return;
      }
    },

    resyncAll: () => {
      const channels = useMixerStore.getState().channels;
      const now = context.currentTime;
      for (const [id, strip] of Object.entries(channels)) {
        const channel = graph.getChannel(id);
        if (!channel) continue; // track/pad channels are built lazily on first use
        channel.setLevel(strip.level, now, false);
        channel.setPan(strip.pan, now, false);
        strip.sendLevels.forEach((level, i) => channel.setSendGain(i, level, now, false));
        applyInserts(context, channel, strip.inserts);
      }
      applyEffectiveMutes();
    },
  };
}
