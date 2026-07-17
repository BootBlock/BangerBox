/**
 * Blocking capability screen — spec §2.1. Rendered instead of the app when a hard
 * requirement is missing: friendly, styled, and explains exactly what is missing and
 * which browser to use. Nothing else loads behind it.
 */
export function CapabilityGate({ missing }: { missing: readonly string[] }) {
  return (
    <main role="alert" className="flex min-h-dvh items-center justify-center p-6">
      <div className="w-full max-w-xl rounded-bb-lg border border-bb-line bg-bb-surface p-8 shadow-bb-raised">
        <p className="text-sm font-semibold tracking-widest text-bb-danger uppercase">Unsupported browser</p>
        <h1 className="mt-1 text-2xl font-bold">BangerBox can&rsquo;t run here yet</h1>
        <p className="mt-3 text-sm leading-relaxed text-bb-muted">
          BangerBox is a full digital audio workstation that runs entirely in your browser. It needs a modern
          Chromium browser — <strong className="text-bb-text">Microsoft Edge</strong> or{' '}
          <strong className="text-bb-text">Google Chrome</strong> (version 120 or newer) on desktop Windows.
          Firefox and Safari are not supported.
        </p>
        <h2 className="mt-6 text-sm font-semibold">This environment is missing:</h2>
        <ul className="mt-2 space-y-1.5">
          {missing.map((label) => (
            <li
              key={label}
              className="rounded-bb-sm border border-bb-line bg-bb-raised px-3 py-2 text-sm text-bb-text"
            >
              {label}
            </li>
          ))}
        </ul>
        <p className="mt-6 text-xs leading-relaxed text-bb-muted">
          If cross-origin isolation is the only missing item, the app is probably being served without its
          COOP/COEP headers — launch it with <code>npm run dev</code> or <code>npm run preview</code>.
        </p>
      </div>
    </main>
  );
}
