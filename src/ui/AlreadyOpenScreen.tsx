import { useEffect, useState } from 'react';

/**
 * Multi-tab blocking screen — spec §8.1/§9.7. Shown when another tab already
 * holds the exclusive database lock. `whenReleased` settles once the owning tab
 * closes; only then is taking over offered, because the SQLite OPFS lock makes a
 * second live connection impossible.
 */
export function AlreadyOpenScreen({ whenReleased }: { whenReleased: Promise<void> }) {
  const [ownerGone, setOwnerGone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void whenReleased.then(() => {
      if (!cancelled) setOwnerGone(true);
    });
    return () => {
      cancelled = true;
    };
  }, [whenReleased]);

  return (
    <main role="alert" className="flex min-h-dvh items-center justify-center p-6">
      <div className="w-full max-w-xl rounded-bb-lg border border-bb-line bg-bb-surface p-8 shadow-bb-raised">
        <p className="text-sm font-semibold tracking-widest text-bb-warn uppercase">Already open</p>
        <h1 className="mt-1 text-2xl font-bold">BangerBox is already open in another tab</h1>
        <p className="mt-3 text-sm leading-relaxed text-bb-muted">
          Project data lives in a single on-device database that only one tab can own at a time. Close the
          other BangerBox tab to continue here.
        </p>
        <div className="mt-6 flex items-center gap-3">
          <button
            type="button"
            data-testid="already-open-takeover"
            disabled={!ownerGone}
            onClick={() => window.location.reload()}
            className="rounded-bb-md bg-bb-accent px-4 py-2 text-sm font-semibold text-bb-bg transition-colors duration-150 hover:bg-bb-accent-strong disabled:cursor-not-allowed disabled:opacity-60"
          >
            {ownerGone ? 'Use BangerBox here' : 'Waiting for the other tab…'}
          </button>
          <span aria-live="polite" className="text-xs text-bb-muted">
            {ownerGone ? 'The other tab has closed.' : 'This screen updates automatically.'}
          </span>
        </div>
      </div>
    </main>
  );
}
