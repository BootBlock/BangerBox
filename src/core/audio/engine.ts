/**
 * AudioEngine — the audio core orchestrator (spec §5, §7). Owns the single AudioContext's
 * graph (§5.2), the voice pool (§5.4), the meter registry + taps (§5.8), the metronome and
 * preview channel (§5.9), the sample cache (§9.4), the sequencer
 * {@link SchedulerClient} (§7.1) plus the dispatcher that realises its scheduled batches on
 * the graph (§7.1.4) and the playhead pump that reads the scheduler SAB each frame (§7.1.4).
 * Construction builds the (silent) graph synchronously; {@link initialise} loads the worklet
 * modules during the start gate (§5.1), starts the scheduler, and publishes the meter
 * registry. Every owned resource is released by {@link dispose} (spec §3.2).
 */
import { programWithLiveGestures } from '@/store/useProgramStore';
import { useProgramStore, useProjectStore, useSequenceStore, useTransportStore } from '@/store';
import { resetAutomationRecording, setAutomationClock } from '@/store/automationRecord';
import { createDefaultEnvelope } from '@/core/project/schemas';
import { sampleCandidatePaths } from '@/core/storage/opfs';
import {
  createPlayheadSab,
  PlayheadReader,
  SchedulerClient,
  tickToBarBeatTick,
  type ScheduledEvent,
} from '@/core/sequencer';
import { meterScope } from '@/ui/primitives/meterScope';
import { createAudioBridge, type AudioBridge } from './audioBridge';
import { loadAudioWorklets } from './context';
import { ensureDemoSampleInOpfs } from './demoSample';
import type { ChannelHandle } from './factory';
import { MixerGraph } from './graph';
import { Looper } from './looper';
import { MeterRegistry } from './metering';
import { Metronome } from './metronome';
import { PreviewChannel } from './preview';
import { resolvedVoiceToTrigger, resolveVoice, type ResolvedVoice } from './programVoice';
import { SampleCache } from './sampleCache';
import { ReversedBufferCache } from './voiceBuffer';
import { VoicePool } from './voicePool';

/** Identity of the demo pad/track used by the test UI + smoke (not shipped). */
const DEMO_PROGRAM_ID = 'phase3-demo';
const DEMO_TRACK_ID = 'phase3-demo';
const DEMO_PAD_INDEX = 0;
const DEMO_PAD_CHANNEL = `pad:${DEMO_PROGRAM_ID}:${DEMO_PAD_INDEX}`;

/** Coarse position readout is refreshed at most this often (spec §4.2 ≤ 4×/second). */
const COARSE_POSITION_INTERVAL_MS = 250;

export class AudioEngine {
  readonly graph: MixerGraph;
  readonly voicePool: VoicePool;
  readonly meterRegistry: MeterRegistry;
  readonly metronome: Metronome;
  readonly preview: PreviewChannel;
  readonly sampleCache: SampleCache;
  readonly bridge: AudioBridge;
  readonly scheduler: SchedulerClient;

  private readonly playheadReader: PlayheadReader;
  private readonly meterNodes: AudioWorkletNode[] = [];
  private readonly meterSinks: GainNode[] = [];
  /** Observers of the dispatched batch — see {@link watchScheduledEvents}. Empty in use. */
  private readonly eventObservers = new Set<(event: ScheduledEvent) => void>();
  /** Decoded program sample buffers keyed by sampleId (spec §9.4 decode-once). */
  private readonly programBuffers = new Map<string, AudioBuffer>();
  /** Reversed copies for §6 reversed layers, one per decoded buffer (spec §6). */
  private readonly reversedBuffers: ReversedBufferCache;
  /** Preloaded demo sample the scheduler dispatch triggers per note (the demo instrument). */
  private demoBuffer: AudioBuffer | null = null;
  private playheadRaf: number | null = null;
  private lastCoarseAt = 0;
  /** Count of scheduled notes the dispatcher has realised (test probe, §11.4). */
  private scheduledNotes = 0;
  private initialised = false;

