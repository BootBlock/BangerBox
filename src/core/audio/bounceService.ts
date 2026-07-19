/**
 * Bounce / mixdown (spec §9.5) — renders offline and encodes to WAV. It reconstructs the
 * note schedule with the SAME pure tick→seconds maths as the live scheduler (spec §9.5)
 * inside an `OfflineAudioContext` on the main thread (§9.5), resolving each track's
 * program → voice (§6) over its OPFS samples decoded via the canonical {@link decodeWav}.
 * The rendered buffer is encoded in the WAV worker and written to `/bounces/` (spec §9.1).
 *
 * Spec §9.5 names four variants; all four render through the one {@link renderSegments}
 * core so the scheduling maths cannot diverge between them:
 *   - bounce sequence      ({@link bounceActiveSequence})
 *   - bounce song          ({@link bounceSong}, honouring per-entry repeats — spec §7.9)
 *   - bounce selected track({@link bounceTrack}, post-insert/pre-master)
 *   - resample to pad      ({@link resampleSequenceToSample})
 */
import { PPQN } from '@/core/constants';
import type { Repositories } from '@/core/storage/repositories';
import { bouncePath, readFile, samplePath, writeFileStreamed } from '@/core/storage/opfs';
import { assertWriteHeadroom } from '@/core/storage/safeguards';
import type { BitDepth, Sequence } from '@/core/project/schemas';
import { useProgramStore, useSequenceStore, useTransportStore } from '@/store';
import { resolveVoice, resolvedVoiceToTrigger } from './programVoice';
import { decodeWav } from './wav';
import { encodeWavInWorker, saveChannelsAsSample } from './sampleImport';
import { VoicePool } from './voicePool';

export interface BounceContext {
  readonly repos: Repositories;
  readonly projectId: string;
  readonly projectSampleRate: number;
  readonly projectBitDepth: BitDepth;
}

/** Let releases and reverb tails finish rather than clipping the end of the render. */
const TAIL_SECONDS = 2;

/** One pass of one sequence, placed at an absolute offset in the render (spec §7.9). */
interface Segment {
  readonly sequence: Sequence;
  readonly bpm: number;
  /** Seconds from the start of the render at which this pass begins. */
  readonly startSeconds: number;
  /** Restrict the render to a single track (bounce-selected-track), or null for all. */
  readonly onlyTrackId: string | null;
}

/** Seconds one pass of a sequence occupies at `bpm` (spec §7.2 tick maths). */
function segmentSeconds(sequence: Sequence, bpm: number): number {
  const secondsPerTick = 60 / (bpm * PPQN);
  const ticksPerBeat = (PPQN * 4) / sequence.timeSig.denominator;
  return sequence.lengthBars * sequence.timeSig.numerator * ticksPerBeat * secondsPerTick;
}

/**
 * Render a list of segments to a stereo buffer. Shared by every bounce variant so the
 * tick→seconds conversion, voice resolution, and sample decoding happen in exactly one
 * place (spec §9.5 "code shared with the live scheduler").
 */
