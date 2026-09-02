/**
 * Voice pool — spec §5.4. A global pool of at most `MAX_VOICES` voices; each voice is one
 * `AudioBufferSourceNode` → amp-envelope `GainNode` → (optional) filter `BiquadFilterNode`
 * feeding a pad channel input (spec §5.2 stages 1–2, 5). Owns per-pad playback modes
 * (poly / mono / oneShot), choke groups, and voice stealing with a short fade — never a
 * hard cut/click (spec §5.4). Each voice carries the §6 sound-design surface: per-voice
 * filter + filter envelope, pitch envelope, and LFOs / static mod-matrix offsets
 * (spec §6). Allocation policy is the pure {@link selectStealVictim}/{@link
 * selectChokeVictims} (spec §11.1); this class wires and tears down nodes (spec §3.2).
 */
import { CHOKE_FADE_MS, DECLICK_FADE_MS, MAX_VOICES, VOICE_STEAL_FADE_MS } from '@/core/constants';
import { clamp } from '@/core/math';
import {
  DEFAULT_BPM,
  FILTER_CUTOFF_RANGE,
  FILTER_RESONANCE_RANGE,
  type AhdsrEnvelope,
  type LfoConfig,
  type ModRoute,
  type PadFilter,
  type PlaybackMode,
} from '@/core/project/schemas';
import {
  modEnvelopeBreakpoints,
  scheduleAmpAttack,
  scheduleAmpDeclick,
  scheduleAmpRelease,
  scheduleModEnvelope,
  velocityToGain,
} from './voiceEnvelope';
import {
  applyRetune,
  consumedBetween,
  regionEndTime,
  type DetuneBreakpoint,
  type DetuneOscillation,
  type DetuneSchedule,
} from './detuneSchedule';
import {
  biquadFilterType,
  lfoOscillator,
  lfoRateHz,
  lfoWaveCoefficients,
  staticModulation,
  FILTER_ENV_OCTAVES,
  FILTER_MOD_OCTAVES,
  PITCH_MOD_CENTS,
} from './voiceModulation';
import { routesForSource } from './modMatrix';
import { cancelParams, rampParamTarget } from './params/ramps';
import type { ProgramParamTarget } from './voiceParams';
import { selectChokeVictims, selectStealVictim, type ChokeCandidate, type VoiceRef } from './voiceSelection';
import { createBufferVoiceSource, createGranularVoiceSource, type VoiceSource } from './voiceSource';
import { getKernelModule } from '@/core/dsp/kernelModules';

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
  /** Transport tempo a §6 tempo-synced LFO locks to (spec §7.2); defaults to §9.3's default. */
  readonly bpm?: number;
  /**
   * spec §6 `Pad.warp` — play through the §5.7.9 granular source instead of an
   * `AudioBufferSourceNode`, so the voice's detune shifts pitch without changing how long
   * the region lasts. Ignored when the kernel module has not been loaded (a unit context,
   * or an offline render that skipped the §5.1 gate): the voice falls back to coupled
   * repitch, which is the ordinary behaviour rather than silence.
   */
  readonly warp?: boolean;
}

/**
 * A free-running LFO shared by every voice of a pad (spec §6 `retrigger: false`). It is
 * per pad rather than per voice because that is what "free-running" means: the cycle has
 * to outlive the note that first started it, or the next note restarts it at phase zero
 * and `retrigger: false` is indistinguishable from `retrigger: true`.
 */
interface SharedLfo {
  readonly osc: OscillatorNode;
  /** Context time the oscillator started — the origin the declick model integrates from. */
  readonly since: number;
  /** The §6 config this was built for; a changed config rebuilds rather than drifts. */
  readonly signature: string;
}

