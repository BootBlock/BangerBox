import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkWriteHeadroom, estimateStorage, requestPersistentStorage } from './safeguards';

type StorageManagerStub = Partial<{
  estimate: () => Promise<{ usage?: number; quota?: number }>;
  persist: () => Promise<boolean>;
  persisted: () => Promise<boolean>;
}>;

function stubStorage(stub: StorageManagerStub | undefined) {
  vi.stubGlobal('navigator', { ...navigator, storage: stub });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('estimateStorage', () => {
  it('reports usage, quota, and ratio', async () => {
    stubStorage({ estimate: async () => ({ usage: 250, quota: 1000 }) });
    await expect(estimateStorage()).resolves.toEqual({
      usage: 250,
      quota: 1000,
      ratio: 0.25,
      supported: true,
    });
  });

  it('degrades safely when the API is missing or throws', async () => {
    stubStorage(undefined);
    await expect(estimateStorage()).resolves.toMatchObject({ supported: false });

    stubStorage({
      estimate: async () => {
        throw new Error('nope');
      },
    });
    await expect(estimateStorage()).resolves.toMatchObject({ supported: false });
  });
});

describe('requestPersistentStorage', () => {
  it('short-circuits when already persisted', async () => {
    const persist = vi.fn(async () => true);
    stubStorage({ persisted: async () => true, persist });
    await expect(requestPersistentStorage()).resolves.toBe(true);
    expect(persist).not.toHaveBeenCalled();
  });

  it('requests persistence and reports refusal', async () => {
    stubStorage({ persisted: async () => false, persist: async () => false });
    await expect(requestPersistentStorage()).resolves.toBe(false);
  });

  it('returns false when the API is missing', async () => {
    stubStorage(undefined);
    await expect(requestPersistentStorage()).resolves.toBe(false);
  });
});

describe('checkWriteHeadroom (spec §9.7 hard stop)', () => {
  it('allows writes that stay within 90 % of quota', async () => {
    stubStorage({ estimate: async () => ({ usage: 100, quota: 1000 }) });
    await expect(checkWriteHeadroom(800)).resolves.toMatchObject({ allowed: true });
  });

  it('refuses writes that would breach the hard stop', async () => {
    stubStorage({ estimate: async () => ({ usage: 100, quota: 1000 }) });
    await expect(checkWriteHeadroom(801)).resolves.toMatchObject({ allowed: false });
  });

  it('allows when the estimate API is unavailable (nothing to check against)', async () => {
    stubStorage(undefined);
    await expect(checkWriteHeadroom(10_000_000)).resolves.toMatchObject({
      allowed: true,
      supported: false,
    });
  });
});
