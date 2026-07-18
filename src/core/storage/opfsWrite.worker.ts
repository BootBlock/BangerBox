/**
 * OPFS streaming write worker (spec §9.1: "streamed reads/writes via sync access handles
 * in workers"). Sync access handles are only available in workers, and they are markedly
 * faster than the main-thread `createWritable` path for the large buffers the sampler
 * produces (imports, bounces, looper takes).
 *
 * The atomicity contract is unchanged from the main-thread path (spec §9.7): bytes land in
 * a temporary file and are renamed onto the destination only after a successful flush, so
 * a failure can never leave a corrupt file at the canonical path.
 *
 * A thin message shell over the same correlation-id protocol as the other workers
 * (spec §1.3 #7 — hand-rolled, no Comlink).
 */
// The path helpers are worker-safe (they touch only `navigator.storage`), so the worker
// shares the canonical segment validation rather than re-implementing it.
import { splitOpfsPath } from './opfs';

export interface OpfsWriteRequest {
  readonly id: number;
  readonly kind: 'write';
  readonly path: string;
  /** Transferred to the worker, so the caller must not touch it afterwards. */
  readonly bytes: Uint8Array;
}

export type OpfsWriteResponse =
  | { readonly id: number; readonly ok: true }
  | { readonly id: number; readonly ok: false; readonly error: string };

/** Chromium ships FileSystemFileHandle.move(); lib.dom does not declare it yet. */
interface MovableFileHandle extends FileSystemFileHandle {
  move?(name: string): Promise<void>;
}

async function resolveDirectory(segments: readonly string[]): Promise<FileSystemDirectoryHandle> {
  let directory = await navigator.storage.getDirectory();
  for (const segment of segments) {
    directory = await directory.getDirectoryHandle(segment, { create: true });
  }
  return directory;
}

async function writeStreamed(path: string, bytes: Uint8Array): Promise<void> {
  const segments = splitOpfsPath(path);
  const fileName = segments[segments.length - 1]!;
  const directory = await resolveDirectory(segments.slice(0, -1));

  const tempName = `${fileName}.tmp-${crypto.randomUUID()}`;
  const tempHandle = (await directory.getFileHandle(tempName, { create: true })) as MovableFileHandle;

  try {
    const handle = await tempHandle.createSyncAccessHandle();
    try {
      handle.truncate(0);
      handle.write(bytes, { at: 0 });
      handle.flush();
    } finally {
      // The handle holds an exclusive lock; the rename below cannot proceed until closed.
      handle.close();
    }

    if (typeof tempHandle.move === 'function') {
      await tempHandle.move(fileName);
      return;
    }
    // Defensive fallback (baseline Chromium ≥ 120 always has move()).
    const file = await tempHandle.getFile();
    const finalHandle = await directory.getFileHandle(fileName, { create: true });
    const writable = await finalHandle.createWritable();
    try {
      await writable.write(file);
    } finally {
      await writable.close();
    }
    await directory.removeEntry(tempName);
  } catch (error) {
    // Never leave the temp artefact behind on failure (spec §9.7).
    try {
      await directory.removeEntry(tempName);
    } catch {
      // Already renamed or never created — nothing to clean.
    }
    throw error;
  }
}

self.addEventListener('message', (event: MessageEvent<OpfsWriteRequest>) => {
  const request = event.data;
  void writeStreamed(request.path, request.bytes)
    .then(() => {
      const response: OpfsWriteResponse = { id: request.id, ok: true };
      self.postMessage(response);
    })
    .catch((error: unknown) => {
      const response: OpfsWriteResponse = {
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : 'OPFS write failed',
      };
      self.postMessage(response);
    });
});
