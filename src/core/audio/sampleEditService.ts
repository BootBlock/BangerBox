/**
 * Sample-editor engine glue (spec §8.5.4) — reads a sample's canonical WAV from OPFS, applies a
 * destructive tool (Normalise / Reverse / Trim / Fade / Chop / Time-stretch), and writes the
 * result as a NEW OPFS sample + metadata row (new `sampleId`; the original persists until Purge —
 * spec §8.5.4). It ties the pure DSP (`sampleEdit`, `chop`) and the WASM kernels
 * (`transientDetect`, `granularStretch`) into the live app so nothing stays an orphan (§3.4).
 * Browser-only (OPFS + WASM); the underlying transforms are unit-tested in their own modules.
 */
import type { SampleRow } from '@/core/storage/repositories';
import { readFile } from '@/core/storage/opfs';
import { slicesFromOnsets, type SliceRegion } from './chop';
import { loadKernelModule } from '@/core/dsp/kernelLoader';
import { GranularStretchKernel, granularStretchWasmUrl, type StretchParams } from '@/core/dsp/granularStretchKernel';
import { TransientDetectKernel, transientDetectWasmUrl, type DetectOptions } from '@/core/dsp/transientDetectKernel';
import { saveChannelsAsSample, type SampleWriteContext } from './sampleImport';
import { decodeWav } from './wav';

type EditContext = SampleWriteContext;

/** Read a project sample's canonical WAV back into planar Float32 channels (spec §8.5.4). */
export async function readSampleChannels(
  row: SampleRow,
): Promise<{ channels: Float32Array[]; sampleRate: number }> {
  const file = await readFile(row.opfs_path);
  const decoded = decodeWav(new Uint8Array(await file.arrayBuffer()));
  return { channels: decoded.channels, sampleRate: decoded.sampleRate };
}

/** Write processed channels as a new OPFS sample + row (spec §8.5.4 non-destructive result). */
function writeNewSample(
  channels: Float32Array[],
  sampleRate: number,
  name: string,
  tags: readonly string[],
  ctx: EditContext,
): Promise<SampleRow> {
  return saveChannelsAsSample(channels, sampleRate, name, ['edited', ...tags], ctx);
}

/** Apply a pure channel transform (Normalise/Reverse/Trim/Fade) to a new sample (spec §8.5.4). */
export async function applyEditToNewSample(
  row: SampleRow,
  transform: (channels: Float32Array[]) => Float32Array[],
  label: string,
  ctx: EditContext,
): Promise<SampleRow> {
  const { channels, sampleRate } = await readSampleChannels(row);
  return writeNewSample(transform(channels), sampleRate, `${row.name} (${label})`, [label.toLowerCase()], ctx);
}

/** Time-stretch/pitch-shift a sample to a new sample via the granularStretch kernel (spec §5.7.9). */
export async function stretchSampleToNewSample(
  row: SampleRow,
  params: StretchParams,
  ctx: EditContext,
): Promise<SampleRow> {
  const { channels, sampleRate } = await readSampleChannels(row);
  const module = await loadKernelModule(granularStretchWasmUrl());
  const maxInput = channels[0]?.length ?? 0;
  const kernel = GranularStretchKernel.fromModule(module, sampleRate, maxInput);
  try {
    const rendered = channels.map((channel) => kernel.render(channel, params));
    return await writeNewSample(rendered, sampleRate, `${row.name} (stretch)`, ['stretch'], ctx);
  } finally {
    kernel.destroy();
  }
}

/**
 * Chop a sample by WASM transient detection (spec §8.5.4): detect onsets on the mono sum, slice
 * one region per transient, and write each slice as a new sample tagged `chop`. Returns the new
 * sample rows in order.
 */
export async function chopSampleToNewSamples(
  row: SampleRow,
  options: DetectOptions,
  ctx: EditContext,
): Promise<SampleRow[]> {
  const { channels, sampleRate } = await readSampleChannels(row);
  const mono = monoSum(channels);
  const module = await loadKernelModule(transientDetectWasmUrl());
  const kernel = TransientDetectKernel.fromModule(module, sampleRate, mono.length);
  let regions: SliceRegion[];
  try {
    const onsets = kernel.detect(mono, options);
    regions = slicesFromOnsets(mono.length, onsets);
  } finally {
    kernel.destroy();
  }
  const rows: SampleRow[] = [];
  for (let i = 0; i < regions.length; i++) {
    const { startFrame, endFrame } = regions[i]!;
    const sliceChannels = channels.map((channel) => channel.slice(startFrame, endFrame));
    rows.push(await writeNewSample(sliceChannels, sampleRate, `${row.name} chop ${i + 1}`, ['chop'], ctx));
  }
  return rows;
}

/** Down-mix channels to a mono sum for analysis (spec §7.5 / §8.5.4). */
function monoSum(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0]!.slice();
  const frames = channels[0]!.length;
  const out = new Float32Array(frames);
  for (const channel of channels) {
    for (let i = 0; i < frames; i++) out[i] = (out[i] ?? 0) + channel[i]! / channels.length;
  }
  return out;
}
