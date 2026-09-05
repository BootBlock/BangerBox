/**
 * Offline effect renders — spec §11.2. Node lacks Web Audio, so the DSP correctness of
 * the native inserts is proven by rendering a known input through each effect in an
 * `OfflineAudioContext` inside the browser (driven by the Playwright smoke, §11.4) and
 * asserting numeric properties (non-silent output, bounded peak, filter attenuation).
 * This module is browser-only; it is reached only through the audio probe seam.
 */
import { DEFAULT_BPM, type EffectType, type Program } from '@/core/project/schemas';
import { prepareVoiceWorklets, prepareWorkletEffects } from './context';
import { createInsert } from './inserts/insert';
import { EFFECT_PARAM_CHOICES } from './inserts/effectParams';
import { rampParamLinear, rampParamTarget, setParamNow } from './params/ramps';
import { lfoWaveCoefficients } from './voiceModulation';
import { ReversedBufferCache } from './voiceBuffer';

/** Effects whose engine is a WASM worklet and so need the processor + kernels loaded first. */
const WORKLET_EFFECTS: ReadonlySet<EffectType> = new Set<EffectType>(['reverb', 'multibandComp', 'limiter']);
import {
  createDefaultDrumProgram,
  createDefaultLfo,
  createDefaultPad,
  createDefaultVelocityLayer,
  type LfoConfig,
} from '@/core/project/schemas';
import { resolvedVoiceToTrigger, resolveVoice } from './programVoice';
import { VoicePool } from './voicePool';
import { PreviewChannel } from './preview';
import { DECLICK_FADE_MS } from '@/core/constants';
import { MixerGraph } from './graph';
import { createAudioBridge } from './audioBridge';
import { programParamPath } from './params/registry';

export interface EffectRenderResult {
  inputRms: number;
  outputRms: number;
  outputPeak: number;
}

interface RenderOptions {
  toneHz?: number;
  amplitude?: number;
  params?: Record<string, number>;
  seconds?: number;
}

function rms(data: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i]! * data[i]!;
  return Math.sqrt(sum / data.length);
}

function peak(data: Float32Array): number {
  let max = 0;
  for (let i = 0; i < data.length; i++) {
    const abs = Math.abs(data[i]!);
    if (abs > max) max = abs;
  }
  return max;
}

/**
 * Render a sine through one insert effect offline and measure it (spec §11.2). Returns
 * the input reference RMS alongside the output RMS/peak so callers can assert ratios
 * (attenuation, saturation bounds) independently of absolute level.
 */
export async function renderEffectOffline(
  effectType: EffectType,
  { toneHz = 440, amplitude = 0.6, params = {}, seconds = 0.3 }: RenderOptions = {},
): Promise<EffectRenderResult> {
  const sampleRate = 48_000;
  const length = Math.floor(sampleRate * seconds);
  const context = new OfflineAudioContext(1, length, sampleRate);

  // Worklet-hosted effects (reverb/multibandComp/limiter) need the processor + kernel modules
  // registered on this offline context before the insert can be built synchronously (§5.6.2).
  if (WORKLET_EFFECTS.has(effectType)) await prepareWorkletEffects(context);

  const osc = context.createOscillator();
  osc.frequency.value = toneHz;
  const inputGain = context.createGain();
  inputGain.gain.value = amplitude;
  osc.connect(inputGain);

  const insert = createInsert(context, effectType, params);
  insert.setEnabled(true);
  inputGain.connect(insert.input);
  insert.output.connect(context.destination);

  osc.start();
  osc.stop(seconds);
  const rendered = await context.startRendering();
  insert.destroy();

  const data = rendered.getChannelData(0);
  return {
    inputRms: amplitude * Math.SQRT1_2, // RMS of a full sine at this amplitude
    outputRms: rms(data),
    outputPeak: peak(data),
  };
}

// --- Tempo-synced delay (spec §11.2, §5.7) --------------------------------------------

export interface DelayEchoResult {
  /** Seconds between the impulse and its echo — the delay time the graph actually used. */
  readonly echoSeconds: number;
  /** Peak of the echo, so a silent render is distinguishable from a mistimed one. */
  readonly echoPeak: number;
}

