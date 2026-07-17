import {
  SOFT_CAPABILITY_LABELS,
  type CapabilityReport,
  type SoftCapabilities,
} from '@/core/platform/capabilities';
import { EngineSelfTest } from '@/ui/EngineSelfTest';
import { PwaUpdatePrompt } from '@/ui/PwaUpdatePrompt';
import type { PwaUpdateApi } from '@/ui/usePwaUpdate';

interface AppProps {
  capabilities: CapabilityReport;
  /** Test seam for the PWA update flow; production uses the browser seam. */
  pwaApiOverride?: PwaUpdateApi;
}

/** Explanatory tooltip copy for soft capabilities — spec §2.1 (missing ⇒ disabled with tooltip). */
const SOFT_CAPABILITY_EXPLANATIONS: Readonly<Record<keyof SoftCapabilities, string>> = {
  bluetooth: 'Connects the BLE-MIDI hardware controller. Requires Web Bluetooth (Chromium).',
  microphone: 'Records the Looper from a microphone. Requires media device access.',
  persistentStorage: 'Asks the browser to protect project data from eviction.',
  wakeLock: 'Keeps the screen awake while the transport is playing or recording.',
};

/**
 * Phase 0 application shell: wordmark, version, soft-capability summary, and the
 * engine self-test. The 12-mode surface (§8.5) arrives in later phases.
 */
export function App({ capabilities, pwaApiOverride }: AppProps) {
  const softEntries = (Object.keys(SOFT_CAPABILITY_LABELS) as (keyof SoftCapabilities)[]).map((key) => ({
    key,
    label: SOFT_CAPABILITY_LABELS[key],
    explanation: SOFT_CAPABILITY_EXPLANATIONS[key],
    available: capabilities.soft[key],
  }));

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex items-center justify-between border-b border-bb-line bg-bb-surface px-6 py-3">
        <h1 className="text-lg font-bold tracking-tight">
          Banger<span className="text-bb-accent">Box</span>
        </h1>
        <span className="rounded-bb-sm border border-bb-line bg-bb-raised px-2 py-0.5 text-xs text-bb-muted">
          v{__APP_VERSION__}
        </span>
      </header>

      <main className="flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-xl rounded-bb-lg border border-bb-line bg-bb-surface p-8 shadow-bb-raised">
          <p className="text-sm font-semibold tracking-widest text-bb-accent uppercase">Phase 0</p>
          <h2 className="mt-1 text-2xl font-bold">Verified empty shell</h2>
          <p className="mt-2 text-sm leading-relaxed text-bb-muted">
            The toolchain, offline PWA shell, capability gate, and WASM worklet pipeline are in place. The
            instrument arrives in the phases ahead.
          </p>

          <section aria-labelledby="soft-capabilities-heading" className="mt-6">
            <h3 id="soft-capabilities-heading" className="text-sm font-semibold">
              Optional device features
            </h3>
            <ul className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {softEntries.map((entry) => (
                <li
                  key={entry.key}
                  title={entry.explanation}
                  className="flex items-center justify-between gap-2 rounded-bb-sm border border-bb-line bg-bb-raised px-3 py-2 text-xs"
                >
                  <span className="text-bb-text">{entry.label}</span>
                  <span
                    className={entry.available ? 'font-semibold text-bb-ok' : 'font-semibold text-bb-muted'}
                  >
                    {entry.available ? 'Available' : 'Unavailable'}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <EngineSelfTest />
        </div>
      </main>

      <PwaUpdatePrompt apiOverride={pwaApiOverride} />
    </div>
  );
}
