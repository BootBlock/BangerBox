/**
 * Bounce / mixdown (spec §9.5) — renders the active sequence offline and encodes it to WAV. It
 * reconstructs the note schedule with the SAME pure tick→seconds maths as the live scheduler
 * (spec §9.5) inside an `OfflineAudioContext` on the main thread (§9.5), resolving each track's
 * program → voice (§6) over its OPFS samples decoded via the canonical {@link decodeWav}. The
 * rendered buffer is encoded in the WAV worker and written to `/bounces/` (spec §9.1). The full
 * insert/mixer graph in the bounce is Phase 7 polish; this bounces the resolved voices. Returns
 * the OPFS bounce path.
 */
import { PPQN } from '@/core/constants';
import type { Repositories } from '@/core/storage/repositories';
import { bouncePath, readFile, writeFileAtomic } from '@/core/storage/opfs';
import type { BitDepth } from '@/core/project/schemas';
import { useProgramStore, useSequenceStore, useTransportStore } from '@/store';
import { resolveVoice, resolvedVoiceToTrigger } from './programVoice';
import { decodeWav } from './wav';
import { encodeWavInWorker } from './sampleImport';
import { samplePath } from '@/core/storage/opfs';
import { VoicePool } from './voicePool';

export interface BounceContext {
  readonly repos: Repositories;
  readonly projectId: string;
  readonly projectSampleRate: number;
  readonly projectBitDepth: BitDepth;
}

/** Render the active sequence to a `/bounces/` WAV file (spec §9.5). Returns the OPFS path. */
export async function bounceActiveSequence(name: string, ctx: BounceContext): Promise<string> {
  const transport = useTransportStore.getState();
  const sequenceId = transport.activeSequenceId;
  const sequence = sequenceId ? useSequenceStore.getState().sequences[sequenceId] : undefined;
  if (!sequenceId || !sequence) throw new Error('No active sequence to bounce.');

  const bpm = sequence.tempo ?? transport.bpm;
  const secondsPerTick = 60 / (bpm * PPQN); // spec §7.2
  const ticksPerBeat = (PPQN * 4) / sequence.timeSig.denominator;
  const totalTicks = sequence.lengthBars * sequence.timeSig.numerator * ticksPerBeat;
  const tailSeconds = 2; // let releases/reverb tails finish
  const frames = Math.ceil(totalTicks * secondsPerTick * ctx.projectSampleRate) + tailSeconds * ctx.projectSampleRate;

  const offline = new OfflineAudioContext(2, Math.max(1, frames), ctx.projectSampleRate);
  const master = offline.createGain();
  master.connect(offline.destination);
  const pool = new VoicePool(offline);

  const tracks = Object.values(useSequenceStore.getState().tracks).filter((t) => t.sequenceId === sequenceId);
  const programs = useProgramStore.getState().programs;
  const bufferCache = new Map<string, AudioBuffer>();

  const decodeSample = async (sampleId: string): Promise<AudioBuffer | null> => {
    const cached = bufferCache.get(sampleId);
    if (cached) return cached;
    try {
      const file = await readFile(samplePath(ctx.projectId, sampleId));
      const decoded = decodeWav(new Uint8Array(await file.arrayBuffer()));
      const buffer = offline.createBuffer(decoded.channels.length, decoded.channels[0]!.length, decoded.sampleRate);
      decoded.channels.forEach((channel, index) =>
        buffer.copyToChannel(channel as Float32Array<ArrayBuffer>, index),
      );
      bufferCache.set(sampleId, buffer);
      return buffer;
    } catch {
      return null; // missing/undecodable sample — skip the note, never crash (spec §5.1)
    }
  };

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
          id: `${track.id}:${event.id}`,
          buffer,
          destination: master,
          when: event.tickStart * secondsPerTick,
          velocity: event.velocity,
          programId: program.id,
        }),
      );
    }
  }

  const rendered = await offline.startRendering();
  pool.destroy();

  const channels: Float32Array[] = [];
  for (let c = 0; c < rendered.numberOfChannels; c++) channels.push(rendered.getChannelData(c).slice());
  const bytes = await encodeWavInWorker(channels, ctx.projectSampleRate, ctx.projectBitDepth);
  const path = bouncePath(ctx.projectId, name);
  await writeFileAtomic(path, new Uint8Array(bytes));
  return path;
}