  constructor(readonly context: AudioContext) {
    this.graph = new MixerGraph(context);
    this.voicePool = new VoicePool(context);
    this.meterRegistry = new MeterRegistry();
    this.metronome = new Metronome(context, this.graph.monitorBus);
    this.preview = new PreviewChannel(context, this.graph.monitorBus);
    this.sampleCache = new SampleCache(context);
    this.reversedBuffers = new ReversedBufferCache(context);
    this.bridge = createAudioBridge({
      graph: this.graph,
      context,
      // Program-scope automation reaches sounding voices through the pool (spec §6/§7.8).
      voicePool: () => this.voicePool,
    });
    const playheadSab = createPlayheadSab();
    this.playheadReader = new PlayheadReader(playheadSab);
    this.scheduler = new SchedulerClient({
      playheadSab,
      getClockPair: () => this.clockPair(),
      dispatch: (event) => this.dispatchScheduledEvent(event),
      onRecorded: (trackId, events) =>
        useSequenceStore
          .getState()
          .commitRecordedTake(trackId, events, useTransportStore.getState().recordMode),
      onErased: (trackId, eventIds) => useSequenceStore.getState().removeEvents(trackId, eventIds),
      // spec §7.9: the index into the POSITION-SORTED playlist, which §8.5.12's Song mode
      // marks as playing. An entry holds it for every one of its repeats (issue #130).
      onSongAdvanced: (entryIndex) => useTransportStore.getState().setSongEntryIndex(entryIndex),
      // spec §7.9: the song reached its end with looping off, so the main thread stops the
      // transport exactly as though the user had pressed stop. The worker has already closed
      // its open notes and flushed the take, so nothing is lost by stopping here.
      onSongEnded: () => useTransportStore.getState().stop(),
    });
  }

  /** Load worklets (start gate, §5.1), preload the demo instrument, start the scheduler. */
  async initialise(): Promise<void> {
    if (this.initialised) return;
    await loadAudioWorklets(this.context);
    this.attachMeterTap('master', this.graph.master.meterPoint);
    meterScope.setRegistry(this.meterRegistry);
    await this.preloadDemoInstrument();
    this.scheduler.start();
    this.startPlayheadPump();
    // Publish the playhead to the automation recorder (spec §7.8) the way the meter
    // registry is published to `meterScope` — the recorder must not import the engine.
    setAutomationClock(() => this.playheadReader.read());
    this.initialised = true;
  }

  /**
   * Play the bundled demo pluck from OPFS through a real voice → pad → track → master →
   * destination path (spec §12 audible proof; §5.4 pad playback from OPFS samples).
   */
  async triggerDemoPad(velocity = 110): Promise<void> {
    const projectId = useProjectStore.getState().projectId || DEMO_PROGRAM_ID;
    const path = await ensureDemoSampleInOpfs(projectId);
    const buffer = await this.sampleCache.get(path);
    const track = this.trackChannel(DEMO_TRACK_ID);
    const pad = this.graph.ensurePadChannel(DEMO_PAD_CHANNEL, DEMO_TRACK_ID, track.input).channel;
    this.voicePool.trigger({
      id: crypto.randomUUID(),
      buffer,
      destination: pad.input,
      when: this.context.currentTime,
      velocity,
      playbackMode: 'oneShot', // a drum-style one-shot hit (spec §5.4)
      chokeGroup: 0,
      programId: DEMO_PROGRAM_ID,
      padKey: `${DEMO_PROGRAM_ID}:${DEMO_PAD_INDEX}`,
      amp: createDefaultEnvelope(),
      gainDb: 0,
      tuneSemitones: 0,
      tuneCents: 0,
    });
  }

