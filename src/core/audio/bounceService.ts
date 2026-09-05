/**
 * Bounce / mixdown (spec §9.5) — renders offline and encodes to WAV. It reconstructs the
 * note schedule with the SAME pure tick→seconds maths as the live scheduler (spec §9.5)
 * inside an `OfflineAudioContext` on the main thread (§9.5), resolving each track's
 * program → voice (§6) over its OPFS samples decoded via the canonical {@link decodeWav}.
 * The rendered buffer is encoded in the WAV worker and written to `/bounces/` (spec §9.1).
 *
 * **The §5.2 graph is the live one, built by the live factories on the offline context**
 * (issue #134). `MixerGraph`, `createAudioBridge` and `VoicePool` all take a
 * `BaseAudioContext`, so a render is the same ten-stage hierarchy the user is listening to
 * rather than a parallel one — which is what §9.5's "reconstructs the full graph" asks for,
 * and the only arrangement in which the two cannot disagree about §5.2. A render therefore
 * carries stages 1–10:
 *
 *   1–2  source + pad DSP        the §5.4 pool, exactly as live
 *   3–4  pad inserts + sends     the pad strip, seeded from §6 and then from the §4.2 store
 *   5–7  track group, inserts, sends
 *   8    master bus              track outputs + the four return outputs
 *   9    master inserts          EXCEPT in a stem, which §9.5 places pre-master
 *   10   `destination`
 *
 * Two stages are deliberately absent, and neither is a mix decision:
 *
 *   - **The §5.9 monitor bus.** The metronome and Browser-mode auditioning are monitoring,
 *     not music; §5.9 merges them past the master inserts precisely so they are not part of
 *     the programme material. No `Metronome` or `PreviewChannel` is built, so the bus
 *     `MixerGraph` constructs renders silence.
 *   - **The §5.8 metering taps.** They exist to write a SAB a rAF loop reads; an offline
 *     render has no frame loop and nothing reads the SAB. They contribute no signal either
 *     way — their sinks are at zero gain — so leaving them out changes the audio not at all
 *     and saves a worklet per strip.
 *
 * Spec §9.5 names four variants; all four render through the one {@link renderSegments}
 * core so the scheduling maths cannot diverge between them:
 *   - bounce sequence      ({@link bounceActiveSequence})
 *   - bounce song          ({@link bounceSong}, honouring per-entry repeats — spec §7.9)
 *   - bounce selected track({@link bounceTrack}, post-insert/pre-master)
 *   - resample to pad      ({@link resampleSequenceToSample})
 *
 * **A §7.8 lane on a §6 sound-design parameter renders** (issue #138): `filter.cutoff`,
 * `filter.resonance` and `pitch` each ride a `ConstantSourceNode` the whole pad shares, which
 * every voice is built against, so a lane reaches a voice for exactly as long as that voice
 * sounds. **The two amp-ENVELOPE leaves render too** (issue #143), by the rule that follows
 * from the order below rather than in spite of it: an AHDSR is applied when a voice STARTS
 * (spec §6), so a voice's envelope is the pad's as of its own note-on — and because this loop
 * builds every voice before it applies any ramp, a write reaches back to the voices whose
 * note-on is at or after it. Live the same rule reaches the same voices.
 *
 * **What a render still does not carry is a note-OFF.** The loop triggers and never releases,
 * so the §6 release stage is silent in every bounce — as it is live, where the §7.1.4
 * dispatcher discards `noteOff` and `triggerLiveNote(..., false)` reaches only the scheduler.
 * A §7.8 `amp.release` lane therefore reaches the voice and cannot yet be heard; that is a
 * §5.4 defect of its own, not this loop's.
 *
 * **What a render cannot see, and does not guess.** A bounce is of COMMITTED state. A §4.1
 * gesture still in flight lives on the transient channel and has not been committed, so a
 * fader held down while Bounce is tapped renders at the value the project holds — the rule
 * `programWithLiveGestures` already stated for the §6 program, now true of the §5.2 mixer as
 * well, and for the same reason: a knob nobody has let go of is not part of the arrangement.
 * A §10.2 pitch bend is a performance gesture on sounding voices and is never applied. The
 * §5.7.9 warp worklet and the §5.7 worklet effects, by contrast, ARE part of the arrangement,
 * so both processors are registered on the offline context before any node is built.
 */
