/**
 * Audio-graph bridge — the real {@link SyncBridge} (spec §4.3), the ONLY code that
 * touches audio nodes in response to store state (spec §3.1). Mixer changes ramp the
 * matching graph channel's params (spec §4.3 dezipper); mute/solo are evaluated as
 * solo-in-place computed mutes across the whole mixer (spec §5.2, {@link
 * computeEffectiveMutes}). Inserts rebuild the channel's serial chain from slot state
 * (spec §5.7). Tempo reaches the graph because the §5.7 synced delay is a graph parameter;
 * the remaining transport and mode hooks are deliberately inert here — those concerns
 * belong to the scheduler worker and `core/midi`, not the graph (see {@link SyncBridge}).
 */
import { useMixerStore, useTransportStore } from '@/store';
import type { ChannelStrip, InsertSlotState } from '@/core/project/schemas';
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
  /**
   * Flush every §4.2 strip onto the channels the graph already holds (start-up, and the
   * §9.5 bounce's one pass over the offline graph).
   *
   * `includeChannel` exists for the §9.5 stem, which §9.5 places "post-insert, pre-master":
   * the render leaves the master strip out and the master bus keeps the unity pass-through
   * `createChannelStrip` builds. Excluding it by not applying it, rather than by rewiring the
   * graph, keeps §5.2's topology identical in every render — `bouncePlan` owns the rule, and
   * the §7.8 automation pass reads the same predicate so a lane cannot ride a fader the
   * static pass deliberately left alone.
   */
  resyncAll: (includeChannel?: (channelId: string) => boolean) => void;
  /**
   * Apply the §4.2 strip and the §5.2 effective mute to ONE freshly built channel.
   *
   * A pad channel is realised per track (issue #141), so a second track playing the same
   * program builds its instance mid-session — after `resyncAll` has run and after any edit
   * the strip has had. Seeding just that instance is what {@link AudioBridge.resyncAll}
   * cannot do: rebuilding the insert chain of a realisation that is already sounding would
   * glitch it. Does nothing where the store holds no strip for the id, which is every pad of
   * a program that is not the active one — there the §6 payload is the only value there is.
   */
  seedChannel: (channel: ChannelHandle) => void;
  /** Apply a scheduled automation ramp to a registered target (spec §7.8). */
  applyAutomation: (targetPath: string, value: number, when: number, rampEnd: number) => void;
};

/** Write one §4.2 strip onto one graph channel, without the §4.3 dezipper (spec §4.3). */
function applyStrip(
  context: BaseAudioContext,
  channel: ChannelHandle,
  strip: ChannelStrip,
  now: number,
): void {
  channel.setLevel(strip.level, now, false);
  channel.setPan(strip.pan, now, false);
  strip.sendLevels.forEach((level, i) => channel.setSendGain(i, level, now, false));
  applyInserts(context, channel, strip.inserts);
}

function applyInserts(
  context: BaseAudioContext,
  channel: ChannelHandle,
  inserts: readonly InsertSlotState[],
): void {
  // A freshly built insert starts at the tempo the transport is already at, so a synced
  // delay (spec §5.7) is in time from its first repeat rather than from the next tempo edit.
  const bpm = useTransportStore.getState().bpm;
  // One handle per §4.2 slot, `null` for an empty one, so the graph's slot list is the
  // store's slot list and a §7.8 `slotN` address means the same thing on both sides. The
  // chain used to be compacted, which shifted every effect behind an empty slot out from
  // under its own address (issue #134).
  const handles = inserts.map((slot) => {
    if (slot.effectType === null) return null;
    const handle = createInsert(context, slot.effectType, slot.params, bpm);
    handle.setEnabled(slot.enabled);
    return handle;
  });
  channel.setInserts(handles);
}

