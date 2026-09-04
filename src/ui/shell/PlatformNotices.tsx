/**
 * PlatformNotices — the shell's strip for a condition the device imposes on the whole app
 * (spec §2.1 soft requirements, §9.7 storage safeguards; issue #51).
 *
 * §9.7 requires "a persistent dismissible warning that the browser may evict data" when
 * the persistence request is refused. That warning existed, but only inside `StoragePanel`
 * — mounted in Q-Link Edit, mode 11 of 12 — while the always-mounted `StorageGauge`
 * carried it as a `title` attribute, which is unreachable by keyboard and, on the tablet
 * §1.1 targets, unreachable at all. §14 2026-07-18 (o) moved the gauge to the transport bar
 * so storage state would be visible everywhere; this is the warning making the same move.
 *
 * A strip under the transport bar rather than a popover or an icon: it is readable without
 * a gesture, reachable by Tab because its Dismiss is an ordinary button, and it costs no
 * height at all when there is nothing to say — which on the §1.3 #15 Chromium baseline is
 * every session where persistence was granted.
 */
import { useState } from 'react';
import { SOFT_CAPABILITY_NOTICES, type CapabilityDetail } from '@/core/platform/capabilities';
import { useUIStore } from '@/store';
import { Button, useAnnounce } from '@/ui/primitives';
import { IconWarning } from '@/ui/icons';

/** One rendered notice: the §2.1 copy plus the key that dismisses it. */
interface ShellNotice extends CapabilityDetail {
  readonly id: string;
}

export function PlatformNotices() {
  const capabilities = useUIStore((s) => s.capabilities);
  const storagePersisted = useUIStore((s) => s.storagePersisted);
  const [dismissed, setDismissed] = useState<readonly string[]>([]);

  const notices: ShellNotice[] = [];

  // Two conditions, one consequence: a browser with no `persist()` cannot protect the data
  // and a browser that refused the grant has not — the user loses their work the same way,
  // so they read the same warning (spec §9.7). Nothing is said until the request has
  // answered, because "not yet asked" is not a refusal.
  const persistenceNotice = SOFT_CAPABILITY_NOTICES.persistentStorage;
  const cannotPersist = capabilities !== null && !capabilities.soft.persistentStorage;
  if (persistenceNotice && (cannotPersist || storagePersisted === false)) {
    notices.push({ ...persistenceNotice, id: 'persistentStorage' });
  }

  const wakeLockNotice = SOFT_CAPABILITY_NOTICES.wakeLock;
  if (wakeLockNotice && capabilities !== null && !capabilities.soft.wakeLock) {
    notices.push({ ...wakeLockNotice, id: 'wakeLock' });
  }

  const visible = notices.filter((notice) => !dismissed.includes(notice.id));

  // Announced through the one §8.2 announcer rather than by giving the strip a live role of
  // its own, which is the competing-region defect issue #34 is about.
  useAnnounce(visible.length > 0 ? visible.map((notice) => notice.title).join('. ') : null);

  if (visible.length === 0) return null;

  return (
    <div
      data-testid="platform-notices"
      className="flex flex-col gap-px border-b border-bb-warn/40 bg-bb-surface"
    >
      {visible.map((notice) => (
        <div
          key={notice.id}
          data-testid={`platform-notice-${notice.id}`}
          className="flex items-start gap-3 px-4 py-2 text-xs"
        >
          <IconWarning size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-bb-warn" />
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-bb-warn">{notice.title}</p>
            <p className="mt-0.5 leading-relaxed text-bb-muted">
              {notice.what} {notice.fix}
            </p>
          </div>
          <Button
            label="Dismiss"
            // Two notices would otherwise present two buttons called "Dismiss" — the same
            // defect issue #58 reports against the insert bypass toggles (spec §8.2).
            accessibleName={`Dismiss ${notice.title}`}
            size="sm"
            variant="quiet"
            data-testid={`platform-notice-dismiss-${notice.id}`}
            onClick={() => setDismissed((current) => [...current, notice.id])}
          />
        </div>
      ))}
    </div>
  );
}
