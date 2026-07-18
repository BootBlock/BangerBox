/**
 * useUIStore — transient UI state (spec §4.2). The active mode (one of the 12,
 * spec §8.5 — switched here, never by a router, spec §1.3 #9), modal state, the
 * browser→pad drag payload, theme, the frozen capability report (spec §2.1), the
 * toast queue (spec §4.4), and the Screen-mode Q-Link focus registry (spec §10.3).
 *
 * This is view state only — it never persists, so it carries no undo/autosave.
 */
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import type { CapabilityReport } from '@/core/platform/capabilities';

/** The 12 application modes (spec §8.5); ids match the `src/features/*` directories (spec §2.5). */
export const MODES = [
  'main',
  'grid',
  'muting',
  'sample-edit',
  'program-edit',
  'mixer',
  'browser',
  'looper',
  'pad-perform',
  'xyfx',
  'qlink-edit',
  'song',
] as const;
export type Mode = (typeof MODES)[number];

export type Theme = 'dark' | 'light';

export interface ModalState {
  readonly id: string;
}

/** Payload carried while dragging a sample from the Browser onto a pad (spec §8.5.7). */
export interface DragDropPayload {
  readonly sampleId: string;
  readonly name: string;
}

export type ToastTone = 'info' | 'success' | 'warning' | 'error';
export interface Toast {
  readonly id: string;
  readonly message: string;
  readonly tone: ToastTone;
  readonly createdAt: number;
}

/** A parameter a focused panel exposes to Screen-mode Q-Link encoders (spec §10.3). */
export interface QLinkFocusParam {
  readonly label: string;
  readonly targetParameterPath: string;
}

interface UIState {
  activeMode: Mode;
  modal: ModalState | null;
  dragDropPayload: DragDropPayload | null;
  theme: Theme;
  /** Frozen at boot (spec §2.1); null until the capability gate has run. */
  capabilities: CapabilityReport | null;
  toasts: Toast[];
  /** Parameters the currently focused panel offers Screen-mode Q-Links (spec §10.3). */
  focusedControlParams: QLinkFocusParam[];

  setActiveMode: (mode: Mode) => void;
  openModal: (modal: ModalState) => void;
  closeModal: () => void;
  setDragDropPayload: (payload: DragDropPayload | null) => void;
  setTheme: (theme: Theme) => void;
  setCapabilities: (report: CapabilityReport) => void;
  pushToast: (message: string, tone?: ToastTone) => string;
  dismissToast: (id: string) => void;
  setFocusedControlParams: (params: QLinkFocusParam[]) => void;
}

/** Toast queue depth — old toasts drop off the back so a burst can't grow unbounded. */
const MAX_TOASTS = 8;

/**
 * How long an advisory notice stays up before it dismisses itself. Warnings and errors are
 * NOT on a timer: they report something the user has to know about and act on, so they wait
 * to be dismissed by hand.
 */
const AUTO_DISMISS_MS = 6000;
const AUTO_DISMISS: ReadonlySet<ToastTone> = new Set<ToastTone>(['info', 'success']);

/**
 * Trim the queue to {@link MAX_TOASTS} by dropping the oldest notice the user can afford to
 * lose. A repeating failure (autosave retries every debounce tick) would otherwise push a
 * one-shot "could not open your project" off the back before it had been read, so advisory
 * notices are evicted first and an error is only dropped when the queue is nothing but errors.
 */
function trimQueue(toasts: Toast[]): Toast[] {
  if (toasts.length <= MAX_TOASTS) return toasts;
  const victim = toasts.findIndex((toast) => toast.tone !== 'error');
  const index = victim === -1 ? 0 : victim;
  return [...toasts.slice(0, index), ...toasts.slice(index + 1)];
}

/** Pending auto-dismiss timers by toast id, so a refreshed notice restarts rather than stacks. */
const dismissTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleAutoDismiss(id: string, tone: ToastTone): void {
  const pending = dismissTimers.get(id);
  if (pending !== undefined) clearTimeout(pending);
  if (!AUTO_DISMISS.has(tone)) {
    dismissTimers.delete(id);
    return;
  }
  dismissTimers.set(
    id,
    setTimeout(() => {
      dismissTimers.delete(id);
      useUIStore.getState().dismissToast(id);
    }, AUTO_DISMISS_MS),
  );
}

export const useUIStore = create<UIState>()(
  subscribeWithSelector((set, get) => ({
    activeMode: 'main',
    modal: null,
    dragDropPayload: null,
    theme: 'dark', // spec §3.6 dark is the default aesthetic
    capabilities: null,
    toasts: [],
    focusedControlParams: [],

    setActiveMode: (mode) => set({ activeMode: mode }),
    openModal: (modal) => set({ modal }),
    closeModal: () => set({ modal: null }),
    setDragDropPayload: (dragDropPayload) => set({ dragDropPayload }),
    setTheme: (theme) => set({ theme }),
    setCapabilities: (capabilities) => set({ capabilities }),

    pushToast: (message, tone = 'info') => {
      // A retrying failure says the same thing every tick. Refreshing the notice already on
      // screen keeps the queue describing distinct problems rather than one problem eight times.
      const existing = get().toasts.find((toast) => toast.message === message && toast.tone === tone);
      if (existing) {
        set((state) => ({
          toasts: state.toasts.map((toast) =>
            toast.id === existing.id ? { ...toast, createdAt: Date.now() } : toast,
          ),
        }));
        scheduleAutoDismiss(existing.id, tone);
        return existing.id;
      }

      const toast: Toast = { id: crypto.randomUUID(), message, tone, createdAt: Date.now() };
      set((state) => ({ toasts: trimQueue([...state.toasts, toast]) }));
      scheduleAutoDismiss(toast.id, tone);
      return toast.id;
    },
    dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),

    setFocusedControlParams: (focusedControlParams) => set({ focusedControlParams }),
  })),
);
