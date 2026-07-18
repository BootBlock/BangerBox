/**
 * Project session bootstrap (spec §4.4). Run once at app start (after the capability
 * gate and multi-tab guard): boot the database, open or create the active project and
 * hydrate the stores, then register the store→graph sync subscribers (spec §4.3) and
 * an autosave flush on tab-hide (spec §4.4). A failure surfaces as a toast, never a
 * white screen (spec §8.1) — the storage panel independently reports the boot fault.
 */
import { bootDatabase } from '@/core/storage/client';
import { disposeHardwareService } from '@/core/midi/hardwareService';
import { AudioEngine } from '@/core/audio/engine';
import { createAudioContext, resumeAudioContext } from '@/core/audio/context';
import { useProjectStore, useUIStore } from '@/store';
import { registerSyncSubscribers, type Unsubscribe } from '@/store/syncLayer';
import { subscribeSequencerSync } from '@/store/syncLayer/sequencerSync';
import { installProjectService, loadOrCreateActiveProject, projectService } from './projectService';

let syncDispose: Unsubscribe | null = null;
let sequencerSyncDispose: Unsubscribe | null = null;
let visibilityHandler: (() => void) | null = null;
let audioEngine: AudioEngine | null = null;

export async function startProjectSession(): Promise<void> {
  installProjectService();
  try {
    await bootDatabase();
    await loadOrCreateActiveProject();
    syncDispose = registerSyncSubscribers();
    visibilityHandler = () => {
      if (document.visibilityState === 'hidden') void projectService.saveNow();
    };
    document.addEventListener('visibilitychange', visibilityHandler);
  } catch {
    useUIStore
      .getState()
      .pushToast('BangerBox could not open your project — storage may be unavailable.', 'error');
  }
}

/**
 * Start the audio engine from the user's Start-screen gesture (spec §5.1). Creates the
 * AudioContext at the project sample rate, resumes it, loads the worklets, then swaps the
 * store→graph sync subscribers from the no-op bridge to the real audio bridge (spec §4.3)
 * and flushes the current mixer state into the graph. Idempotent.
 */
export async function startAudioEngine(): Promise<AudioEngine> {
  if (audioEngine) return audioEngine;
  const sampleRate = useProjectStore.getState().sampleRate || 48_000;
  const context = createAudioContext(sampleRate);
  await resumeAudioContext(context);
  const engine = new AudioEngine(context);
  await engine.initialise();
  // Re-wire the sync subscribers onto the live graph, then push current state (spec §4.3).
  syncDispose?.();
  syncDispose = registerSyncSubscribers(engine.bridge);
  engine.bridge.resyncAll();
  // Register the sequencer sync onto the live scheduler and push the full state (spec §7.1.3).
  sequencerSyncDispose?.();
  sequencerSyncDispose = subscribeSequencerSync(engine.scheduler);
  audioEngine = engine;
  return engine;
}

/** The running audio engine, or null before the start gate (spec §5.1). */
export function getAudioEngine(): AudioEngine | null {
  return audioEngine;
}

/** Tear the session down (test teardown / hot reload). */
export function stopProjectSession(): void {
  // Release the BLE link and its timers before the graph goes (spec §3.5 lens 5).
  disposeHardwareService();
  sequencerSyncDispose?.();
  sequencerSyncDispose = null;
  syncDispose?.();
  syncDispose = null;
  audioEngine?.dispose();
  audioEngine = null;
  if (visibilityHandler !== null) {
    document.removeEventListener('visibilitychange', visibilityHandler);
    visibilityHandler = null;
  }
}
