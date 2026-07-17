/**
 * Audio probe — the DOM-reachable test seam the Playwright smoke drives (spec §11.4).
 * It exposes read-only introspection (master meter peak, live voice count, playhead), the
 * offline effect renders (§11.2), and the Phase 4 record-then-playback proof (§12 exit) —
 * all surfaces that have no other browser-observable handle. Installed only once the engine
 * has started from a user gesture. Harmless in production: it drives the same stores and
 * scheduler the UI does.
 */
import type { AudioEngine } from '@/core/audio/engine';
import { renderEffectOffline, type EffectRenderResult } from '@/core/audio/offlineTest';
import { createDefaultSequence, createDefaultTrack, type EffectType } from '@/core/project/schemas';
import { useSequenceStore, useTransportStore } from '@/store';

export interface RecordPlaybackResult {
  /** Notes captured into the track by the recording pass (spec §7.7). */
  readonly recorded: number;
  /** Scheduled notes the dispatcher realised while playing the take back (spec §7.1.4). */
  readonly played: number;
}

export interface AudioProbe {
  /** Current master meter peak from the SAB (spec §5.8) — proves audible signal. */
  masterPeak: () => number;
  /** Live voices in the pool (spec §5.4) — should return to 0 after playback. */
  liveVoiceCount: () => number;
  /** Current playhead tick from the scheduler SAB (spec §7.1.4). */
  playheadTick: () => number;
  /** Trigger `count` demo pads back to back (create/destroy churn, spec §5.3). */
  churn: (count: number) => Promise<void>;
  /** Render a tone through one effect offline and measure it (spec §11.2). */
  renderEffect: (
    effectType: EffectType,
    options?: { toneHz?: number; params?: Record<string, number> },
  ) => Promise<EffectRenderResult>;
  /** Record a short take via live notes, then play it back (spec §12 exit criterion). */
  recordThenPlayback: () => Promise<RecordPlaybackResult>;
}

declare global {
  interface Window {
    __bangerboxAudioProbe?: AudioProbe;
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Drive the real sequencer end to end (spec §12 record-then-playback): set up a one-bar
 * looping track, arm recording, tap a pad three times via live notes, let the worker
 * capture and flush the take into the store, then play it back through the scheduler and
 * count the dispatched notes. Exercises the store → sync → worker → dispatcher → graph path.
 */
async function recordThenPlayback(engine: AudioEngine): Promise<RecordPlaybackResult> {
  const seqId = crypto.randomUUID();
  const trackId = crypto.randomUUID();
  const note = 36;

  // A one-bar 4/4 sequence (3840 ticks = 2 s at 120 bpm) looping on a single drum track.
  const sequence = { ...createDefaultSequence(crypto.randomUUID(), 0, 'Smoke', seqId), lengthBars: 1 };
  const track = createDefaultTrack(seqId, null, 0, 'Smoke', 'drum', trackId);
  useSequenceStore.getState().hydrate({
    sequences: { [seqId]: sequence },
    tracks: { [trackId]: track },
    events: {},
    automation: {},
    songEntries: [],
  });

  const transport = useTransportStore.getState();
  transport.setActiveSequenceId(seqId);
  transport.setPlaybackMode('sequence');
  transport.setBpm(120);
  transport.setMetronomeEnabled(false);
  transport.setCountInBars(0);
  transport.setRecordMode('overdub');
  transport.setLoop({ enabled: true, startTick: 0, endTick: 3840 });

  // --- record: play + three pad taps across the bar ---
  transport.setRecording(true);
  transport.play();
  for (let i = 0; i < 3; i++) {
    await delay(300);
    engine.scheduler.sendLiveNote(note, 110, true, performance.now(), trackId);
    await delay(60);
    engine.scheduler.sendLiveNote(note, 110, false, performance.now(), trackId);
  }
  await delay(1400); // cross the loop boundary so the overdub take flushes to the store
  useTransportStore.getState().stop();
  await delay(250);
  const recorded = (useSequenceStore.getState().events[trackId] ?? []).length;

  // --- playback: play the take back and count dispatched notes ---
  const before = engine.scheduledNoteCount();
  useTransportStore.getState().setRecording(false);
  useTransportStore.getState().play();
  await delay(2300); // roughly one loop of the recorded bar
  useTransportStore.getState().stop();
  await delay(150);
  const played = engine.scheduledNoteCount() - before;

  return { recorded, played };
}

export function installAudioProbe(engine: AudioEngine): void {
  window.__bangerboxAudioProbe = {
    masterPeak: () => {
      const slot = engine.meterRegistry.slotOf('master');
      if (slot === undefined) return 0;
      const reading = engine.meterRegistry.read(slot);
      return Math.max(reading.peakL, reading.peakR);
    },
    liveVoiceCount: () => engine.voicePool.activeVoiceCount(),
    playheadTick: () => engine.playheadTick(),
    churn: async (count) => {
      for (let i = 0; i < count; i++) await engine.triggerDemoPad(100);
    },
    renderEffect: (effectType, options) => renderEffectOffline(effectType, options),
    recordThenPlayback: () => recordThenPlayback(engine),
  };
}