export function createAudioBridge({ graph, context, voicePool = () => null }: BridgeTarget): AudioBridge {
  /**
   * Re-evaluate solo-in-place and apply the resulting mutes to every graph channel.
   *
   * The solo evaluation always sees the WHOLE mixer, even when `includeChannel` narrows what
   * is written: solo-in-place is a statement about the other strips, so judging it on a subset
   * would make a §9.5 stem of a soloed track silence itself.
   */
  const applyEffectiveMutes = (includeChannel: (channelId: string) => boolean = () => true): void => {
    const mutes = computeEffectiveMutes(useMixerStore.getState().channels);
    const now = context.currentTime;
    for (const [id, muted] of Object.entries(mutes)) {
      if (!includeChannel(id)) continue;
      for (const channel of graph.channelsFor(id)) channel.setMuted(muted, now);
    }
  };

  const bridge: AudioBridge = {
    // One §4.2 strip, N realisations (issue #141): a pad channel exists once per track that
    // plays the program, and every write below addresses the STRIP, so it reaches all of them.
    setChannelLevel: (id, level) => {
      for (const channel of graph.channelsFor(id)) channel.setLevel(level, context.currentTime);
    },
    setChannelPan: (id, pan) => {
      for (const channel of graph.channelsFor(id)) channel.setPan(pan, context.currentTime);
    },
    // Any mute/solo change re-derives every channel's effective mute (spec §5.2).
    setChannelMute: () => applyEffectiveMutes(),
    setChannelSolo: () => applyEffectiveMutes(),
    setChannelSend: (id, index, level) => {
      for (const channel of graph.channelsFor(id)) {
        channel.setSendGain(index, level, context.currentTime);
      }
    },
    setChannelInserts: (id, inserts) => {
      for (const channel of graph.channelsFor(id)) applyInserts(context, channel, inserts);
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
    // spec §5.7: the delay's synced division follows the transport tempo. This is the one
    // transport value the graph does own a copy of, because a `DelayNode`'s time is a graph
    // parameter, not a scheduler one.
    setBpm: (bpm) => graph.setTempo(bpm, context.currentTime),
    onQLinkModeChanged: () => {}, // `core/midi/qlinkRuntime` owns Q-Link mode (spec §10.3)

    // Automation dispatch (spec §7.8): resolve the registered target and ramp its param.
    // `when` starts the dezipper ramp; native/insert params ramp identically to live edits.
    // The sync layer's immediate form of the same application (spec §4.3).
    applyParam: (targetPath, value) => {
      const now = context.currentTime;
      bridge.applyAutomation(targetPath, value, now, now);
    },

    /**
     * The §7.1.3 `rampEnd` is deliberately NOT consumed, and the parameter stays in the
     * signature because the protocol carries it (spec §7.1.3, §7.8).
     *
     * Every write below goes through the §4.3 dezipper, which settles over `PARAM_RAMP_MS`.
     * Gliding across the whole window instead is not expressible for half the targets: pan
     * and every §5.7 effect core ramp with `setTargetAtTime`, which has no arrival time at
     * all — its shape is a settle, not a ramp. Making the automation window the one writer
     * to these params with a different §4.3 shape, for half of them only, would be worse than
     * arriving early: `PARAM_RAMP_MS` (10 ms) is shorter than `SCHEDULER_INTERVAL_MS` (25 ms),
     * so the param holds the window's OWN value for the remainder rather than lagging it.
     * The §9.5 bounce emits the same windows through the same helpers, so what it renders is
     * what live playback sounds like (issue #134).
     */
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
        for (const padChannel of graph.channelsFor(padChannelId)) {
          if (change.target === 'channelLevel') padChannel.setLevel(change.value, when);
          else padChannel.setPan(change.value, when);
        }
        return;
      }
      if (target.kind === 'transportParam') {
        // Transport parameters (tempo, swing) are the scheduler's, not the graph's — they
        // reach it through the transport store's own sync subscriber (spec §7.1.3).
        return;
      }
      for (const channel of graph.channelsFor(target.channelId)) {
        switch (target.kind) {
          case 'channelLevel':
            channel.setLevel(value, when);
            break;
          case 'channelPan':
            channel.setPan(value, when);
            break;
          case 'channelSend':
            channel.setSendGain(target.sendIndex, value, when);
            break;
          case 'insertParam':
            channel.setInsertParam(target.slot, target.param, value, when);
            break;
        }
      }
    },

    resyncAll: (includeChannel = () => true) => {
      const channels = useMixerStore.getState().channels;
      const now = context.currentTime;
      for (const [id, strip] of Object.entries(channels)) {
        if (!includeChannel(id)) continue;
        // Track/pad channels are built lazily on first use, and a pad has one realisation
        // per track playing its program (issue #141) — so this is 0..N, never exactly 1.
        for (const channel of graph.channelsFor(id)) applyStrip(context, channel, strip, now);
      }
      applyEffectiveMutes(includeChannel);
    },

    seedChannel: (channel) => {
      const now = context.currentTime;
      const strip = useMixerStore.getState().channels[channel.id];
      if (strip !== undefined) applyStrip(context, channel, strip, now);
      // The §5.2 mute is derived from the WHOLE mixer, so it is read even where the strip
      // itself is absent: a soloed track elsewhere silences this realisation from its first
      // note rather than from the next mute edit.
      const muted = computeEffectiveMutes(useMixerStore.getState().channels)[channel.id] ?? false;
      channel.setMuted(muted, now);
    },
  };

  return bridge;
}
