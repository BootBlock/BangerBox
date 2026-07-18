/**
 * Voice pool — spec §5.4. A global pool of at most `MAX_VOICES` voices; each voice is one
 * `AudioBufferSourceNode` → amp-envelope `GainNode` → (optional) filter `BiquadFilterNode`
 * feeding a pad channel input (spec §5.2 stages 1–2, 5). Owns per-pad playback modes
 * (poly / mono / oneShot), choke groups, and voice stealing with a short fade — never a
 * hard cut/click (spec §5.4). Phase 5 enriches the voice with the §6 sound-design surface:
 * per-voice filter + filter envelope, pitch envelope, and LFOs / static mod-matrix offsets
 * (spec §6). Allocation policy is the pure {@link selectStealVictim}/{@link
 * selectChokeVictims} (spec §11.1); this class wires and tears down nodes (spec §3.2).
 */
import { CHOKE_FADE_MS, DECLICK_FADE_MS, MAX_VOICES, VOICE_STEAL_FADE_MS } from '@/core/constants';
import { clamp } from '@/core/math';
import {
  FILTER_CUTOFF_RANGE,
  FILTER_RESONANCE_RANGE,
  type AhdsrEnvelope,
  type LfoConfig,
  type ModRoute,
  type PadFilter,
  type PlaybackMode,
} from '@/core/project/schemas';
import {
  scheduleAmpAttack,
  scheduleAmpDeclick,
  scheduleAmpRelease,
  scheduleModEnvelope,
  velocityToGain,
} from './voiceEnvelope';
import {
  biquadFilterType,
  lfoOscillator,
  staticModulation,
  FILTER_MOD_OCTAVES,
  PITCH_MOD_CENTS,
} from './voiceModulation';
import { routesForSource } from './modMatrix';
import { rampParamTarget } from './params/ramps';
import type { ProgramParamTarget } from './voiceParams';
import { selectChokeVictims, selectStealVictim, type ChokeCandidate, type VoiceRef } from './voiceSelection';

/** The §6 sound-design surface for one voice (optional — omitted by the demo path). */
export interface VoiceSoundDesign {
  readonly filter?: PadFilter;
  readonly pitchEnv?: AhdsrEnvelope;
  readonly filterEnv?: AhdsrEnvelope;
  readonly pitchEnvSemitones?: number;
  readonly lfos?: readonly [LfoConfig, LfoConfig];
  readonly modMatrix?: readonly ModRoute[];
}

/** Everything the pool needs to sound one hit (spec §5.4, §6). */
export interface VoiceTriggerSpec extends VoiceSoundDesign {
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
  /** Non-destructive per-layer trim in frames (spec §6); omitted/0 with `endFrame` = whole sample. */
  readonly startFrame?: number;
  readonly endFrame?: number;
  /** Keygroup voice cap for the owning program (spec §6); undefined = pool-global only. */
  readonly programPolyphony?: number;
  /** Keygroup mono glide time in ms (spec §6): portamento into the note; 0/undefined = off. */
  readonly glideMs?: number;
}

interface Voice {
  readonly id: string;
  readonly source: AudioBufferSourceNode;
  readonly ampGain: GainNode;
  /** Per-voice filter (spec §5.2 stage 2), or null when the pad filter is off. */
  readonly filter: BiquadFilterNode | null;
  /** LFO oscillators (spec §6) — started with the voice, stopped in teardown. */
  readonly oscillators: OscillatorNode[];
  /** LFO scaling gains feeding modulation targets. */
  readonly modGains: GainNode[];
  readonly padKey: string;
  readonly programId: string;
  readonly chokeGroup: number;
  readonly oneShot: boolean;
  readonly releaseMs: number;
  /** Base detune in cents (tune + static pitch mod) — the glide origin (spec §6). */
  readonly baseDetune: number;
  /** Buffer seconds this voice sounds — its trimmed region at unity rate (spec §6). */
  readonly regionSeconds: number;
  /** Buffer seconds already consumed as of `rateSince`, for end-time bookkeeping. */
  consumedSeconds: number;
  /** Context time `rate` took effect — the origin the next retune integrates from. */
  rateSince: number;
  /** Playback rate implied by the voice's current detune (1 = unity). */
  rate: number;
  /** Context time the scheduled declick fade begins (spec §5.4). */
  declickFadeStart: number;
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

    // Capture the sounding same-pad pitch before any cut, so mono glide can portamento
    // from it into the new note (spec §6 keygroup glide).
    const glideFrom = (spec.glideMs ?? 0) > 0 ? this.currentPadDetune(spec.padKey) : undefined;

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

    // 3. Keygroup polyphony: cap concurrent voices per program, stealing the oldest (spec §6).
    this.enforceProgramPolyphony(spec, now);