export interface DelayEchoOptions {
  /**
   * The §5.7 synced division to follow, by name (`'1/4'`, `'1/8.'`, …). Omitted or unknown
   * leaves the delay on its free `time` — the same fallback `delaySyncDivision` applies.
   */
  readonly division?: string;
  /** Free delay time in milliseconds, used when `sync` is 0. */
  readonly time?: number;
  /** Transport tempo the insert is built at (spec §7.2). */
  readonly bpm?: number;
  /** Tempo pushed in through `setTempo` before the impulse, if the retune is under test. */
  readonly retuneToBpm?: number;
  /** Seconds to wait before the impulse, so any dezipper ramp has settled. */
  readonly impulseAt?: number;
  readonly seconds?: number;
  /**
   * Build the delay from this params record VERBATIM, ignoring `division` and `time`.
   *
   * It is the proof seam for issue #131: the record is the one `applyInserts` hands
   * `createInsert` for a slot in the store (spec §4.3), so the echo it produces is the time
   * the GRAPH runs while the §8.5.6 panel reads the store's own value for the same slot. The
   * TEMPO is still this function's own, not the live transport's, so a caller measuring a
   * §5.7 synced division has to pass `bpm` as well.
   */
  readonly params?: Record<string, number>;
}

/**
 * Send one impulse through a `delay` insert offline and measure where its echo lands
 * (spec §11.2). This is the numeric proof of §5.7's synced division: the echo must arrive
 * one note division after the impulse at the transport tempo, not at the free `time`.
 *
 * Feedback is forced to zero so exactly one echo exists, and mix to 1 so the equal-power
 * dry leg contributes nothing to confuse the peak search.
 */
export async function renderDelayEchoOffline({
  division,
  time = 350,
  bpm = DEFAULT_BPM,
  retuneToBpm,
  impulseAt = 0.05,
  seconds = 3,
  params,
}: DelayEchoOptions = {}): Promise<DelayEchoResult> {
  const sampleRate = 48_000;
  const context = new OfflineAudioContext(1, Math.floor(sampleRate * seconds), sampleRate);

  const impulse = context.createBuffer(1, Math.max(1, Math.round(sampleRate * 0.001)), sampleRate);
  impulse.getChannelData(0).fill(1);
  const source = context.createBufferSource();
  source.buffer = impulse;

  // The index is looked up rather than passed in, so a probe names a musical division and
  // cannot drift out of step with the order of the list (spec §5.7).
  const modes = EFFECT_PARAM_CHOICES.delay?.sync ?? [];
  const sync = division === undefined ? 0 : Math.max(0, modes.indexOf(division));
  const insert = createInsert(context, 'delay', params ?? { sync, time, feedback: 0, mix: 1 }, bpm);
  insert.setEnabled(true);
  source.connect(insert.input);
  insert.output.connect(context.destination);
  // Retune before the impulse so the `PARAM_RAMP_MS` dezipper has settled by the time the
  // delay line is read — the render measures the new time, not the ramp through it.
  if (retuneToBpm !== undefined) insert.setTempo(retuneToBpm, 0);
  source.start(impulseAt);

  const rendered = await context.startRendering();
  insert.destroy();

  const data = rendered.getChannelData(0);
  // The echo is the loudest sample after the impulse itself has passed.
  const searchFrom = Math.floor((impulseAt + 0.01) * sampleRate);
  let bestIndex = -1;
  let bestValue = 0;
  for (let i = searchFrom; i < data.length; i++) {
    const abs = Math.abs(data[i]!);
    if (abs > bestValue) {
      bestValue = abs;
      bestIndex = i;
    }
  }
  return {
    echoSeconds: bestIndex < 0 ? 0 : bestIndex / sampleRate - impulseAt,
    echoPeak: bestValue,
  };
}

// --- Program voice pitch renders (spec §11.2, §12 velocity-layer + keygroup exit) -----

/** Fill a mono buffer with `seconds` of a `frequency` Hz sine — a known-pitch test sample. */
function sineBuffer(context: BaseAudioContext, frequency: number, seconds: number): AudioBuffer {
  const buffer = context.createBuffer(1, Math.floor(context.sampleRate * seconds), context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    data[i] = Math.sin((2 * Math.PI * frequency * i) / context.sampleRate);
  }
  return buffer;
}

/**
 * Estimate the dominant frequency of a rendered mono signal by autocorrelation (spec §11.2).
 * Robust for a single sustained tone; returns 0 when the signal is effectively silent.
 */
