/**
 * Main-thread client for `pack.worker.ts` (spec §9.6) — a small typed promise bridge that spins
 * the pack worker up lazily, correlates each request/response by id, and resolves with the packed
 * bytes or the validated unpacked project. Mirrors the hand-rolled RPC style of the DB bridge
 * (spec §1.3 #7) without adding Comlink.
 */
import type { PackInput, UnpackedProject } from './mpcwebZip';
import type { PackWorkerRequest, PackWorkerResponse } from './pack.worker';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

function ensureWorker(): Worker {
  if (worker) return worker;
  // The exact `new Worker(new URL(...), { type: 'module' })` form Vite statically bundles.
  worker = new Worker(new URL('./pack.worker.ts', import.meta.url), { type: 'module', name: 'bangerbox-pack' });
  worker.addEventListener('message', (event: MessageEvent<PackWorkerResponse>) => {
    const response = event.data;
    const entry = pending.get(response.id);
    if (!entry) return;
    pending.delete(response.id);
    if (response.ok) entry.resolve(response.kind === 'pack' ? response.bytes : response.result);
    else entry.reject(new Error(response.error));
  });
  return worker;
}

type PackRequestBody = { kind: 'pack'; input: PackInput } | { kind: 'unpack'; bytes: Uint8Array };

function send<T>(body: PackRequestBody): Promise<T> {
  const id = nextId++;
  const active = ensureWorker();
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    active.postMessage({ ...body, id } as PackWorkerRequest);
  });
}

/** Zip a project snapshot + sample bytes into `.mpcweb` bytes off the main thread (spec §9.6). */
export function packMpcwebInWorker(input: PackInput): Promise<Uint8Array> {
  return send<Uint8Array>({ kind: 'pack', input });
}

/** Unzip + validate `.mpcweb` bytes off the main thread (spec §9.6). */
export function unpackMpcwebInWorker(bytes: Uint8Array): Promise<UnpackedProject> {
  return send<UnpackedProject>({ kind: 'unpack', bytes });
}
