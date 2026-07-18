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
import { equalSlices, slicesFromMarkers, slicesFromOnsets, type SliceRegion } from './chop';
import { loadKernelModule } from '@/core/dsp/kernelLoader';
import {
  GranularStretchKernel,
  granularStretchWasmUrl,
  type StretchParams,
} from '@/core/dsp/granularStretchKernel';
import {
  TransientDetectKernel,
  transientDetectWasmUrl,
  type DetectOptions,
} from '@/core/dsp/transientDetectKernel';
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

/**
 * Write processed channels as a new OPFS sample + row (spec §8.5.4 non-destructive result).
 *
 * The result inherits the SOURCE sample's scope (spec §9.3): editing a global-library sample
 * yields a global-library sample. Filing it under the active project instead would drop it out
 * of the library the user is looking at, and would tie a shared sample's derivative to the
 * lifetime of whichever project happened to be open.
 */
function writeNewSample(
  source: SampleRow,
  channels: Float32Array[],
  sampleRate: number,
  name: string,
  tags: readonly string[],
  ctx: EditContext,
): Promise<SampleRow> {
  const scope = source.project_id === null ? 'global' : 'project';
  return saveChannelsAsSample(channels, sampleRate, name, ['edited', ...tags], { ...ctx, scope });
}

/** Apply a pure channel transform (Normalise/Reverse/Trim/Fade) to a new sample (spec §8.5.4). */
export async function applyEditToNewSample(
  row: SampleRow,
  transform: (channels: Float32Array[]) => Float32Array[],
  label: string,
  ctx: EditContext,
): Promise<SampleRow> {
  const { channels, sampleRate } = await readSampleChannels(row);
  return writeNewSample(
    row,
    transform(channels),
    sampleRate,
    `${row.name} (${label})`,
    [label.toLowerCase()],
    ctx,
  );
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
    return await writeNewSample(row, rendered, sampleRate, `${row.name} (stretch)`, ['stretch'], ctx);
  } finally {
    kernel.destroy();
  }
}

/**
 * How a Chop divides the sample (spec §8.5.4 requires all three): WASM transient detection,
 * equal divisions, or the editor's manual markers. Modelled as a discriminated union so a mode
 * cannot be selected without the parameter it needs — an equal chop with no count, or a marker
 * chop with a sensitivity, will not type-check.
 */
export type ChopSpec =
  | { readonly mode: 'transients'; readonly detect: DetectOptions }
  | { readonly mode: 'equal'; readonly count: number }
  | { readonly mode: 'markers'; readonly markers: readonly number[] };

/**
 * Resolve a spec to slice regions. Only the transient mode needs the WASM kernel (and so the
 * mono sum); the other two are pure maths over the frame count, which is why they are separated
 * from the write path below.
 */
async function regionsForSpec(
  spec: ChopSpec,
  channels: readonly Float32Array[],
  sampleRate: number,
): Promise<SliceRegion[]> {
  const frames = channels[0]?.length ?? 0;
  if (spec.mode === 'equal') return equalSlices(frames, spec.count);
  if (spec.mode === 'markers') return slicesFromMarkers(frames, spec.markers);

  const mono = monoSum(channels);
  const module = await loadKernelModule(transientDetectWasmUrl());
  const kernel = TransientDetectKernel.fromModule(module, sampleRate, mono.length);
  try {
    return slicesFromOnsets(mono.length, kernel.detect(mono, spec.detect));
  } finally {
    kernel.destroy();
  }
}

/**
 * Chop a sample into one NEW sample per slice (spec §8.5.4), by whichever mode `spec` selects.
 * Every mode shares this write path, so a slice is rendered and tagged identically however its
 * boundaries were decided. Returns the new sample rows in order.
 */
export async function chopSampleToNewSamples(
  row: SampleRow,
  spec: ChopSpec,
  ctx: EditContext,
): Promise<SampleRow[]> {
  const { channels, sampleRate } = await readSampleChannels(row);
  const regions = await regionsForSpec(spec, channels, sampleRate);
  const rows: SampleRow[] = [];
  for (let i = 0; i < regions.length; i++) {
    const { startFrame, endFrame } = regions[i]!;
    // A degenerate region would write a zero-length sample; the marker and equal modes clamp
    // upstream, but a detector returning coincident onsets must not be able to produce one.
    if (endFrame <= startFrame) continue;
    const sliceChannels = channels.map((channel) => channel.slice(startFrame, endFrame));
    rows.push(
      await writeNewSample(row, sliceChannels, sampleRate, `${row.name} chop ${i + 1}`, ['chop'], ctx),
    );
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