import type { Repositories, SampleRow } from '@/core/storage/repositories';
import { bouncePath, readFile, sampleCandidatePaths, writeFileStreamed } from '@/core/storage/opfs';
import { assertWriteHeadroom } from '@/core/storage/safeguards';
import type { BitDepth } from '@/core/project/schemas';
import { useProgramStore, useSequenceStore, useTransportStore } from '@/store';
import { resolveVoice, resolvedVoiceToTrigger, type ResolvedVoice } from './programVoice';
import { decodeWav } from './wav';
import { encodeWavInWorker, saveChannelsAsSample } from './sampleImport';
import { buildSongMap, sequenceLengthTicks, type SongSegment } from '@/core/sequencer/songMap';
import { secondsPerTick } from '@/core/sequencer/ppqn';
import { prepareVoiceWorklets, prepareWorkletEffects } from './context';
import { createAudioBridge } from './audioBridge';
import type { ChannelHandle } from './factory';
import { MixerGraph } from './graph';
import { bounceAutomationRamps, bounceIncludesChannel, type BounceScope } from './bouncePlan';
import { ReversedBufferCache } from './voiceBuffer';
import { VoicePool } from './voicePool';

export interface BounceContext {
  readonly repos: Repositories;
  readonly projectId: string;
  readonly projectSampleRate: number;
  readonly projectBitDepth: BitDepth;
}

/** Let releases and reverb tails finish rather than clipping the end of the render. */
const TAIL_SECONDS = 2;

/**
 * Render a segment list to a stereo buffer through the §5.2 graph. Shared by every bounce
 * variant so the tick→seconds conversion, voice resolution, sample decoding and mixer
 * reconstruction happen in exactly one place (spec §9.5 "code shared with the live scheduler").
 */