function detectPitch(data: Float32Array, sampleRate: number): number {
  if (rms(data) < 1e-3) return 0;
  const minLag = Math.floor(sampleRate / 2000); // up to 2 kHz
  const maxLag = Math.floor(sampleRate / 100); // down to 100 Hz
  let bestLag = -1;
  let bestCorr = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0;
    for (let i = 0; i < data.length - lag; i++) corr += data[i]! * data[i + lag]!;
    if (corr > bestCorr) {
      bestCorr = corr;
      bestLag = lag;
    }
  }
  return bestLag > 0 ? sampleRate / bestLag : 0;
}

/** What one resolved program note sounds like, rendered offline (spec §11.2). */
export interface NoteRenderResult {
  /** Dominant frequency in Hz, 0 when effectively silent. */
  readonly frequency: number;
  readonly rms: number;
  /** Largest absolute sample — how an un-clamped amp modulation shows itself (issue #76). */
  readonly peak: number;
  /** Seconds from the note-on to the last audible frame — the voice's real length. */
  readonly soundingSeconds: number;
  /** Level of the first and second halves, which is how a reversed layer shows itself. */
  readonly firstHalfRms: number;
  readonly secondHalfRms: number;
  /**
   * Magnitude of the last audible frame (spec §5.4, issue #87). A voice that fades to true
   * zero at its region's end leaves a small number here; one whose buffer simply ran out
   * leaves whatever the waveform was doing, which is the step that clicks.
   */
  readonly finalMagnitude: number;
}

/** The synthesised test sample a render feeds the voice (spec §11.2 — no stored goldens). */
export type NoteRenderSignal = 'sine' | 'lateBurst';

export interface NoteRenderOptions {
  readonly baseFrequency?: number;
  readonly seconds?: number;
  /**
   * `sine` measures pitch; `lateBurst` is silent for its first half and a tone for its
   * second, so playing it backwards moves the energy from one half to the other — which is
   * what makes §6 `reverse` observable rather than merely plausible.
   */
  readonly signal?: NoteRenderSignal;
  /**
   * Length of the synthesised sample. It defaults to half the render, so the voice ends
   * inside the window and its duration is measurable — which is how §5.7.9 warp shows
   * itself. A probe that measures the two halves of the sample instead passes the whole
   * render length, so the halves it reads are the sample's and not the window's.
   */
  readonly sampleSeconds?: number;
  /** Transport tempo a §6 tempo-synced LFO locks to (spec §7.2). */
  readonly bpm?: number;
}

/** Magnitude of the last frame above the noise floor — how a voice ENDED (spec §5.4). */
function finalMagnitude(data: Float32Array): number {
  for (let i = data.length - 1; i >= 0; i--) {
    if (Math.abs(data[i]!) > 1e-3) return Math.abs(data[i]!);
  }
  return 0;
}

/** Seconds from 0 to the last frame above the noise floor. */
function soundingSeconds(data: Float32Array, sampleRate: number): number {
  for (let i = data.length - 1; i >= 0; i--) {
    if (Math.abs(data[i]!) > 1e-3) return (i + 1) / sampleRate;
  }
  return 0;
}

/**
 * Render one program note through the real resolution + voice pool in an OfflineAudioContext
 * and measure it (spec §11.2). Proves velocity-layer switching (different layers → different
 * pitch), keygroup pitch accuracy (coupled repitch), §6 `reverse` (the energy changes halves)
 * and §5.7.9 `warp` (pitch moves, duration does not) — all audibly (spec §12 exit).
 *
 * The layer/zone `sampleId` maps to a synthesised signal so the result is known in advance.
 */
