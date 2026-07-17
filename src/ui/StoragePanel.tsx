import { useEffect, useState } from 'react';
import { bootDatabase, getDatabaseDriver, type DbBootResult } from '@/core/storage/client';
import { createRepositories } from '@/core/storage/repositories';
import { deleteFile, globalLibraryPath, readFile, writeFileAtomic } from '@/core/storage/opfs';
import {
  checkWriteHeadroom,
  estimateStorage,
  requestPersistentStorage,
  type StorageEstimateResult,
} from '@/core/storage/safeguards';

/**
 * Phase 1 storage foundation panel: boots the database worker (OPFS VFS +
 * migrations), requests persistent storage (spec §9.7), and offers a self-test
 * that proves the full durable path — repository write/read through the worker
 * AND an atomic OPFS file round-trip. The browser smoke drives this control
 * (spec §11.4, Phase 1 exit criterion).
 */
// STUB(phase-7): the state engine (project load/hydrate + the §4.2 stores) now runs at
// boot (src/core/project/session.ts); this diagnostic panel — and the §9.7 eviction
// warning it still hosts — is retired when the Browser/Main modes and the toast-queue
// eviction notice ship in Phase 7 (§8.5). Kept meanwhile as the smoke's storage proof.

export interface StoragePanelApi {
  boot(): Promise<DbBootResult>;
  requestPersist(): Promise<boolean>;
  estimate(): Promise<StorageEstimateResult>;
  runSelfTest(): Promise<string>;
}

/** Production implementation over the real worker driver, repositories, and OPFS. */
export const storagePanelBrowserApi: StoragePanelApi = {
  boot: bootDatabase,
  requestPersist: requestPersistentStorage,
  estimate: estimateStorage,

  async runSelfTest(): Promise<string> {
    // Quota hard-stop check runs before any storage-growing write (spec §9.7).
    const probeBytes = new TextEncoder().encode('BangerBox OPFS self-test payload');
    const headroom = await checkWriteHeadroom(probeBytes.byteLength);
    if (!headroom.allowed) {
      throw new Error('Storage is nearly full (90 % quota hard-stop) — free space and retry.');
    }

    // Repository round-trip through the real worker (SQLite on the OPFS VFS).
    const repos = createRepositories(getDatabaseDriver());
    const project = await repos.projects.create({ name: 'Storage self-test' });
    try {
      const readBack = await repos.projects.getById(project.id);
      if (readBack?.name !== 'Storage self-test' || readBack.sample_rate !== 48000) {
        throw new Error('Project row did not read back intact from SQLite.');
      }

      // Atomic OPFS file round-trip through the typed wrapper (spec §9.1/§9.7).
      const testPath = globalLibraryPath(`self-test-${project.id}`);
      await writeFileAtomic(testPath, probeBytes);
      try {
        const file = await readFile(testPath);
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (bytes.length !== probeBytes.length || !bytes.every((b, i) => b === probeBytes[i])) {
          throw new Error('OPFS file did not read back byte-identical.');
        }
      } finally {
        await deleteFile(testPath);
      }
    } finally {
      await repos.projects.remove(project.id);
    }

    return 'Project row and OPFS file both round-tripped through the durable layer.';
  },
};

type PanelStatus = 'booting' | 'ready' | 'failed';
type SelfTestStatus = 'idle' | 'running' | 'passed' | 'failed';

const integerFormat = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });

function formatMebibytes(bytes: number): string {
  return `${integerFormat.format(bytes / (1024 * 1024))} MiB`;
}

