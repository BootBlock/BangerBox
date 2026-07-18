/**
 * Main-thread client for `opfsWrite.worker.ts` (spec §9.1) — the typed promise bridge that
 * hands large writes to the worker's sync-access-handle path. Mirrors the hand-rolled RPC
 * style of the DB and pack bridges (spec §1.3 #7 — no Comlink).
 */
import type { OpfsWriteRequest, OpfsWriteResponse } from './opfsWrite.worker';

interface Pending {
  resolve: () => void;
  reject: (error: Error) => void;
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

function ensureWorker(): Worker {
  if (worker) return worker;
  // The exact `new Worker(new URL(...), { type: 'module' })` form Vite statically bundles.
  worker = new Worker(new URL('./opfsWrite.worker.ts', import.meta.url), {
    type: 'module',
    name: 'bangerbox-opfs-write',
  });
  worker.addEventListener('message', (event: MessageEvent<OpfsWriteResponse>) => {
    const response = event.data;
    const entry = pending.get(response.id);
    if (!entry) return;
    pending.delete(response.id);
    if (response.ok) entry.resolve();
    else entry.reject(new Error(response.error));
  });
  return worker;
}

/**
 * Write bytes to an OPFS path through the worker, atomically (spec §9.1, §9.7). The buffer
 * is *transferred*, so the caller must not read it afterwards — the callers here have all
 * just produced it and are done with it.
 */
export function writeFileInWorker(path: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
  const id = nextId++;
  const active = ensureWorker();
  return new Promise<void>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    const request: OpfsWriteRequest = { id, kind: 'write', path, bytes };
    active.postMessage(request, [bytes.buffer]);
  });
}

/** True when the worker path is usable — a worker-less environment (unit tests) falls back. */
export function workerWritesAvailable(): boolean {
  return typeof Worker !== 'undefined';
}
