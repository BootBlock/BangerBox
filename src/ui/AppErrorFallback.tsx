import { useRef, useState } from 'react';
import type { FallbackProps } from 'react-error-boundary';
import { projectService } from '@/core/project';
import { disposeDatabase, getDatabaseDriver } from '@/core/storage/client';
import { purgeAllStorage } from '@/core/storage/opfs';

/**
 * Global error boundary fallback — Safe Mode (spec §8.1). The user must never be
 * trapped in a white screen: the rescue actions work even when the React tree
 * above has crashed, because they talk straight to the storage/project layer.
 */

type ResetStage = 'idle' | 'confirming' | 'resetting';

/** Trigger a browser download of raw bytes (the .sqlite rescue — spec §8.1). */
function downloadBytes(bytes: Uint8Array, filename: string): void {
  // A fresh ArrayBuffer-backed copy keeps Blob typing exact regardless of the
  // buffer the worker transferred.
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)]));
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function AppErrorFallback({ error }: FallbackProps) {
  const message = error instanceof Error ? error.message : String(error);
  const [actionNote, setActionNote] = useState<string | null>(null);
  const [resetStage, setResetStage] = useState<ResetStage>('idle');
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Export the active project as a portable `.mpcweb` archive (spec §8.1 / §9.6 rescue). */
  const exportProject = async () => {
    try {
      setActionNote('Packing project export…');
      const blob = await projectService.exportMpcweb();
      const url = URL.createObjectURL(blob);
      try {
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = 'bangerbox-project.mpcweb';
        anchor.click();
      } finally {
        URL.revokeObjectURL(url);
      }
      setActionNote('Project exported. Keep the .mpcweb file safe.');
    } catch (err) {
      setActionNote(`Export failed: ${err instanceof Error ? err.message : String(err)}.`);
    }
  };

  const downloadBackup = async () => {
    try {
      setActionNote('Preparing database backup…');
      const bytes = await getDatabaseDriver().exportBinary();
      downloadBytes(bytes, 'bangerbox-backup.sqlite3');
      setActionNote('Backup downloaded. Keep it safe before resetting.');
    } catch (err) {
      setActionNote(
        `Backup failed: ${err instanceof Error ? err.message : String(err)}. The database may be unreachable.`,
      );
    }
  };

  // Hard reset purges OPFS + database after double confirmation (spec §8.1).
  const hardReset = async () => {
    if (resetStage === 'idle') {
      setResetStage('confirming');
      setActionNote('Hard reset erases every project and sample on this device. Tap again to confirm.');
      confirmTimer.current = setTimeout(() => setResetStage('idle'), 8000);
      return;
    }
    if (resetStage !== 'confirming') return;
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    setResetStage('resetting');
    setActionNote('Erasing on-device data…');
    try {
      // Release the SQLite OPFS lock before deleting its file.
      await disposeDatabase();
      await purgeAllStorage();
    } catch (err) {
      setResetStage('idle');
      setActionNote(`Hard reset failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    window.location.reload();
  };

  return (
    <main role="alert" className="flex min-h-dvh items-center justify-center p-6">
      <div className="w-full max-w-xl rounded-bb-lg border border-bb-line bg-bb-surface p-8 shadow-bb-raised">
        <p className="text-sm font-semibold tracking-widest text-bb-danger uppercase">Safe Mode</p>
        <h1 className="mt-1 text-2xl font-bold">BangerBox hit an unexpected error</h1>
        <p className="mt-3 rounded-bb-sm border border-bb-line bg-bb-raised px-3 py-2 font-mono text-xs text-bb-muted">
          {message}
        </p>

        <p className="mt-4 text-sm leading-relaxed text-bb-muted">
          Your data is still on this device. Rescue it, or reset if the problem persists after reloading.
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-bb-md bg-bb-accent px-4 py-2 text-sm font-semibold text-bb-bg transition-colors duration-150 hover:bg-bb-accent-strong"
          >
            Reload BangerBox
          </button>
          <button
            type="button"
            data-testid="safe-mode-export"
            onClick={() => void exportProject()}
            className="rounded-bb-md border border-bb-line px-4 py-2 text-sm font-semibold text-bb-text transition-colors duration-150 hover:bg-bb-raised"
          >
            Export project (.mpcweb)
          </button>
          <button
            type="button"
            data-testid="safe-mode-backup"
            onClick={() => void downloadBackup()}
            className="rounded-bb-md border border-bb-line px-4 py-2 text-sm font-semibold text-bb-text transition-colors duration-150 hover:bg-bb-raised"
          >
            Download database backup
          </button>
          <button
            type="button"
            data-testid="safe-mode-hard-reset"
            onClick={() => void hardReset()}
            disabled={resetStage === 'resetting'}
            className={
              resetStage === 'confirming'
                ? 'rounded-bb-md bg-bb-danger px-4 py-2 text-sm font-semibold text-bb-bg'
                : 'rounded-bb-md border border-bb-danger px-4 py-2 text-sm font-semibold text-bb-danger transition-colors duration-150 hover:bg-bb-raised disabled:cursor-not-allowed disabled:opacity-60'
            }
          >
            {resetStage === 'confirming' ? 'Tap again to erase everything' : 'Hard reset…'}
          </button>
        </div>

        {actionNote && (
          <p aria-live="polite" className="mt-4 text-xs leading-relaxed text-bb-warn">
            {actionNote}
          </p>
        )}
      </div>
    </main>
  );
}
