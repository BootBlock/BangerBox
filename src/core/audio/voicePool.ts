/**
 * Voice pool — spec §5.4. A global pool of at most `MAX_VOICES` voices; each voice is one
 * `AudioBufferSourceNode` → amp-envelope `GainNode` feeding a pad channel input (spec
 * §5.2 stages 1–2, 5). Owns per-pad playback modes (poly / mono / oneShot), choke groups,
 * and voice stealing with a short fade — never a hard cut/click (spec §5.4). Allocation
 * policy is the pure {@link selectStealVictim}/{@link selectChokeVictims} (spec §11.1);
 * this class only wires and tears down nodes (spec §3.2).
 */
import { CHOKE_FADE_MS, MAX_VOICES, VOICE_STEAL_FADE_MS } from '@/core/constants';
import type { AhdsrEnvelope, PlaybackMode } from '@/core/project/schemas';
import { scheduleAmpAttack, scheduleAmpRelease, velocityToGain } from './voiceEnvelope';
import {
  selectChokeVictims,
  selectStealVictim,
  type ChokeCandidate,
  type VoiceRef,
} from './voiceSelection';

/** Everything the pool needs to sound one hit (spec §5.4, §6). */
export interface VoiceTriggerSpec {
  readonly id: string;
  readonly buffer: AudioBuffer;
  readonly destination: AudioNode;
  readonly when: number;
  readonly velocity: number; // 1..127
  readonly playbackMode: PlaybackMode;
  readonly chokeGroup: number;
  readonly programId: string;
  readonly padKey: string; // `${programId}:${padIndex}`
  readonly amp: AhdsrEnvelope;
  readonly gainDb: number;
  readonly tuneSemitones: number;
  readonly tuneCents: number;
}

interface Voice {
  readonly id: string;
  readonly source: AudioBufferSourceNode;
  readonly ampGain: GainNode;
  readonly padKey: string;
  readonly programId: string;
  readonly chokeGroup: number;
  readonly oneShot: boolean;
  readonly releaseMs: number;
  startTime: number;
  released: boolean;
  stopScheduled: boolean;
}

export class VoicePool {
  private readonly voices = new Map<string, Voice>();

  constructor(
    private readonly context: BaseAudioContext,
    private readonly maxVoices: number = MAX_VOICES,
  ) {}

  /** Sound one hit, applying choke, mono-retrigger and voice-steal rules (spec §5.4). */
  trigger(spec: VoiceTriggerSpec): void {
    const now = spec.when;

    // 1. Choke: cut other pads sharing this pad's non-zero choke group (spec §5.4).
    for (const id of selectChokeVictims(this.chokeCandidates(), spec)) {
      const victim = this.voices.get(id);
      if (victim) this.fadeAndStop(victim, now, CHOKE_FADE_MS);
    }

    // 2. Mono: a retrigger of the same pad cuts its previous voice(s) (spec §5.4).
    if (spec.playbackMode === 'mono') {
      for (const voice of this.voices.values()) {
        if (voice.padKey === spec.padKey && !voice.stopScheduled) {
          this.fadeAndStop(voice, now, VOICE_STEAL_FADE_MS);
        }
      }
    }

    // 3. Capacity: steal a voice when the pool is exhausted (spec §5.4).
    if (this.voices.size >= this.maxVoices) {
      const victimId = selectStealVictim(this.voiceRefs());
      const victim = victimId ? this.voices.get(victimId) : undefined;
      if (victim) this.fadeAndStop(victim, now, VOICE_STEAL_FADE_MS);
    }

    // 4. Build and start the voice.
    const source = this.context.createBufferSource();
    source.buffer = spec.buffer;
    source.detune.value = spec.tuneSemitones * 100 + spec.tuneCents; // cents (spec §6 coupled tune)
    const ampGain = this.context.createGain();
    source.connect(ampGain);
    ampGain.connect(spec.destination);

    const peak = velocityToGain(spec.velocity, spec.gainDb);
    scheduleAmpAttack(ampGain.gain, peak, spec.amp, now);
    source.start(now);

    const voice: Voice = {
      id: spec.id,
      source,
      ampGain,
      padKey: spec.padKey,
      programId: spec.programId,
      chokeGroup: spec.chokeGroup,
      oneShot: spec.playbackMode === 'oneShot',
      releaseMs: spec.amp.release,
      startTime: now,
      released: false,
      stopScheduled: false,
    };
    // A finite buffer ends on its own → teardown; stolen/choked voices end after the fade.
    source.onended = () => this.teardown(spec.id);
    this.voices.set(spec.id, voice);
  }

  /** Note-off for a pad: release its sustaining voices (oneShot ignores note-off, §5.4). */
  release(padKey: string, when: number): void {
    for (const voice of this.voices.values()) {
      if (voice.padKey !== padKey || voice.oneShot || voice.stopScheduled) continue;
      const end = scheduleAmpRelease(voice.ampGain.gain, when, voice.releaseMs);
      this.safeStop(voice, end);
      voice.released = true;
      voice.stopScheduled = true;
    }
  }

  /** Number of live voices (perf HUD / tests). */
  activeVoiceCount(): number {
    return this.voices.size;
  }

  /** Stop and tear down every voice (project close / mode unmount) — spec §3.2. */
  destroy(): void {
    for (const voice of [...this.voices.values()]) {
      this.safeStop(voice);
      this.teardown(voice.id);
    }
    this.voices.clear();
  }

  private fadeAndStop(voice: Voice, when: number, fadeMs: number): void {
    voice.released = true;
    voice.stopScheduled = true;
    voice.ampGain.gain.cancelAndHoldAtTime(when);
    voice.ampGain.gain.linearRampToValueAtTime(0, when + fadeMs / 1000);
    this.safeStop(voice, when + fadeMs / 1000);
  }

  private safeStop(voice: Voice, when?: number): void {
    try {
      voice.source.stop(when);
    } catch {
      // Already stopped — Web Audio throws on a second stop(); harmless here.
    }
  }

  private teardown(id: string): void {
    const voice = this.voices.get(id);
    if (!voice) return;
    this.voices.delete(id);
    voice.source.onended = null;
    try {
      voice.source.disconnect();
    } catch {
      // Never connected / already gone.
    }
    voice.ampGain.disconnect();
  }

  private voiceRefs(): VoiceRef[] {
    return [...this.voices.values()].map((v) => ({
      id: v.id,
      startTime: v.startTime,
      released: v.released,
    }));
  }

  private chokeCandidates(): ChokeCandidate[] {
    return [...this.voices.values()].map((v) => ({
      id: v.id,
      programId: v.programId,
      padKey: v.padKey,
      chokeGroup: v.chokeGroup,
    }));
  }
}
