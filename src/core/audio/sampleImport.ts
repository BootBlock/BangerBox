/**
 * Audio import & standardise pipeline (spec §9.4) — decode an imported/created file, standardise
 * it to the project sample rate and ≤ 2 channels, encode it to canonical WAV in the worker, write
 * it to OPFS, and insert its metadata row with inferred tags. Also the shared entry point for
 * Looper captures and destructive sample-edit results (they arrive already as channels). The pure
 * helpers (mixdown, channel extraction) are unit-tested; the orchestrator is browser-only.
 */
import type { BitDepth } from '@/core/project/schemas';
import type { Repositories, SampleRow } from '@/core/storage/repositories';
import { globalLibraryPath, samplePath, writeFileStreamed } from '@/core/storage/opfs';
import { assertWriteHeadroom } from '@/core/storage/safeguards';
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
const pendingEncodes = new Map<
  number,
  { resolve: (bytes: Uint8Array) => void; reject: (e: Error) => void }
>();

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

/**
 * Where a written sample lands (spec §9.1, §9.3): inside the active project, or in the
 * global library, whose rows carry a NULL `project_id` and whose bytes live outside any
 * project directory. Omitted means `'project'` — only Browser-mode global imports opt out.
 */
export type SampleScope = 'project' | 'global';

export interface ImportContext {
  readonly context: BaseAudioContext;
  readonly repos: Repositories;
  readonly projectId: string;
  readonly projectSampleRate: number;
  readonly projectBitDepth: BitDepth;
  readonly scope?: SampleScope;
}

/** The subset needed to persist channels (no AudioContext) — shared by edit/looper writes. */
export type SampleWriteContext = Pick<ImportContext, 'repos' | 'projectId' | 'projectBitDepth' | 'scope'>;

/**
 * Encode planar channels to canonical WAV, write them to a new OPFS sample, and insert the
 * metadata row + tags (spec §9.4 steps 4–5). The shared write path for import, destructive
 * sample edits, and Looper captures. Returns the new sample row.
 */
export async function saveChannelsAsSample(
  channels: Float32Array[],
  sampleRate: number,
  name: string,
  tags: readonly string[],
  ctx: SampleWriteContext,
): Promise<SampleRow> {
  // Capture the shape BEFORE encoding: encodeWavInWorker transfers (detaches) the channel
  // buffers, after which `channels[0].length` reads as 0.
  const frames = channels[0]?.length ?? 0;
  const channelCount: 1 | 2 = channels.length === 1 ? 1 : 2;
  const bytes = await encodeWavInWorker(channels, sampleRate, ctx.projectBitDepth);
  const sampleId = crypto.randomUUID();
  const global = ctx.scope === 'global';
  const path = global ? globalLibraryPath(sampleId) : samplePath(ctx.projectId, sampleId);
  // The §9.7 hard stop, on the encoded size rather than the source file's: this is what actually
  // lands in OPFS. Checked here — after encoding, before the write — so every caller of this
  // shared path (import, Looper take, destructive edit, resample-to-pad) is covered by one gate,
  // and a refusal costs only the in-memory encode (spec §9.4 step 6).
  await assertWriteHeadroom(bytes.byteLength);
  // Fresh ArrayBuffer-backed view — the OPFS stream API rejects shared-buffer views.
  // Sample payloads are the large writes the worker sync-access-handle path exists for
  // (spec §9.1); the view is transferred there, and nothing below reads it again.
  await writeFileStreamed(path, new Uint8Array(bytes));
  const row = await ctx.repos.samples.create({
    id: sampleId,
    // NULL project_id is what makes a row global (spec §9.3).
    project_id: global ? null : ctx.projectId,
    name,
    opfs_path: path,
    frames,
    sample_rate: sampleRate,
    channels: channelCount,
    root_note: 60,
  });
  await ctx.repos.samples.setTags(sampleId, [...new Set(tags)]);
  return row;
}

/** Resample a decoded buffer to `targetRate` if needed, via an OfflineAudioContext (spec §9.4). */
async function resampleIfNeeded(buffer: AudioBuffer, targetRate: number): Promise<Float32Array[]> {
  if (buffer.sampleRate === targetRate) return planarChannels(buffer);
  const frames = Math.ceil(buffer.duration * targetRate);
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
 * caller decodes via `audioContext.decodeAudioData` (spec §9.4 step 2); the quota headroom check
 * (spec §9.7) is applied by {@link saveChannelsAsSample} below, so callers need not repeat it.
 */
export async function importDecodedSample(
  buffer: AudioBuffer,
  name: string,
  tags: readonly string[],
  ctx: ImportContext,
): Promise<SampleRow> {
  const standardised = mixdownToStereo(await resampleIfNeeded(buffer, ctx.projectSampleRate));
  return saveChannelsAsSample(standardised, ctx.projectSampleRate, name, ['imported', ...tags], ctx);
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