    // 4. Capacity: steal a voice when the global pool is exhausted (spec §5.4).
    if (this.voices.size >= this.maxVoices) {
      const victimId = selectStealVictim(this.voiceRefs());
      const victim = victimId ? this.voices.get(victimId) : undefined;
      if (victim) this.fadeAndStop(victim, now, VOICE_STEAL_FADE_MS);
    }

    // 5. Build and start the enriched voice chain (spec §5.2 stages 1–2, §6).
    const voice = this.buildVoice(spec, now, glideFrom);
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

  /**
   * Apply a program-scope parameter change to every sounding voice of a pad (spec §6,
   * §7.8) — the per-voice half of automation and live sound-design edits. Values ramp
   * over `PARAM_RAMP_MS` like any live parameter move, so an automated filter sweep does
   * not zipper (spec §4.3).
   *
   * A voice whose pad filter is off has no filter node; filter changes simply skip it
   * rather than materialising a node mid-note (which would click).
   */
  applyPadParam(padKey: string, target: ProgramParamTarget, value: number, when: number): void {
    for (const voice of this.voices.values()) {
      if (voice.padKey !== padKey || voice.stopScheduled) continue;
      switch (target) {
        case 'filterFrequency':
          if (voice.filter) rampParamTarget(voice.filter.frequency, value, when);
          break;
        case 'filterQ':
          if (voice.filter) rampParamTarget(voice.filter.Q, value, when);
          break;
        case 'detune':
          // Layered on the voice's base detune so tune/pitch-mod are not discarded (§6).
          this.retune(voice, voice.baseDetune + value, when);
          break;
        default:
          // Channel-scope targets are the pad channel's business, not the voice's.
          break;
      }
    }
  }

  /**
   * Apply a pitch-bend detune, in cents, to every sounding voice of a program (spec §10.2).
   * Layered on each voice's base detune so pad tune and pitch modulation survive the bend
   * (spec §6), and ramped like any other live parameter change (spec §4.3 dezipper).
   */
  applyProgramDetune(programId: string, cents: number, when: number): void {
    for (const voice of this.voices.values()) {
      if (voice.programId !== programId || voice.stopScheduled) continue;
      this.retune(voice, voice.baseDetune + cents, when);
    }
  }

  /** Live voices sounding a given program (keygroup polyphony bookkeeping, spec §6). */
  programVoiceCount(programId: string): number {
    let count = 0;
    for (const voice of this.voices.values()) if (voice.programId === programId) count++;
    return count;
  }

  /** Stop and tear down every voice (project close / mode unmount) — spec §3.2. */
  destroy(): void {
    for (const voice of [...this.voices.values()]) {
      this.safeStop(voice);
      this.teardown(voice.id);
    }
    this.voices.clear();
  }

  // --------------------------------------------------------------- internals ---

  /** Steal the oldest voices of a program until it is under its polyphony cap (spec §6). */
  private enforceProgramPolyphony(spec: VoiceTriggerSpec, now: number): void {
    const cap = spec.programPolyphony;
    if (cap === undefined) return;
    const live = [...this.voices.values()]
      .filter((voice) => voice.programId === spec.programId && !voice.stopScheduled)
      .sort((a, b) => a.startTime - b.startTime);
    for (let i = 0; i <= live.length - cap; i++) this.fadeAndStop(live[i]!, now, VOICE_STEAL_FADE_MS);
  }

  /**
   * Retune a live voice to an absolute detune and move its declick with it (spec §5.4,
   * §10.2). The rate change alters when the buffer runs out, so a fade laid at trigger
   * time would land in the wrong place for a bend held through the end of a sample.
   */
  private retune(voice: Voice, detuneCents: number, when: number): void {
    rampParamTarget(voice.source.detune, detuneCents, when);
    this.rescheduleDeclick(voice, detuneCents, when);
  }

  /**
   * Re-lay the end-of-region declick after a rate change. The voice's consumption is
   * integrated as piecewise-constant rate segments: whatever it played at the old rate is
   * banked, and the remainder is divided by the new one. The `PARAM_RAMP_MS` dezipper on
   * `detune` is treated as instantaneous — it is far shorter than the error it corrects.
   *
   * Two cases are left alone, because re-laying could only make them worse: a region that
   * has already run out, and a fade that has already begun (the ramp in flight is nearer
   * the truth than anything scheduled behind it, and cutting it short would click).
   *
   * This does not model the §6 modulators — pitch envelope, mono glide and a pitch-routed
   * LFO all vary `detune` inside the AudioParam, where the pool cannot see it — so for
   * those voices the end time stays an estimate (issue #87).
   */
  private rescheduleDeclick(voice: Voice, detuneCents: number, when: number): void {
    const at = Math.max(when, voice.startTime);
    voice.consumedSeconds += Math.max(0, at - voice.rateSince) * voice.rate;
    voice.rateSince = at;
    voice.rate = playbackRate(detuneCents);
    const remaining = voice.regionSeconds - voice.consumedSeconds;
    if (remaining <= 0 || at >= voice.declickFadeStart) return;
    // Erase the stale fade first: holding at its own start leaves the amp on the level the
    // AHDSR had reached there, which is exactly what the new fade wants to depart from.
    voice.ampGain.gain.cancelAndHoldAtTime(voice.declickFadeStart);
    const endTime = at + remaining / voice.rate;
    voice.declickFadeStart = scheduleAmpDeclick(voice.ampGain.gain, endTime, at, DECLICK_FADE_MS);
  }

