import { useState, type ReactNode } from 'react';
import type { CapabilityReport, HardCapabilities } from '@/core/platform/capabilities';
import { LINKS } from '@/core/platform/links';
import { Button } from './primitives';

/**
 * Blocking capability screen — spec §2.1. Rendered instead of the app when a hard
 * requirement is missing. Nothing else loads behind it.
 *
 * Written for the person who just wanted to make some music, not for a developer. Three
 * rules follow from that:
 *
 *   1. LEAD WITH THE FIX, NOT THE FAULT. By far the most common reason to land here is
 *      that cross-origin isolation has not settled yet — which one reload cures. That
 *      case gets its own headline and a button, rather than being buried under a list of
 *      API names the reader has no way to act on.
 *   2. BE SPECIFIC PER ITEM. Every missing requirement explains what it costs the user
 *      and what to try, individually. A single blanket "unsupported browser" is a dead
 *      end for anyone who cannot read the API names.
 *   3. ALWAYS OFFER A WAY OUT. The wiki's troubleshooting guides and the issue tracker
 *      are on screen, plus one-click diagnostics so a bug report is actually useful.
 */

/** Requirements browsers switch off together until the page is cross-origin isolated. */
const ISOLATION_KEYS: readonly (keyof HardCapabilities)[] = [
  'crossOriginIsolated',
  'sharedArrayBuffer',
  'atomics',
];

export function CapabilityGate({ report }: { report: CapabilityReport }) {
  const [copied, setCopied] = useState(false);

  const missingKeys = (Object.keys(report.hard) as (keyof HardCapabilities)[]).filter(
    (key) => !report.hard[key],
  );

  // Everything missing is isolation-related ⇒ a reload very probably fixes it and the
  // browser itself is fine. Worth saying loudly, rather than implying the user has to go
  // and install a different browser.
  const isolationOnly = missingKeys.length > 0 && missingKeys.every((key) => ISOLATION_KEYS.includes(key));

  async function copyDiagnostics() {
    const lines = [
      'BangerBox diagnostics',
      `Page: ${window.location.href}`,
      `Browser: ${report.browser.name} (${report.browser.engine})`,
      `User agent: ${navigator.userAgent}`,
      `Secure context: ${String(window.isSecureContext)}`,
      `Service worker: ${'serviceWorker' in navigator ? 'available' : 'unavailable'}`,
      '',
      'Missing requirements:',
      ...report.missingHardDetails.map((detail) => `  - ${detail.title} (${detail.technical})`),
    ];
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 3000);
    } catch {
      // Clipboard blocked — it needs a secure context and permission. Everything in it is
      // visible on screen anyway, so there is nothing to recover; just don't claim success.
      setCopied(false);
    }
  }

  return (
    <main role="alert" className="flex min-h-dvh items-center justify-center p-6">
      <div className="w-full max-w-2xl rounded-bb-lg border border-bb-line bg-bb-surface p-8 shadow-bb-raised">
        <p className="text-sm font-semibold tracking-widest text-bb-warn uppercase">
          {isolationOnly ? 'Almost there' : 'Can’t start'}
        </p>
        <h1 className="mt-1 text-2xl font-bold">
          {isolationOnly ? 'BangerBox needs one more reload' : 'BangerBox can’t start in this browser'}
        </h1>

        {isolationOnly ? (
          <p className="mt-3 text-sm leading-relaxed text-bb-muted">
            Nothing is broken. The first time you open BangerBox it has to switch the page into a secure mode
            that lets it process audio, and that only takes effect after a reload.
          </p>
        ) : (
          <p className="mt-3 text-sm leading-relaxed text-bb-muted">
            BangerBox is a complete music studio that runs entirely on your device — nothing is uploaded. That
            needs a few modern browser features, and some of them aren’t available here. Each one is listed
            below with what to try.
          </p>
        )}

        {isolationOnly && (
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <Button
              label="Reload the page"
              variant="accent"
              size="lg"
              data-testid="capability-gate-reload"
              onClick={() => window.location.reload()}
            />
            <span className="text-xs text-bb-muted">If this screen comes back after reloading, read on.</span>
          </div>
        )}

        <h2 className="mt-8 text-sm font-semibold">
          {isolationOnly ? 'What isn’t ready yet' : 'What’s missing, and what to try'}
        </h2>
        <ul className="mt-3 space-y-3">
          {report.missingHardDetails.map((detail) => (
            <li key={detail.technical} className="rounded-bb-sm border border-bb-line bg-bb-raised px-4 py-3">
              <p className="text-sm font-semibold text-bb-text">{detail.title}</p>
              <p className="mt-1 text-sm leading-relaxed text-bb-muted">{detail.what}</p>
              <p className="mt-2 text-sm leading-relaxed text-bb-text">
                <span className="font-semibold">Try this: </span>
                {detail.fix}
              </p>
              <p className="mt-2 font-mono text-[11px] text-bb-muted">{detail.technical}</p>
            </li>
          ))}
        </ul>

        {!report.browser.supported && (
          <p className="mt-6 rounded-bb-sm border border-bb-line bg-bb-raised px-4 py-3 text-sm leading-relaxed text-bb-muted">
            <span className="font-semibold text-bb-text">You’re using {report.browser.name}.</span> BangerBox
            is built and tested on Microsoft Edge and Google Chrome (version 120 or newer) on desktop Windows.
            Other browsers may still work, but aren’t supported yet — if the steps above don’t help, trying
            Edge or Chrome is the quickest way to rule it out.
          </p>
        )}

        <h2 className="mt-8 text-sm font-semibold">Still stuck?</h2>
        <ul className="mt-2 space-y-1.5 text-sm">
          <li>
            <GateLink href={LINKS.troubleshooting}>Troubleshooting guide</GateLink>
            <span className="text-bb-muted"> — step-by-step fixes for this and other start-up problems.</span>
          </li>
          <li>
            <GateLink href={LINKS.wiki}>Documentation wiki</GateLink>
            <span className="text-bb-muted"> — how BangerBox works, and what it needs to run.</span>
          </li>
          <li>
            <GateLink href={LINKS.newIssue}>Report this problem</GateLink>
            <span className="text-bb-muted">
              {' '}
              — please include the diagnostics below so it can be traced.
            </span>
          </li>
          <li>
            <GateLink href={LINKS.repo}>BangerBox on GitHub</GateLink>
            <span className="text-bb-muted"> — the source code for the whole project.</span>
          </li>
        </ul>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Button
            label="Copy diagnostics"
            size="lg"
            data-testid="capability-gate-copy-diagnostics"
            onClick={() => void copyDiagnostics()}
          />
          <span aria-live="polite" className="text-xs text-bb-muted">
            {copied
              ? 'Copied — paste this into your bug report.'
              : 'Details about this device, for a bug report.'}
          </span>
        </div>
      </div>
    </main>
  );
}

function GateLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="font-semibold text-bb-accent underline underline-offset-2 hover:text-bb-accent-strong"
    >
      {children}
    </a>
  );
}
