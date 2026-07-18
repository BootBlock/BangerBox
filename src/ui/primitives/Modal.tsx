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

/**
 * Elements that can hold focus inside the dialog, for the Tab loop (spec §8.2). `summary`,
 * `[contenteditable]` and media with `controls` are tab stops the browser creates without any
 * `tabindex`, so they belong here too — `StoragePanel`'s `<details>` is the live example.
 */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  '[contenteditable]:not([contenteditable="false"])',
  'audio[controls]',
  'video[controls]',
  '[tabindex]:not([tabindex="-1"])',
]
  .map((selector) => `${selector}:not([aria-disabled="true"]):not([hidden])`)
  .join(',');

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
  // Held in a ref so an inline `onClose` from the caller cannot re-run the effect below —
  // that would re-store the invoker and yank focus back to the panel on every render.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
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
    const panel = panelRef.current;
    panel?.focus();

    // Both listeners are on the document rather than the panel: clicking any non-focusable
    // part of the dialog (prose, a label, the padding) drops `activeElement` to `<body>`,
    // and a panel-scoped React `onKeyDown` never fires from there — Escape would go dead and
    // Tab would walk out into the transport behind the dialog.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) {
        // Nothing to land on, but Tab must still not leave the dialog.
        event.preventDefault();
        panel?.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      // Wrap the focus ring at both ends so Tab cannot escape the dialog (spec §8.2). Focus
      // sitting outside the panel re-enters at the near end instead of wrapping.
      if (!(active instanceof HTMLElement) || !panel?.contains(active) || active === panel) {
        if (active !== panel) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        }
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    // Pointer-driven escapes have no key event to intercept, so pull focus back whenever it
    // lands outside the panel. `document.hasFocus()` skips the alt-tab case, where the page
    // legitimately has no focused element and stealing it back would fight the window manager.
    const onFocusIn = (event: FocusEvent) => {
      if (!panel || !document.hasFocus()) return;
      const target = event.target;
      if (target instanceof Node && panel.contains(target)) return;
      panel.focus();
    };
    const onFocusOut = (event: FocusEvent) => {
      if (!panel || !document.hasFocus()) return;
      // `relatedTarget` is null when focus falls to `<body>`, which is the click-on-prose case.
      const next = event.relatedTarget;
      if (next instanceof Node && panel.contains(next)) return;
      panel.focus();
    };

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusin', onFocusIn);
    panel?.addEventListener('focusout', onFocusOut);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('focusin', onFocusIn);
      panel?.removeEventListener('focusout', onFocusOut);
      restoreFocusTo.current?.focus();
    };
  }, [open, focusables]);

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
