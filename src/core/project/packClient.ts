/**
 * Main-thread client for `pack.worker.ts` (spec §9.6) — a small typed promise bridge that spins
 * the pack worker up lazily, correlates each request/response by id, and resolves with the
 * validated unpacked project or the finished archive. Mirrors the hand-rolled RPC style of the
 * DB bridge (spec §1.3 #7) without adding Comlink.
 *
 * **The export path is a session, not a call** (issue #99). {@link beginMpcwebPack} opens one,
 * the caller transfers one sample at a time, and {@link MpcwebPackSession.finish} closes it and
 * hands back the archive. Two things make that a real bound on memory rather than a rearranged
 * one:
 *
 * - **Each sample's buffer is transferred**, so it is detached here the moment it is sent. The
 *   caller cannot hold a project's worth of audio even by accident.
 * - **Each compressed chunk becomes a `Blob` immediately** and the `Uint8Array` is dropped. A
 *   `Blob` is browser-owned storage the engine may keep off the JS heap or spill to disk; an
 *   array of chunks kept until the end would put the whole archive back in memory, which is
 *   the thing being fixed.
 */
import type { PackedSample, UnpackedProject } from './mpcwebZip';
import type { ProjectSnapshot } from './mpcweb';
import type { PackWorkerRequest, PackWorkerRequestBody, PackWorkerResponse } from './pack.worker';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

let worker: Worker | null = null;
let nextId = 1;
let nextSession = 1;
const pending = new Map<number, Pending>();
/** Where each open session's compressed chunks are collected, keyed by session id. */
const chunkSinks = new Map<number, Blob[]>();

function ensureWorker(): Worker {
  if (worker) return worker;
  // The exact `new Worker(new URL(...), { type: 'module' })` form Vite statically bundles.
  worker = new Worker(new URL('./pack.worker.ts', import.meta.url), {
    type: 'module',
    name: 'bangerbox-pack',
  });
  const active = worker;
  active.addEventListener('message', (event: MessageEvent<PackWorkerResponse>) => {
    const response = event.data;
    // Archive output, not a reply: it belongs to a session and has no request waiting on it.
    if (response.ok && response.kind === 'packChunk') {
      // A Blob per chunk, so the bytes leave the JS heap as soon as they arrive.
      chunkSinks.get(response.session)?.push(new Blob([response.chunk as BlobPart]));
      return;
    }
    const entry = pending.get(response.id);
    if (!entry) return;
    pending.delete(response.id);
    if (!response.ok) {
      entry.reject(new Error(response.error));
      return;
    }
    entry.resolve(response.kind === 'unpack' ? response.result : undefined);
  });
  // A worker that crashes, fails to load, or receives an unclonable message never replies, so
  // without this every in-flight call would hang forever (spec §13.6, mirroring the DB bridge).
  const handleFailure = (event: Event): void => {
    const detail = event instanceof ErrorEvent && event.message ? event.message : 'unknown worker failure';
    failAll(new Error(`Pack worker error: ${detail}`), active);
  };
  active.addEventListener('error', handleFailure);
  active.addEventListener('messageerror', handleFailure);
  return active;
}

/**
 * Settle every in-flight call with `error` and drop the dead worker so the next request builds a
 * fresh one. Guarded on identity: a late failure from an already-replaced worker must not tear
 * down its successor.
 */
function failAll(error: Error, source: Worker): void {
  if (worker !== source) {
    source.terminate();
    return;
  }
  worker = null;
  // The half-built archives go with it: their remaining chunks are never coming, and keeping
  // the parts would let a later `finish` return a truncated file.
  chunkSinks.clear();
  const entries = [...pending.values()];
  pending.clear();
  for (const entry of entries) entry.reject(error);
  source.terminate();
}

function send<T>(body: PackWorkerRequestBody, transfer: Transferable[] = []): Promise<T> {
  const id = nextId++;
  const active = ensureWorker();
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    active.postMessage({ ...body, id } as PackWorkerRequest, transfer);
  });
}

export interface MpcwebPackSession {
  /**
   * Add one sample. **The bytes are transferred and unusable afterwards** — that detachment
   * is what stops the caller accumulating a project's worth of audio.
   */
  addSample: (sample: PackedSample) => Promise<void>;
  /**
   * Close the archive and return it. `snapshot`'s sample rows are filtered down to what was
   * actually added, so an export that skipped an unreadable sample stays internally
   * consistent and re-imports past the §9.6 completeness check.
   */
  finish: (snapshot: ProjectSnapshot) => Promise<Blob>;
  /** Give up without producing a file, releasing the worker's packer (a failed read). */
  abort: () => Promise<void>;
}

/** Open a streaming `.mpcweb` pack session in the worker (spec §9.6, issue #99). */
export async function beginMpcwebPack(appVersion: string): Promise<MpcwebPackSession> {
  const session = nextSession++;
  const parts: Blob[] = [];
  chunkSinks.set(session, parts);
  try {
    await send<void>({ kind: 'packBegin', session, appVersion });
  } catch (error) {
    chunkSinks.delete(session);
    throw error;
  }

  /** Release the sink whichever way the session ends, so a failure leaks no parts. */
  const release = () => chunkSinks.delete(session);

  return {
    addSample: async ({ sampleId, bytes }) => {
      try {
        await send<void>({ kind: 'packSample', session, sampleId, bytes }, [bytes.buffer]);
      } catch (error) {
        release();
        throw error;
      }
    },
    finish: async (snapshot) => {
      try {
        // The worker posts the archive's last chunk during `finish` and acknowledges after,
        // and `postMessage` preserves order — so this resolving means every part has arrived.
        await send<void>({ kind: 'packEnd', session, snapshot });
        return new Blob(parts, { type: 'application/zip' });
      } finally {
        release();
      }
    },
    abort: async () => {
      release();
      await send<void>({ kind: 'packAbort', session });
    },
  };
}

/** Unzip + validate `.mpcweb` bytes off the main thread (spec §9.6). */
export function unpackMpcwebInWorker(bytes: Uint8Array): Promise<UnpackedProject> {
  return send<UnpackedProject>({ kind: 'unpack', bytes });
}