  /**
   * Live note input from the UI pads/keyboard — spec §7.6's dual path, taken by *both*
   * legs simultaneously:
   *
   *  1. Immediate audition: the voice pool is triggered directly with `when = now`. This
   *     is the sole sanctioned bypass of the store (latency), and it mutates nothing.
   *  2. `liveNote` to the scheduler worker for note-repeat processing and record capture.
   *
   * BLE hardware input joins the same two legs rather than adding a third path: it passes
   * the reconstructed, latency-compensated BLE timestamp as `timestampMs` so recording
   * captures when the pad was *struck*, not when the packet arrived (spec §10.2, §10.4).
   */
  triggerLiveNote(
    trackId: string,
    note: number,
    velocity: number,
    on = true,
    timestampMs: number = performance.now(),
  ): void {
    if (on) {
      const resolved = this.resolveNote(trackId, note, velocity);
      if (resolved) {
        this.soundResolvedVoice(trackId, resolved, {
          kind: 'noteOn',
          trackId,
          note,
          velocity,
          when: this.context.currentTime,
          tick: 0,
        });
      } else {
        this.triggerFallbackDemo({
          kind: 'noteOn',
          trackId,
          note,
          velocity,
          when: this.context.currentTime,
          tick: 0,
        });
      }
    }
    // Leg 2 — note repeat + record capture (spec §7.3, §7.7).
    this.scheduler.sendLiveNote(note, velocity, on, timestampMs, trackId);
  }

  /**
   * Apply a pitch bend, in cents, to every sounding voice of a program (spec §10.2). This
   * is a voice-pool path like note audition — not a store mutation — because a bend is a
   * performance gesture, not project state.
   */
  applyPitchBend(programId: string, cents: number): void {
    this.voicePool.applyProgramDetune(programId, cents, this.context.currentTime);
  }

  /** Create + attach a Looper capturing the master bus (spec §8.5.8). Caller owns disposal. */
  createLooper(): Looper {
    const looper = new Looper(this.context, this.graph.master.meterPoint, this.context.sampleRate);
    looper.attach();
    return looper;
  }

  /** Sound one metronome click now (test UI); in playback the dispatcher drives the click. */
  clickMetronome(accented = true): void {
    this.metronome.click(this.context.currentTime, accented);
  }

  /**
   * Audition a sample through the preview channel (spec §5.9) — Browser-mode tap-to-hear. Never
   * routes through a pad/track chain. Re-decodes after a destructive edit replaces the file.
   */
  async auditionSample(opfsPath: string, invalidate = false): Promise<void> {
    if (invalidate) this.sampleCache.invalidate(opfsPath);
    const buffer = await this.sampleCache.get(opfsPath);
    this.preview.play(buffer, this.context.currentTime);
  }

  /** Latest playhead reading from the scheduler SAB (spec §7.1.4) — for the test probe. */
  playheadTick(): number {
    return this.playheadReader.read().currentTick;
  }

  /** Total scheduled notes realised by the dispatcher — for the §11.4 record/play smoke. */
  scheduledNoteCount(): number {
    return this.scheduledNotes;
  }

  /**
   * Watch what the dispatcher realises, and stop watching (spec §11.4). Returns an
   * unsubscribe.
   *
   * The scheduled batch is the worker's only observable output, and nothing downstream of
   * this point can stand in for it: a note reaches a voice, a click reaches the metronome
   * and a ramp reaches an `AudioParam`, so measuring the audio says a sound happened but
   * never which of the three the worker actually sent. A browser proof of what song mode
   * SCHEDULES therefore has to read the batch itself (spec §13.5, issue #94).
   */
  watchScheduledEvents(observer: (event: ScheduledEvent) => void): () => void {
    this.eventObservers.add(observer);
    return () => {
      this.eventObservers.delete(observer);
    };
  }