async function renderSegments(segments: readonly Segment[], ctx: BounceContext): Promise<AudioBuffer> {
  if (segments.length === 0) throw new Error('Nothing to bounce.');

  const lastSegment = segments[segments.length - 1]!;
  const totalSeconds = lastSegment.startSeconds + segmentSeconds(lastSegment.sequence, lastSegment.bpm);
  const frames = Math.ceil((totalSeconds + TAIL_SECONDS) * ctx.projectSampleRate);

  const offline = new OfflineAudioContext(2, Math.max(1, frames), ctx.projectSampleRate);
  const master = offline.createGain();
  master.connect(offline.destination);
  const pool = new VoicePool(offline);

  const programs = useProgramStore.getState().programs;
  const bufferCache = new Map<string, AudioBuffer>();

  const decodeSample = async (sampleId: string): Promise<AudioBuffer | null> => {
    const cached = bufferCache.get(sampleId);
    if (cached) return cached;
    try {
      const file = await readFile(samplePath(ctx.projectId, sampleId));
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

  for (const segment of segments) {
    const secondsPerTick = 60 / (segment.bpm * PPQN); // spec §7.2
    const tracks = Object.values(useSequenceStore.getState().tracks).filter(
      (track) =>
        track.sequenceId === segment.sequence.id &&
        (segment.onlyTrackId === null || track.id === segment.onlyTrackId),
    );
    for (const track of tracks) {
      const program = track.programId ? programs[track.programId] : undefined;
      if (!program) continue;
      const events = useSequenceStore.getState().events[track.id] ?? [];
      for (const event of events) {
        const resolved = resolveVoice(program, event.note, event.velocity);
        if (!resolved) continue;
        const buffer = await decodeSample(resolved.sampleId);
        if (!buffer) continue;
        pool.trigger(
          resolvedVoiceToTrigger(resolved, {
            // Ids stay unique across repeats of the same sequence in a song.
            id: `${track.id}:${event.id}:${segment.startSeconds}`,
            buffer,
            destination: master,
            when: segment.startSeconds + event.tickStart * secondsPerTick,
            velocity: event.velocity,
            programId: program.id,
          }),
        );
      }
    }
  }

  const rendered = await offline.startRendering();
  pool.destroy();
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

/** The active sequence as a single segment at time zero. */
function activeSequenceSegment(onlyTrackId: string | null): Segment {
  const transport = useTransportStore.getState();
  const sequenceId = transport.activeSequenceId;
  const sequence = sequenceId ? useSequenceStore.getState().sequences[sequenceId] : undefined;
  if (!sequence) throw new Error('No active sequence to bounce.');
  return {
    sequence,
    bpm: sequence.tempo ?? transport.bpm,
    startSeconds: 0,
    onlyTrackId,
  };
}

/** Render the active sequence to a `/bounces/` WAV file (spec §9.5). Returns the OPFS path. */
export async function bounceActiveSequence(name: string, ctx: BounceContext): Promise<string> {
  const rendered = await renderSegments([activeSequenceSegment(null)], ctx);
  return writeBounce(rendered, name, ctx);
}

/**
 * Render one track of the active sequence — post-insert, pre-master (spec §9.5). The
 * per-track insert chain is applied by the voice's own channel; the master chain is
 * deliberately excluded, which is what "pre-master" means for a stem.
 */
export async function bounceTrack(trackId: string, name: string, ctx: BounceContext): Promise<string> {
  const rendered = await renderSegments([activeSequenceSegment(trackId)], ctx);
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

  const segments: Segment[] = [];
  let cursorSeconds = 0;
  for (const entry of [...songEntries].sort((a, b) => a.position - b.position)) {
    const sequence = sequences[entry.sequenceId];
    if (!sequence) continue; // a deleted sequence leaves a hole, never a crash
    const bpm = sequence.tempo ?? projectBpm;
    for (let pass = 0; pass < entry.repeats; pass += 1) {
      segments.push({ sequence, bpm, startSeconds: cursorSeconds, onlyTrackId: null });
      cursorSeconds += segmentSeconds(sequence, bpm);
    }
  }
  if (segments.length === 0) throw new Error('The song playlist is empty.');

  const rendered = await renderSegments(segments, ctx);
  return writeBounce(rendered, name, ctx);
}

/**
 * Resample the active sequence into a new *sample* rather than a bounce file (spec §9.5
 * "resample-to-pad"), so the result can be assigned to a pad. Returns the new sampleId.
 */
export async function resampleSequenceToSample(name: string, ctx: BounceContext): Promise<string> {
  const rendered = await renderSegments([activeSequenceSegment(null)], ctx);
  const created = await saveChannelsAsSample(
    channelsOf(rendered),
    ctx.projectSampleRate,
    name,
    ['resampled'], // inferred tag, matching the import pipeline's convention (spec §9.4)
    ctx,
  );
  return created.id;
}