  /** The base detune of the sounding voice on a pad (mono glide origin, spec §6), or undefined. */
  private currentPadDetune(padKey: string): number | undefined {
    for (const voice of this.voices.values()) {
      if (voice.padKey === padKey && !voice.stopScheduled) return voice.baseDetune;
    }
    return undefined;
  }

  /** Assemble source → ampGain → [filter] → destination with §6 modulation (spec §5.2). */
  private buildVoice(spec: VoiceTriggerSpec, now: number, glideFrom?: number): Voice {
    const oscillators: OscillatorNode[] = [];
    const modGains: GainNode[] = [];
    const routes = spec.modMatrix ?? [];
    const stat = staticModulation(
      routes,
      noteFromPadKey(spec.padKey),
      spec.velocity,
      deterministicRandom(spec.id),
    );

    const source = this.context.createBufferSource();
    source.buffer = spec.buffer;
    const baseDetune = spec.tuneSemitones * 100 + spec.tuneCents + stat.detuneCents;

    const ampGain = this.context.createGain();
    const filterType = spec.filter ? biquadFilterType(spec.filter.type) : null;
    const filter = filterType ? this.context.createBiquadFilter() : null;

    // Chain: source → ampGain → [filter] → destination (spec §5.2 stages 1–2, 5).
    source.connect(ampGain);
    if (filter) {
      filter.type = filterType!;
      filter.frequency.value = clamp(
        spec.filter!.cutoff * stat.cutoffFactor,
        FILTER_CUTOFF_RANGE[0],
        FILTER_CUTOFF_RANGE[1],
      );
      filter.Q.value = clamp(spec.filter!.resonance, FILTER_RESONANCE_RANGE[0], FILTER_RESONANCE_RANGE[1]);
      ampGain.connect(filter);
      filter.connect(spec.destination);
      this.scheduleFilterEnvelope(filter, spec, now);
    } else {
      ampGain.connect(spec.destination);
    }

    // Pitch: base detune, then either mono glide (portamento) or the pitch envelope on top
    // (spec §6). Keygroups glide and carry no pitch env; drums use the pitch env — they do
    // not co-occur, so a single detune schedule owns the param.
    const pitchDepth = (spec.pitchEnvSemitones ?? 0) * 100;
    const glideMs = spec.glideMs ?? 0;
    if (glideMs > 0 && glideFrom !== undefined && glideFrom !== baseDetune) {
      source.detune.setValueAtTime(glideFrom, now);
      source.detune.linearRampToValueAtTime(baseDetune, now + glideMs / 1000);
    } else if (spec.pitchEnv && pitchDepth !== 0) {
      scheduleModEnvelope(source.detune, baseDetune, pitchDepth, spec.pitchEnv, now);
    } else {
      source.detune.value = baseDetune;
    }

    // Amp AHDSR (velocity × gain trim × static amp mod) — spec §5.4/§6.
    const peak = velocityToGain(spec.velocity, spec.gainDb) * stat.ampFactor;
    scheduleAmpAttack(ampGain.gain, peak, spec.amp, now);

    // Declick the natural end of the region (spec §5.4). The end time is derived from the
    // base detune only: a pitch envelope, glide or pitch LFO varies the real playback rate,
    // so for those voices the fade is an approximation rather than frame-exact. A later
    // retune (pad detune, pitch bend) moves the fade with it — see `rescheduleDeclick`.
    const region = playRegion(spec.buffer, spec.startFrame, spec.endFrame);
    const rate = playbackRate(baseDetune);
    const endTime = now + region.durationSeconds / rate;
    const declickFadeStart = scheduleAmpDeclick(ampGain.gain, endTime, now, DECLICK_FADE_MS);

    // LFOs → pitch (detune) and filter cutoff (filter.detune) targets (spec §6).
    this.wireLfos(spec, source, filter, oscillators, modGains);

    source.start(now, region.offsetSeconds, region.durationSeconds);
    for (const osc of oscillators) osc.start(now);

    const voice: Voice = {
      id: spec.id,
      source,
      ampGain,
      filter,
      oscillators,
      modGains,
      padKey: spec.padKey,
      programId: spec.programId,
      chokeGroup: spec.chokeGroup,
      oneShot: spec.playbackMode === 'oneShot',
      releaseMs: spec.amp.release,
      baseDetune,
      regionSeconds: region.durationSeconds,
      consumedSeconds: 0,
      rateSince: now,
      rate,
      declickFadeStart,
      startTime: now,
      released: false,
      stopScheduled: false,
    };
    // A finite buffer ends on its own → teardown; stolen/choked voices end after the fade.
    source.onended = () => this.teardown(spec.id);
    return voice;
  }