export async function renderProgramNote(
  program: Program,
  note: number,
  velocity: number,
  {
    baseFrequency = 440,
    seconds = 0.4,
    signal = 'sine',
    sampleSeconds = seconds / 2,
    bpm = DEFAULT_BPM,
  }: NoteRenderOptions = {},
): Promise<NoteRenderResult> {
  const sampleRate = 48_000;
  const context = new OfflineAudioContext(1, Math.floor(sampleRate * seconds), sampleRate);
  const resolved = resolveVoice(program, note, velocity);
  const empty: NoteRenderResult = {
    frequency: 0,
    rms: 0,
    peak: 0,
    soundingSeconds: 0,
    firstHalfRms: 0,
    secondHalfRms: 0,
    finalMagnitude: 0,
  };
  if (!resolved) return empty;
  // A warp pad plays through the §5.7.9 worklet source, which needs its processor and the
  // kernel module on THIS context before the voice is built (spec §5.6.2).
  if (resolved.warp) await prepareVoiceWorklets(context);

  const pool = new VoicePool(context);
  const destination = context.createGain();
  destination.connect(context.destination);
  const source =
    signal === 'sine'
      ? sineBuffer(context, baseFrequency, sampleSeconds)
      : lateBurstBuffer(context, baseFrequency, sampleSeconds);
  // spec §6 `VelocityLayer.reverse`, applied exactly as the live engine applies it.
  const buffer = resolved.reverse ? new ReversedBufferCache(context).get(source) : source;
  pool.trigger(
    resolvedVoiceToTrigger(resolved, {
      id: 'offline-note',
      buffer,
      destination,
      when: 0,
      velocity,
      programId: 'offline',
      bpm,
    }),
  );

  const rendered = await context.startRendering();
  pool.destroy();
  const data = rendered.getChannelData(0);
  const half = Math.floor(data.length / 2);
  return {
    frequency: detectPitch(data, sampleRate),
    rms: rms(data),
    peak: peak(data),
    soundingSeconds: soundingSeconds(data, sampleRate),
    firstHalfRms: rms(data.subarray(0, half)),
    secondHalfRms: rms(data.subarray(half)),
    finalMagnitude: finalMagnitude(data),
  };
}

/** Silence for the first half, then a tone — a sample whose direction is audible. */
function lateBurstBuffer(context: BaseAudioContext, frequency: number, seconds: number): AudioBuffer {
  const buffer = context.createBuffer(1, Math.floor(context.sampleRate * seconds), context.sampleRate);
  const data = buffer.getChannelData(0);
  const from = Math.floor(data.length / 2);
  for (let i = from; i < data.length; i++) {
    data[i] = Math.sin((2 * Math.PI * frequency * i) / context.sampleRate);
  }
  return buffer;
}

// --- §6 LFO renders (spec §11.2, issue #107) ------------------------------------------

/**
 * Render a §6 LFO routed to the pad filter's cutoff and measure the rate it actually runs
 * at, by counting the swings of the output's own amplitude envelope.
 *
 * A synced LFO has no other browser-observable handle: its rate lives on an `OscillatorNode`
 * inside a voice, and the only honest proof that `sync` reached it is that the sound moves
 * at the tempo it was told to.
 */
export async function renderLfoRateOffline(
  sync: LfoConfig['sync'],
  bpm: number,
  seconds = 2,
): Promise<{ measuredHz: number }> {
  const program = createDefaultDrumProgram('LFO probe');
  const pad = createDefaultPad(0);
  pad.layers = [{ ...createDefaultVelocityLayer('offline'), velocityStart: 0, velocityEnd: 127 }];
  // A lowpass parked below the tone, swept ±4 octaves by the LFO: the tone comes and goes
  // once per LFO cycle, so the envelope carries the rate.
  pad.filter = { type: 'lp', cutoff: 400, resonance: 1, envDepth: 0 };
  // 2 Hz free-running: four cycles across the render, and clearly different from the
  // 1 Hz a 1/4 division gives at 60 bpm — so a sync that failed to override it would show.
  pad.lfos = [{ ...createDefaultLfo(), sync, shape: 'sine', rate: 2 }, createDefaultLfo()];
  pad.modMatrix = [{ source: 'lfo1', target: 'filterCutoff', amount: 1 }];
  pad.envelopes = {
    ...pad.envelopes,
    amp: { ...pad.envelopes.amp, decay: 0, sustain: 1, release: 0 },
  };
  program.pads = [pad];

  const sampleRate = 48_000;
  const context = new OfflineAudioContext(1, Math.floor(sampleRate * seconds), sampleRate);
  const resolved = resolveVoice(program, 0, 100);
  if (!resolved) return { measuredHz: 0 };
  const pool = new VoicePool(context);
  const destination = context.createGain();
  destination.connect(context.destination);
  pool.trigger(
    resolvedVoiceToTrigger(resolved, {
      id: 'offline-lfo',
      buffer: sineBuffer(context, 2_000, seconds),
      destination,
      when: 0,
      velocity: 100,
      programId: 'offline',
      bpm,
    }),
  );
  const rendered = await context.startRendering();
  pool.destroy();
  return { measuredHz: envelopeRateHz(rendered.getChannelData(0), seconds) };
}

