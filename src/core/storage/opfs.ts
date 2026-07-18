/**
 * Typed OPFS wrapper (spec §9.1) — the single gateway for Origin Private File
 * System access: canonical path building, existence checks, atomic writes, and
 * deletion. The §9.1 directory layout is strict:
 *
 *   /bangerbox.sqlite3                     (owned by the SQLite OPFS VFS — never
 *                                           touched through this wrapper)
 *   /projects/{projectId}/samples/{sampleId}.wav
 *   /projects/{projectId}/bounces/{name}.wav
 *   /global_library/{sampleId}.wav
 *
 * The Phase 6 sample/looper/import pipelines write via {@link writeFileAtomic} (main-thread
 * `createWritable`, atomic temp-then-rename — spec §9.7), which is correct and sufficient.
 * // STUB(phase-7): a worker sync-access-handle streaming path is a throughput refinement for
 * very large writes (spec §9.1), not a Phase 6 blocker.
 */

/** Canonical OPFS path of a project-scoped sample (spec §9.1). */
export function samplePath(projectId: string, sampleId: string): string {
  return `/projects/${projectId}/samples/${sampleId}.wav`;
}

/** Canonical OPFS path of a project bounce (spec §9.1). */
export function bouncePath(projectId: string, name: string): string {
  return `/projects/${projectId}/bounces/${name}.wav`;
}

/** Canonical OPFS path of a global-library sample (spec §9.1). */
export function globalLibraryPath(sampleId: string): string {
  return `/global_library/${sampleId}.wav`;
}

/**
 * Split a canonical path into validated segments. Rejects traversal and empty
 * segments so a malformed path can never escape or corrupt the layout.
 */
export function splitOpfsPath(path: string): string[] {
  const trimmed = path.startsWith('/') ? path.slice(1) : path;
  const segments = trimmed.split('/');
  if (segments.length === 0 || segments.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`Invalid OPFS path: "${path}"`);
  }
  return segments;
}

async function opfsRoot(): Promise<FileSystemDirectoryHandle> {
  return navigator.storage.getDirectory();
}

async function resolveDirectory(
  directorySegments: readonly string[],
  create: boolean,
): Promise<FileSystemDirectoryHandle> {
  let directory = await opfsRoot();
  for (const segment of directorySegments) {
    directory = await directory.getDirectoryHandle(segment, { create });
  }
  return directory;
}

async function resolveFile(path: string, create: boolean): Promise<FileSystemFileHandle> {
  const segments = splitOpfsPath(path);
  const fileName = segments[segments.length - 1]!;
  const directory = await resolveDirectory(segments.slice(0, -1), create);
  return directory.getFileHandle(fileName, { create });
}

/** True when a file exists at the canonical path. */
export async function fileExists(path: string): Promise<boolean> {
  try {
    await resolveFile(path, false);
    return true;
  } catch {
    return false;
  }
}

/** Chromium ships FileSystemFileHandle.move(); lib.dom does not declare it yet. */
interface MovableFileHandle extends FileSystemFileHandle {
  move?(name: string): Promise<void>;
}

/**
 * Write a file atomically (spec §9.7): the bytes land under a temporary name and
 * are renamed onto the final name only once the write completed, so a failure
 * mid-write can never leave a corrupt half-written file at the canonical path.
 */
export async function writeFileAtomic(
  path: string,
  // Uint8Array<ArrayBuffer>: the stream API rejects SharedArrayBuffer-backed views.
  data: Blob | ArrayBuffer | Uint8Array<ArrayBuffer>,
): Promise<void> {
  const segments = splitOpfsPath(path);
  const fileName = segments[segments.length - 1]!;
  const directory = await resolveDirectory(segments.slice(0, -1), true);

  const tempName = `${fileName}.tmp-${crypto.randomUUID()}`;
  const tempHandle = (await directory.getFileHandle(tempName, { create: true })) as MovableFileHandle;
  try {
    const writable = await tempHandle.createWritable();
    try {
      // FileSystemWriteChunkType accepts Blob/ArrayBuffer/ArrayBufferView directly.
      await writable.write(data);
    } finally {
      await writable.close();
    }

    if (typeof tempHandle.move === 'function') {
      // Same-directory rename: atomic replacement of the destination (Chromium OPFS).
      await tempHandle.move(fileName);
    } else {
      // Extremely defensive fallback (baseline Chromium ≥ 120 always has move()):
      // copy the completed temp file onto the destination, then drop the temp.
      const file = await tempHandle.getFile();
      const finalHandle = await directory.getFileHandle(fileName, { create: true });
      const finalWritable = await finalHandle.createWritable();
      try {
        await finalWritable.write(file);
      } finally {
        await finalWritable.close();
      }
      await directory.removeEntry(tempName);
    }
  } catch (err) {
    // Never leave the temp artefact behind on failure.
    try {
      await directory.removeEntry(tempName);
    } catch {
      // Already renamed or never created — nothing to clean.
    }
    throw err;
  }
}

/** Read a file back as a File (a Blob with metadata). */
export async function readFile(path: string): Promise<File> {
  const handle = await resolveFile(path, false);
  return handle.getFile();
}

/** Delete a file; missing files resolve silently (idempotent). */
export async function deleteFile(path: string): Promise<void> {
  const segments = splitOpfsPath(path);
  const fileName = segments[segments.length - 1]!;
  try {
    const directory = await resolveDirectory(segments.slice(0, -1), false);
    await directory.removeEntry(fileName);
  } catch {
    // Absent directory or file — deletion is already true.
  }
}

/** Recursively delete a directory subtree; missing directories resolve silently. */
export async function deleteDirectory(path: string): Promise<void> {
  const segments = splitOpfsPath(path);
  const name = segments[segments.length - 1]!;
  try {
    const parent = await resolveDirectory(segments.slice(0, -1), false);
    await parent.removeEntry(name, { recursive: true });
  } catch {
    // Absent — deletion is already true.
  }
}

/**
 * Purge the entire origin storage — the Safe Mode hard reset (spec §8.1). The
 * caller MUST dispose the database worker first so the SQLite OPFS lock is
 * released before its file is removed.
 */
export async function purgeAllStorage(): Promise<void> {
  const root = await opfsRoot();
  // The async-iterable directory handle is Chromium reality; lib.dom lags it.
  const iterable = root as unknown as {
    keys(): AsyncIterableIterator<string>;
  };
  const names: string[] = [];
  for await (const name of iterable.keys()) names.push(name);
  for (const name of names) {
    await root.removeEntry(name, { recursive: true });
  }
}
