/**
 * Mixer graph assembly — spec §5.2 (Strict Signal Hierarchy). Owns the fixed
 * infrastructure (master bus, 4 return channels, monitor bus) and the dynamic channel
 * strips (per-track, per-pad) created on demand. Enforces the topology's edge cases:
 * returns carry no sends (feedback-safe by construction, §5.2), and the monitor bus
 * (metronome + preview) merges into `destination` AFTER the master inserts so the click
 * and auditioning are never coloured by master FX (§5.9).
 *
 * A §4.2 channel id NAMES a strip; the graph may hold SEVERAL channels under one name.
 * That is the whole of issue #141. A `pad:<programId>:<padIndex>` id carries no track, and
 * §5.2 stage 5 says "all pad outputs of the program ON A TRACK merge into the track input"
 * — so two tracks playing one program each need their own realisation of that pad, or the
 * second track's voices arrive at the first track's input and its own fader, pan, mute,
 * solo, sends and inserts are bypassed for every pad the two share. A pad channel is
 * therefore keyed by (channel id, track id) here, while the STRIP that supplies its values
 * stays per program: one §6 `Pad` record, one §4.2 strip, one §7.8 address, N realisations.
 * {@link MixerGraph.channelsFor} is what makes the difference invisible to every writer.
 */
import {
  createMasterBus,
  createPadChannel,
  createReturnChannel,
  createTrackChannel,
  type ChannelHandle,
} from './factory';

/** Number of global send/return channels (spec §1.3.1). */
const RETURN_COUNT = 4;

/** A channel the graph holds, and whether this call is what built it (spec §5.2, §5.3). */
export interface EnsuredChannel {
  readonly channel: ChannelHandle;
  /**
   * True only for the call that created the channel, so the caller seeds it exactly once.
   * The graph reports it rather than the caller remembering: a caller's own "already seeded"
   * set outlives {@link MixerGraph.removePadChannel} and
   * {@link MixerGraph.removeTrackChannel}, and a rebuilt channel would then keep the §4.2
   * defaults `createChannelStrip` gives it.
   */
  readonly created: boolean;
}

export class MixerGraph {
  readonly master: ChannelHandle;
  readonly returns: readonly ChannelHandle[];
  /** Metronome + Browser-mode audition merge here, post master inserts (spec §5.9). */
  readonly monitorBus: GainNode;

  private readonly tracks = new Map<string, ChannelHandle>();
  /** `pad:<prog>:<idx>` → trackId → that track's realisation of the strip (issue #141). */
  private readonly pads = new Map<string, Map<string, ChannelHandle>>();

  constructor(private readonly context: BaseAudioContext) {
    this.master = createMasterBus(context);
    this.master.output.connect(context.destination);

    const returns: ChannelHandle[] = [];
    for (let i = 0; i < RETURN_COUNT; i++) {
      const channel = createReturnChannel(context, i);
      channel.output.connect(this.master.input); // returns merge into master (stage 8)
      returns.push(channel);
    }
    this.returns = returns;

    this.monitorBus = context.createGain();
    this.monitorBus.connect(context.destination); // parallel to master (spec §5.9)
  }

  /**
   * The track channel for `trackId` (spec §5.2 stages 5–7), created and wired to master +
   * returns if absent.
   *
   * A track channel is built lazily, on the track's first note — long after the one
   * `resyncAll` that `startAudioEngine` runs, and `mixerSync` only pushes what CHANGED. So
   * `created` matters here for the same reason it does for a pad: nothing else will ever
   * put the §4.2 strip the project was loaded with onto this channel.
   */
  ensureTrackChannel(trackId: string): EnsuredChannel {
    const channelId = `track:${trackId}`;
    const existing = this.tracks.get(channelId);
    if (existing) return { channel: existing, created: false };
    const channel = createTrackChannel(this.context, trackId); // id = `track:<trackId>`
    channel.output.connect(this.master.input);
    this.wireSends(channel);
    this.tracks.set(channelId, channel);
    return { channel, created: true };
  }