/** Swings per second of a signal's amplitude envelope — the rate modulating it. */
function envelopeRateHz(data: Float32Array, seconds: number): number {
  const hop = 256;
  const windows = Math.floor(data.length / hop);
  if (windows < 4) return 0;
  const envelope = new Float32Array(windows);
  for (let w = 0; w < windows; w++) envelope[w] = rms(data.subarray(w * hop, (w + 1) * hop));
  let mean = 0;
  for (const value of envelope) mean += value;
  mean /= windows;
  // Skip the first and last window: the note-on and the §5.4 declick are not modulation.
  let crossings = 0;
  for (let w = 2; w < windows - 1; w++) {
    if (envelope[w - 1]! <= mean && envelope[w]! > mean) crossings++;
  }
  return crossings / seconds;
}

/**
 * Render a §6 phase-shifted LFO waveform on its own and report where it starts (spec §11.2).
 *
 * `createPeriodicWave`'s basis is the one thing about this work that cannot be settled by
 * reading types (spec §2.7): a sine rotated a quarter turn must START at its peak, and only
 * a real browser can say whether it does. A wrong basis would show up here as 0 or −1.
 */
export async function renderLfoPhaseOffline(phaseOffset: number): Promise<{ firstSample: number }> {
  const sampleRate = 48_000;
  const context = new OfflineAudioContext(1, 4_800, sampleRate);
  const osc = context.createOscillator();
  const { real, imag } = lfoWaveCoefficients('sine', phaseOffset);
  osc.setPeriodicWave(context.createPeriodicWave(real, imag));
  osc.frequency.value = 10;
  osc.connect(context.destination);
  osc.start(0);
  const rendered = await context.startRendering();
  return { firstSample: rendered.getChannelData(0)[0] ?? 0 };
}

// --- §4.3 / §5.6 guard renders (spec §11.2, issue #97) --------------------------------

/** What a guarded parameter write did to a real audio path (spec §11.2). */
export interface GuardRenderResult {
  /** RMS of the rendered signal — non-zero proves the graph still sounds. */
  readonly rms: number;
  /** True when every rendered frame is a finite number. */
  readonly finite: boolean;
}

function measure(data: Float32Array): GuardRenderResult {
  return { rms: rms(data), finite: data.every((value) => Number.isFinite(value)) };
}

/**
 * Write a non-finite value through each §4.3 ramp helper onto a real `GainNode.gain`, then
 * render a tone through it (spec §11.2, issue #97).
 *
 * This is the failure the guards exist for and the one a unit test cannot show: on the fake
 * context a NaN is just a recorded call, while a real `AudioParam` that takes one outputs NaN
 * for every frame afterwards and silences everything downstream for the rest of the session.
 */
export async function renderRampGuardOffline(): Promise<GuardRenderResult> {
  const sampleRate = 48_000;
  const context = new OfflineAudioContext(1, sampleRate / 2, sampleRate);
  const osc = context.createOscillator();
  osc.frequency.value = 440;
  const gain = context.createGain();
  gain.gain.value = 0.5;
  osc.connect(gain);
  gain.connect(context.destination);
  // Each of these would poison `gain.gain` if it reached the param.
  rampParamLinear(gain.gain, Number.NaN, 0);
  rampParamTarget(gain.gain, Number.POSITIVE_INFINITY, 0);
  setParamNow(gain.gain, Number.NaN, 0);
  osc.start(0);
  const rendered = await context.startRendering();
  osc.stop();
  return measure(rendered.getChannelData(0));
}

/**
 * Drive a §5.6 WASM kernel through the REAL worklet path with non-finite parameters
 * (spec §11.2, §13.5, issue #97). An un-clamped NaN becomes a NaN coefficient inside linear
 * memory, and the kernel then outputs NaN forever — which only a real render can show.
 */
export async function renderKernelGuardOffline(effectType: EffectType): Promise<GuardRenderResult> {
  const rendered = await renderEffectOffline(effectType, {
    toneHz: 220,
    params: { ceiling: Number.NaN, release: Number.NaN, size: Number.NaN, damping: Number.NaN },
  });
  return { rms: rendered.outputRms, finite: Number.isFinite(rendered.outputRms) && rendered.outputRms > 0 };
}

