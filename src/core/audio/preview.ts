/**
 * Preview channel — spec §5.9. Browser-mode auditioning plays through a dedicated gain on
 * the monitor bus, NEVER through a pad or track chain, so a sample can be heard before it
 * is assigned. A single voice at a time: a new preview cuts the previous one. The Browser
 * UI that drives this lands in Phase 6; the channel itself is live now.
 */
import { clamp } from '@/core/math';
import { rampParamLinear, setParamNow } from './params/ramps';

export class PreviewChannel {
  /** Level gain feeding the monitor bus. */
  readonly output: GainNode;
  private current: AudioBufferSourceNode | null = null;

  constructor(
    private readonly context: BaseAudioContext,
    monitorBus: AudioNode,
  ) {
    this.output = context.createGain();
    this.output.connect(monitorBus);
    setParamNow(this.output.gain, 1, context.currentTime);
  }

  /** Audition `buffer` from `when` (default: now), replacing any current preview. */
  play(buffer: AudioBuffer, when: number = this.context.currentTime): void {
    this.stop(when);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.output);
    source.onended = () => {
      source.disconnect();
      if (this.current === source) this.current = null;
    };
    source.start(when);
    this.current = source;
  }

  /** Stop the current preview (Browser navigation away / new audition). */
  stop(when?: number): void {
    const source = this.current;
    if (!source) return;
    this.current = null;
    try {
      source.stop(when);
    } catch {
      // Already stopped.
    }
    source.disconnect();
  }

  setLevel(level: number, when: number): void {
    rampParamLinear(this.output.gain, clamp(level, 0, 1), when);
  }

  destroy(): void {
    this.stop();
    this.output.disconnect();
  }
}
