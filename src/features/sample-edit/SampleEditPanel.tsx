/**
 * Sample Edit mode (spec §8.5, mode 4) — the Phase 6 functional editor (unpolished; the deep
 * canvas tooling is Phase 7). It wires the built sample pipeline end to end: import a file
 * (§9.4), audition it (§5.9), view its waveform (§8.4), and run the destructive tools —
 * Normalise / Reverse / Fade / Trim (§8.5.4), WASM transient Chop (§7.5/§8.5.4), and granular
 * Time-stretch (§5.7.9) — each rendering a NEW sample (§8.5.4). Every control is wired (§3.4).
 */
import { useEffect, useState } from 'react';
import { getAudioEngine } from '@/core/project';
import type { SampleRow } from '@/core/storage/repositories';
import { fadeIn, fadeOut, normalise, reverse, trim } from '@/core/audio/sampleEdit';
import {
  applyEditToNewSample,
  chopSampleToNewSamples,
  readSampleChannels,
  stretchSampleToNewSample,
} from '@/core/audio/sampleEditService';
import { importAudioFile } from '@/core/audio/sampleImport';
import { extractAndBakeGroove } from '@/core/audio/grooveService';
import { useBrowserStore, useProjectStore, useSequenceStore, useTransportStore, useUIStore } from '@/store';
import { WaveformCanvas } from '@/ui/primitives/WaveformCanvas';
import { refreshSamples, sampleEditContext } from './sampleContext';

/** Mono down-mix for the waveform preview. */
function monoOf(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0]!;
  const frames = channels[0]!.length;
  const out = new Float32Array(frames);
  for (const channel of channels) {
    for (let i = 0; i < frames; i++) out[i] = (out[i] ?? 0) + channel[i]! / channels.length;
  }
  return out;
}

