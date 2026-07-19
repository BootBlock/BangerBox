/**
 * The §9.7 quota hard stop on the paths that actually grow storage (issue #23). The check itself
 * is unit-tested in `storage/safeguards.test.ts`; what is pinned here is that the shared write
 * choke points CALL it, and that a refusal happens BEFORE any byte reaches OPFS — near quota the
 * user must get the purge prompt, not a raw QuotaExceededError out of the worker.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const writeFileStreamed = vi.fn(() => Promise.resolve());

vi.mock('@/core/storage/opfs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/storage/opfs')>();
  return {
    ...actual,
    writeFileStreamed: (path: string, bytes: Uint8Array) => writeFileStreamed(path, bytes),
  };
});

/** A Worker stand-in answering every encode request with a fixed-size WAV payload. */
class EchoWorker {
  #listener: ((event: MessageEvent) => void) | null = null;
  addEventListener(_type: string, listener: (event: MessageEvent) => void) {
    this.#listener = listener;
  }
  postMessage(request: { id: number }) {
    queueMicrotask(() =>
      this.#listener?.({ data: { id: request.id, ok: true, bytes: new Uint8Array(1000) } } as MessageEvent),
    );
  }
}

const { saveChannelsAsSample } = await import('./sampleImport');
const { StorageHeadroomError } = await import('@/core/storage/safeguards');

function context() {
  return {
    repos: {
      samples: { create: (row: unknown) => Promise.resolve(row), setTags: () => Promise.resolve() },
    },
    projectId: 'p1',
    projectBitDepth: '16',
  } as unknown as Parameters<typeof saveChannelsAsSample>[4];
}

/** Stub `navigator.storage.estimate` at a given usage against a 10 000-byte quota. */
function stubQuota(usage: number) {
  vi.stubGlobal('navigator', {
    storage: { estimate: () => Promise.resolve({ usage, quota: 10_000 }) },
  });
}

beforeEach(() => {
  writeFileStreamed.mockClear();
  vi.stubGlobal('Worker', EchoWorker);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('saveChannelsAsSample headroom gate (spec §9.7)', () => {
  it('refuses the write when the encoded payload would breach 90 % of quota', async () => {
    // 8 100 used + 1 000 encoded = 91 % of 10 000, just past the hard stop.
    stubQuota(8100);
    await expect(
      saveChannelsAsSample([new Float32Array(4)], 48000, 'Kick', [], context()),
    ).rejects.toBeInstanceOf(StorageHeadroomError);
  });

  it('leaves nothing half-written when it refuses', async () => {
    stubQuota(8100);
    await expect(saveChannelsAsSample([new Float32Array(4)], 48000, 'Kick', [], context())).rejects.toThrow();
    expect(writeFileStreamed).not.toHaveBeenCalled();
  });

  it('names the purge route so the refusal is actionable, not a dead end', async () => {
    stubQuota(8100);
    await expect(saveChannelsAsSample([new Float32Array(4)], 48000, 'Kick', [], context())).rejects.toThrow(
      /Purge unused samples/,
    );
  });

  it('allows the write with room to spare', async () => {
    // 8 000 used + 1 000 encoded = 90 % exactly, which the hard stop permits.
    stubQuota(8000);
    await saveChannelsAsSample([new Float32Array(4)], 48000, 'Kick', [], context());
    expect(writeFileStreamed).toHaveBeenCalledTimes(1);
  });
});
