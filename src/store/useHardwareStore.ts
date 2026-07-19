/**
 * useHardwareStore — BLE-MIDI connection and Q-Link binding state (spec §4.2, §10.3).
 * This store owns the connection/mode state and the persisted binding model; the BLE
 * transport and the runtime that executes a binding live in `core/midi` (spec §10.4,
 * {@link qlinkRuntime}) and drive this store rather than the reverse. Binding edits are undoable
 * (spec §4.5 "Q-Link binding edits") and persist per mode in `app_settings` (spec
 * §10.3) via the settings dirty key.
 */
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { clamp } from '@/core/math';
import { dirtyKey } from '@/core/project/dirty';
import { type QLinkBinding, type QLinkMode } from '@/core/project/schemas';
import { commit } from './commit';

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting';

/** Input latency offset bounds and default — spec §10.2 (default 15 ms, range 0–50 ms). */
export const INPUT_LATENCY_RANGE = [0, 50] as const;
export const INPUT_LATENCY_DEFAULT_MS = 15;

interface HardwareState {
  bleDeviceConnected: boolean;
  bleDeviceName: string | null;
  connectionState: ConnectionState;
  qLinkMode: QLinkMode;
  qLinkBindings: QLinkBinding[];
  /** Raw incoming CC number → logical encoder index (spec §4.2, §10.4). */
  ccMappings: Record<number, number>;
  /**
   * Input latency offset in ms, subtracted from BLE timestamps when recording to
   * compensate transmission delay (spec §10.2: default 15, settable 0–50 in Q-Link
   * Edit's settings pane). Added in Phase 7 — see §14 2026-07-18 (i).
   */
  inputLatencyMs: number;

  setConnectionState: (state: ConnectionState) => void;
  setDevice: (name: string | null, connected: boolean) => void;
  setQLinkMode: (mode: QLinkMode) => void;
  setInputLatencyMs: (ms: number) => void;

  /** Replace the binding set for the current mode (hydration — spec §10.3). */
  setBindings: (bindings: readonly QLinkBinding[]) => void;
  /** Add or replace the binding on an encoder (spec §4.5 undoable). */
  upsertBinding: (binding: QLinkBinding) => void;
  removeBinding: (encoderIndex: number) => void;

  setCcMapping: (cc: number, encoderIndex: number) => void;
}

export const useHardwareStore = create<HardwareState>()(
  subscribeWithSelector((set, get) => ({
    bleDeviceConnected: false,
    bleDeviceName: null,
    connectionState: 'idle',
    qLinkMode: 'screen',
    qLinkBindings: [],
    ccMappings: {},
    inputLatencyMs: INPUT_LATENCY_DEFAULT_MS,

    setConnectionState: (connectionState) => set({ connectionState }),
    setDevice: (bleDeviceName, bleDeviceConnected) => set({ bleDeviceName, bleDeviceConnected }),
    setQLinkMode: (qLinkMode) => set({ qLinkMode }),
    setInputLatencyMs: (ms) =>
      set({ inputLatencyMs: clamp(ms, INPUT_LATENCY_RANGE[0], INPUT_LATENCY_RANGE[1]) }),

    setBindings: (bindings) => set({ qLinkBindings: [...bindings] }),

    upsertBinding: (binding) => {
      const prev = get().qLinkBindings;
      const next = [
        ...prev.filter((existing) => existing.encoderIndex !== binding.encoderIndex),
        binding,
      ].sort((a, b) => a.encoderIndex - b.encoderIndex);
      const write = (value: QLinkBinding[]) => set({ qLinkBindings: value });
      commit({
        label: 'Edit Q-Link binding',
        apply: () => write(next),
        revert: () => write(prev),
        dirtyKeys: [dirtyKey.settings(`qlink:${get().qLinkMode}`)],
      });
    },

    removeBinding: (encoderIndex) => {
      const prev = get().qLinkBindings;
      const next = prev.filter((binding) => binding.encoderIndex !== encoderIndex);
      const write = (value: QLinkBinding[]) => set({ qLinkBindings: value });
      commit({
        label: 'Remove Q-Link binding',
        apply: () => write(next),
        revert: () => write(prev),
        dirtyKeys: [dirtyKey.settings(`qlink:${get().qLinkMode}`)],
      });
    },

    setCcMapping: (cc, encoderIndex) =>
      set((state) => ({ ccMappings: { ...state.ccMappings, [cc]: encoderIndex } })),
  })),
);