async function renderSegments(
  segments: readonly SongSegment[],
  scope: BounceScope,
  ctx: BounceContext,
): Promise<AudioBuffer> {
  if (segments.length === 0) throw new Error('Nothing to bounce.');

  const lastSegment = segments[segments.length - 1]!;
  const totalSeconds = lastSegment.startSeconds + lastSegment.lengthTicks * secondsPerTick(lastSegment.bpm);
  const frames = Math.ceil((totalSeconds + TAIL_SECONDS) * ctx.projectSampleRate);

  const offline = new OfflineAudioContext(2, Math.max(1, frames), ctx.projectSampleRate);
  // Both worklet processors are registered before any node is built (spec §5.6.2): the
  // §5.7.9 warp source, so a warp pad bounces the way it plays rather than falling back to
  // coupled repitch, and the §5.7 DSP-effect host, so a reverb, limiter or multiband
  // compressor in an insert slot builds instead of throwing on a context that has never
  // heard of `dsp-effect`.
  await prepareVoiceWorklets(offline);
  await prepareWorkletEffects(offline);

  const graph = new MixerGraph(offline);
  const pool = new VoicePool(offline);
  // The pool is the bridge's, so a §7.8 lane on a §6 sound-design parameter renders (issue
  // #138). It can be, because such a lane no longer writes the voices that exist at the moment
  // of the ramp — which offline is every voice of the whole render at once. It writes the
  // pad's own §7.8 lane node, which each voice is built against and hears only for as long as
  // it sounds. `bounceAutomationRamps` emits the same windows for these addresses as for a
  // §5.2 strip, so what a bounce renders is what live playback sounds like.
  const bridge = createAudioBridge({ graph, context: offline, voicePool: () => pool });

  const programs = useProgramStore.getState().programs;
  const bufferCache = new Map<string, AudioBuffer>();
  const reversedBuffers = new ReversedBufferCache(offline);

  const decodeSample = async (sampleId: string): Promise<AudioBuffer | null> => {
    const cached = bufferCache.get(sampleId);
    if (cached) return cached;
    try {
      // Either §9.1 root may hold the sample a pad plays, exactly as live playback resolves
      // it (see AudioEngine.loadProgramSample) — a bounce that only looked in the project
      // would render silence wherever the live pad sounds a global-library sample.
      const [projectScoped, global] = sampleCandidatePaths(ctx.projectId, sampleId);
      const file = await readFile(projectScoped).catch(() => readFile(global));
      const decoded = decodeWav(new Uint8Array(await file.arrayBuffer()));
      const buffer = offline.createBuffer(
        decoded.channels.length,
        decoded.channels[0]!.length,
        decoded.sampleRate,
      );
      decoded.channels.forEach((channel, index) =>
        buffer.copyToChannel(channel as Float32Array<ArrayBuffer>, index),
      );
      bufferCache.set(sampleId, buffer);
      return buffer;
    } catch {
      return null; // missing/undecodable sample — skip the note, never crash (spec §5.1)
    }
  };

  /**
   * This track's realisation of the pad channel a voice merges into (spec §5.2 stages 3–5),
   * created under its track group and seeded once with the §6 pad mixer — the same rule, in
   * the same order, as `AudioEngine.ensureProgramChannel`.
   *
   * Two tracks playing one program get one realisation EACH (issue #141), so a stem carries
   * only the voices its own track played and the §4.2 strips below reach both. The §4.2 seed
   * the live engine does per instance is `resyncAll`'s job here, because a render creates
   * every channel it needs before that one pass.
   */
  const padChannelFor = (trackId: string, resolved: ResolvedVoice): ChannelHandle => {
    const track = graph.ensureTrackChannel(trackId).channel;
    const { channel: pad, created } = graph.ensurePadChannel(resolved.channelId, trackId, track.input);
    if (created) {
      pad.setLevel(resolved.mixer.level, 0, false);
      pad.setPan(resolved.mixer.pan, 0, false);
      resolved.mixer.sendLevels.forEach((level, index) => pad.setSendGain(index, level, 0, false));
    }
    return pad;
  };

  for (const segment of segments) {
    const perTick = secondsPerTick(segment.bpm); // spec §7.2
    const tracks = Object.values(useSequenceStore.getState().tracks).filter(
      (track) =>
        track.sequenceId === segment.sequenceId &&
        (scope.stemTrackId === null || track.id === scope.stemTrackId),
    );
    for (const track of tracks) {
      const program = track.programId ? programs[track.programId] : undefined;
      if (!program) continue;
      const events = useSequenceStore.getState().events[track.id] ?? [];
      for (const event of events) {
        const resolved = resolveVoice(program, event.note, event.velocity);
        if (!resolved) continue;
        const decoded = await decodeSample(resolved.sampleId);
        if (!decoded) continue;
        // spec §6 `VelocityLayer.reverse`, exactly as live playback applies it.
        const buffer = resolved.reverse ? reversedBuffers.get(decoded) : decoded;
        pool.trigger(
          resolvedVoiceToTrigger(resolved, {
            // Ids stay unique across repeats of the same sequence in a song.
            id: `${track.id}:${event.id}:${segment.startSeconds}`,
            buffer,
            destination: padChannelFor(track.id, resolved).input,
            when: segment.startSeconds + event.tickStart * perTick,
            velocity: event.velocity,
            programId: program.id,
            // The segment's own tempo, so a §6 synced LFO renders at the rate the live
            // scheduler would have played it at (spec §6, §7.9).
            bpm: segment.bpm,
          }),
        );
      }
    }
  }

  // The §4.2 strips, applied AFTER every channel exists: `resyncAll` writes onto the channels
  // the graph already holds, and a pad channel is only built once a voice needs it. The store
  // is the §1.3 #16 runtime source of truth, so where it carries a strip for a pad it wins
  // over the §6 payload seeded above; where it does not — a pad of a program that is not the
  // active one (spec §4.2, `store/derive/padStripMirror` publishes only the active program's)
  // — the payload is the only value there is. Since issue #133 the two agree wherever both
  // exist, because a strip edit is written back into that payload.
  bridge.resyncAll((channelId) => bounceIncludesChannel(channelId, scope));

  // spec §5.7/§7.2: a synced delay follows the tempo of the segment it is sounding under, so
  // the tempo map reaches the inserts the same way it reaches the notes. `applyInserts` built
  // each slot at the transport's tempo; this retunes it per segment.
  for (const segment of segments) graph.setTempo(segment.bpm, segment.startSeconds);

  // spec §7.8: the mixer automation, emitted by the live rule at the live resolution.
  for (const ramp of bounceAutomationRamps(segments, useSequenceStore.getState().automation, scope)) {
    bridge.applyAutomation(ramp.targetPath, ramp.value, ramp.when, ramp.rampEnd);
  }

  const rendered = await offline.startRendering();
  pool.destroy();
  graph.destroy();
  return rendered;
}

/** Planar channel copies of a rendered buffer, ready for the WAV encoder. */
function channelsOf(rendered: AudioBuffer): Float32Array[] {
  const channels: Float32Array[] = [];
  for (let channel = 0; channel < rendered.numberOfChannels; channel += 1) {
    channels.push(rendered.getChannelData(channel).slice());
  }
  return channels;
}

/** Encode a rendered buffer and write it to `/bounces/<name>.wav` (spec §9.1). */
async function writeBounce(rendered: AudioBuffer, name: string, ctx: BounceContext): Promise<string> {
  const bytes = await encodeWavInWorker(channelsOf(rendered), ctx.projectSampleRate, ctx.projectBitDepth);
  const path = bouncePath(ctx.projectId, name);
  // A song bounce is the largest single write the app makes; refuse it before committing bytes
  // rather than letting a long render die on a raw QuotaExceededError (spec §9.7).
  await assertWriteHeadroom(bytes.byteLength, 'this bounce');
  await writeFileStreamed(path, new Uint8Array(bytes));
  return path;
}

