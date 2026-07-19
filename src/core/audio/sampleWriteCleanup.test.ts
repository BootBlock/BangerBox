/**
 * A failed sample write leaves nothing behind (spec §9.6 transactionality, §9.4).
 *
 * `saveChannelsAsSample` is three separate writes — OPFS file, metadata row, tags — with no
 * transaction spanning them, and it is the shared path for import, destructive sample edits and
 * Looper captures. A failure between the file and the row would orphan a WAV that nothing
 * references and the §8.5.7 purge cannot find; a failure on the tags would leave a sample in the
 * Browser that its caller believes was never created. Each step therefore undoes the ones before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const writeFileStreamed = vi.fn(() => Promise.resolve());
const deleteFile = vi.fn(() => Promise.resolve());

vi.mock('@/core/storage/opfs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/storage/opfs')>();
  return {
    ...actual,
    writeFileStreamed: (path: string, bytes: Uint8Array) => writeFileStreamed(path, bytes),
    deleteFile: (path: string) => deleteFile(path),
  };
});

/** A Worker stand-in that answers every encode request with empty WAV bytes. */
class EchoWorker {
  #listener: ((event: MessageEvent) => void) | null = null;
  addEventListener(_type: string, listener: (event: MessageEvent) => void) {
    this.#listener = listener;
  }
  postMessage(request: { id: number }) {
    queueMicrotask(() =>
      this.#listener?.({ data: { id: request.id, ok: true, bytes: new Uint8Array(0) } } as MessageEvent),
    );
  }
}

const { saveChannelsAsSample } = await import('./sampleImport');

const create = vi.fn((row: unknown) => Promise.resolve(row));
const setTags = vi.fn(() => Promise.resolve());
const remove = vi.fn(() => Promise.resolve());

function context() {
  return {
    repos: { samples: { create, setTags, remove } },
    projectId: 'p1',
    projectBitDepth: '16',
  } as unknown as Parameters<typeof saveChannelsAsSample>[4];
}

function save(): Promise<unknown> {
  return saveChannelsAsSample([new Float32Array(4)], 48000, 'Kick', ['drum'], context());
}

beforeEach(() => {
  writeFileStreamed.mockClear();
  deleteFile.mockClear();
  create.mockClear();
  setTags.mockClear();
  remove.mockClear();
  vi.stubGlobal('Worker', EchoWorker);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('saveChannelsAsSample cleanup (spec §9.6)', () => {
  it('deletes the written file when the metadata row fails', async () => {
    create.mockRejectedValueOnce(new Error('constraint failed'));

    await expect(save()).rejects.toThrow('constraint failed');

    // The bytes are already in OPFS and no row will ever name them, so nothing but this
    // delete can reclaim the quota they hold.
    expect(deleteFile).toHaveBeenCalledWith(writeFileStreamed.mock.calls[0]![0]);
  });

  it('removes the row and the file when the tag write fails', async () => {
    setTags.mockRejectedValueOnce(new Error('tags failed'));

    await expect(save()).rejects.toThrow('tags failed');

    expect(remove).toHaveBeenCalledTimes(1);
    expect(deleteFile).toHaveBeenCalledWith(writeFileStreamed.mock.calls[0]![0]);
  });

  it('reports the original failure, not a cleanup failure', async () => {
    create.mockRejectedValueOnce(new Error('constraint failed'));
    deleteFile.mockRejectedValueOnce(new Error('delete failed'));

    // The caller needs to know WHY the import failed; a cleanup error masking it would send
    // them looking in the wrong place.
    await expect(save()).rejects.toThrow('constraint failed');
  });

  it('deletes nothing on a successful write', async () => {
    await save();

    expect(create).toHaveBeenCalledTimes(1);
    expect(setTags).toHaveBeenCalledTimes(1);
    expect(deleteFile).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
});
