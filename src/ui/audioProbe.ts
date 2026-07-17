/**
 * Audio probe — the DOM-reachable test seam the Playwright smoke drives (spec §11.4).
 * It exposes read-only introspection (master meter peak, live voice count) and the
 * offline effect renders (§11.2) that have no other browser-observable surface. Installed
 * only once the engine has started from a user gesture. Harmless in production: it reads
 * engine state and, for churn, triggers the same demo pad the visible buttons do.
 */
import type { AudioEngine } from '@/core/audio/engine';
import { renderEffectOffline, type EffectRenderResult } from '@/core/audio/offlineTest';
import type { EffectType } from '@/core/project/schemas';

export interface AudioProbe {
  /** Current master meter peak from the SAB (spec §5.8) — proves audible signal. */
  masterPeak: () => number;
  /** Live voices in the pool (spec §5.4) — should return to 0 after playback. */
  liveVoiceCount: () => number;
  /** Trigger `count` demo pads back to back (create/destroy churn, spec §5.3). */
  churn: (count: number) => Promise<void>;
  /** Render a tone through one effect offline and measure it (spec §11.2). */
  renderEffect: (
    effectType: EffectType,
    options?: { toneHz?: number; params?: Record<string, number> },
  ) => Promise<EffectRenderResult>;
}

declare global {
  interface Window {
    __bangerboxAudioProbe?: AudioProbe;
  }
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
    churn: async (count) => {
      for (let i = 0; i < count; i++) await engine.triggerDemoPad(100);
    },
    renderEffect: (effectType, options) => renderEffectOffline(effectType, options),
  };
}
