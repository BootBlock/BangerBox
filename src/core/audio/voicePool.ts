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
  GAIN_DB_RANGE,
  MOD_AMOUNT_RANGE,
  TUNE_CENTS_RANGE,
  TUNE_SEMITONES_RANGE,
  type AhdsrEnvelope,
  type LfoConfig,
  type ModRoute,
  type PadFilter,
  type PlaybackMode,
} from '@/core/project/schemas';
import {
  ampLevelAt,
  declickFadeStart,
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
import { oscillatorDepthScale, routesForSource } from './modMatrix';
import { cancelParams, rampParamTarget, setParamNow } from './params/ramps';
import type { ProgramParamTarget } from './voiceParams';
import { selectChokeVictims, selectStealVictim, type ChokeCandidate, type VoiceRef } from './voiceSelection';
import { createBufferVoiceSource, createGranularVoiceSource, type VoiceSource } from './voiceSource';
import { getKernelModule } from '@/core/dsp/kernelModules';

/**
 * The furthest a voice's detune may reach, in cents (spec §6, issue #76): the §6 layer tune
 * range at full scale plus one octave of §6 pitch modulation. Derived from the ranges rather
 * than written down, so tightening any of them tightens this too (spec §13.6).
 */
const MAX_VOICE_DETUNE_CENTS = TUNE_SEMITONES_RANGE[1] * 100 + TUNE_CENTS_RANGE[1] + PITCH_MOD_CENTS;

/**
 * The furthest the §7.8 `pitch` leaf may move a pad, in cents (spec §6 `TUNE_SEMITONES_RANGE`).
 * It bounds the pad-lane node rather than the voice, because that is where the pad's own tune
 * now lives; the two bounds together still admit exactly the §6 drum voice
 * {@link MAX_VOICE_DETUNE_CENTS} admitted on its own before (issue #138).
 */
const MAX_PAD_TUNE_CENTS = TUNE_SEMITONES_RANGE[1] * 100;

/**
 * The furthest a §6 LAYER's tune may sit from its pad's, in cents: both at full scale and
 * opposed (spec §6). It bounds the voice's own share of the split rather than the pad's, and
 * the two are bounded separately because each is bounded by a different §6 rule — their SUM is
 * still the one tune §6 admits, since a layer's tune and the pad's cancel in it.
 */
const MAX_LAYER_TUNE_CENTS = 2 * TUNE_SEMITONES_RANGE[1] * 100;

/**
 * The loudest a voice's amp envelope may peak (spec §6, issue #76): the §6 layer gain trim at
 * full scale with the mod matrix at its own. Velocity only ever scales this down.
 */
const MAX_VOICE_GAIN = 10 ** (GAIN_DB_RANGE[1] / 20) * (1 + MOD_AMOUNT_RANGE[1]);

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
  /** The §7.8 `pitch` leaf's value — it rides the pad's own lane node (spec §7.8, issue #138). */
  readonly tuneSemitones: number;
  /** How far this layer's §6 tune sits from the pad's, in cents; 0 where there are no layers. */
  readonly layerTuneCents?: number;
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
  /** Voices still borrowing it. A retired oscillator is released when this reaches zero. */
  refs: number;
  /** True once a config change has replaced it: no new voice takes it, old ones keep it. */
  retired: boolean;
}

