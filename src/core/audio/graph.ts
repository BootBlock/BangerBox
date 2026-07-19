/**
 * Mixer graph assembly — spec §5.2 (Strict Signal Hierarchy). Owns the fixed
 * infrastructure (master bus, 4 return channels, monitor bus) and the dynamic channel
 * strips (per-track, per-pad) created on demand. Enforces the topology's edge cases:
 * returns carry no sends (feedback-safe by construction, §5.2), and the monitor bus
 * (metronome + preview) merges into `destination` AFTER the master inserts so the click
 * and auditioning are never coloured by master FX (§5.9).
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

export class MixerGraph {
  readonly master: ChannelHandle;
  readonly returns: readonly ChannelHandle[];
  /** Metronome + Browser-mode audition merge here, post master inserts (spec §5.9). */
  readonly monitorBus: GainNode;

  private readonly tracks = new Map<string, ChannelHandle>();
  private readonly pads = new Map<string, ChannelHandle>();

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

  /** The track channel for `trackId`, created and wired to master + returns if absent. */
  ensureTrackChannel(trackId: string): ChannelHandle {
    const channelId = `track:${trackId}`;
    const existing = this.tracks.get(channelId);
    if (existing) return existing;
    const channel = createTrackChannel(this.context, trackId); // id = `track:<trackId>`
    channel.output.connect(this.master.input);
    this.wireSends(channel);
    this.tracks.set(channelId, channel);
    return channel;
  }

  /**
   * The pad channel `channelId` (`pad:<prog>:<idx>`), created and merged into the given
   * track input (spec §5.2 stage 5) with its sends wired to the returns, if absent.
   */
  ensurePadChannel(channelId: string, trackInput: AudioNode): ChannelHandle {
    const existing = this.pads.get(channelId);
    if (existing) return existing;
    const channel = createPadChannel(this.context, channelId);
    channel.output.connect(trackInput);
    this.wireSends(channel);
    this.pads.set(channelId, channel);
    return channel;
  }

  /** Resolve any channel id to its handle (spec §4.2 channel ids), or undefined. */
  getChannel(channelId: string): ChannelHandle | undefined {
    if (channelId === 'master') return this.master;
    if (channelId.startsWith('return:')) return this.returns[Number(channelId.slice('return:'.length))];
    return this.tracks.get(channelId) ?? this.pads.get(channelId);
  }

  /** Every live channel strip (master, returns, tracks, pads) — for solo evaluation. */
  allChannels(): ChannelHandle[] {
    return [this.master, ...this.returns, ...this.tracks.values(), ...this.pads.values()];
  }

  /** Destroy a pad channel (program change / pad clear) — spec §5.3 routes through here. */
  removePadChannel(channelId: string): void {
    const channel = this.pads.get(channelId);
    if (!channel) return;
    channel.destroy();
    this.pads.delete(channelId);
  }

  /** Destroy a track channel (track delete) — spec §5.3. */
  removeTrackChannel(trackId: string): void {
    const channelId = `track:${trackId}`;
    const channel = this.tracks.get(channelId);
    if (!channel) return;
    channel.destroy();
    this.tracks.delete(channelId);
  }

  destroy(): void {
    for (const pad of this.pads.values()) pad.destroy();
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
