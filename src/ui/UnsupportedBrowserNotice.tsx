import { useState } from 'react';
import type { BrowserInfo } from '@/core/platform/capabilities';
import { LINKS } from '@/core/platform/links';
import { Button } from './primitives';

const DISMISS_KEY = 'bangerbox-browser-notice-dismissed';

function wasDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    // Storage blocked — show the notice. Repeating it is a smaller failure than
    // silently hiding a warning the user has never actually seen.
    return false;
  }
}

function rememberDismissed(): void {
  try {
    localStorage.setItem(DISMISS_KEY, '1');
  } catch {
    /* Storage blocked: the notice returns next load. Acceptable. */
  }
}

/**
 * Non-blocking unsupported-browser warning (spec §1.3 #15).
 *
 * The §2.1 gate is capability-based and nothing else — a browser that can do everything
 * the app needs gets in, whatever its name. Firefox currently passes, so it runs. But
 * "passes the feature probes" is not the same as "tested", and untested engines will
 * have rough edges nobody has looked for. This says so once, plainly, and then gets out
 * of the way: dismissible, remembered, and never blocking.
 */
export function UnsupportedBrowserNotice({ browser }: { browser: BrowserInfo }) {
  const [dismissed, setDismissed] = useState(wasDismissed);

  if (browser.supported || dismissed) return null;

  function dismiss() {
    rememberDismissed();
    setDismissed(true);
  }

  return (
    <div
      role="status"
      data-testid="unsupported-browser-notice"
      className="fixed inset-x-0 bottom-0 z-50 flex justify-center p-3"
    >
      <div className="flex w-full max-w-2xl items-start gap-3 rounded-bb-md border border-bb-warn/40 bg-bb-surface px-4 py-3 shadow-bb-raised">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-bb-text">{browser.name} isn’t supported yet</p>
          <p className="mt-1 text-sm leading-relaxed text-bb-muted">
            BangerBox runs, but it’s only built and tested on Microsoft Edge and Google Chrome, so expect
            rough edges here — and please don’t trust it with work you can’t afford to lose. Hitting problems?{' '}
            <a
              href={LINKS.troubleshooting}
              target="_blank"
              rel="noreferrer noopener"
              className="font-semibold text-bb-accent underline underline-offset-2 hover:text-bb-accent-strong"
            >
              Troubleshooting guide
            </a>{' '}
            ·{' '}
            <a
              href={LINKS.newIssue}
              target="_blank"
              rel="noreferrer noopener"
              className="font-semibold text-bb-accent underline underline-offset-2 hover:text-bb-accent-strong"
            >
              Report an issue
            </a>
          </p>
        </div>
        <Button label="Got it" onClick={dismiss} data-testid="unsupported-browser-dismiss" />
      </div>
    </div>
  );
}
