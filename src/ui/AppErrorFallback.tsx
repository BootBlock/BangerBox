import type { FallbackProps } from 'react-error-boundary';

/**
 * Global error boundary fallback — the user must never be trapped in a white screen
 * (spec §8.1).
 */
// STUB(phase-1): grow into the full Safe Mode of §8.1 (export .mpcweb, download raw
// SQLite binary, hard reset) once the storage layer exists.
export function AppErrorFallback({ error }: FallbackProps) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <main role="alert" className="flex min-h-dvh items-center justify-center p-6">
      <div className="w-full max-w-xl rounded-bb-lg border border-bb-line bg-bb-surface p-8 shadow-bb-raised">
        <p className="text-sm font-semibold tracking-widest text-bb-danger uppercase">Something went wrong</p>
        <h1 className="mt-1 text-2xl font-bold">BangerBox hit an unexpected error</h1>
        <p className="mt-3 rounded-bb-sm border border-bb-line bg-bb-raised px-3 py-2 font-mono text-xs text-bb-muted">
          {message}
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-6 rounded-bb-md bg-bb-accent px-4 py-2 text-sm font-semibold text-bb-bg transition-colors duration-150 hover:bg-bb-accent-strong"
        >
          Reload BangerBox
        </button>
      </div>
    </main>
  );
}
