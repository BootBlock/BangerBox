import { afterEach, describe, expect, it } from 'vitest';
import {
  bouncePath,
  deleteDirectory,
  deleteFile,
  fileExists,
  globalLibraryPath,
  purgeAllStorage,
  readFile,
  sampleCandidatePaths,
  samplePath,
  splitOpfsPath,
  writeFileAtomic,
} from './opfs';
import { installFakeOpfs } from '@/test/fakes/opfs';

describe('OPFS path building (spec §9.1)', () => {
  it('builds the strict §9.1 layout', () => {
    expect(samplePath('p1', 's1')).toBe('/projects/p1/samples/s1.wav');
    expect(bouncePath('p1', 'mixdown')).toBe('/projects/p1/bounces/mixdown.wav');
    expect(globalLibraryPath('s2')).toBe('/global_library/s2.wav');
  });

  // A §6 program payload records only a sampleId, and §9.3 lets that row live in either root.
  // Reconstructing the project path alone made every global-library sample assigned to a pad
  // silent, with no error — the read failed and the note was skipped.
  it('offers both §9.1 roots for a sample a program plays, project first', () => {
    expect(sampleCandidatePaths('p1', 's1')).toEqual([
      '/projects/p1/samples/s1.wav',
      '/global_library/s1.wav',
    ]);
  });

  it('splits canonical paths into segments', () => {
    expect(splitOpfsPath('/projects/p1/samples/s1.wav')).toEqual(['projects', 'p1', 'samples', 's1.wav']);
    expect(splitOpfsPath('global_library/s.wav')).toEqual(['global_library', 's.wav']);
  });

  it('rejects traversal and malformed paths', () => {
    expect(() => splitOpfsPath('/projects/../etc')).toThrow(/Invalid OPFS path/);
    expect(() => splitOpfsPath('//double')).toThrow(/Invalid OPFS path/);
    expect(() => splitOpfsPath('/a/./b')).toThrow(/Invalid OPFS path/);
    expect(() => splitOpfsPath('')).toThrow(/Invalid OPFS path/);
  });
});

// Real handle operations against a real OPFS are proven by the browser smoke (spec §11.4,
// §13.5). What is unit-tested here is the *policy* around them — which failures propagate
// and which are read as "already absent" (issue #98) — driven by the in-memory fake.
describe('OPFS handle operations (spec §9.1, §9.7)', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis.navigator, 'storage');
  });

  it('writes bytes atomically and leaves no temp artefact behind', async () => {
    const { root } = installFakeOpfs();
    await writeFileAtomic('/projects/p1/samples/s1.wav', new Uint8Array([1, 2, 3]));

    expect(root.read('/projects/p1/samples/s1.wav')).toEqual(new Uint8Array([1, 2, 3]));
    expect(root.list('/projects/p1/samples')).toEqual(['s1.wav']);
  });

  it('leaves the destination intact and no temp behind when the write fails (spec §9.7)', async () => {
    const { root, control } = installFakeOpfs();
    await writeFileAtomic('/projects/p1/samples/s1.wav', new Uint8Array([9]));

    control.writeError = new Error('disk fell over');
    await expect(writeFileAtomic('/projects/p1/samples/s1.wav', new Uint8Array([1, 2]))).rejects.toThrow(
      /disk fell over/,
    );

    expect(root.read('/projects/p1/samples/s1.wav')).toEqual(new Uint8Array([9]));
    expect(root.list('/projects/p1/samples')).toEqual(['s1.wav']);
  });

  it('reads a written file back', async () => {
    installFakeOpfs();
    await writeFileAtomic('/global_library/s2.wav', new Uint8Array([4, 5]));
    const file = await readFile('/global_library/s2.wav');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([4, 5]));
  });

  it('creates missing directories on the way to a new file', async () => {
    installFakeOpfs();
    await writeFileAtomic('/projects/deep/samples/s1.wav', new Uint8Array([7]));
    expect(await fileExists('/projects/deep/samples/s1.wav')).toBe(true);
  });

  it('reports presence and absence', async () => {
    installFakeOpfs();
    expect(await fileExists('/global_library/s2.wav')).toBe(false);
    await writeFileAtomic('/global_library/s2.wav', new Uint8Array([1]));
    expect(await fileExists('/global_library/s2.wav')).toBe(true);
  });

  // Issue #98: a catch-all made an I/O or permissions failure indistinguishable from
  // "absent", so a caller could not tell "not there" from "could not tell".
  it('propagates a non-NotFoundError from fileExists rather than reporting absent', async () => {
    const { control } = installFakeOpfs();
    const boom = new DOMException('no', 'NotAllowedError');
    control.directoryError = { name: 'global_library', error: boom };
    await expect(fileExists('/global_library/s2.wav')).rejects.toBe(boom);
  });

  it('treats a missing file as already deleted', async () => {
    installFakeOpfs();
    await expect(deleteFile('/global_library/gone.wav')).resolves.toBeUndefined();
  });

  it('propagates a non-NotFoundError from deleteFile rather than reporting deleted', async () => {
    const { root, control } = installFakeOpfs();
    await writeFileAtomic('/global_library/s1.wav', new Uint8Array([1]));
    const boom = new DOMException('locked', 'NoModificationAllowedError');
    control.removeError = { name: 's1.wav', error: boom };

    await expect(deleteFile('/global_library/s1.wav')).rejects.toBe(boom);
    // The file really is still there — the caller must not be told it is gone.
    expect(root.read('/global_library/s1.wav')).toBeDefined();
  });

  it('refuses to delete outside the two content roots', async () => {
    installFakeOpfs();
    await expect(deleteFile('/bangerbox.sqlite3')).rejects.toThrow(/Refusing to delete/);
  });

  it('treats a missing directory as already deleted', async () => {
    installFakeOpfs();
    await expect(deleteDirectory('/projects/p1/gone')).resolves.toBeUndefined();
  });

  it('propagates a non-NotFoundError from deleteDirectory', async () => {
    const { control } = installFakeOpfs();
    await writeFileAtomic('/projects/p1/samples/s1.wav', new Uint8Array([1]));
    const boom = new DOMException('busy', 'NoModificationAllowedError');
    control.removeError = { name: 'samples', error: boom };
    await expect(deleteDirectory('/projects/p1/samples')).rejects.toBe(boom);
  });

  it('purges every top-level entry (Safe Mode hard reset — spec §8.1)', async () => {
    const { root } = installFakeOpfs();
    await writeFileAtomic('/projects/p1/samples/s1.wav', new Uint8Array([1]));
    await writeFileAtomic('/global_library/s2.wav', new Uint8Array([2]));
    await purgeAllStorage();
    expect(root.list('/')).toEqual([]);
  });
});