  dispose(): void {
    if (this.playheadRaf !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.playheadRaf);
    }
    this.playheadRaf = null;
    this.eventObservers.clear();
    this.scheduler.dispose();
    setAutomationClock(null);
    meterScope.setRegistry(null);
    for (const node of this.meterNodes) node.disconnect();
    for (const sink of this.meterSinks) sink.disconnect();
    this.meterNodes.length = 0;
    this.meterSinks.length = 0;
    this.voicePool.destroy();
    this.metronome.destroy();
    this.preview.destroy();
    this.graph.destroy();
    this.sampleCache.clear();
    this.programBuffers.clear();
    this.demoBuffer = null;
  }

  // --------------------------------------------------------------- internals ---

  /**
   * Clock sync source for the worker (spec §7.1.2). `performanceTime` is sent in the
   * absolute-epoch domain (`timeOrigin + performance.now()`) so the offset survives the
   * worker's independent `performance.timeOrigin` — the worker estimates in the same
   * absolute domain (see `scheduler.worker.ts`). See spec §14 (2026-07-17 (f)).
   */
  private clockPair(): { contextTime: number; performanceTime: number } {
    const timestamp = this.context.getOutputTimestamp();
    return {
      contextTime: timestamp.contextTime ?? this.context.currentTime,
      performanceTime: performance.timeOrigin + (timestamp.performanceTime ?? performance.now()),
    };
  }

  /** Realise one scheduled event on the audio graph (spec §7.1.4 dispatcher). */
  private dispatchScheduledEvent(event: ScheduledEvent): void {
    // Empty in production, so this costs one `size` read per scheduled event.
    if (this.eventObservers.size > 0) {
      for (const observer of this.eventObservers) observer(event);
    }
    switch (event.kind) {
      case 'noteOn':
        this.triggerScheduledNote(event);
        return;
      case 'click':
        this.metronome.click(event.when, event.accented ?? false);
        return;
      case 'automationRamp':
        if (event.target !== undefined && event.value !== undefined) {
          this.bridge.applyAutomation(event.target, event.value, event.when, event.rampEnd ?? event.when);
        }
        return;
      case 'noteOff':
        // Sequenced note lifetime is carried by `durationSec` on the noteOn, so the voice
        // releases itself; there is nothing an explicit note-off dispatch would add here.
        return;
    }
  }

  /**
   * Trigger one scheduled note (spec §7.1.4) by resolving the track's program → pad/zone →
   * layer into a real voice (spec §6, {@link resolveVoice}). Tracks with no program (or a
   * note that resolves to nothing, e.g. the demo track) fall back to the bundled
   * demo sample so the record-then-playback smoke stays audible (spec §12) — but a track
   * the store no longer holds falls back to nothing at all, see {@link triggerFallbackDemo}.
   */
  private triggerScheduledNote(event: ScheduledEvent): void {
    if (event.trackId === undefined || event.note === undefined) return;
    const resolved = this.resolveNote(event.trackId, event.note, event.velocity ?? 100);
    if (resolved) this.soundResolvedVoice(event.trackId, resolved, event);
    else this.triggerFallbackDemo(event);
  }

  /** Resolve a track's note to a §6 voice via its program, or null if nothing sounds. */
  private resolveNote(trackId: string, note: number, velocity: number): ResolvedVoice | null {
    const track = useSequenceStore.getState().tracks[trackId];
    if (!track?.programId) return null;
    const program = useProgramStore.getState().programs[track.programId];
    if (!program) return null;
    // The program AS IT SOUNDS NOW: a §4.1 gesture in flight reaches the graph rather than
    // the store (issue #27), and `applyParam` can only move a voice that already exists —
    // so a pad struck mid-turn would otherwise be built from the pre-gesture value.
    return resolveVoice(programWithLiveGestures(program, note), note, velocity);
  }

  /** Sound a resolved §6 voice, decoding its sample once and applying the §6 pad mixer. */
  private soundResolvedVoice(trackId: string, resolved: ResolvedVoice, event: ScheduledEvent): void {
    const projectId = useProjectStore.getState().projectId || DEMO_PROGRAM_ID;
    const programId = useSequenceStore.getState().tracks[trackId]?.programId ?? trackId;
    const channel = this.ensureProgramChannel(trackId, resolved);
    const play = (decoded: AudioBuffer): void => {
      this.scheduledNotes++;
      // spec §6 `VelocityLayer.reverse`: the layer plays a reversed copy of its sample, and
      // `resolvedVoiceToTrigger` mirrors the trim into that copy's frame numbering.
      const buffer = resolved.reverse ? this.reversedBuffers.get(decoded) : decoded;
      this.voicePool.trigger(
        resolvedVoiceToTrigger(resolved, {
          id: crypto.randomUUID(),
          buffer,
          destination: channel.input,
          when: event.when,
          velocity: event.velocity ?? 100,
          programId,
          // The tempo the scheduler placed the note at (spec §7.2), which in song mode is
          // the segment's own rather than the transport's (spec §7.9). A live audition
          // carries none and falls back to the transport, which is the tempo it is played at.
          bpm: event.bpm ?? useTransportStore.getState().bpm,
        }),
      );
    };
    const cached = this.programBuffers.get(resolved.sampleId);
    if (cached) {
      play(cached);
      return;
    }
    void this.loadProgramSample(projectId, resolved.sampleId)
      .then((buffer) => {
        this.programBuffers.set(resolved.sampleId, buffer);
        play(buffer);
      })
      .catch(() => {
        // Missing/undecodable sample — the note is silently skipped, never a crash (spec §5.1).
      });
  }

  /**
   * Decode a program sample from whichever §9.1 root holds it. A pad may be assigned a
   * project sample or a shared global-library one (spec §9.8), and the §6 payload records
   * only the id, so the project path is tried first and the global library second.
   */
  private loadProgramSample(projectId: string, sampleId: string): Promise<AudioBuffer> {
    const [projectScoped, global] = sampleCandidatePaths(projectId, sampleId);
    return this.sampleCache.get(projectScoped).catch(() => this.sampleCache.get(global));
  }

  /**
   * The §5.2 track group for `trackId`, seeded from its §4.2 strip on the call that BUILDS it.
   *
   * A track channel is built lazily, on the track's first note. `startAudioEngine` runs its
   * one `resyncAll` before any of them exist and `mixerSync` only pushes what changed, so
   * without this a project loaded with a track fader at 0.3, a pan, an open send, an insert
   * rack or `mute: true` plays that track at unity, centred, dry and unmuted until the user
   * touches the control.
   */
  private trackChannel(trackId: string): ChannelHandle {
    const { channel, created } = this.graph.ensureTrackChannel(trackId);
    if (created) this.bridge.seedChannel(channel);
    return channel;
  }

  /**
   * This track's realisation of the pad channel for a resolved voice, created under the
   * track group (spec §5.2 stage 5) and seeded once, in the §14 (ar) order: the §6 payload
   * first, then the §4.2 strip where the store has one.
   *
   * A pad channel exists once PER TRACK playing the program (issue #141), so a second track
   * builds its instance long after `resyncAll` ran and after any edit the strip has had —
   * which is why it is seeded here rather than left at the §4.2 defaults `createChannelStrip`
   * gives it. The graph reports what it built; an engine-side "already seeded" set would
   * outlive `removePadChannel` and leave a rebuilt channel unseeded.
   */
  private ensureProgramChannel(trackId: string, resolved: ResolvedVoice): ChannelHandle {
    const track = this.trackChannel(trackId);
    const { channel: pad, created } = this.graph.ensurePadChannel(resolved.channelId, trackId, track.input);
    if (created) {
      const now = this.context.currentTime;
      pad.setLevel(resolved.mixer.level, now, false);
      pad.setPan(resolved.mixer.pan, now, false);
      resolved.mixer.sendLevels.forEach((level, index) => pad.setSendGain(index, level, now, false));
      // The store is the §1.3 #16 runtime truth, so it wins where it carries a strip for this
      // pad; where it does not — a pad of a program that is not the active one — the §6
      // payload above is the only value there is.
      this.bridge.seedChannel(pad);
    }
    return pad;
  }

  /** The demo instrument: one demo pad channel per (track, note) — the smoke path. */
  private triggerFallbackDemo(event: ScheduledEvent): void {
    if (!this.demoBuffer || event.trackId === undefined || event.note === undefined) return;
    // A track the project no longer HAS is not a track with no program (spec §3.2, §5.3,
    // issue #137). `ensureTrackChannel` below would rebuild the channel `deleteTrack` has
    // just destroyed and leave it, and a fresh pad channel, wired to the master bus for the
    // rest of the session — and it would sound the demo sample rather than the track. A note
    // still inside the §7.1.4 lookahead window when the track was deleted therefore sounds
    // nothing, which is what "the track stopped" has to mean.
    if (useSequenceStore.getState().tracks[event.trackId] === undefined) return;
    this.scheduledNotes++;
    const track = this.trackChannel(event.trackId);
    const pad = this.graph.ensurePadChannel(
      `pad:${event.trackId}:${event.note}`,
      event.trackId,
      track.input,
    ).channel;
    this.voicePool.trigger({
      id: crypto.randomUUID(),
      buffer: this.demoBuffer,
      destination: pad.input,
      when: event.when,
      velocity: event.velocity ?? 100,
      playbackMode: 'oneShot',
      chokeGroup: 0,
      programId: event.trackId,
      padKey: `${event.trackId}:${event.note}`,
      amp: createDefaultEnvelope(),
      gainDb: 0,
      tuneSemitones: 0,
      tuneCents: 0,
    });
  }

  private async preloadDemoInstrument(): Promise<void> {
    const projectId = useProjectStore.getState().projectId || DEMO_PROGRAM_ID;
    const path = await ensureDemoSampleInOpfs(projectId);
    this.demoBuffer = await this.sampleCache.get(path);
  }

  /** Read the playhead SAB each frame and refresh the coarse readout ≤ 4×/s (spec §7.1.4). */
  private startPlayheadPump(): void {
    if (typeof requestAnimationFrame !== 'function') return;
    let wasCapturing = false;
    const pump = (): void => {
      const reading = this.playheadReader.read();
      const now = performance.now();
      if (now - this.lastCoarseAt >= COARSE_POSITION_INTERVAL_MS) {
        this.lastCoarseAt = now;
        this.publishCoarsePosition(reading.currentTick);
      }
      // A pass that has ended must not thin the next one against its last sample
      // (spec §7.8) — the playhead is the only place the count-in and the stop are both
      // visible, so the recorder is reset from here rather than from the transport store.
      if (wasCapturing && !reading.isCapturing) resetAutomationRecording();
      wasCapturing = reading.isCapturing;
      this.playheadRaf = requestAnimationFrame(pump);
    };
    this.playheadRaf = requestAnimationFrame(pump);
  }

  private publishCoarsePosition(currentTick: number): void {
    const { activeSequenceId } = useTransportStore.getState();
    const sequence = activeSequenceId ? useSequenceStore.getState().sequences[activeSequenceId] : undefined;
    const timeSig = sequence?.timeSig ?? { numerator: 4, denominator: 4 };
    const { bar, beat } = tickToBarBeatTick(currentTick, timeSig);
    useTransportStore.getState().setCoarsePosition({ bar, beat });
  }

  /**
   * Branch a `meter-tap` worklet off `tapPoint` into its own slot. Its output feeds a
   * silenced sink → destination so the node stays scheduled (and thus keeps writing the
   * SAB) without doubling the audible signal (spec §5.8).
   */
  private attachMeterTap(meterId: string, tapPoint: AudioNode): void {
    const slot = this.meterRegistry.allocate(meterId);
    const node = new AudioWorkletNode(this.context, 'meter-tap', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { sab: this.meterRegistry.sab, slot },
    });
    const sink = this.context.createGain();
    sink.gain.value = 0;
    tapPoint.connect(node);
    node.connect(sink);
    sink.connect(this.context.destination);
    this.meterNodes.push(node);
    this.meterSinks.push(sink);
  }
}
