/**
 * Toast viewport (spec §4.2 toast queue). Renders `useUIStore.toasts` — autosave and
 * session notices (spec §4.4), and the §9.7 eviction warning. Placement and queue
 * lifetime live here; how a single notice looks and dismisses belongs to the §2.5 `Toast`
 * primitive (spec §3.6).
 *
 * Announcing belongs here too, and to nothing below it. Severity used to give each toast
 * its own `role="status"` or `role="alert"`, which minted a live region per notice —
 * several at once during a burst, competing with the single §8.2 announcer and with each
 * other (issue #34). Each new notice is now announced ONCE through that announcer, on the
 * channel its severity chooses, and the toast itself is ordinary markup.
 */
import { useEffect, useRef } from 'react';
import { AnimatePresence } from 'motion/react';
import { Toast, announce } from '@/ui/primitives';
import { useUIStore, type ToastTone } from '@/store/useUIStore';

/** Warnings and errors interrupt; advisory notices wait their turn (spec §8.2). */
const ASSERTIVE: ReadonlySet<ToastTone> = new Set<ToastTone>(['warning', 'error']);

export function ToastViewport() {
  const toasts = useUIStore((state) => state.toasts);
  const dismissToast = useUIStore((state) => state.dismissToast);

  // Ids already spoken. `pushToast` refreshes a repeated notice in place rather than
  // queueing a second copy, so an autosave failing every debounce tick keeps one id and is
  // announced once — which is the behaviour a per-toast live region could not give.
  const announced = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const seen = announced.current;
    const next = new Set<string>();
    for (const toast of toasts) {
      next.add(toast.id);
      if (seen.has(toast.id)) continue;
      announce(toast.message, ASSERTIVE.has(toast.tone) ? 'assertive' : 'polite');
    }
    announced.current = next;
  }, [toasts]);

  // The container stays mounted even when the queue is empty so a dismissed toast can
  // play its exit before unmounting (§8.3); it is inert, being `pointer-events-none`.
  // The region landmark comes and goes with the queue: an empty labelled landmark is one
  // more thing for a screen-reader user to step over in all 12 modes, for nothing.
  return (
    <div
      role={toasts.length > 0 ? 'region' : undefined}
      aria-label={toasts.length > 0 ? 'Notifications' : undefined}
      className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4"
    >
      <AnimatePresence initial={false}>
        {toasts.map((toast) => (
          <Toast
            key={toast.id}
            message={toast.message}
            tone={toast.tone}
            onDismiss={() => dismissToast(toast.id)}
          />
        ))}
      </AnimatePresence>
    </div>
  );
}
