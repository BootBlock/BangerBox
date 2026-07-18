/**
 * Offline effect renders — spec §11.2. Node lacks Web Audio, so the DSP correctness of
 * the native inserts is proven by rendering a known input through each effect in an
 * `OfflineAudioContext` inside the browser (driven by the Playwright smoke, §11.4) and
 * asserting numeric properties (non-silent output, bounded peak, filter attenuation).
 * This module is browser-only; it is reached only through the audio probe seam.
 */
import type { EffectType, Program } from '@/core/project/schemas';
import { prepareWorkletEffects } from './context';
import { createInsert } from './inserts/insert';

/** Effects whose engine is a WASM worklet and so need the processor + kernels loaded first. */
const WORKLET_EFFECTS: ReadonlySet<EffectType> = new Set<EffectType>(['reverb', 'multibandComp', 'limiter']);
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

/** The measured pitch (Hz) of one resolved program note rendered offline (spec §11.2). */
export interface NotePitchResult {
  readonly frequency: number;
  readonly rms: number;
}

/**
 * Render one program note through the real resolution + voice pool in an OfflineAudioContext
 * and measure its pitch (spec §11.2). Proves velocity-layer switching (different layers →
 * different pitch) and keygroup pitch accuracy (coupled repitch) audibly (spec §12 exit).
 * The layer/zone `sampleId` maps to a synthesised `baseFrequency` sine so the pitch is known.
 */
export async function renderProgramNotePitch(
  program: Program,
  note: number,
  velocity: number,
  baseFrequency = 440,
  seconds = 0.4,
): Promise<NotePitchResult> {
  const sampleRate = 48_000;
  const context = new OfflineAudioContext(1, Math.floor(sampleRate * seconds), sampleRate);
  const resolved = resolveVoice(program, note, velocity);
  if (!resolved) return { frequency: 0, rms: 0 };

  const pool = new VoicePool(context);
  const destination = context.createGain();
  destination.connect(context.destination);
  pool.trigger(
    resolvedVoiceToTrigger(resolved, {
      id: 'offline-note',
      buffer: sineBuffer(context, baseFrequency, seconds),
      destination,
      when: 0,
      velocity,
      programId: 'offline',
    }),
  );

  const rendered = await context.startRendering();
  pool.destroy();
  const data = rendered.getChannelData(0);
  return { frequency: detectPitch(data, sampleRate), rms: rms(data) };
}