  /**
   * `trackId`'s realisation of the pad channel `channelId` (`pad:<prog>:<idx>`), created and
   * merged into that track's input (spec §5.2 stage 5) with its sends wired to the returns.
   *
   * `trackId` is passed explicitly rather than inferred from `trackInput`, because it is the
   * other half of the key: a second track playing the same program gets its OWN instance
   * here, and the two never share a node (issue #141).
   */
  ensurePadChannel(channelId: string, trackId: string, trackInput: AudioNode): EnsuredChannel {
    let byTrack = this.pads.get(channelId);
    if (byTrack === undefined) {
      byTrack = new Map<string, ChannelHandle>();
      this.pads.set(channelId, byTrack);
    }
    const existing = byTrack.get(trackId);
    if (existing) return { channel: existing, created: false };
    const channel = createPadChannel(this.context, channelId);
    channel.output.connect(trackInput);
    this.wireSends(channel);
    byTrack.set(trackId, channel);
    return { channel, created: true };
  }

  /**
   * Every channel the §4.2 id `channelId` names (spec §4.2 channel ids), or an empty list.
   *
   * One for the master, a return or a track; one PER TRACK playing the program for a pad. A
   * §4.2 strip write and a §7.8 automation ramp both address the strip, so both reach every
   * realisation of it — one fader, one address, one persisted record (issue #141).
   */
  channelsFor(channelId: string): readonly ChannelHandle[] {
    if (channelId === 'master') return [this.master];
    if (channelId.startsWith('return:')) {
      const channel = this.returns[Number(channelId.slice('return:'.length))];
      return channel ? [channel] : [];
    }
    const track = this.tracks.get(channelId);
    if (track) return [track];
    const byTrack = this.pads.get(channelId);
    return byTrack ? [...byTrack.values()] : [];
  }

  /** Every live channel strip (master, returns, tracks, pads) — for solo evaluation. */
  allChannels(): ChannelHandle[] {
    const pads: ChannelHandle[] = [];
    for (const byTrack of this.pads.values()) pads.push(...byTrack.values());
    return [this.master, ...this.returns, ...this.tracks.values(), ...pads];
  }

  /**
   * Push a tempo change to every insert on every strip (spec §7.2). Only the §5.7 synced
   * delay acts on it today; the fan-out lives here rather than in the bridge so a strip
   * created later cannot be missed — the bridge holds no list of strips, the graph does.
   */
  setTempo(bpm: number, when: number): void {
    for (const channel of this.allChannels()) channel.setInsertTempo(bpm, when);
  }

  /**
   * Destroy every realisation of a pad channel (program change / pad clear) — spec §5.3
   * routes through here. The strip has left the store, so no track's copy of it survives.
   */
  removePadChannel(channelId: string): void {
    const byTrack = this.pads.get(channelId);
    if (!byTrack) return;
    for (const channel of byTrack.values()) channel.destroy();
    this.pads.delete(channelId);
  }

  /**
   * Destroy a track channel (track delete) — spec §5.3.
   *
   * The track's OWN pad realisations go with it. They are connected to the input node this
   * destroys, so leaving them would be an orphaned node on a dead branch whose sends still
   * feed the returns (spec §3.2) — and the shared-channel form of that was the second half
   * of issue #141: deleting one track silenced the other.
   */
  removeTrackChannel(trackId: string): void {
    for (const [channelId, byTrack] of this.pads) {
      const pad = byTrack.get(trackId);
      if (!pad) continue;
      pad.destroy();
      byTrack.delete(trackId);
      if (byTrack.size === 0) this.pads.delete(channelId);
    }
    const channelId = `track:${trackId}`;
    const channel = this.tracks.get(channelId);
    if (!channel) return;
    channel.destroy();
    this.tracks.delete(channelId);
  }

  destroy(): void {
    for (const byTrack of this.pads.values()) {
      for (const pad of byTrack.values()) pad.destroy();
    }
    for (const track of this.tracks.values()) track.destroy();
    for (const channel of this.returns) channel.destroy();
    this.master.destroy();
    this.monitorBus.disconnect();
    this.pads.clear();
    this.tracks.clear();
  }

  private wireSends(channel: ChannelHandle): void {
    channel.sends.forEach((send, index) => {
      const target = this.returns[index];
      if (target) send.connect(target.input);
    });
  }
}
