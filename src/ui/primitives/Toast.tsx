/**
 * Toast — the transient-notice primitive named in the §2.5 set. Owns the tone variants,
 * the dismiss affordance and the entry/exit motion (§8.3, transform/opacity only, and
 * collapsing to a plain fade under `prefers-reduced-motion`).
 *
 * Severity drives the announcement role, and it does so here rather than at the call
 * site so the mapping cannot drift: info/success are advisory and announce politely
 * (`status`), warning/error interrupt (`alert`) — spec §8.2. {@link ToastViewport}
 * supplies the queue and its placement; this component supplies everything a single
 * notice looks and behaves like (§3.6).
 */
import { motion, useReducedMotion } from 'motion/react';
import type { ToastTone } from '@/store/useUIStore';
import { EASE_BB_SNAP } from '@/ui/motionTokens';

export interface ToastProps {
  message: string;
  tone: ToastTone;
  onDismiss: () => void;
}

const TONE_CLASS: Record<ToastTone, string> = {
  info: 'border-bb-accent/50 text-bb-text',
  success: 'border-bb-ok/50 text-bb-ok',
  warning: 'border-bb-warn/50 text-bb-warn',
  error: 'border-bb-danger/50 text-bb-danger',
};

/** Warnings and errors interrupt; advisory notices wait their turn (spec §8.2). */
const ASSERTIVE: ReadonlySet<ToastTone> = new Set<ToastTone>(['warning', 'error']);

export function Toast({ message, tone, onDismiss }: ToastProps) {
  const reduceMotion = useReducedMotion();

  return (
    <motion.div
      data-testid="toast"
      // The tone is the smoke's hook for "did anything warn or fail?" (spec §11.4) — the
      // role alone cannot say, since several notices share `role="status"`.
      data-tone={tone}
      role={ASSERTIVE.has(tone) ? 'alert' : 'status'}
      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.98 }}
      animate={reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.98 }}
      transition={{ duration: 0.18, ease: EASE_BB_SNAP }}
      className={`pointer-events-auto flex w-full max-w-md items-start justify-between gap-3 rounded-bb-md border bg-bb-surface px-4 py-3 text-sm shadow-bb-raised ${TONE_CLASS[tone]}`}
    >
      <span className="leading-relaxed">{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss notification"
        className="shrink-0 rounded-bb-sm border border-bb-line px-2 py-0.5 text-xs font-semibold text-bb-text transition-colors duration-150 hover:bg-bb-raised"
      >
        Dismiss
      </button>
    </motion.div>
  );
}