interface Voice {
  readonly id: string;
  /** The §5.2 stage-1 source: a buffer source, or the §5.7.9 warp source for a warp pad. */
  readonly source: VoiceSource;
  readonly ampGain: GainNode;
  /** Per-voice filter (spec §5.2 stage 2), or null when the pad filter is off. */
  readonly filter: BiquadFilterNode | null;
  /** LFO oscillators (spec §6) — started with the voice, stopped in teardown. */
  readonly oscillators: OscillatorNode[];
  /** LFO scaling gains feeding modulation targets. */
  readonly modGains: GainNode[];
  /**
   * Connections from a shared free-running LFO into this voice's mod gains (spec §6). They
   * are detached by hand on teardown: disconnecting a gain releases its outputs, not the
   * oscillator still feeding it, and that oscillator outlives the voice.
   */
  readonly sharedLinks: { readonly from: OscillatorNode; readonly to: GainNode }[];
  /**
   * Live bend offset in cents, summed into `source.detune` (spec §10.2, §6). Built on the
   * first retune rather than at note-on, so a voice that is never bent costs no extra node.
   */
  bendSource: ConstantSourceNode | null;
  readonly padKey: string;
  readonly programId: string;
  readonly chokeGroup: number;
  readonly oneShot: boolean;
  readonly releaseMs: number;
  /** Base detune in cents (tune + static pitch mod) — the glide origin (spec §6). */
  readonly baseDetune: number;
  /** Buffer seconds this voice sounds — its trimmed region at unity rate (spec §6). */
  readonly regionSeconds: number;
  /** The voice's detune contour, from which its true end time is integrated (issue #87). */
  readonly detune: DetuneSchedule;
  /** Buffer seconds already consumed as of `consumedUntil`, banked on each retune. */
  consumedSeconds: number;
  /** Context time `consumedSeconds` was banked to — the origin the next retune integrates from. */
  consumedUntil: number;
  /** Context time the scheduled declick fade begins (spec §5.4). */
  declickFadeStart: number;
  startTime: number;
  released: boolean;
  stopScheduled: boolean;
}

