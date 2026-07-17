/**
 * Fake StoragePanel seam for unit tests — an instantly-ready durable layer (the
 * production api needs the real worker, OPFS, and WASM; spec §11.3).
 */
import type { StoragePanelApi } from '@/ui/StoragePanel';

export function fakeStorageApi(overrides: Partial<StoragePanelApi> = {}): StoragePanelApi {
  return {
    boot: async () => ({
      diagnostics: {
        sqliteVersion: '3.50.0',
        vfs: 'opfs',
        opfs: true,
        userVersion: 1,
        filename: '/bangerbox.sqlite3',
      },
      migration: { from: 0, to: 1, applied: [1] },
    }),
    requestPersist: async () => true,
    estimate: async () => ({ usage: 1024, quota: 1024 * 1024, ratio: 0.001, supported: true }),
    runSelfTest: async () => 'ok',
    ...overrides,
  };
}
