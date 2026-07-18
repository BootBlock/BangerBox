/**
 * Peak-pyramid cache (spec §8.5.4) — one worker-computed {@link PeakPyramid} per sample, memoised
 * by OPFS path so a waveform is reduced once and every surface that draws it (Sample Edit's
 * editor canvas, Browser's micro-preview) shares the result.
 *
 * There is deliberately no `invalidate`: a destructive edit renders a NEW OPFS file with a new
 * `sampleId` (§8.5.4) rather than rewriting one in place, so a path's audio never changes under a
 * cached pyramid. Memory is bounded by an LRU cap instead — Browser can list a whole directory,
 * and holding a pyramid for every sample a user has ever scrolled past would grow without limit.
 */
import { readFile } from '@/core/storage/opfs';
import type { PeakPyramid } from './peakPyramid';
import type { PeakPyramidRequest, PeakPyramidResponse } from './peakPyramid.worker';

/** Pyramids held at once. Ample for a screenful of Browser rows plus the open editor. */
const MAX_CACHED = 96;

const cache = new Map<string, Promise<PeakPyramid>>();

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<
  number,
  { resolve: (pyramid: PeakPyramid) => void; reject: (error: Error) => void }
>();

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./peakPyramid.worker.ts', import.meta.url), {
    type: 'module',
    name: 'bangerbox-peaks',
  });
  worker.addEventListener('message', (event: MessageEvent<PeakPyramidResponse>) => {
    const response = event.data;
    const entry = pending.get(response.id);
    if (!entry) return;
    pending.delete(response.id);
    if (response.ok) entry.resolve(response.pyramid);
    else entry.reject(new Error(response.error));
  });
  return worker;
}

/** Read the WAV bytes and reduce them in the worker (spec §3.3: never on the main thread). */
async function computePyramid(opfsPath: string): Promise<PeakPyramid> {
  const file = await readFile(opfsPath);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const id = nextId++;
  const client = ensureWorker();
  return new Promise<PeakPyramid>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    const request: PeakPyramidRequest = { id, bytes };
    client.postMessage(request, [bytes.buffer]);
  });
}

/**
 * The peak pyramid for a sample's OPFS path, computing it at most once (spec §8.5.4).
 *
 * Concurrent callers share the in-flight promise, so a Browser list that reveals eight rows at
 * once and an editor opening the same sample cost one decode between them.
 */
export function getPeakPyramid(opfsPath: string): Promise<PeakPyramid> {
  const cached = cache.get(opfsPath);
  if (cached) {
    // Refresh recency — Map preserves insertion order, so re-inserting moves it to the end.
    cache.delete(opfsPath);
    cache.set(opfsPath, cached);
    return cached;
  }
  const built = computePyramid(opfsPath);
  cache.set(opfsPath, built);
  built.catch(() => cache.delete(opfsPath)); // let a transient read failure be retried
  if (cache.size > MAX_CACHED) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  return built;
}
