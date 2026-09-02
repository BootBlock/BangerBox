/**
 * Groove extraction service (spec §7.5) — the live consumer of the pure groove maths. It reads a
 * sample's transients (the `transientDetect` WASM kernel), builds a groove template
 * ({@link grooveFromTransients}), and bakes it destructively into a track's events
 * ({@link applyGrooveToEvents}) via the undoable store action (spec §7.5 "bake-able as a
 * destructive edit").
 *
 * §7.5's other half is non-destructive: {@link extractAndSaveGroove} stores the template on
 * the project instead, and the Grid's per-track picker applies it at schedule time like
 * swing. Both start from the same extraction, so the two ways of spending a groove can never
 * disagree about what it is. Browser-only (OPFS + WASM).
 */
import { loadKernelModule } from '@/core/dsp/kernelLoader';
import { TransientDetectKernel, transientDetectWasmUrl } from '@/core/dsp/transientDetectKernel';
import { PPQN } from '@/core/constants';
import {
  applyGrooveToEvents,
  grooveFromTransients,
  type GrooveTemplate,
  type Transient,
} from '@/core/sequencer/groove';
import type { SampleRow } from '@/core/storage/repositories';
import { useSequenceStore } from '@/store';
import { readSampleChannels } from './sampleEditService';

/** Peak magnitude of a sample in a short window after a frame — the onset's strength. */
function onsetMagnitude(mono: Float32Array, frame: number, window = 512): number {
  let peak = 0;
  for (let i = frame; i < Math.min(frame + window, mono.length); i++) {
    peak = Math.max(peak, Math.abs(mono[i]!));
  }
  return peak;
}

/** Extract a groove template from a sample's transients at a given tempo (spec §7.5). */
async function extractGrooveFromSample(row: SampleRow, bpm: number): Promise<GrooveTemplate> {
  const { channels, sampleRate } = await readSampleChannels(row);
  const mono = channels[0]!;
  const module = await loadKernelModule(transientDetectWasmUrl());
  const kernel = TransientDetectKernel.fromModule(module, sampleRate, mono.length);
  let transients: Transient[];
  try {
    transients = kernel.detect(mono, { sensitivity: 0.6, minSpacingMs: 40 }).map((frame) => ({
      frame,
      magnitude: onsetMagnitude(mono, frame),
    }));
  } finally {
    kernel.destroy();
  }
  const lengthTicks = Math.max(PPQN, Math.round((mono.length / sampleRate) * (bpm / 60) * PPQN));
  return grooveFromTransients(transients, { bpm, sampleRate, lengthTicks, division: 16 });
}

/**
 * Extract a groove from `row` and store it on the project under the sample's own name
 * (spec §7.5, §9.3 payload), where the Grid's per-track picker can spend it.
 *
 * The sample's name is the key rather than a fresh UUID, so re-extracting from the same
 * sample replaces its template instead of adding a second one the picker cannot tell apart —
 * `grooveTemplates` is keyed by a string and carries no name of its own.
 */
export async function extractAndSaveGroove(
  row: SampleRow,
  bpm: number,
): Promise<{ id: string; template: GrooveTemplate }> {
  const template = await extractGrooveFromSample(row, bpm);
  useSequenceStore.getState().setGrooveTemplate(row.name, template);
  return { id: row.name, template };
}

/**
 * Extract a groove from `row` and bake it into `trackId`'s events (spec §7.5). Returns the
 * template and the number of events shifted. The store action is undoable (spec §4.5).
 */
export async function extractAndBakeGroove(
  row: SampleRow,
  trackId: string,
  bpm: number,
): Promise<{ template: GrooveTemplate; eventCount: number }> {
  const template = await extractGrooveFromSample(row, bpm);
  const events = useSequenceStore.getState().events[trackId] ?? [];
  const baked = applyGrooveToEvents(events, template);
  useSequenceStore.getState().setTrackEvents(trackId, baked);
  return { template, eventCount: baked.length };
}
