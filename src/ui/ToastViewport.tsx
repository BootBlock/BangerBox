/**
 * Toast viewport (spec §4.2 toast queue). Renders `useUIStore.toasts` — autosave and
 * session notices (spec §4.4), and the §9.7 eviction warning. Placement and queue
 * lifetime live here; how a single notice looks, announces and dismisses belongs to the
 * §2.5 `Toast` primitive (spec §3.6).
 */
import { AnimatePresence } from 'motion/react';
import { Toast } from '@/ui/primitives';
import { useUIStore } from '@/store/useUIStore';

export function ToastViewport() {
  const toasts = useUIStore((state) => state.toasts);
  const dismissToast = useUIStore((state) => state.dismissToast);

  // The container stays mounted even when the queue is empty so a dismissed toast can
  // play its exit before unmounting (§8.3); it is inert, being `pointer-events-none`.
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4">
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