export function SampleEditPanel() {
  const samples = useBrowserStore((state) => state.samples);
  const projectId = useProjectStore((state) => state.projectId);
  const pushToast = useUIStore((state) => state.pushToast);
  const [selected, setSelected] = useState<SampleRow | null>(null);
  const [waveform, setWaveform] = useState<Float32Array | null>(null);
  const [busy, setBusy] = useState(false);
  const [fadeMs, setFadeMs] = useState(50);
  const [stretchRate, setStretchRate] = useState(1);
  const [stretchPitch, setStretchPitch] = useState(0);
  const [sensitivity, setSensitivity] = useState(0.5);

  useEffect(() => {
    void refreshSamples();
  }, [projectId]);

  const select = async (row: SampleRow) => {
    setSelected(row);
    try {
      const { channels } = await readSampleChannels(row);
      setWaveform(monoOf(channels));
    } catch {
      setWaveform(null);
    }
  };

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await refreshSamples();
      pushToast(`${label} complete.`, 'success');
    } catch (error) {
      pushToast(error instanceof Error ? error.message : `${label} failed.`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const onImport = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const engine = getAudioEngine();
    if (!engine) {
      pushToast('Start the audio engine before importing.', 'warning');
      return;
    }
    void run('Import', () => importAudioFile(file, { ...sampleEditContext(), context: engine.context }));
  };

  const edit = (label: string, transform: (channels: Float32Array[]) => Float32Array[]) => {
    if (!selected) return;
    void run(label, () => applyEditToNewSample(selected, transform, label, sampleEditContext()));
  };

  const frames = waveform?.length ?? 0;

  return (
    <section aria-labelledby="sample-edit-heading" className="mt-6">
      <h2 id="sample-edit-heading" className="text-lg font-bold">
        Sample edit
      </h2>
      <p className="mt-1 text-xs leading-relaxed text-bb-muted">
        Import, audition, and edit samples. Destructive tools render a new sample; the original is kept.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="cursor-pointer rounded-bb-sm border border-bb-line bg-bb-raised px-3 py-1.5 text-xs">
          Import audio…
          <input
            type="file"
            accept=".wav,.mp3,.flac,.ogg,audio/*"
            className="sr-only"
            data-testid="sample-import"
            onChange={onImport}
          />
        </label>
        <span className="text-xs text-bb-muted" data-testid="sample-count">
          {samples.length} sample{samples.length === 1 ? '' : 's'}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-[16rem_1fr]">
        <ul
          className="max-h-56 overflow-auto rounded-bb-sm border border-bb-line"
          aria-label="Project samples"
        >
          {samples.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                onClick={() => void select(row)}
                className={`flex w-full items-center justify-between px-2 py-1 text-left text-xs ${
                  selected?.id === row.id ? 'bg-bb-accent/20' : 'hover:bg-bb-raised'
                }`}
                aria-current={selected?.id === row.id}
              >
                <span className="truncate">{row.name}</span>
                <span className="ml-2 shrink-0 text-bb-muted">{row.frames}f</span>
              </button>
            </li>
          ))}
          {samples.length === 0 && <li className="px-2 py-2 text-xs text-bb-muted">No samples yet.</li>}
        </ul>

        <div>
          <WaveformCanvas
            samples={waveform}
            ariaLabel={selected ? `Waveform of ${selected.name}` : 'No sample selected'}
          />
          {selected && (
            <div className="mt-2 space-y-2">
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  disabled={busy}
                  className="rounded-bb-sm border border-bb-line px-2 py-1 text-xs disabled:opacity-50"
                  onClick={() => void getAudioEngine()?.auditionSample(selected.opfs_path)}
                >
                  Audition
                </button>
                <ToolButton
                  busy={busy}
                  label="Normalise"
                  onClick={() => edit('Normalise', (c) => normalise(c))}
                />
                <ToolButton busy={busy} label="Reverse" onClick={() => edit('Reverse', reverse)} />
                <ToolButton
                  busy={busy}
                  label="Fade in"
                  onClick={() => edit('Fade in', (c) => fadeIn(c, msToFrames(fadeMs, selected.sample_rate)))}
                />
                <ToolButton
                  busy={busy}
                  label="Fade out"
                  onClick={() =>
                    edit('Fade out', (c) => fadeOut(c, msToFrames(fadeMs, selected.sample_rate)))
                  }
                />
                <ToolButton
                  busy={busy}
                  label="Trim ends"
                  onClick={() =>
                    edit('Trim', (c) => trim(c, Math.floor(frames * 0.1), Math.ceil(frames * 0.9)))
                  }
                />
              </div>

              <div className="flex flex-wrap items-center gap-2 text-xs">
                <label className="flex items-center gap-1">
                  Fade ms
                  <input
                    type="number"
                    min={1}
                    max={2000}
                    value={fadeMs}
                    onChange={(e) => setFadeMs(Number(e.target.value))}
                    className="w-16 rounded-bb-sm border border-bb-line bg-bb-raised px-1 py-0.5"
                  />
                </label>
                <label className="flex items-center gap-1">
                  Chop sensitivity
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={sensitivity}
                    onChange={(e) => setSensitivity(Number(e.target.value))}
                    aria-valuetext={sensitivity.toFixed(2)}
                  />
                </label>
                <ToolButton
                  busy={busy}
                  label="Chop (transients)"
                  testId="sample-chop"
                  onClick={() =>
                    void run('Chop', () =>
                      chopSampleToNewSamples(selected, { sensitivity }, sampleEditContext()),
                    )
                  }
                />
                <ToolButton
                  busy={busy}
                  label="Groove → bake to track"
                  testId="sample-groove"
                  onClick={() => {
                    const track = Object.values(useSequenceStore.getState().tracks)[0];
                    if (!track) {
                      pushToast('No track to bake the groove into.', 'warning');
                      return;
                    }
                    void run('Groove bake', () =>
                      extractAndBakeGroove(selected, track.id, useTransportStore.getState().bpm),
                    );
                  }}
                />
              </div>

              <div className="flex flex-wrap items-center gap-2 text-xs">
                <label className="flex items-center gap-1">
                  Rate
                  <input
                    type="number"
                    min={0.25}
                    max={4}
                    step={0.05}
                    value={stretchRate}
                    onChange={(e) => setStretchRate(Number(e.target.value))}
                    className="w-16 rounded-bb-sm border border-bb-line bg-bb-raised px-1 py-0.5"
                  />
                </label>
                <label className="flex items-center gap-1">
                  Pitch st
                  <input
                    type="number"
                    min={-24}
                    max={24}
                    step={1}
                    value={stretchPitch}
                    onChange={(e) => setStretchPitch(Number(e.target.value))}
                    className="w-16 rounded-bb-sm border border-bb-line bg-bb-raised px-1 py-0.5"
                  />
                </label>
                <ToolButton
                  busy={busy}
                  label="Time-stretch render"
                  testId="sample-stretch"
                  onClick={() =>
                    void run('Time-stretch', () =>
                      stretchSampleToNewSample(
                        selected,
                        { rate: stretchRate, pitchSemitones: stretchPitch },
                        sampleEditContext(),
                      ),
                    )
                  }
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function msToFrames(ms: number, sampleRate: number): number {
  return Math.max(1, Math.round((ms / 1000) * sampleRate));
}

interface ToolButtonProps {
  label: string;
  busy: boolean;
  onClick: () => void;
  testId?: string;
}
function ToolButton({ label, busy, onClick, testId }: ToolButtonProps) {
  return (
    <button
      type="button"
      disabled={busy}
      data-testid={testId}
      onClick={onClick}
      className="rounded-bb-sm border border-bb-line bg-bb-raised px-2 py-1 text-xs disabled:opacity-50"
    >
      {label}
    </button>
  );
}
