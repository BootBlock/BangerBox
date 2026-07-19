/**
 * Audio-graph bridge — the real {@link SyncBridge} (spec §4.3), the ONLY code that
 * touches audio nodes in response to store state (spec §3.1). Mixer changes ramp the
 * matching graph channel's params (spec §4.3 dezipper); mute/solo are evaluated as
 * solo-in-place computed mutes across the whole mixer (spec §5.2, {@link
 * computeEffectiveMutes}). Inserts rebuild the channel's serial chain from slot state
 * (spec §5.7). The transport and mode hooks are deliberately inert here — those concerns
 * belong to the scheduler worker and `core/midi`, not the graph (see {@link SyncBridge}).
 */
import { useMixerStore } from '@/store';
import type { InsertSlotState } from '@/core/project/schemas';
import type { SyncBridge } from '@/store/syncLayer';
import { parseParamTarget } from './params/registry';
import { isPerVoiceTarget, padKeyFor, programParamChange } from './voiceParams';
import type { ChannelHandle } from './factory';
import type { MixerGraph } from './graph';
import type { VoicePool } from './voicePool';
import { createInsert } from './inserts/insert';
import { computeEffectiveMutes } from './solo';

interface BridgeTarget {
  readonly graph: MixerGraph;
  readonly context: BaseAudioContext;
  /**
   * The voice pool, for program-scope automation that acts on sounding voices (spec §6,
   * §7.8). Supplied lazily: the engine constructs the bridge and the pool together, and
   * offline/unit bridges legitimately have no pool.
   */
  readonly voicePool?: () => VoicePool | null;
}

/** A bridge that can also flush the full current mixer state to the graph (start-up). */
export type AudioBridge = SyncBridge & {
  resyncAll: () => void;
  /** Apply a scheduled automation ramp to a registered target (spec §7.8). */
  applyAutomation: (targetPath: string, value: number, when: number, rampEnd: number) => void;
};

function applyInserts(
  context: BaseAudioContext,
  channel: ChannelHandle,
  inserts: readonly InsertSlotState[],
): void {
  const handles = inserts
    .filter((slot) => slot.effectType !== null)
    .map((slot) => {
      const handle = createInsert(context, slot.effectType!, slot.params);
      handle.setEnabled(slot.enabled);
      return handle;
    });
  channel.setInserts(handles);
}

export function createAudioBridge({ graph, context, voicePool = () => null }: BridgeTarget): AudioBridge {
  /** Re-evaluate solo-in-place and apply the resulting mutes to every graph channel. */
  const applyEffectiveMutes = (): void => {
    const mutes = computeEffectiveMutes(useMixerStore.getState().channels);
    const now = context.currentTime;
    for (const [id, muted] of Object.entries(mutes)) graph.getChannel(id)?.setMuted(muted, now);
  };

  const bridge: AudioBridge = {
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
    // Master and the returns are fixtures of the graph (spec §5.2) — they have no strip to
    // lose, so an id addressing one is ignored rather than torn out from under the mix.
    removeChannel: (id) => {
      if (id.startsWith('track:')) graph.removeTrackChannel(id.slice('track:'.length));
      else if (id.startsWith('pad:')) graph.removePadChannel(id);
    },

    // Inert by design — the graph is not the owner of any of these (spec §3.1):
    setTransportPlaying: () => {}, // the scheduler worker owns transport (spec §7.1.3)
    setTransportRecording: () => {},
    setBpm: () => {}, // no synced-delay tempo map to feed yet — see issue #70 (spec §5.7)
    onActiveProgramChanged: () => {}, // `syncLayer/padStrips` populates pad strips (spec §4.2)
    onQLinkModeChanged: () => {}, // `core/midi/qlinkRuntime` owns Q-Link mode (spec §10.3)

    // Automation dispatch (spec §7.8): resolve the registered target and ramp its param.
    // `when` starts the dezipper ramp; native/insert params ramp identically to live edits.
    // The sync layer's immediate form of the same application (spec §4.3).
    applyParam: (targetPath, value) => {
      const now = context.currentTime;
      bridge.applyAutomation(targetPath, value, now, now);
    },

    applyAutomation: (targetPath, value, when) => {
      const target = parseParamTarget(targetPath);
      if (!target) return;
      if (target.kind === 'programParam') {
        // Program-scope leaves split two ways (spec §6, §7.8): sound-design parameters act
        // on each sounding voice of the pad, while amp/pan are the pad channel's own
        // strip values — see `voiceParams` for the mapping.
        const change = programParamChange(target.param, value);
        if (!change) return;
        const padChannelId = `pad:${target.programId}:${target.padIndex}`;
        if (isPerVoiceTarget(change.target)) {
          voicePool()?.applyPadParam(
            padKeyFor(target.programId, target.padIndex),
            change.target,
            change.value,
            when,
          );
          return;
        }
        const padChannel = graph.getChannel(padChannelId);
        if (!padChannel) return;
        if (change.target === 'channelLevel') padChannel.setLevel(change.value, when);
        else padChannel.setPan(change.value, when);
        return;
      }
      if (target.kind === 'transportParam') {
        // Transport parameters (tempo, swing) are the scheduler's, not the graph's — they
        // reach it through the transport store's own sync subscriber (spec §7.1.3).
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

  return bridge;
}