// --- §5.4 amp-gain profile (spec §11.2, issue #144) -----------------------------------

/**
 * The shape of a voice's amp gain across its region, measured rather than inferred
 * (spec §5.4, §11.2).
 *
 * Every previous proof of the end-of-buffer declick read a voice's ENDS — how long it
 * sounded, and how near zero its last frame was — and a fade that runs the whole length of
 * the region satisfies both. That is how issue #144 survived every proof since §14
 * `2026-07-18 (t)`. These fields describe the shape in between.
 */
export interface AmpProfileResult {
  /** Seconds from the note-on to the last frame above the noise floor — the region's end. */
  readonly regionSeconds: number;
  /** Gain 1 ms after the note-on — the level the §6 AHDSR settles this voice at. */
  readonly headGain: number;
  /** Gain at the region's midpoint. §5.4 holds it there; a fade across the whole region halves it. */
  readonly midGain: number;
  /** Gain `DECLICK_FADE_MS` before the end — where the §5.4 fade begins, so still at head level. */
  readonly fadeStartGain: number;
  /** Milliseconds the gain spends below half `headGain` — how long the fade to zero really is. */
  readonly fadeMs: number;
}

/**
 * Read a rendered signal as an amp-gain profile. The caller renders a CONSTANT sample, so
 * every frame is the amp gain itself and the profile needs no envelope estimation — which
 * is what lets a 3 ms fade be told from a 250 ms one.
 */
function ampProfile(data: Float32Array, sampleRate: number): AmpProfileResult {
  const end = soundingSeconds(data, sampleRate);
  const at = (seconds: number): number => {
    const index = Math.round(seconds * sampleRate);
    return Math.abs(data[Math.min(data.length - 1, Math.max(0, index))] ?? 0);
  };
  const headGain = at(0.001);
  const half = headGain / 2;
  let lastAboveHalf = 0;
  for (let i = 0; i < data.length; i++) {
    if (Math.abs(data[i]!) >= half) lastAboveHalf = (i + 1) / sampleRate;
  }
  return {
    regionSeconds: end,
    headGain,
    midGain: at(end / 2),
    fadeStartGain: at(end - DECLICK_FADE_MS / 1000),
    fadeMs: Math.max(0, end - lastAboveHalf) * 1000,
  };
}

/** A buffer of constant 1.0 — played by a voice, the render IS that voice's amp gain. */
function constantBuffer(context: BaseAudioContext, seconds: number): AudioBuffer {
  const buffer = context.createBuffer(1, Math.floor(context.sampleRate * seconds), context.sampleRate);
  buffer.getChannelData(0).fill(1);
  return buffer;
}

/**
 * Profile the amp gain of one pool voice across its region (spec §5.4, §11.2, issue #144).
 *
 * The pad carries a flat AHDSR — no attack, no decay, full sustain — so the only thing that
 * may move its gain is the §5.4 declick, and the §6 filter is off so nothing colours the
 * constant sample on its way out.
 */
export async function renderAmpProfileOffline(
  seconds = 0.4,
  sampleSeconds = 0.25,
): Promise<AmpProfileResult> {
  const sampleRate = 48_000;
  const context = new OfflineAudioContext(1, Math.floor(sampleRate * seconds), sampleRate);
  const program = createDefaultDrumProgram('Declick profile');
  const pad = createDefaultPad(0);
  pad.layers = [{ ...createDefaultVelocityLayer('offline'), velocityStart: 0, velocityEnd: 127 }];
  pad.envelopes = {
    ...pad.envelopes,
    amp: { attack: 0, hold: 0, decay: 0, sustain: 1, release: 10, curve: 'linear' },
  };
  program.pads = [pad];
  const resolved = resolveVoice(program, 0, 127);
  if (!resolved) return ampProfile(new Float32Array(1), sampleRate);

  const pool = new VoicePool(context);
  const destination = context.createGain();
  destination.connect(context.destination);
  pool.trigger(
    resolvedVoiceToTrigger(resolved, {
      id: 'offline-declick',
      buffer: constantBuffer(context, sampleSeconds),
      destination,
      when: 0,
      velocity: 127,
      programId: 'offline',
      bpm: DEFAULT_BPM,
    }),
  );
  const rendered = await context.startRendering();
  pool.destroy();
  return ampProfile(rendered.getChannelData(0), sampleRate);
}

