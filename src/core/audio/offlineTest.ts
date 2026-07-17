/**
 * Offline effect renders — spec §11.2. Node lacks Web Audio, so the DSP correctness of
 * the native inserts is proven by rendering a known input through each effect in an
 * `OfflineAudioContext` inside the browser (driven by the Playwright smoke, §11.4) and
 * asserting numeric properties (non-silent output, bounded peak, filter attenuation).
 * This module is browser-only; it is reached only through the audio probe seam.
 */
import type { EffectType } from '@/core/project/schemas';
import { createInsert } from './inserts/insert';

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