/**
 * The three §7.8 per-voice leaves of one pad, each on a `ConstantSourceNode` every voice of
 * the pad is connected to (spec §6, §7.8, issue #138).
 *
 * **A lane node holds the pad's CURRENT value for its leaf — it replaces the patch's static
 * value rather than offsetting it.** The voice keeps only what the leaf does not own: its
 * layer fine tune and static pitch mod on `source.detune`, its own static cutoff mod beside
 * the §6 filter envelope and cutoff LFO on `filter.detune`. So a `filter.cutoff` lane at
 * 5 kHz means 5 kHz, exactly as it does when the §6 knob is turned there, and the envelope,
 * the LFO and the per-voice mod all keep modulating around it.
 *
 * Sharing one node per pad is what makes a §7.8 lane render at all. Writing each sounding
 * voice — what {@link VoicePool.applyPadParam} used to do — reaches only the voices that
 * exist at the moment of the write: live, a pad struck between two automation windows is
 * built from the patch and jumps a `SCHEDULER_INTERVAL_MS` later, and in
 * an `OfflineAudioContext`, where every voice of the render exists before any ramp is
 * applied, "the voices sounding now" is the whole span at once. A node the voice is built
 * against has neither problem: it carries the contour once, and each voice hears it for
 * exactly as long as it sounds.
 *
 * A node is created when the pad first sounds, or on the first write if that comes first, and
 * is seeded from the §6 payload then. Afterwards both a §7.8 lane and a §6 edit move it through
 * {@link VoicePool.applyPadParam} — `syncLayer/programParams` publishes an edit as the same
 * address — so the later of the two wins, which is the §7.8 rule every mixer lane already
 * follows. **A trigger re-seeds it when the §6 value it carries has MOVED since the last
 * trigger**, which is the only way an edit that does NOT publish can reach the node: a
 * keygroup's `filter` (`changedPadLeaves` skips non-drum programs) and a project or pack
 * loaded over the top of the one open. A §7.8 ramp does not write the store, so it never looks
 * like such a move and is never undone by the next note.
 */
interface PadLane {
  /** Cutoff in Hz, summed into each voice's `filter.frequency` (spec §7.8 `filter.cutoff`). */
  cutoff: ConstantSourceNode | null;
  /** Resonance, summed into each voice's `filter.Q` (spec §7.8 `filter.resonance`). */
  resonance: ConstantSourceNode | null;
  /** Pad tune in cents, summed into each voice's `source.detune` (spec §7.8 `pitch`). */
  pitch: ConstantSourceNode | null;
  /** The pitch node's current value, which the declick model needs beside each voice's bend. */
  pitchCents: number;
  /** The §6 payload values the pool saw at the last trigger — see the re-seed rule above. */
  seen: { cutoff: number | null; resonance: number | null; pitch: number | null };
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
  readonly sharedLinks: { readonly lfo: SharedLfo; readonly to: GainNode }[];
  /**
   * Live bend offset in cents, summed into `source.detune` (spec §10.2, §6). Built on the
   * first retune rather than at note-on, so a voice that is never bent costs no extra node.
   */
  bendSource: ConstantSourceNode | null;
  /** The bend node's current value in cents — one half of what the declick model integrates. */
  bendCents: number;
  /**
   * Connections from this pad's shared {@link PadLane} nodes into this voice's params
   * (spec §6, §7.8). They are cut by hand on teardown for the same reason the shared LFO
   * links are: disconnecting the voice's own nodes releases their outputs, not the pad node
   * still feeding their params, and that node outlives the voice (spec §3.2).
   */
  readonly laneLinks: { readonly from: ConstantSourceNode; readonly to: AudioParam }[];
  readonly padKey: string;
  readonly programId: string;
  readonly chokeGroup: number;
  readonly oneShot: boolean;
  /**
   * The §6 amp envelope and the peak it was built at — the two the §5.4 declick's departure
   * level is evaluated from, on the first lay and on every re-lay (issue #144). `release` is
   * read from here too, rather than banked separately: they are one value.
   */
  readonly amp: AhdsrEnvelope;
  readonly ampPeak: number;
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
  /**
   * The EARLIEST fade start this voice has ever had — where its §6 amp contour stopped
   * running (spec §5.4, issue #144). Each lay truncates the AHDSR at its own fade start and
   * nothing restarts it, so the level the timeline holds from there on is the contour's value
   * HERE, not at the fade start currently in force. Only a re-lay that moves the fade EARLIER
   * moves it.
   */
  contourFrozenAt: number;
  startTime: number;
  released: boolean;
  stopScheduled: boolean;
}