  /** Filter envelope on the biquad `detune` (cents), scaled by envDepth (spec §6). */
  private scheduleFilterEnvelope(filter: BiquadFilterNode, spec: VoiceTriggerSpec, now: number): void {
    const envDepth = spec.filter?.envDepth ?? 0;
    if (!spec.filterEnv || envDepth === 0) return;
    const depthCents = envDepth * FILTER_MOD_OCTAVES * 1200;
    scheduleModEnvelope(filter.detune, 0, depthCents, spec.filterEnv, now);
  }

  /** Wire each LFO to its pitch/filter-cutoff routes as an oscillator → gain → param (spec §6). */
  private wireLfos(
    spec: VoiceTriggerSpec,
    source: AudioBufferSourceNode,
    filter: BiquadFilterNode | null,
    oscillators: OscillatorNode[],
    modGains: GainNode[],
  ): void {
    const lfos = spec.lfos;
    const routes = spec.modMatrix;
    if (!lfos || !routes) return;
    lfos.forEach((config, index) => {
      const sourceName = index === 0 ? 'lfo1' : 'lfo2';
      const targets = routesForSource(routes, sourceName).filter(
        (route) => route.target === 'pitch' || (route.target === 'filterCutoff' && filter),
      );
      if (targets.length === 0) return;
      const { type, sign } = lfoOscillator(config.shape);
      const osc = this.context.createOscillator();
      osc.type = type;
      osc.frequency.value = config.rate; // free-rate Hz; tempo-synced LFO is a later refinement
      oscillators.push(osc);
      for (const route of targets) {
        const gain = this.context.createGain();
        if (route.target === 'pitch') {
          gain.gain.value = sign * route.amount * PITCH_MOD_CENTS;
          osc.connect(gain);
          gain.connect(source.detune);
        } else if (filter) {
          gain.gain.value = sign * route.amount * FILTER_MOD_OCTAVES * 1200;
          osc.connect(gain);
          gain.connect(filter.detune);
        }
        modGains.push(gain);
      }
    });
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
    for (const osc of voice.oscillators) {
      try {
        osc.stop();
      } catch {
        // Never started / already stopped.
      }
      osc.disconnect();
    }
    for (const gain of voice.modGains) gain.disconnect();
    try {
      voice.source.disconnect();
    } catch {
      // Never connected / already gone.
    }
    voice.ampGain.disconnect();
    voice.filter?.disconnect();
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

/** The portion of a buffer a voice sounds, in buffer seconds (spec §6 trim). */
export interface PlayRegion {
  readonly offsetSeconds: number;
  readonly durationSeconds: number;
}

/**
 * Resolve a layer's `[startFrame, endFrame)` trim against a decoded buffer (spec §6).
 * `endFrame` of 0 — the schema default, meaning "whole sample" — and any out-of-range or
 * inverted pair fall back to the buffer's own end, so a stale trim can never silence a pad.
 */
export function playRegion(buffer: AudioBuffer, startFrame = 0, endFrame = 0): PlayRegion {
  const frames = buffer.length;
  const start = clamp(Math.floor(startFrame), 0, frames);
  const requestedEnd = Math.floor(endFrame);
  const end = requestedEnd > start && requestedEnd <= frames ? requestedEnd : frames;
  return {
    offsetSeconds: start / buffer.sampleRate,
    durationSeconds: (end - start) / buffer.sampleRate,
  };
}

/** Buffer-consumption rate for a detune in cents — 1200 cents doubles the rate (spec §6). */
function playbackRate(detuneCents: number): number {
  return 2 ** (detuneCents / 1200);
}

/** Extract the pad index from a `${programId}:${padIndex}` key for the noteNumber source. */
function noteFromPadKey(padKey: string): number {
  const index = Number(padKey.slice(padKey.lastIndexOf(':') + 1));
  return Number.isFinite(index) ? index : 0;
}

/**
 * A stable bipolar pseudo-random in [−1, 1] derived from the voice id, so the `random`
 * mod source is deterministic per hit (repeatable renders, spec §11.2) yet varies between
 * hits. A hash of the id keeps it dependency-free.
 */
function deterministicRandom(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return (hash % 2000) / 1000 - 1; // −1..1
}