export function StoragePanel({ apiOverride }: { apiOverride?: StoragePanelApi }) {
  const api = apiOverride ?? storagePanelBrowserApi;

  const [status, setStatus] = useState<PanelStatus>('booting');
  const [bootDetail, setBootDetail] = useState('Opening the on-device database…');
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [evictionWarningDismissed, setEvictionWarningDismissed] = useState(false);
  const [estimate, setEstimate] = useState<StorageEstimateResult | null>(null);
  const [testStatus, setTestStatus] = useState<SelfTestStatus>('idle');
  const [testDetail, setTestDetail] = useState('Not yet run.');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await api.boot();
        // First-run persistence request (spec §9.7) happens right after boot.
        const persistedNow = await api.requestPersist();
        const usage = await api.estimate();
        if (cancelled) return;
        setStatus('ready');
        setBootDetail(
          `SQLite ${result.diagnostics.sqliteVersion} on the ${result.diagnostics.vfs.toUpperCase()} VFS · schema v${result.diagnostics.userVersion}`,
        );
        setPersisted(persistedNow);
        setEstimate(usage);
      } catch (error) {
        if (cancelled) return;
        setStatus('failed');
        setBootDetail(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

  const runSelfTest = async () => {
    setTestStatus('running');
    setTestDetail('Writing and reading back through SQLite and OPFS…');
    try {
      const summary = await api.runSelfTest();
      setTestStatus('passed');
      setTestDetail(summary);
    } catch (error) {
      setTestStatus('failed');
      setTestDetail(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <section aria-labelledby="storage-panel-heading" className="mt-6">
      <h3 id="storage-panel-heading" className="text-sm font-semibold">
        Storage foundation
      </h3>
      <p className="mt-1 text-xs leading-relaxed text-bb-muted">
        Project data lives in an on-device SQLite database; audio lives in the Origin Private File System.
        Nothing leaves this device.
      </p>

      <div className="mt-3 flex items-center gap-3">
        <span
          data-testid="storage-panel-status"
          data-status={status}
          className={
            status === 'ready'
              ? 'text-sm font-semibold text-bb-ok'
              : status === 'failed'
                ? 'text-sm font-semibold text-bb-danger'
                : 'text-sm text-bb-muted'
          }
        >
          {status === 'booting' ? 'Starting…' : status === 'ready' ? 'Ready' : 'Failed'}
        </span>
        <span data-testid="storage-panel-detail" className="text-xs text-bb-muted">
          {bootDetail}
        </span>
      </div>

      {status === 'ready' && (
        <dl className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div className="flex items-center justify-between gap-2 rounded-bb-sm border border-bb-line bg-bb-raised px-3 py-2 text-xs">
            <dt className="text-bb-text">Protected from eviction</dt>
            <dd
              data-testid="storage-persisted"
              className={persisted ? 'font-semibold text-bb-ok' : 'font-semibold text-bb-warn'}
            >
              {persisted ? 'Yes' : 'Not granted'}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-2 rounded-bb-sm border border-bb-line bg-bb-raised px-3 py-2 text-xs">
            <dt className="text-bb-text">Storage used</dt>
            <dd className="font-semibold text-bb-text">
              {estimate?.supported
                ? `${formatMebibytes(estimate.usage)} of ${formatMebibytes(estimate.quota)}`
                : 'Unknown'}
            </dd>
          </div>
        </dl>
      )}

      {status === 'ready' && persisted === false && !evictionWarningDismissed && (
        <div
          role="note"
          className="mt-3 flex items-start justify-between gap-3 rounded-bb-sm border border-bb-warn/40 bg-bb-raised px-3 py-2 text-xs text-bb-warn"
        >
          <p className="leading-relaxed">
            The browser declined persistent storage, so it may evict project data under storage pressure.
            Installing BangerBox as an app usually grants protection.
          </p>
          <button
            type="button"
            onClick={() => setEvictionWarningDismissed(true)}
            className="shrink-0 rounded-bb-sm border border-bb-line px-2 py-1 font-semibold text-bb-text transition-colors duration-150 hover:bg-bb-surface"
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          data-testid="storage-self-test-run"
          onClick={() => void runSelfTest()}
          disabled={status !== 'ready' || testStatus === 'running'}
          className="rounded-bb-md bg-bb-accent px-4 py-2 text-sm font-semibold text-bb-bg transition-colors duration-150 hover:bg-bb-accent-strong disabled:cursor-not-allowed disabled:opacity-60"
        >
          {testStatus === 'running' ? 'Running…' : 'Run storage self-test'}
        </button>
        <span
          data-testid="storage-self-test-status"
          data-status={testStatus}
          className={
            testStatus === 'passed'
              ? 'text-sm font-semibold text-bb-ok'
              : testStatus === 'failed'
                ? 'text-sm font-semibold text-bb-danger'
                : 'text-sm text-bb-muted'
          }
        >
          {testStatus === 'idle' ? 'Idle' : testStatus.charAt(0).toUpperCase() + testStatus.slice(1)}
        </span>
      </div>
      <p aria-live="polite" data-testid="storage-self-test-detail" className="mt-2 text-xs text-bb-muted">
        {testDetail}
      </p>
    </section>
  );
}