/**
 * The active sequence as a single §7.9 segment at time zero — a one-pass song map.
 *
 * Its length and tempo come from `sequenceLengthTicks` and the §7.2 effective-tempo rule,
 * which is what `buildSongMap` uses for every other segment: a sequence render and a song
 * render are the same shape, differing only in how many segments they carry.
 */
function activeSequenceSegments(): SongSegment[] {
  const transport = useTransportStore.getState();
  const sequenceId = transport.activeSequenceId;
  const sequence = sequenceId ? useSequenceStore.getState().sequences[sequenceId] : undefined;
  if (!sequence) throw new Error('No active sequence to bounce.');
  return [
    {
      entryIndex: 0,
      sequenceId: sequence.id,
      startTick: 0,
      lengthTicks: sequenceLengthTicks(sequence),
      bpm: sequence.tempo ?? transport.bpm,
      startSeconds: 0,
    },
  ];
}

/** Render the active sequence to a `/bounces/` WAV file (spec §9.5). Returns the OPFS path. */
export async function bounceActiveSequence(name: string, ctx: BounceContext): Promise<string> {
  const rendered = await renderSegments(
    activeSequenceSegments(),
    { mode: 'sequence', stemTrackId: null },
    ctx,
  );
  return writeBounce(rendered, name, ctx);
}

/**
 * Render one track of the active sequence — post-insert, pre-master (spec §9.5).
 *
 * "Pre-master" is achieved by leaving the master STRIP out of the render rather than by
 * rewiring §5.2: the bus stays the unity pass-through `createChannelStrip` builds, so its
 * inserts, fader, pan and mute contribute nothing while the topology is byte-identical to
 * every other bounce. The track's own strip, its sends and the return channels those sends
 * drive are all in — see {@link bounceIncludesChannel} for why the returns stay.
 */
export async function bounceTrack(trackId: string, name: string, ctx: BounceContext): Promise<string> {
  const rendered = await renderSegments(
    activeSequenceSegments(),
    { mode: 'sequence', stemTrackId: trackId },
    ctx,
  );
  return writeBounce(rendered, name, ctx);
}

/**
 * Render the whole song playlist (spec §9.5, §7.9): entries in order, each repeated
 * `repeats` times, with per-sequence tempo building the offset map — the same rule the
 * scheduler applies for song playback.
 */
export async function bounceSong(name: string, ctx: BounceContext): Promise<string> {
  const { songEntries, sequences } = useSequenceStore.getState();
  const projectBpm = useTransportStore.getState().bpm;

  // The expansion is `buildSongMap`'s, not a second copy of it. §9.5 renders "the same span"
  // the scheduler plays, so the two reading `repeats` differently is the drift the shared
  // maths exists to prevent — and the segment bound that guard carries (issue #130) applies
  // to the render as well, which is the path that expands the playlist on the MAIN thread.
  // A segment whose sequence has been deleted leaves a hole rather than a crash: `buildSongMap`
  // skips it while still consuming its §7.9 entry index.
  const segments = buildSongMap(songEntries, sequences, projectBpm);
  if (segments.length === 0) throw new Error('The song playlist is empty.');

  const rendered = await renderSegments(segments, { mode: 'song', stemTrackId: null }, ctx);
  return writeBounce(rendered, name, ctx);
}

/**
 * Resample the active sequence into a new *sample* rather than a bounce file (spec §9.5
 * "resample-to-pad"), so the result can be assigned to a pad.
 *
 * It renders the SAME graph as a sequence bounce, master inserts included, and that is a
 * decision rather than a convenience: §8.5.8's Looper — the app's other resampler — taps
 * `graph.master.meterPoint`, which is the master strip's output, and §9.5 lists resampling
 * beside the bounces rather than beside the stem. Resampling in BangerBox therefore means the
 * same thing everywhere: what came out of the master bus. The cost is the familiar one — a
 * resampled pad played back through the master chain is processed by it twice — and the
 * answer is the familiar one too: bypass or trim the master chain before resampling, which is
 * a choice the user can see, where a silently different render is not.
 *
 * Returns the whole `samples` row, not just its id: the caller's next step is to offer the
 * new sample to `AssignTargetDialog`, which needs the name and root note as well — and §9.5
 * calls this "resample-to-PAD", so stopping at an id would leave the last step of the named
 * feature unreachable (issue #104).
 */
export async function resampleSequenceToSample(name: string, ctx: BounceContext): Promise<SampleRow> {
  const rendered = await renderSegments(
    activeSequenceSegments(),
    { mode: 'sequence', stemTrackId: null },
    ctx,
  );
  return saveChannelsAsSample(
    channelsOf(rendered),
    ctx.projectSampleRate,
    name,
    ['resampled'], // inferred tag, matching the import pipeline's convention (spec §9.4)
    ctx,
  );
}
