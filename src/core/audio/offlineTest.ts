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
  const insert = createInsert(context, 'delay', { sync, time, feedback: 0, mix: 1 }, bpm);
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
