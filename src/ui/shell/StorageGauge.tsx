/**
 * Storage gauge — the persistent read on how much room is left (spec §8.5.1 "storage
 * usage", §9.7 quota safeguards). It lives in the transport bar rather than on Main
 * because the figure it reports is a *warning*, not a statistic: §9.7 hard-stops any
 * storage-growing write at 90 % of quota, so the moment it matters is mid-session while
 * importing samples — a dashboard the user last looked at an hour ago cannot serve that.
 *
 * It also owns the §9.7 first-run persistence request. That has to happen somewhere
 * always-mounted; the transport bar is the only thing on screen in all 12 modes. The
 * ANSWER goes to `useUIStore.storagePersisted` rather than staying here, because the
 * warning §9.7 asks for is a strip of readable, dismissible text — `PlatformNotices` —
 * and not the `title` attribute this gauge used to hide it in (issue #51).
 */
import { useEffect, useState } from 'react';
import { QUOTA_HARD_STOP_RATIO } from '@/core/constants';
import { estimateStorage, requestPersistentStorage } from '@/core/storage/safeguards';
import { useUIStore } from '@/store';

/** Amber well before the hard stop, so there is time to free space (spec §9.7). */
const WARN_RATIO = 0.75;
/** Usage moves slowly; a minute between estimates is plenty (spec §9.7 budget). */
const POLL_MS = 60_000;

/** Format bytes in en-GB units (spec §1.3.1 — Intl, no libraries). */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 }).format(value)} ${units[unitIndex]}`;
}

export function StorageGauge() {
  const [estimate, setEstimate] = useState<{ usage: number; quota: number; ratio: number } | null>(null);
  const persisted = useUIStore((s) => s.storagePersisted);

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      const next = await estimateStorage();
      if (cancelled || !next.supported || next.quota <= 0) return;
      setEstimate({ usage: next.usage, quota: next.quota, ratio: next.ratio });
    };

    void (async () => {
      // First-run persistence request (spec §9.7), before the first estimate so the
      // gauge's eviction state is right from its first paint.
      const granted = await requestPersistentStorage();
      if (!cancelled) useUIStore.getState().setStoragePersisted(granted);
      await refresh();
    })();

    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  // Nothing to show where the estimate API is missing — the capability gate treats
  // storage estimation as a soft requirement (spec §2.1), so degrade to absent.
  if (!estimate) return null;

  const percent = Math.min(100, Math.round(estimate.ratio * 100));
  const atHardStop = estimate.ratio >= QUOTA_HARD_STOP_RATIO;
  const warning = estimate.ratio >= WARN_RATIO;
  const fillColour = atHardStop ? 'bg-bb-danger' : warning ? 'bg-bb-warn' : 'bg-bb-accent';

  const usageText = `${formatBytes(estimate.usage)} of ${formatBytes(estimate.quota)} used`;
  const limitText = atHardStop
    ? ' — at the 90 % limit, new samples and bounces are blocked until you free space'
    : warning
      ? ' — approaching the 90 % limit'
      : '';

  return (
    <span
      data-testid="transport-storage"
      data-status={atHardStop ? 'full' : warning ? 'warn' : 'ok'}
      // The eviction sentence is deliberately NOT here any more: a `title` is unreachable
      // by keyboard and, on a touch device, unreachable at all, which is not the persistent
      // dismissible warning §9.7 asks for. `PlatformNotices` carries it; the ring below is
      // the gauge's own echo of the same state (issue #51).
      title={`${usageText}${limitText}.`}
      className="flex items-center gap-1.5"
    >
      <span
        role="progressbar"
        aria-label="Storage used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={`${percent}% — ${usageText}${limitText}`}
        className={`h-2 w-12 overflow-hidden rounded-full bg-bb-raised ${
          persisted === false ? 'ring-1 ring-bb-warn/40' : ''
        }`}
      >
        <span className={`block h-full ${fillColour}`} style={{ width: `${percent}%` }} />
      </span>
      <span className="font-mono text-bb-micro tabular-nums text-bb-muted">{percent} %</span>
    </span>
  );
}