/**
 * The same profile for a §5.9 preview audition, which §5.9 says is "declicked at both ends
 * like a voice" and reaches that through the very same helper (spec §5.9, §14 `(u)`).
 *
 * It is measured separately rather than assumed to agree, because sharing the helper is a
 * claim about the code and this is a claim about the sound.
 */
export async function renderPreviewProfileOffline(
  seconds = 0.4,
  sampleSeconds = 0.25,
): Promise<AmpProfileResult> {
  const sampleRate = 48_000;
  const context = new OfflineAudioContext(1, Math.floor(sampleRate * seconds), sampleRate);
  const monitor = context.createGain();
  monitor.connect(context.destination);
  const preview = new PreviewChannel(context, monitor);
  preview.play(constantBuffer(context, sampleSeconds), 0);
  const rendered = await context.startRendering();
  preview.destroy();
  return ampProfile(rendered.getChannelData(0), sampleRate);
}

/**
 * What one voice's §6 amp contour did, read off a channel that carries only that voice
 * (spec §6, §5.4, §11.2, issue #143).
 *
 * A rise and a fall are the two things an envelope TIME is: no level reading and no length
 * reading can tell a 1 ms attack from a 300 ms one, which is why §14 `(ay)` had to profile a
 * voice rather than sample its ends.
 */
export interface AmpEnvelopeVoiceProfile {
  /** Seconds from the note-on until the gain first reaches 90 % of the voice's own plateau. */
  readonly riseSeconds: number;
  /** Seconds from the note-off until the gain falls below 5 % of that plateau. */
  readonly fallSeconds: number;
  /** The plateau itself — a floor of zero here would make both numbers meaningless. */
  readonly plateau: number;
}

/** Outcome of {@link renderAmpEnvelopeLaneOffline}. */
export interface AmpEnvelopeLaneResult {
  readonly attackPath: string;
  readonly releasePath: string;
  /** The voice struck BEFORE the lane moved — §6 says its AHDSR was applied when it started. */
  readonly sounding: AmpEnvelopeVoiceProfile;
  /** The voice struck AFTER it, which is the whole of what the two leaves address. */
  readonly struckAfter: AmpEnvelopeVoiceProfile;
  /** The §6 payload's own times, in ms, so the ratios below have their baseline stated. */
  readonly payloadAttackMs: number;
  readonly payloadReleaseMs: number;
  /** The times the lane wrote, in ms. */
  readonly laneAttackMs: number;
  readonly laneReleaseMs: number;
}

/** Profile one channel of the render as a rise and a fall around a known note-off. */
function envelopeProfile(
  data: Float32Array,
  sampleRate: number,
  startSeconds: number,
  offSeconds: number,
): AmpEnvelopeVoiceProfile {
  let plateau = 0;
  for (let i = 0; i < data.length; i += 1) plateau = Math.max(plateau, Math.abs(data[i]!));
  if (plateau <= 0) return { riseSeconds: 0, fallSeconds: 0, plateau: 0 };

  const from = Math.max(0, Math.round(startSeconds * sampleRate));
  let rise = 0;
  for (let i = from; i < data.length; i += 1) {
    if (Math.abs(data[i]!) >= plateau * 0.9) {
      rise = (i - from) / sampleRate;
      break;
    }
  }
  const off = Math.max(0, Math.round(offSeconds * sampleRate));
  let fall = (data.length - off) / sampleRate;
  for (let i = off; i < data.length; i += 1) {
    if (Math.abs(data[i]!) < plateau * 0.05) {
      fall = (i - off) / sampleRate;
      break;
    }
  }
  return { riseSeconds: rise, fallSeconds: fall, plateau };
}

