/**
 * Modal — the bespoke dialog primitive (spec §1.3 #10: no Radix/shadcn). Implements the
 * accessibility contract a dialog owes (spec §8.2): `role="dialog"` + `aria-modal`, an
 * accessible name from its heading, Escape to dismiss, focus moved in on open and
 * restored to the invoker on close, and a Tab loop confined to the dialog.
 *
 * Motion honours `prefers-reduced-motion` by collapsing to a pure opacity fade
 * (spec §8.2/§8.3).
 */
import { useCallback, useEffect, useId, useRef, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { IconClose } from '@/ui/icons';

export interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Action row pinned to the foot of the dialog (Confirm/Cancel). */
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  'data-testid'?: string;
}

const SIZE: Record<'sm' | 'md' | 'lg', string> = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-3xl',
};

/** Elements that can hold focus inside the dialog, for the Tab loop (spec §8.2). */
const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  size = 'md',
  'data-testid': testId,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusTo = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const reduceMotion = useReducedMotion();

  const focusables = useCallback(
    () => Array.from(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []),
    [],
  );

  // Remember the invoker and move focus into the dialog on open; restore it on close so
  // the keyboard user lands back where they were (spec §8.2 logical Tab order). Focus goes
  // to the panel itself rather than its first focusable — in DOM order that is the close
  // button, and landing on a dismiss control is a poor (and occasionally destructive)
  // starting point. From the panel, Tab enters the content in order.
  useEffect(() => {
    if (!open) return;
    restoreFocusTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();
    return () => {
      restoreFocusTo.current?.focus();
    };
  }, [open]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = focusables();
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    // Wrap the focus ring at both ends so Tab cannot escape the dialog (spec §8.2).
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-bb-bg/80 p-4"
        >
          {/* Backdrop click dismisses; it is presentational, Escape is the keyboard path. */}
          <div aria-hidden="true" className="absolute inset-0" onClick={onClose} />
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
            data-testid={testId}
            onKeyDown={handleKeyDown}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: 8 }}
            animate={reduceMotion ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: 8 }}
            transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
            className={`relative flex max-h-[85dvh] w-full flex-col rounded-bb-lg border border-bb-line bg-bb-surface shadow-bb-raised ${SIZE[size]}`}
          >
            <header className="flex items-center justify-between gap-4 border-b border-bb-line px-5 py-3">
              <h2 id={titleId} className="text-sm font-bold">
                {title}
              </h2>
              <button
                type="button"
                aria-label="Close dialog"
                onClick={onClose}
                className="rounded-bb-sm p-1 text-bb-muted transition-colors duration-150 hover:text-bb-text"
              >
                <IconClose size={16} aria-hidden="true" />
              </button>
            </header>
            <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
            {footer && (
              <footer className="flex items-center justify-end gap-2 border-t border-bb-line px-5 py-3">
                {footer}
              </footer>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
