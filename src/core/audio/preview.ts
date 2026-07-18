/**
 * Preview channel — spec §5.9. Browser-mode auditioning plays through a dedicated gain on
 * the monitor bus, NEVER through a pad or track chain, so a sample can be heard before it
 * is assigned. A single voice at a time: a new preview cuts the previous one. The Browser
 * UI that drives this lands in Phase 6; the channel itself is live now.
 *
 * Each audition gets its own amp gain between the source and the level gain, so it can be
 * declicked like a pool voice (spec §5.4): a fade to zero at the buffer's natural end, and
 * a `VOICE_STEAL_FADE_MS` fade when a new audition (or navigating away) cuts it. The amp is
 * per-audition rather than shared so an outgoing fade never touches the incoming preview.
 */
import { DECLICK_FADE_MS, VOICE_STEAL_FADE_MS } from '@/core/constants';
import { clamp } from '@/core/math';
import { rampParamLinear, setParamNow } from './params/ramps';
import { scheduleAmpDeclick, scheduleAmpRelease } from './voiceEnvelope';

interface PreviewVoice {
  readonly source: AudioBufferSourceNode;
  readonly amp: GainNode;
}

export class PreviewChannel {
  /** Level gain feeding the monitor bus. */
  readonly output: GainNode;
  private current: PreviewVoice | null = null;
  /** Cut voices still ramping down; disposed on `onended`, or by `destroy()` if it beats them. */
  private readonly fading = new Set<PreviewVoice>();

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
    const amp = this.context.createGain();
    amp.connect(this.output);
    setParamNow(amp.gain, 1, when);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(amp);
    const voice: PreviewVoice = { source, amp };
    // Preview never repitches, so the buffer's own duration is the exact end time.
    scheduleAmpDeclick(amp.gain, when + buffer.duration, when, DECLICK_FADE_MS);
    source.onended = () => this.dispose(voice);
    source.start(when);
    this.current = voice;
  }

  /** Stop the current preview (Browser navigation away / new audition). */
  stop(when: number = this.context.currentTime): void {
    const voice = this.current;
    if (!voice) return;
    this.current = null;
    this.fading.add(voice);
    // Same fade-then-stop shape a stolen pool voice gets, so a cut preview never steps to zero.
    const silentAt = scheduleAmpRelease(voice.amp.gain, when, VOICE_STEAL_FADE_MS);
    try {
      voice.source.stop(silentAt);
    } catch {
      // Already stopped.
    }
  }

  private dispose(voice: PreviewVoice): void {
    voice.source.onended = null;
    voice.source.disconnect();
    voice.amp.disconnect();
    this.fading.delete(voice);
    if (this.current === voice) this.current = null;
  }

  setLevel(level: number, when: number): void {
    rampParamLinear(this.output.gain, clamp(level, 0, 1), when);
  }

  destroy(): void {
    this.stop();
    for (const voice of [...this.fading]) this.dispose(voice);
    this.output.disconnect();
  }
}