/**
 * Profile the §6 amp contour of two voices of one pad, separated by a §7.8 lane on
 * `amp.attack` and `amp.release` (spec §6, §7.8, §11.2, issue #143).
 *
 * Both voices play a CONSTANT sample, so every rendered frame IS that voice's amp gain and a
 * 300 ms attack can be told from a 1 ms one without estimating an envelope from a tone — the
 * instrument §14 `(ay)` built. Each voice is given its own channel of the render, because the
 * two overlap and a summed reading could not attribute either shape.
 *
 * **The write travels the real §7.8 dispatch**: `createAudioBridge.applyAutomation` parses the
 * registered address, `programParamChange` maps it, and the pool applies it — the three the
 * defect broke at the second step. It is made with the first voice already sounding and the
 * second not yet started, which is the whole of the rule under test.
 *
 * The note-off is issued directly, because nothing in the application issues one yet: the
 * §7.1.4 dispatcher discards `noteOff` and `triggerLiveNote(..., false)` reaches only the
 * scheduler, so the §6 release stage is unreachable in production. That is a §5.4 defect of
 * its own and it is filed, not fixed here — the release half of this proof is a claim about
 * where the lane's value LANDS, which is the release ramp `VoicePool.release` schedules.
 */
export async function renderAmpEnvelopeLaneOffline(): Promise<AmpEnvelopeLaneResult> {
  const sampleRate = 48_000;
  const seconds = 3;
  const context = new OfflineAudioContext(2, Math.floor(sampleRate * seconds), sampleRate);

  const payloadAttackMs = 1;
  const payloadReleaseMs = 20;
  const laneAttackMs = 300;
  const laneReleaseMs = 500;

  const programId = 'amp-lane-offline';
  const program = { ...createDefaultDrumProgram('Amp envelope lane'), id: programId };
  const pad = createDefaultPad(0);
  pad.playbackMode = 'poly'; // §5.4: only a `poly` or `mono` pad answers a note-off at all
  pad.layers = [{ ...createDefaultVelocityLayer('offline'), velocityStart: 0, velocityEnd: 127 }];
  pad.filter = { ...pad.filter, type: 'off' };
  pad.envelopes = {
    ...pad.envelopes,
    amp: {
      attack: payloadAttackMs,
      hold: 0,
      decay: 0,
      sustain: 1,
      release: payloadReleaseMs,
      curve: 'linear',
    },
  };
  program.pads = [pad];

  const attackPath = programParamPath(programId, 0, 'amp.attack');
  const releasePath = programParamPath(programId, 0, 'amp.release');
  const empty: AmpEnvelopeVoiceProfile = { riseSeconds: 0, fallSeconds: 0, plateau: 0 };
  const resolved = resolveVoice(program, 0, 127);
  if (!resolved) {
    return {
      attackPath,
      releasePath,
      sounding: empty,
      struckAfter: empty,
      payloadAttackMs,
      payloadReleaseMs,
      laneAttackMs,
      laneReleaseMs,
    };
  }

  const pool = new VoicePool(context);
  const graph = new MixerGraph(context);
  const bridge = createAudioBridge({ graph, context, voicePool: () => pool });

  // One channel per voice: the two overlap, and a summed render could attribute neither.
  const merger = context.createChannelMerger(2);
  merger.connect(context.destination);
  const lane = (index: number): GainNode => {
    const gain = context.createGain();
    gain.connect(merger, 0, index);
    return gain;
  };

  const buffer = constantBuffer(context, 2.5);
  const soundingStart = 0;
  const afterStart = 1;
  const noteOff = 1.6;
  pool.trigger(
    resolvedVoiceToTrigger(resolved, {
      id: 'sounding',
      buffer,
      destination: lane(0),
      when: soundingStart,
      velocity: 127,
      programId,
      bpm: DEFAULT_BPM,
    }),
  );
  // The write lands while the first voice is sounding and before the second exists.
  bridge.applyAutomation(attackPath, laneAttackMs, 0.5, 0.5);
  bridge.applyAutomation(releasePath, laneReleaseMs, 0.5, 0.5);
  pool.trigger(
    resolvedVoiceToTrigger(resolved, {
      id: 'after',
      buffer,
      destination: lane(1),
      when: afterStart,
      velocity: 127,
      programId,
      bpm: DEFAULT_BPM,
    }),
  );
  pool.release(resolved.padKey, noteOff);

  const rendered = await context.startRendering();
  pool.destroy();
  graph.destroy();
  return {
    attackPath,
    releasePath,
    sounding: envelopeProfile(rendered.getChannelData(0), sampleRate, soundingStart, noteOff),
    struckAfter: envelopeProfile(rendered.getChannelData(1), sampleRate, afterStart, noteOff),
    payloadAttackMs,
    payloadReleaseMs,
    laneAttackMs,
    laneReleaseMs,
  };
}
