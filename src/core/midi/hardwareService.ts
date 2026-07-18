/**
 * Hardware session service — the single place the §10 pieces are joined: BLE transport →
 * parser → router → (voice pool | Q-Link runtime → stores). Everything below it is pure or
 * injectable; this module is the one that reaches for the live engine and stores, so it is
 * also the one the UI talks to (spec §10.2 execution flow).
 *
 * Connection state is mirrored into `useHardwareStore` so the UI reads hardware status the
 * same way it reads everything else (spec §3.1 unidirectional flow) — the transport itself
 * never renders anything.
 */
import { getAudioEngine } from '@/core/project/session';
import { resolveLiveTrackId } from '@/ui/usePadTrigger';
import { useHardwareStore, useProgramStore, useUIStore } from '@/store';
import { BleMidiTransport, type BleTransportOptions } from './bleTransport';
import { createMidiRouter, type ActiveKeygroup, type MidiRouter } from './router';
import { createQLinkRuntime, type QLinkRuntime } from './qlinkRuntime';

export interface HardwareService {
  /** Open the browser's device chooser and connect (must be called from a user gesture). */
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  /** The Q-Link runtime, so the Edit surface can show the bindings in force (spec §8.5.11). */
  readonly qLink: QLinkRuntime;
  /** The most recent CC seen, for the Q-Link learn flow's CC half (spec §8.5.11). */
  onNextControlChange: (listener: (cc: number) => void) => () => void;
  dispose: () => void;
}

/**
 * The keygroup program a pitch bend applies to, or null when the active program is a drum
 * kit — drum programs ignore bend entirely (spec §10.2).
 */
function activeKeygroup(): ActiveKeygroup | null {
  const { programs, activeProgramId } = useProgramStore.getState();
  if (activeProgramId === null) return null;
  const program = programs[activeProgramId];
  if (program?.type !== 'keygroup') return null;
  return { programId: program.id, pitchBendRange: program.pitchBendRange };
}

export function createHardwareService(options: BleTransportOptions = {}): HardwareService {
  const qLink = createQLinkRuntime();
  /** Learn-flow listeners, notified of the raw CC number before it is dispatched. */
  const ccListeners = new Set<(cc: number) => void>();

  const router: MidiRouter = createMidiRouter({
    triggerLiveNote: (note, velocity, on, timestampMs) => {
      const engine = getAudioEngine();
      const trackId = resolveLiveTrackId();
      // Without an engine or a resolvable track there is nothing to sound (spec §7.6).
      if (!engine || trackId === null) return;
      engine.triggerLiveNote(trackId, note, velocity, on, timestampMs);
    },
    applyPitchBend: (programId, cents) => getAudioEngine()?.applyPitchBend(programId, cents),
    handleControlChange: (cc, value) => {
      for (const listener of ccListeners) listener(cc);
      qLink.handleControlChange(cc, value);
    },
    inputLatencyMs: () => useHardwareStore.getState().inputLatencyMs,
    activeKeygroup,
  });

  const transport = new BleMidiTransport({
    ...options,
    onMessages: (messages) => router.route(messages),
    onStateChange: (state, deviceName) => {
      const hardware = useHardwareStore.getState();
      hardware.setConnectionState(state);
      hardware.setDevice(deviceName, state === 'connected');
      if (state === 'reconnecting') {
        // A drop must never crash the graph, pause playback, or lose bindings (spec §10.4)
        // — it is purely an advisory, so the user knows why the encoders went quiet.
        useUIStore.getState().pushToast('Controller disconnected — reconnecting…', 'warning');
        router.reset();
      }
      if (state === 'connected' && deviceName) {
        useUIStore.getState().pushToast(`${deviceName} connected.`, 'success');
      }
    },
  });

  return {
    qLink,
    connect: () => transport.connect(),
    disconnect: () => transport.disconnect(),
    onNextControlChange: (listener) => {
      ccListeners.add(listener);
      return () => ccListeners.delete(listener);
    },
    dispose: () => {
      ccListeners.clear();
      qLink.dispose();
      router.reset();
      void transport.disconnect();
    },
  };
}

let service: HardwareService | null = null;

/** The app-wide hardware service, created on first use (spec §10.2). */
export function hardwareService(): HardwareService {
  service ??= createHardwareService();
  return service;
}

/** Tear the hardware session down (test teardown / hot reload). */
export function disposeHardwareService(): void {
  service?.dispose();
  service = null;
}
