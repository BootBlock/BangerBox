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

export const useUIStore = create<UIState>()(
  subscribeWithSelector((set) => ({
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
      const toast: Toast = { id: crypto.randomUUID(), message, tone, createdAt: Date.now() };
      set((state) => ({ toasts: [...state.toasts, toast].slice(-MAX_TOASTS) }));
      return toast.id;
    },
    dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),

    setFocusedControlParams: (focusedControlParams) => set({ focusedControlParams }),
  })),
);
