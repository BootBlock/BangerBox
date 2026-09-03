/**
 * In-memory Origin Private File System, enough of it to drive `core/storage/opfs.ts`
 * (spec §9.1) in the unit suite.
 *
 * The real handle operations are proven in the browser smoke (spec §11.4, §13.5); this
 * fake exists so the *policy* around them is testable — which errors propagate, which are
 * read as "already absent", and what a failed write leaves behind (issue #98). Failures are
 * injected through a mutable control object rather than by entry name, because the atomic
 * write's temp file is named from `crypto.randomUUID()` and so cannot be named in advance.
 */

/** The error a real OPFS raises for a missing file or directory. */
export function notFound(name: string): DOMException {
  return new DOMException(`A requested file or directory could not be found: ${name}`, 'NotFoundError');
}

/** Failure injection, mutable so a test can arm it between operations. */
export interface FakeOpfsControl {
  /** Thrown by `getDirectoryHandle` for a directory of this name. */
  directoryError?: { name: string; error: unknown };
  /** Thrown by `getFileHandle` for a file of this name. */
  fileError?: { name: string; error: unknown };
  /** Thrown by `removeEntry` for an entry of this name. */
  removeError?: { name: string; error: unknown };
  /** Thrown by every `createWritable().write()` while set. */
  writeError?: unknown;
}

interface FakeFile {
  bytes: Uint8Array;
}

export class FakeDirectory {
  readonly files = new Map<string, FakeFile>();
  readonly directories = new Map<string, FakeDirectory>();

  constructor(
    readonly name: string,
    readonly control: FakeOpfsControl,
  ) {}

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FakeDirectory> {
    if (this.control.directoryError?.name === name) throw this.control.directoryError.error;
    const existing = this.directories.get(name);
    if (existing) return existing;
    if (!options?.create) throw notFound(name);
    const created = new FakeDirectory(name, this.control);
    this.directories.set(name, created);
    return created;
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<FakeFileHandle> {
    if (this.control.fileError?.name === name) throw this.control.fileError.error;
    if (!this.files.has(name)) {
      if (!options?.create) throw notFound(name);
      this.files.set(name, { bytes: new Uint8Array(0) });
    }
    return new FakeFileHandle(this, name);
  }

  async removeEntry(name: string, options?: { recursive?: boolean }): Promise<void> {
    if (this.control.removeError?.name === name) throw this.control.removeError.error;
    if (this.files.delete(name)) return;
    const directory = this.directories.get(name);
    if (directory) {
      if (!options?.recursive && directory.files.size > 0) {
        throw new DOMException('Directory not empty', 'InvalidModificationError');
      }
      this.directories.delete(name);
      return;
    }
    throw notFound(name);
  }

  async *keys(): AsyncIterableIterator<string> {
    for (const name of [...this.files.keys(), ...this.directories.keys()]) yield name;
  }

  /** The directory at a canonical path, or undefined (test assertions). */
  directoryAt(path: string): FakeDirectory | undefined {
    return descend(this, path.replace(/^\//, '').split('/').filter(Boolean));
  }

  /** Read a file back by canonical path, or undefined when absent (test assertions). */
  read(path: string): Uint8Array | undefined {
    const cut = path.lastIndexOf('/');
    return this.directoryAt(path.slice(0, cut))?.files.get(path.slice(cut + 1))?.bytes;
  }

  /** Every entry name in the directory at `path` (temp-artefact assertions). */
  list(path: string): string[] {
    const directory = this.directoryAt(path);
    if (!directory) return [];
    return [...directory.files.keys(), ...directory.directories.keys()];
  }
}

class FakeFileHandle {
  constructor(
    private readonly parent: FakeDirectory,
    public name: string,
  ) {}

  async getFile(): Promise<File> {
    const bytes = this.parent.files.get(this.name)?.bytes ?? new Uint8Array(0);
    return new File([bytes as BlobPart], this.name);
  }

  async createWritable(): Promise<{
    write(data: Blob | ArrayBuffer | Uint8Array): Promise<void>;
    close(): Promise<void>;
  }> {
    const entry = this.parent.files.get(this.name)!;
    const control = this.parent.control;
    return {
      write: async (data) => {
        if (control.writeError !== undefined) throw control.writeError;
        entry.bytes = await toBytes(data);
      },
      close: async () => undefined,
    };
  }

  async move(name: string): Promise<void> {
    const entry = this.parent.files.get(this.name)!;
    this.parent.files.delete(this.name);
    this.parent.files.set(name, entry);
    this.name = name;
  }
}

/** Walk `segments` down from `from`, or undefined where one is missing. */
function descend(from: FakeDirectory, segments: readonly string[]): FakeDirectory | undefined {
  let directory = from;
  for (const segment of segments) {
    const next = directory.directories.get(segment);
    if (!next) return undefined;
    directory = next;
  }
  return directory;
}

async function toBytes(data: Blob | ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  if (data instanceof Uint8Array) return new Uint8Array(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(await data.arrayBuffer());
}

/**
 * Install a fake OPFS as `navigator.storage.getDirectory`, returning its root and the
 * control object that arms failures. The caller restores the environment itself.
 */
export function installFakeOpfs(): { root: FakeDirectory; control: FakeOpfsControl } {
  const control: FakeOpfsControl = {};
  const root = new FakeDirectory('', control);
  Object.defineProperty(globalThis.navigator, 'storage', {
    configurable: true,
    value: { getDirectory: async () => root as unknown as FileSystemDirectoryHandle },
  });
  return { root, control };
}
