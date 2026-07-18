/**
 * Toast viewport (spec §4.2 toast queue). Renders `useUIStore.toasts` — autosave and
 * session notices (spec §4.4), and where the §9.7 eviction warning migrates when the
 * storage panel is retired in Phase 7. Info/success announce politely (`status`);
 * warning/error assertively (`alert`). The full Toast primitive lands in Phase 7 (§8).
 */
import { useUIStore, type ToastTone } from '@/store/useUIStore';

const TONE_CLASS: Record<ToastTone, string> = {
  info: 'border-bb-accent/50 text-bb-text',
  success: 'border-bb-ok/50 text-bb-ok',
  warning: 'border-bb-warn/50 text-bb-warn',
  error: 'border-bb-danger/50 text-bb-danger',
};

export function ToastViewport() {
  const toasts = useUIStore((state) => state.toasts);
  const dismissToast = useUIStore((state) => state.dismissToast);
  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          data-testid="toast"
          // The tone is the smoke's hook for "did anything warn or fail?" (spec §11.4) — the
          // role alone cannot say, since the §8.2 announcer is also role="status".
          data-tone={toast.tone}
          role={toast.tone === 'warning' || toast.tone === 'error' ? 'alert' : 'status'}
          className={`pointer-events-auto flex w-full max-w-md items-start justify-between gap-3 rounded-bb-md border bg-bb-surface px-4 py-3 text-sm shadow-bb-raised ${TONE_CLASS[toast.tone]}`}
        >
          <span className="leading-relaxed">{toast.message}</span>
          <button
            type="button"
            onClick={() => dismissToast(toast.id)}
            aria-label="Dismiss notification"
            className="shrink-0 rounded-bb-sm border border-bb-line px-2 py-0.5 text-xs font-semibold text-bb-text transition-colors duration-150 hover:bg-bb-raised"
          >
            Dismiss
          </button>
        </div>
      ))}
    </div>
  );
}