export class VoicePool {
  private readonly voices = new Map<string, Voice>();
  /** Free-running §6 LFOs, keyed `${padKey}:${lfoIndex}` — see {@link SharedLfo}. */
  private readonly sharedLfos = new Map<string, SharedLfo>();

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
          // An offset summed onto the voice's contour, so tune, pitch-mod and any pitch
          // envelope or glide still in flight are all preserved (§6).
          this.retune(voice, value, when);
          break;
        default:
          // Channel-scope targets are the pad channel's business, not the voice's.
          break;
      }
    }
  }

  /**
   * Apply a pitch-bend detune, in cents, to every sounding voice of a program (spec §10.2).
   * Summed onto each voice's detune contour so pad tune, pitch modulation and any pitch
   * envelope or mono glide survive the bend (spec §6), and ramped like any other live
   * parameter change (spec §4.3 dezipper).
   */
  applyProgramDetune(programId: string, cents: number, when: number): void {
    for (const voice of this.voices.values()) {
      if (voice.programId !== programId || voice.stopScheduled) continue;
      this.retune(voice, cents, when);
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
    // Free-running LFOs outlive their voices by design (spec §6), so the pool owns their
    // teardown — nothing else would ever release them.
    for (const shared of this.sharedLfos.values()) {
      try {
        shared.osc.stop();
      } catch {
        // Never started / already stopped.
      }
      cancelParams(shared.osc.frequency, shared.osc.detune);
      shared.osc.disconnect();
    }
    this.sharedLfos.clear();
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
   * Retune a live voice by an offset in cents and move its declick with it (spec §5.4,
   * §10.2). The rate change alters when the buffer runs out, so a fade laid at trigger
   * time would land in the wrong place for a bend held through the end of a sample.
   *
   * The offset goes on the voice's own bend node, not on `source.detune`, so it *sums*
   * with whatever the pitch envelope or glide is doing there rather than competing with it
   * (spec §10.2). Writing it onto `source.detune` would be swallowed outright whenever a
   * contour event was still pending — see §14 `2026-07-18 (x)`.
   */
  private retune(voice: Voice, offsetCents: number, when: number): void {
    rampParamTarget(this.bendNode(voice, when).offset, offsetCents, when);
    this.rescheduleDeclick(voice, offsetCents, when);
  }

  /** The voice's bend node, wired into `source.detune` on first use (spec §10.2). */
  private bendNode(voice: Voice, when: number): ConstantSourceNode {
    if (voice.bendSource) return voice.bendSource;
    const node = this.context.createConstantSource();
    node.offset.value = 0; // defaults to 1 — a voice starts unbent
    node.connect(voice.source.detune);
    node.start(when);
    voice.bendSource = node;
    return node;
  }

  /**
   * Re-lay the end-of-region declick after a detune change. Whatever the voice consumed
   * up to `when` is banked by integrating its detune contour, the retune is folded into
   * that contour, and the remainder is integrated forward to the true end (issue #87).
   * The `PARAM_RAMP_MS` dezipper on `detune` is treated as instantaneous — it is far
   * shorter than the error it corrects.
   *
   * Two cases are left alone, because re-laying could only make them worse: a region that
   * has already run out, and a fade that has already begun (the ramp in flight is nearer
   * the truth than anything scheduled behind it, and cutting it short would click).
   */
  private rescheduleDeclick(voice: Voice, offsetCents: number, when: number): void {
    // A §5.7.9 warp voice decouples pitch from duration, so a retune moves no end to chase.
    // Its declick was laid at the source's own length and stays where it is.
    if (!voice.source.pitchCoupled) return;
    const at = Math.max(when, voice.startTime);
    voice.consumedSeconds += consumedBetween(voice.detune, voice.consumedUntil, at);
    voice.consumedUntil = at;
    applyRetune(voice.detune, at, offsetCents);
    const remaining = voice.regionSeconds - voice.consumedSeconds;
    if (remaining <= 0 || at >= voice.declickFadeStart) return;
    // Erase the stale fade first: holding at its own start leaves the amp on the level the
    // AHDSR had reached there, which is exactly what the new fade wants to depart from.
    voice.ampGain.gain.cancelAndHoldAtTime(voice.declickFadeStart);
    const endTime = regionEndTime(voice.detune, at, remaining);
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
    const sharedLinks: { from: OscillatorNode; to: GainNode }[] = [];
    const routes = spec.modMatrix ?? [];
    const stat = staticModulation(
      routes,
      noteFromPadKey(spec.padKey),
      spec.velocity,
      deterministicRandom(spec.id),
    );

    // The §6 trim resolved against the buffer, then the source that plays it (spec §5.2
    // stage 1): the §5.7.9 granular engine for a warp pad, else an `AudioBufferSourceNode`.
    const region = playRegion(spec.buffer, spec.startFrame, spec.endFrame);
    const source = this.buildSource(spec, region, now);
    const baseDetune = spec.tuneSemitones * 100 + spec.tuneCents + stat.detuneCents;

    const ampGain = this.context.createGain();
    const filterType = spec.filter ? biquadFilterType(spec.filter.type) : null;
    const filter = filterType ? this.context.createBiquadFilter() : null;

    // Chain: source → ampGain → [filter] → destination (spec §5.2 stages 1–2, 5).
    source.node.connect(ampGain);
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
    // not co-occur, so a single detune schedule owns the param. Every write is mirrored
    // into `breakpoints`, which is what lets the declick integrate the real rate curve.
    const pitchDepth = (spec.pitchEnvSemitones ?? 0) * 100;
    const glideMs = spec.glideMs ?? 0;
    let breakpoints: DetuneBreakpoint[]; // live bends are a separate, additive track
    if (glideMs > 0 && glideFrom !== undefined && glideFrom !== baseDetune) {
      const glideEnd = now + glideMs / 1000;
      source.detune.setValueAtTime(glideFrom, now);
      source.detune.linearRampToValueAtTime(baseDetune, glideEnd);
      breakpoints = [
        { time: now, cents: glideFrom },
        { time: glideEnd, cents: baseDetune },
      ];
    } else if (spec.pitchEnv && pitchDepth !== 0) {
      scheduleModEnvelope(source.detune, baseDetune, pitchDepth, spec.pitchEnv, now);
      breakpoints = modEnvelopeBreakpoints(baseDetune, pitchDepth, spec.pitchEnv, now);
    } else {
      source.detune.value = baseDetune;
      breakpoints = [{ time: now, cents: baseDetune }];
    }

    // Amp AHDSR (velocity × gain trim × static amp mod) — spec §5.4/§6.
    const peak = velocityToGain(spec.velocity, spec.gainDb) * stat.ampFactor;
    scheduleAmpAttack(ampGain.gain, peak, spec.amp, now);

    // LFOs → pitch (detune) and filter cutoff (filter.detune) targets (spec §6). Wired
    // before the declick because pitch-routed LFOs are part of the rate curve it solves.
    const oscillations = this.wireLfos(spec, source, filter, now, oscillators, modGains, sharedLinks);
    const detune: DetuneSchedule = { breakpoints, bend: [], oscillations };

    // Declick the natural end of the region (spec §5.4). On a coupled source the detune
    // contour IS the playback rate, so the end is integrated from it and a pitch envelope,
    // glide or pitch LFO lands the fade where the buffer truly runs out (issue #87); a later
    // retune moves it (`rescheduleDeclick`). A §5.7.9 warp source decouples the two, so its
    // end is simply its own length and nothing can move it.
    const endTime = source.pitchCoupled
      ? regionEndTime(detune, now, source.sourceSeconds)
      : now + source.sourceSeconds;
    const declickFadeStart = scheduleAmpDeclick(ampGain.gain, endTime, now, DECLICK_FADE_MS);

    source.start(now);
    for (const osc of oscillators) osc.start(now);

    const voice: Voice = {
      id: spec.id,
      source,
      ampGain,
      filter,
      oscillators,
      modGains,
      sharedLinks,
      bendSource: null,
      padKey: spec.padKey,
      programId: spec.programId,
      chokeGroup: spec.chokeGroup,
      oneShot: spec.playbackMode === 'oneShot',
      releaseMs: spec.amp.release,
      baseDetune,
      regionSeconds: source.sourceSeconds,
      detune,
      consumedSeconds: 0,
      consumedUntil: now,
      declickFadeStart,
      startTime: now,
      released: false,
      stopScheduled: false,
    };
    // A finite source ends on its own → teardown; stolen/choked voices end after the fade.
    source.setOnEnded(() => this.teardown(spec.id));
    return voice;
  }

  /**
   * The §5.2 stage-1 source for a voice. A §6 `warp` pad plays through the §5.7.9 granular
   * worklet source; everything else through an `AudioBufferSourceNode`.
   *
   * Warp falls back to the buffer source when the `granularStretch` module has not been
   * compiled — a unit-test context, or an offline render that skipped the §5.1 start gate.
   * A pad that then repitches in the coupled way is a lesser wrong than a silent one.
   */
  private buildSource(spec: VoiceTriggerSpec, region: PlayRegion, now: number): VoiceSource {
    if (spec.warp) {
      const module = getKernelModule('granularStretch');
      if (module) return createGranularVoiceSource(this.context, module, spec.buffer, region, now);
    }
    return createBufferVoiceSource(this.context, spec.buffer, region);
  }

  /** Filter envelope on the biquad `detune` (cents), scaled by envDepth (spec §6). */
  private scheduleFilterEnvelope(filter: BiquadFilterNode, spec: VoiceTriggerSpec, now: number): void {
    const envDepth = spec.filter?.envDepth ?? 0;
    if (!spec.filterEnv || envDepth === 0) return;
    const depthCents = envDepth * FILTER_ENV_OCTAVES * 1200;
    scheduleModEnvelope(filter.detune, 0, depthCents, spec.filterEnv, now);
  }

  /**
   * Wire each LFO to its pitch/filter-cutoff routes as an oscillator → gain → param
   * (spec §6). Returns a description of the pitch-routed oscillators, which the declick
   * integrator needs because they modulate the voice's playback rate (issue #87).
   *
   * All five §6 `LfoConfig` fields are applied here (issue #107): `rate` and `sync` decide
   * the frequency through {@link lfoRateHz}, `shape` the waveform, `phaseOffset` a rotation
   * baked into that waveform, and `retrigger` whether the voice owns its oscillator or
   * borrows the pad's free-running one.
   */
  private wireLfos(
    spec: VoiceTriggerSpec,
    source: VoiceSource,
    filter: BiquadFilterNode | null,
    now: number,
    oscillators: OscillatorNode[],
    modGains: GainNode[],
    sharedLinks: { from: OscillatorNode; to: GainNode }[],
  ): DetuneOscillation[] {
    const pitchOscillations: DetuneOscillation[] = [];
    const lfos = spec.lfos;
    const routes = spec.modMatrix;
    if (!lfos || !routes) return pitchOscillations;
    const bpm = spec.bpm ?? DEFAULT_BPM;
    lfos.forEach((config, index) => {
      const sourceName = index === 0 ? 'lfo1' : 'lfo2';
      const targets = routesForSource(routes, sourceName).filter(
        (route) => route.target === 'pitch' || (route.target === 'filterCutoff' && filter),
      );
      if (targets.length === 0) return;
      const { type, sign } = lfoOscillator(config.shape);
      const rateHz = lfoRateHz(config, bpm);
      // spec §6 `retrigger`: false borrows the pad's free-running LFO, true starts a fresh
      // one at phase zero with the note.
      const shared = config.retrigger ? null : this.sharedLfo(spec.padKey, index, config, type, rateHz, now);
      const osc = shared?.osc ?? this.buildOscillator(type, rateHz, config.phaseOffset);
      const since = shared?.since ?? now;
      if (!shared) oscillators.push(osc);
      for (const route of targets) {
        const gain = this.context.createGain();
        if (route.target === 'pitch') {
          gain.gain.value = sign * route.amount * PITCH_MOD_CENTS;
          osc.connect(gain);
          gain.connect(source.detune);
          pitchOscillations.push({
            wave: type,
            rateHz,
            amplitudeCents: gain.gain.value,
            since,
            phase: config.phaseOffset,
          });
        } else if (filter) {
          gain.gain.value = sign * route.amount * FILTER_MOD_OCTAVES * 1200;
          osc.connect(gain);
          gain.connect(filter.detune);
        }
        if (shared) sharedLinks.push({ from: osc, to: gain });
        modGains.push(gain);
      }
    });
    return pitchOscillations;
  }

  /**
   * An oscillator for a §6 LFO. `phaseOffset` is baked into the waveform through
   * {@link lfoWaveCoefficients}: an `OscillatorNode` always begins at phase zero and has
   * no phase parameter, so the wave itself is rotated instead. A zero offset keeps the
   * native type, which is band-limited by the browser and costs nothing to build.
   */
  private buildOscillator(type: OscillatorType, rateHz: number, phaseOffset: number): OscillatorNode {
    const osc = this.context.createOscillator();
    if (phaseOffset === 0) {
      osc.type = type;
    } else {
      const { real, imag } = lfoWaveCoefficients(type, phaseOffset);
      osc.setPeriodicWave(this.context.createPeriodicWave(real, imag));
    }
    osc.frequency.value = rateHz;
    return osc;
  }

  /**
   * The pad's free-running LFO for `index`, built on first use and kept running afterwards
   * (spec §6 `retrigger: false`). A changed §6 config rebuilds it — a rate the user has
   * just edited matters more than the cycle the old oscillator was part-way through.
   */
  private sharedLfo(
    padKey: string,
    index: number,
    config: LfoConfig,
    type: OscillatorType,
    rateHz: number,
    now: number,
  ): SharedLfo {
    const key = `${padKey}:${index}`;
    const signature = `${type}:${rateHz}:${config.phaseOffset}`;
    const existing = this.sharedLfos.get(key);
    if (existing && existing.signature === signature) return existing;
    if (existing) {
      try {
        existing.osc.stop();
      } catch {
        // Never started / already stopped.
      }
      cancelParams(existing.osc.frequency, existing.osc.detune);
      existing.osc.disconnect();
    }
    const osc = this.buildOscillator(type, rateHz, config.phaseOffset);
    osc.start(now);
    const shared: SharedLfo = { osc, since: now, signature };
    this.sharedLfos.set(key, shared);
    return shared;
  }

  private fadeAndStop(voice: Voice, when: number, fadeMs: number): void {
    voice.released = true;
    voice.stopScheduled = true;
    this.safeStop(voice, scheduleAmpRelease(voice.ampGain.gain, when, fadeMs));
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
    voice.source.setOnEnded(null);
    // Every param the voice automates, cancelled before the nodes go (spec §3.2): the amp
    // declick/AHDSR, the detune contour, and the §6 modulation and §10.2 bend depths.
    cancelParams(voice.ampGain.gain, ...voice.source.automatedParams());
    for (const osc of voice.oscillators) {
      try {
        osc.stop();
      } catch {
        // Never started / already stopped.
      }
      cancelParams(osc.frequency, osc.detune);
      osc.disconnect();
    }
    // A free-running LFO outlives the voice, so its link into this voice's gain is cut
    // here; disconnecting the gain alone would leave the oscillator holding it (spec §3.2).
    for (const link of voice.sharedLinks) {
      try {
        link.from.disconnect(link.to);
      } catch {
        // Already disconnected.
      }
    }
    voice.sharedLinks.length = 0;
    for (const gain of voice.modGains) {
      cancelParams(gain.gain);
      gain.disconnect();
    }
    if (voice.filter) cancelParams(voice.filter.frequency, voice.filter.Q, voice.filter.detune);
    if (voice.bendSource) {
      try {
        voice.bendSource.stop();
      } catch {
        // Already stopped.
      }
      cancelParams(voice.bendSource.offset);
      voice.bendSource.disconnect();
      voice.bendSource = null;
    }
    voice.source.destroy();
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
