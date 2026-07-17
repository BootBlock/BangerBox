/**
 * Audio import & standardise pipeline (spec §9.4) — decode an imported/created file, standardise
 * it to the project sample rate and ≤ 2 channels, encode it to canonical WAV in the worker, write
 * it to OPFS, and insert its metadata row with inferred tags. Also the shared entry point for
 * Looper captures and destructive sample-edit results (they arrive already as channels). The pure
 * helpers (mixdown, channel extraction) are unit-tested; the orchestrator is browser-only.
 */
import type { BitDepth } from '@/core/project/schemas';
import type { Repositories, SampleRow } from '@/core/storage/repositories';
import { samplePath, writeFileAtomic } from '@/core/storage/opfs';
import type { WavEncodeRequest, WavEncodeResponse } from './wavEncode.worker';

// --- pure standardisation helpers (spec §9.4 step 3) -----------------------------

/** Extract planar Float32 channels from a decoded AudioBuffer. */
export function planarChannels(buffer: AudioBuffer): Float32Array[] {
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c).slice());
  return channels;
}

/**
 * Mix down to at most stereo (spec §9.4 step 3): 1–2 channels pass through; >2 fold into a stereo
 * pair (even-indexed sources → left, odd → right, each averaged) so no channel is dropped.
 */
export function mixdownToStereo(channels: readonly Float32Array[]): Float32Array[] {
  if (channels.length <= 2) return channels.map((c) => c.slice());
  const frames = channels[0]!.length;
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  let leftCount = 0;
  let rightCount = 0;
  for (let c = 0; c < channels.length; c++) {
    const source = channels[c]!;
    const target = c % 2 === 0 ? left : right;
    if (c % 2 === 0) leftCount++;
    else rightCount++;
    for (let i = 0; i < frames; i++) target[i] = (target[i] ?? 0) + (source[i] ?? 0);
  }
  if (leftCount > 1 || rightCount > 1) {
    for (let i = 0; i < frames; i++) {
      if (leftCount) left[i] = (left[i] ?? 0) / leftCount;
      if (rightCount) right[i] = (right[i] ?? 0) / rightCount;
    }
  }
  return [left, right];
}

// --- WAV-encode worker client (spec §9.4 step 4) ---------------------------------

let encodeWorker: Worker | null = null;
let nextId = 1;
const pendingEncodes = new Map<number, { resolve: (bytes: Uint8Array) => void; reject: (e: Error) => void }>();

function ensureEncodeWorker(): Worker {
  if (encodeWorker) return encodeWorker;
  encodeWorker = new Worker(new URL('./wavEncode.worker.ts', import.meta.url), {
    type: 'module',
    name: 'bangerbox-wav',
  });
  encodeWorker.addEventListener('message', (event: MessageEvent<WavEncodeResponse>) => {
    const response = event.data;
    const entry = pendingEncodes.get(response.id);
    if (!entry) return;
    pendingEncodes.delete(response.id);
    if (response.ok) entry.resolve(response.bytes);
    else entry.reject(new Error(response.error));
  });
  return encodeWorker;
}

/** Encode planar channels to canonical WAV bytes off the main thread (spec §9.4 step 4). */
export function encodeWavInWorker(
  channels: Float32Array[],
  sampleRate: number,
  bitDepth: BitDepth,
): Promise<Uint8Array> {
  const id = nextId++;
  const worker = ensureEncodeWorker();
  return new Promise<Uint8Array>((resolve, reject) => {
    pendingEncodes.set(id, { resolve, reject });
    const request: WavEncodeRequest = { id, channels, sampleRate, bitDepth };
    // Transfer the channel buffers (the caller no longer needs them).
    worker.postMessage(
      request,
      channels.map((c) => c.buffer),
    );
  });
}

// --- import orchestrator (browser-only, spec §9.4) -------------------------------

export interface ImportContext {
  readonly context: BaseAudioContext;
  readonly repos: Repositories;
  readonly projectId: string;
  readonly projectSampleRate: number;
  readonly projectBitDepth: BitDepth;
}

/** Resample a decoded buffer to `targetRate` if needed, via an OfflineAudioContext (spec §9.4). */
async function resampleIfNeeded(buffer: AudioBuffer, targetRate: number): Promise<Float32Array[]> {
  if (buffer.sampleRate === targetRate) return planarChannels(buffer);
  const frames = Math.ceil((buffer.duration * targetRate));
  const offline = new OfflineAudioContext(buffer.numberOfChannels, frames, targetRate);
  const source = offline.createBufferSource();
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start();
  return planarChannels(await offline.startRendering());
}

/**
 * Import one decoded AudioBuffer into the project (spec §9.4 steps 3–5): standardise → encode →
 * write to OPFS → insert the samples row with inferred tags. Returns the new sample row. The
 * caller decodes via `audioContext.decodeAudioData` (spec §9.4 step 2) and handles the quota
 * headroom check (spec §9.7) before invoking this.
 */
export async function importDecodedSample(
  buffer: AudioBuffer,
  name: string,
  tags: readonly string[],
  ctx: ImportContext,
): Promise<SampleRow> {
  const standardised = mixdownToStereo(await resampleIfNeeded(buffer, ctx.projectSampleRate));
  const bytes = await encodeWavInWorker(standardised, ctx.projectSampleRate, ctx.projectBitDepth);

  const sampleId = crypto.randomUUID();
  const path = samplePath(ctx.projectId, sampleId);
  // Fresh ArrayBuffer-backed view — the OPFS stream API rejects shared-buffer views.
  await writeFileAtomic(path, new Uint8Array(bytes));

  const row = await ctx.repos.samples.create({
    id: sampleId,
    project_id: ctx.projectId,
    name,
    opfs_path: path,
    frames: standardised[0]?.length ?? 0,
    sample_rate: ctx.projectSampleRate,
    channels: (standardised.length === 1 ? 1 : 2) as 1 | 2,
    root_note: 60,
  });
  const uniqueTags = [...new Set(['imported', ...tags])];
  await ctx.repos.samples.setTags(sampleId, uniqueTags);
  return row;
}

/** Decode + import a picked file (spec §9.4 steps 1–5). Source folder name becomes a tag. */
export async function importAudioFile(
  file: File,
  ctx: ImportContext & { context: AudioContext },
): Promise<SampleRow> {
  const decoded = await ctx.context.decodeAudioData(await file.arrayBuffer());
  const baseName = file.name.replace(/\.[^.]+$/, '');
  return importDecodedSample(decoded, baseName, [], ctx);
}