export class VoicePool {
  private readonly voices = new Map<string, Voice>();
  /** Free-running §6 LFOs, keyed `${padKey}:${lfoIndex}` — see {@link SharedLfo}. */
  private readonly sharedLfos = new Map<string, SharedLfo>();
  /** Replaced free-running LFOs still feeding a sounding voice (see {@link sharedLfo}). */
  private readonly retiredLfos = new Set<SharedLfo>();
  /** The §7.8 per-voice lane nodes of each pad, keyed by pad key — see {@link PadLane}. */
  private readonly padLanes = new Map<string, PadLane>();

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
      const end = scheduleAmpRelease(voice.ampGain.gain, when, voice.amp.release);
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
   * Apply a program-scope parameter change to a pad (spec §6, §7.8) — the per-voice half of
   * §7.8 automation and of a live §6 sound-design edit. Values ramp over `PARAM_RAMP_MS`
   * like any live parameter move, so an automated filter sweep does not zipper (spec §4.3).
   *
   * **The write lands on the pad's shared {@link PadLane} node, not on each sounding voice.**
   * That is the whole of issue #138: a per-voice write reaches only the voices that exist at
   * the moment of it, so a §7.8 lane never reached a note struck after the ramp and rendered
   * as nothing at all in a §9.5 bounce, where every voice is built before any ramp is
   * applied. A node the voices are built against carries the contour once and each voice
   * hears it for as long as it sounds. The lane value REPLACES the patch's static value; the
   * §6 contour — pitch envelope, glide, filter envelope, LFOs — keeps modulating around it.
   *
   * The node is created here when the pad has never sounded, so a ramp that arrives before
   * the first hit is not lost; a pad whose §6 filter is off still has no filter node in any
   * voice, so a cutoff or resonance write reaches nothing, exactly as before.
   *
   * Only `detune` walks the voices, and only to move their declick: detune IS the playback
   * rate, so a pitch lane changes when each voice's region runs out (spec §5.4, issue #87).
   */
  applyPadParam(padKey: string, target: ProgramParamTarget, value: number, when: number): void {
    const lane = this.padLane(padKey);
    switch (target) {
      case 'filterFrequency':
        rampParamTarget(
          this.laneNode(lane, 'cutoff', value, FILTER_CUTOFF_RANGE, when).offset,
          clamp(value, FILTER_CUTOFF_RANGE[0], FILTER_CUTOFF_RANGE[1]),
          when,
        );
        break;
      case 'filterQ':
        rampParamTarget(
          this.laneNode(lane, 'resonance', value, FILTER_RESONANCE_RANGE, when).offset,
          clamp(value, FILTER_RESONANCE_RANGE[0], FILTER_RESONANCE_RANGE[1]),
          when,
        );
        break;
      case 'detune': {
        const cents = clamp(value, -MAX_PAD_TUNE_CENTS, MAX_PAD_TUNE_CENTS);
        const node = this.laneNode(lane, 'pitch', cents, [-MAX_PAD_TUNE_CENTS, MAX_PAD_TUNE_CENTS], when);
        if (cents === lane.pitchCents) break; // a flat span of a lane moves nothing
        lane.pitchCents = cents;
        rampParamTarget(node.offset, cents, when);
        for (const voice of this.voices.values()) {
          // A voice that has not STARTED is skipped, and a later window re-lays it from its own
          // start: a lane writes every `SCHEDULER_INTERVAL_MS` for the whole span of a §9.5
          // render, so re-laying every future voice on every window would integrate the same
          // contour once per (voice × window). A §10.2 bend is one event rather than a stream
          // and keeps the clamp, because nothing comes back for it.
          if (voice.padKey !== padKey || voice.stopScheduled || when < voice.startTime) continue;
          this.rescheduleDeclick(voice, when);
        }
        break;
      }
      default:
        // Channel-scope targets are the pad channel's business, not the voice's.
        break;
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
    for (const shared of [...this.sharedLfos.values(), ...this.retiredLfos]) {
      this.stopSharedLfo(shared);
    }
    this.sharedLfos.clear();
    this.retiredLfos.clear();
    // The §7.8 pad lanes outlive their voices by design (see {@link PadLane}), exactly as the
    // free-running LFOs above do, so the pool is the only thing that can release them.
    for (const lane of this.padLanes.values()) {
      for (const node of [lane.cutoff, lane.resonance, lane.pitch]) this.stopLaneNode(node);
    }
    this.padLanes.clear();
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

  /** The §7.8 lane record for a pad, created empty on first use (see {@link PadLane}). */
  private padLane(padKey: string): PadLane {
    const existing = this.padLanes.get(padKey);
    if (existing) return existing;
    const lane: PadLane = {
      cutoff: null,
      resonance: null,
      pitch: null,
      pitchCents: 0,
      seen: { cutoff: null, resonance: null, pitch: null },
    };
    this.padLanes.set(padKey, lane);
    return lane;
  }

  /**
   * One of a pad's lane nodes, built on first use and SEEDED then only (see {@link PadLane}).
   *
   * `seed` is whatever the caller knows the leaf's current value to be — the §6 payload when
   * a voice is being built, the written value when a §7.8 ramp arrives first. It is never
   * re-applied: the node holds the value from then on, and both writers reach it through
   * {@link applyPadParam}.
   *
   * It starts at the context's own clock rather than at the caller's `when`, because a pad
   * lane belongs to the pad and not to a note: a §9.5 render builds its voices out of time
   * order, so starting one at the first voice's `when` would leave an earlier voice hearing
   * nothing from it.
   */
  private laneNode(
    lane: PadLane,
    kind: 'cutoff' | 'resonance' | 'pitch',
    seed: number,
    [min, max]: readonly [number, number],
    when: number,
  ): ConstantSourceNode {
    const existing = lane[kind];
    if (existing) return existing;
    const node = this.context.createConstantSource();
    node.offset.value = Number.isFinite(seed) ? clamp(seed, min, max) : 0;
    node.start(Math.min(when, this.context.currentTime));
    lane[kind] = node;
    if (kind === 'pitch') lane.pitchCents = node.offset.value;
    return node;
  }

  /**
   * The pad's lane node for `kind` as a VOICE needs it: built and seeded on first use, and
   * re-seeded where the §6 payload value has moved since the last trigger (see {@link PadLane}).
   * The value is applied at the note rather than immediately, because the note is what carries
   * the edit.
   */
  private seedLaneNode(
    lane: PadLane,
    kind: 'cutoff' | 'resonance' | 'pitch',
    payload: number,
    range: readonly [number, number],
    when: number,
  ): ConstantSourceNode {
    const node = this.laneNode(lane, kind, payload, range, when);
    const previous = lane.seen[kind];
    lane.seen[kind] = payload;
    if (previous === null || previous === payload) return node;
    const value = Number.isFinite(payload) ? clamp(payload, range[0], range[1]) : 0;
    setParamNow(node.offset, value, when);
    if (kind === 'pitch') lane.pitchCents = value;
    return node;
  }

  /**
   * Release every §7.8 lane node of a program whose §6 record has left the store (spec §3.2).
   *
   * A pad lane outlives its voices by design, so nothing else would ever free it — and a
   * project loaded over the top of the one open, or a program the user deleted, leaves lanes
   * that nothing can reach and whose last automated value would greet the next program to
   * reuse the id. The §5.4 pad key carries the program id ahead of its first colon, which is
   * colon-free (§14 (am)).
   */
  releaseProgramLanes(programId: string): void {
    for (const [padKey, lane] of [...this.padLanes]) {
      if (padKey.slice(0, padKey.indexOf(':')) !== programId) continue;
      for (const node of [lane.cutoff, lane.resonance, lane.pitch]) this.stopLaneNode(node);
      this.padLanes.delete(padKey);
    }
  }

  private stopLaneNode(node: ConstantSourceNode | null): void {
    if (!node) return;
    try {
      node.stop();
    } catch {
      // Never started / already stopped.
    }
    cancelParams(node.offset);
    node.disconnect();
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
   *
   * The bend node is the voice's own; the pad's §7.8 `pitch` lane rides a second node the
   * whole pad shares ({@link PadLane}), so the two SUM rather than clobbering each other
   * (issue #138). A bend applied over an automated pitch lane bends the automated pitch,
   * which is the same reading §10.2 already gives a bend over a pitch envelope or a glide.
   */
  private retune(voice: Voice, offsetCents: number, when: number): void {
    rampParamTarget(this.bendNode(voice, when).offset, offsetCents, when);
    voice.bendCents = offsetCents;
    this.rescheduleDeclick(voice, when);
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
  private rescheduleDeclick(voice: Voice, when: number): void {
    // A §5.7.9 warp voice decouples pitch from duration, so a retune moves no end to chase.
    // Its declick was laid at the source's own length and stays where it is.
    if (!voice.source.pitchCoupled) return;
    const at = Math.max(when, voice.startTime);
    // Nothing left to re-lay once the fade has begun, and the banking below is the expensive
    // half — a §7.8 lane writes every `SCHEDULER_INTERVAL_MS` for the whole span of a render,
    // so a voice long past its end must cost nothing rather than integrate up to it.
    if (at >= voice.declickFadeStart) return;
    voice.consumedSeconds += consumedBetween(voice.detune, voice.consumedUntil, at);
    voice.consumedUntil = at;
    // The model carries ONE additive track for the two nodes summed into `source.detune`:
    // this voice's §10.2 bend and its pad's §7.8 lane (spec §6, issue #138).
    applyRetune(voice.detune, at, voice.bendCents + this.padLane(voice.padKey).pitchCents);
    const remaining = voice.regionSeconds - voice.consumedSeconds;
    if (remaining <= 0) return;
    // Erase the stale fade first: holding at its own start leaves the amp on the level the
    // AHDSR had reached there, which is where the timeline stands from that moment onwards.
    voice.ampGain.gain.cancelAndHoldAtTime(voice.declickFadeStart);
    const endTime = regionEndTime(voice.detune, at, remaining);
    const fadeStart = declickFadeStart(endTime, at, DECLICK_FADE_MS);
    // The same rule as the first lay — the level the contour holds where the fade begins — but
    // read where the contour STOPPED, which is the earliest fade start this voice has had and
    // not merely the previous one. A §7.8 pitch lane re-lays every `SCHEDULER_INTERVAL_MS`, so
    // reading the last fade start would walk the level down the frozen contour a step per
    // window (issue #144).
    voice.contourFrozenAt = Math.min(voice.contourFrozenAt, fadeStart);
    const level = ampLevelAt(voice.ampPeak, voice.amp, voice.startTime, voice.contourFrozenAt);
    scheduleAmpDeclick(voice.ampGain.gain, endTime, at, DECLICK_FADE_MS, level);
    voice.declickFadeStart = fadeStart;
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
    const sharedLinks: { lfo: SharedLfo; to: GainNode }[] = [];
    // The pad's §7.8 lane nodes, and this voice's connections into them (see {@link PadLane}).
    const lane = this.padLane(spec.padKey);
    const laneLinks: { from: ConstantSourceNode; to: AudioParam }[] = [];
    const link = (node: ConstantSourceNode, param: AudioParam): void => {
      node.connect(param);
      laneLinks.push({ from: node, to: param });
    };
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
    // Clamped at the point it reaches the parameter (spec §6, issue #76): `staticModulation`
    // already bounds the matrix's own contribution, so this catches a `spec` that reached the
    // pool without passing the §6 schema — detune is the playback rate, and a wild one
    // consumes the buffer before a single frame is audible.
    //
    // A non-finite tune becomes NO detune, not the range floor. `clamp` sends NaN to `min`,
    // which here would be four octaves flat — the opposite of `clampModSum`'s policy that a
    // value nobody can interpret contributes nothing (issue #76).
    //
    // `spec.tuneSemitones` is NOT part of this: it is the §7.8 `pitch` leaf's own value, which
    // rides the pad's shared lane node so a §7.8 ramp or a §6 edit moves every voice of the
    // pad — the one already sounding and the one struck a moment later (issue #138). What is
    // left here is the layer fine tune (or a keygroup's key distance) and the static pitch mod.
    const baseDetune =
      boundedCents(spec.layerTuneCents ?? 0, MAX_LAYER_TUNE_CENTS) +
      boundedCents(spec.tuneCents + stat.detuneCents, MAX_VOICE_DETUNE_CENTS);

    const ampGain = this.context.createGain();
    const filterType = spec.filter ? biquadFilterType(spec.filter.type) : null;
    const filter = filterType ? this.context.createBiquadFilter() : null;

    // Chain: source → ampGain → [filter] → destination (spec §5.2 stages 1–2, 5).
    source.node.connect(ampGain);
    if (filter) {
      filter.type = filterType!;
      // The pad's cutoff and resonance come from its §7.8 lane nodes rather than from this
      // voice, so the two values the `filter.cutoff` and `filter.resonance` leaves address are
      // shared by every voice of the pad and a lane reaches the next hit as well as this one
      // (issue #138). The voice's own params hold the neutral 0 the nodes sum onto.
      filter.frequency.value = 0;
      link(
        this.seedLaneNode(lane, 'cutoff', spec.filter!.cutoff, FILTER_CUTOFF_RANGE, now),
        filter.frequency,
      );
      filter.Q.value = 0;
      link(
        this.seedLaneNode(lane, 'resonance', spec.filter!.resonance, FILTER_RESONANCE_RANGE, now),
        filter.Q,
      );
      ampGain.connect(filter);
      filter.connect(spec.destination);
      // The static §6 cutoff modulation is this VOICE's (velocity, note number, its own
      // random), so it stays with the voice — in cents on `filter.detune`, beside the §6
      // filter envelope and the cutoff LFO, where it multiplies the shared cutoff exactly as
      // a §6 mod route in octaves means it to.
      this.scheduleFilterEnvelope(filter, spec, stat.cutoffCents, now);
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

    // Amp AHDSR (velocity × gain trim × static amp mod) — spec §5.4/§6, clamped at the
    // parameter for the same reason as the detune above (issue #76). A non-finite gain has no
    // neutral to fall back to, so it lands on silence — recoverable by fixing the value, where
    // a NaN written to the gain param would poison the chain for the session (§8.5.6).
    const peak = clamp(velocityToGain(spec.velocity, spec.gainDb) * stat.ampFactor, 0, MAX_VOICE_GAIN);
    scheduleAmpAttack(ampGain.gain, peak, spec.amp, now);

    // LFOs → pitch (detune) and filter cutoff (filter.detune) targets (spec §6). Wired
    // before the declick because pitch-routed LFOs are part of the rate curve it solves.
    const oscillations = this.wireLfos(spec, source, filter, now, oscillators, modGains, sharedLinks);
    // The pad's §7.8 `pitch` lane, summed into this voice's detune the way the §10.2 bend is
    // (issue #138). The declick model carries the two on one additive track, because the graph
    // sums the two nodes onto one param.
    link(
      this.seedLaneNode(
        lane,
        'pitch',
        spec.tuneSemitones * 100,
        [-MAX_PAD_TUNE_CENTS, MAX_PAD_TUNE_CENTS],
        now,
      ),
      source.detune,
    );
    const detune: DetuneSchedule = {
      breakpoints,
      bend: [{ time: now, cents: lane.pitchCents }],
      oscillations,
    };

    // Declick the natural end of the region (spec §5.4). On a coupled source the detune
    // contour IS the playback rate, so the end is integrated from it and a pitch envelope,
    // glide or pitch LFO lands the fade where the buffer truly runs out (issue #87); a later
    // retune moves it (`rescheduleDeclick`). A §5.7.9 warp source decouples the two, so its
    // end is simply its own length and nothing can move it.
    const endTime = source.pitchCoupled
      ? regionEndTime(detune, now, source.sourceSeconds)
      : now + source.sourceSeconds;
    // The fade departs from the level the AHDSR holds where it begins. The param cannot be
    // asked for it — the declick is the last thing on that timeline, so `cancelAndHoldAtTime`
    // has nothing to rewrite and pins nothing (issue #144).
    const fadeStart = declickFadeStart(endTime, now, DECLICK_FADE_MS);
    scheduleAmpDeclick(
      ampGain.gain,
      endTime,
      now,
      DECLICK_FADE_MS,
      ampLevelAt(peak, spec.amp, now, fadeStart),
    );

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
      bendCents: 0,
      laneLinks,
      padKey: spec.padKey,
      programId: spec.programId,
      chokeGroup: spec.chokeGroup,
      oneShot: spec.playbackMode === 'oneShot',
      amp: spec.amp,
      ampPeak: peak,
      baseDetune,
      regionSeconds: source.sourceSeconds,
      detune,
      consumedSeconds: 0,
      consumedUntil: now,
      declickFadeStart: fadeStart,
      contourFrozenAt: fadeStart,
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

  /**
   * Filter envelope on the biquad `detune` (cents), scaled by envDepth, over the voice's own
   * static §6 cutoff modulation (spec §6). `filter.frequency` carries only the pad's shared
   * cutoff (issue #138), so everything that modulates it per voice is summed here in cents.
   */
  private scheduleFilterEnvelope(
    filter: BiquadFilterNode,
    spec: VoiceTriggerSpec,
    staticCents: number,
    now: number,
  ): void {
    const envDepth = spec.filter?.envDepth ?? 0;
    if (!spec.filterEnv || envDepth === 0) {
      filter.detune.value = staticCents;
      return;
    }
    scheduleModEnvelope(
      filter.detune,
      staticCents,
      envDepth * FILTER_ENV_OCTAVES * 1200,
      spec.filterEnv,
      now,
    );
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
    sharedLinks: { lfo: SharedLfo; to: GainNode }[],
  ): DetuneOscillation[] {
    const pitchOscillations: DetuneOscillation[] = [];
    const lfos = spec.lfos;
    const routes = spec.modMatrix;
    if (!lfos || !routes) return pitchOscillations;
    const bpm = spec.bpm ?? DEFAULT_BPM;
    // The LFO depths sum in the audio graph, where nothing can clamp them, so they are scaled
    // in proportion before they are wired (spec §6, issue #76). One route is untouched; 32
    // full-depth routes onto pitch share the one octave a single route would have reached.
    const pitchDepthScale = oscillatorDepthScale(routes, 'pitch');
    const cutoffDepthScale = oscillatorDepthScale(routes, 'filterCutoff');
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
          gain.gain.value = sign * route.amount * pitchDepthScale * PITCH_MOD_CENTS;
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
          gain.gain.value = sign * route.amount * cutoffDepthScale * FILTER_MOD_OCTAVES * 1200;
          osc.connect(gain);
          gain.connect(filter.detune);
        }
        if (shared) {
          shared.refs += 1;
          sharedLinks.push({ lfo: shared, to: gain });
        }
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
      // Retired, not destroyed: voices are still sounding through it, and disconnecting it
      // would cut the modulation out from under them mid-note — their filter or pitch would
      // snap to the unmodulated value, and a pitch route's scheduled declick would be left
      // in the wrong place. It goes when the last voice borrowing it ends.
      existing.retired = true;
      this.retiredLfos.add(existing);
      this.releaseSharedLfo(existing);
    }
    const osc = this.buildOscillator(type, rateHz, config.phaseOffset);
    osc.start(now);
    const shared: SharedLfo = { osc, since: now, signature, refs: 0, retired: false };
    this.sharedLfos.set(key, shared);
    return shared;
  }

  /** Release a retired free-running LFO once nothing is borrowing it (spec §3.2). */
  private releaseSharedLfo(shared: SharedLfo): void {
    if (!shared.retired || shared.refs > 0) return;
    this.retiredLfos.delete(shared);
    this.stopSharedLfo(shared);
  }

  private stopSharedLfo(shared: SharedLfo): void {
    try {
      shared.osc.stop();
    } catch {
      // Never started / already stopped.
    }
    cancelParams(shared.osc.frequency, shared.osc.detune);
    shared.osc.disconnect();
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
        link.lfo.osc.disconnect(link.to);
      } catch {
        // Already disconnected.
      }
      link.lfo.refs -= 1;
      this.releaseSharedLfo(link.lfo);
    }
    voice.sharedLinks.length = 0;
    // A pad lane node outlives the voice too (see {@link PadLane}), so its connection into
    // this voice's params is cut here — disconnecting the filter or the source releases their
    // own outputs, not the node still feeding their params (spec §3.2).
    for (const laneLink of voice.laneLinks) {
      try {
        laneLink.from.disconnect(laneLink.to);
      } catch {
        // Already disconnected.
      }
    }
    voice.laneLinks.length = 0;
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

/**
 * One detune contribution in cents, bounded by the §6 rule that admits it. A non-finite one
 * contributes NOTHING rather than the range floor, which `clamp` would make four octaves flat
 * — a value nobody can interpret contributes nothing (spec §6, issue #76).
 */
function boundedCents(cents: number, limit: number): number {
  return Number.isFinite(cents) ? clamp(cents, -limit, limit) : 0;
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
