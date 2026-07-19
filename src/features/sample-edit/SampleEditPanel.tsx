/**
 * Sample Edit mode (spec §8.5, mode 4) — the functional editor. It wires the built sample
 * pipeline end to end: import a file (§9.4), audition it (§5.9), view and navigate its waveform
 * (§8.4), and run the destructive tools — Normalise / Reverse / Fade / Trim (§8.5.4), Chop in
 * all three §8.5.4 modes (manual markers / equal slices / WASM transients, §7.5), and granular
 * Time-stretch (§5.7.9) — each rendering a NEW sample (§8.5.4). Every control is wired (§3.4).
 *
 * The region tools follow the editor's selection when there is one and the whole file when there
 * is not, which is what makes Trim able to do its actual job (§8.5.4) rather than cutting a
 * fixed fraction of the file.
 */
import { useEffect, useMemo, useState } from 'react';
import { getAudioEngine } from '@/core/project';
import type { SampleRow } from '@/core/storage/repositories';
import { applyToRegion, fadeIn, fadeOut, normalise, reverse, trim } from '@/core/audio/sampleEdit';
import {
  applyEditToNewSample,
  chopSampleToNewSamples,
  stretchSampleToNewSample,
  type ChopSpec,
} from '@/core/audio/sampleEditService';
import type { SliceRegion } from '@/core/audio/chop';
import type { PeakPyramid } from '@/core/audio/peakPyramid';
import { getPeakPyramid } from '@/core/audio/peakPyramidCache';
import { importAudioFile } from '@/core/audio/sampleImport';
import { extractAndBakeGroove } from '@/core/audio/grooveService';
import { GLOBAL_LIBRARY_ROOT, projectSamplesRoot } from '@/core/storage/opfs';
import {
  BROWSER_INITIAL_PATH,
  useBrowserStore,
  useProjectStore,
  useSequenceStore,
  useTransportStore,
  useUIStore,
} from '@/store';
import { isGlobalLibraryPath, scopeOfPath } from '../browser/libraryLocation';
import { Button, EmptyState } from '@/ui/primitives';
import { SegmentControl } from '@/ui/primitives/SegmentControl';
import { WaveformEditor } from '@/ui/primitives/WaveformEditor';
import { auditionSample, refreshSamples, reloadSampleList, sampleEditContext } from './sampleContext';

/** The three §8.5.4 Chop modes, in the order the spec lists them. */
type ChopMode = ChopSpec['mode'];
const CHOP_MODES: readonly { value: ChopMode; label: string }[] = [
  { value: 'markers', label: 'Manual markers' },
  { value: 'equal', label: 'Equal slices' },
  { value: 'transients', label: 'Transients' },
];

/**
 * Shortest slice a manual marker may carve out. Five milliseconds is below anything musically
 * useful but comfortably above zero, so the guard only ever catches markers dropped on top of
 * one another.
 */
const MIN_SLICE_MS = 5;

export function SampleEditPanel() {
  const samples = useBrowserStore((state) => state.samples);
  const projectId = useProjectStore((state) => state.projectId);
  const pushToast = useUIStore((state) => state.pushToast);
  const [selected, setSelected] = useState<SampleRow | null>(null);
  const [pyramid, setPyramid] = useState<PeakPyramid | null>(null);
  const [busy, setBusy] = useState(false);
  const [fadeMs, setFadeMs] = useState(50);
  const [stretchRate, setStretchRate] = useState(1);
  const [stretchPitch, setStretchPitch] = useState(0);
  const [sensitivity, setSensitivity] = useState(0.5);
  const [chopMode, setChopMode] = useState<ChopMode>('transients');
  const [sliceCount, setSliceCount] = useState(8);
  const [markers, setMarkers] = useState<number[]>([]);
  const [selection, setSelection] = useState<SliceRegion | null>(null);
  /** Why the selected sample's audio could not be read, or null when it read fine. */
  const [waveformError, setWaveformError] = useState<string | null>(null);
  const samplesError = useBrowserStore((state) => state.samplesError);
  const currentPath = useBrowserStore((state) => state.currentPath);
  const tracks = useSequenceStore((state) => state.tracks);
  const [grooveTrackId, setGrooveTrackId] = useState<string | null>(null);

  /**
   * Which library this panel is editing. It is `useBrowserStore.currentPath` — the same
   * state the Browser's folder tree drives — rather than a second local flag, so the two
   * modes cannot disagree about where "here" is (see `libraryLocation.ts`).
   *
   * This panel used to READ that path without exposing it: factory kits share their audio
   * into the global library (§9.8), so a user who had never opened Browser mode saw an
   * empty list here and no way to reach it.
   */
  const browsingGlobal = isGlobalLibraryPath(currentPath);
  const locationLabel = browsingGlobal ? 'global library' : 'project';

  const grooveTracks = useMemo(() => Object.values(tracks).sort((a, b) => a.position - b.position), [tracks]);
  /**
   * The track a bake would target. Falls back to the first rather than to nothing, so the
   * picker starts on a real track and the label always names where the groove will land.
   */
  const grooveTarget = grooveTracks.find((track) => track.id === grooveTrackId) ?? grooveTracks[0];

  // Point at the active project's samples when a project opens, unless the global library —
  // which outlives any one project — is the location being edited. Mirrors BrowserPanel, so
  // arriving in either mode first leaves the other showing the same place.
  useEffect(() => {
    if (!projectId) return;
    const { currentPath: path, setCurrentPath } = useBrowserStore.getState();
    if (!isGlobalLibraryPath(path)) setCurrentPath(projectSamplesRoot(projectId));
  }, [projectId]);

  // The list follows the location, as the Browser's does (spec §8.5.7).
  useEffect(() => {
    // On first render the store still holds its placeholder path and the effect above is
    // about to point it at the project — querying now would only repeat itself a tick later.
    if (projectId && currentPath === BROWSER_INITIAL_PATH) return;
    void reloadSampleList();
  }, [projectId, currentPath]);

  /**
   * Switch library. The open sample belongs to the list being left, so it is cleared rather
   * than left selected with every destructive tool still armed against audio the user can no
   * longer see in the list.
   */
  const setLocation = (global: boolean) => {
    if (global === browsingGlobal) return;
    setSelected(null);
    setPyramid(null);
    setSelection(null);
    setMarkers([]);
    setWaveformError(null);
    useBrowserStore
      .getState()
      .setCurrentPath(global || !projectId ? GLOBAL_LIBRARY_ROOT : projectSamplesRoot(projectId));
  };

  const select = async (row: SampleRow) => {
    setSelected(row);
    setPyramid(null);
    // A selection and a marker set belong to the sample they were drawn on; carrying them to
    // the next one would silently point them at unrelated audio.
    setSelection(null);
    setMarkers([]);
    setWaveformError(null);
    try {
      setPyramid(await getPeakPyramid(row.opfs_path));
    } catch (error) {
      // An unreadable sample used to draw exactly like an empty one, with every destructive
      // tool still armed against it. Say so, and disarm them below.
      setPyramid(null);
      setWaveformError(
        error instanceof Error && error.message ? error.message : 'The audio could not be read.',
      );
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
    // The import lands where the user is looking. Without the scope it always wrote to the
    // project, so importing while editing the global library dropped the file into a list
    // the panel was not showing.
    void run(`Import into the ${locationLabel}`, () =>
      importAudioFile(file, {
        ...sampleEditContext(),
        context: engine.context,
        scope: scopeOfPath(currentPath),
      }),
    );
  };

  /**
   * Run a length-preserving tool over the selection when there is one, else the whole file
   * (spec §8.5.4). Trim is not routed through here — it changes the length, so it *is* the
   * selection rather than being applied within it.
   */
  const edit = (label: string, transform: (channels: Float32Array[]) => Float32Array[]) => {
    if (!selected) return;
    const region = selection;
    const scoped = region
      ? (channels: Float32Array[]) => applyToRegion(channels, region.startFrame, region.endFrame, transform)
      : transform;
    void run(label, () => applyEditToNewSample(selected, scoped, label, sampleEditContext()));
  };

  const frames = pyramid?.frames ?? 0;
  const sampleRate = selected?.sample_rate ?? 48_000;

  const chopSpec = (): ChopSpec => {
    if (chopMode === 'equal') return { mode: 'equal', count: sliceCount };
    if (chopMode === 'markers') return { mode: 'markers', markers };
    return { mode: 'transients', detect: { sensitivity } };
  };

  // Chopping on no markers would render a single slice identical to the source — a pointless
  // copy, so the action states why it is unavailable instead of silently doing that.
  const chopBlockedReason =
    chopMode === 'markers' && markers.length === 0 ? 'Place at least one marker to chop.' : null;

  // Every tool here renders a NEW sample from the selected audio. Running one against audio
  // that would not load means rendering from nothing, so they stay disarmed until it reads.
  const toolsBlocked = busy || waveformError !== null;

  return (
    <section aria-labelledby="sample-edit-heading" className="mt-6">
      <h3 id="sample-edit-heading" className="text-lg font-bold">
        Sample edit
      </h3>
      <p className="mt-1 text-xs leading-relaxed text-bb-muted">
        Import, audition, and edit samples. Destructive tools render a new sample; the original is kept.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {/* Which library is being edited (spec §8.5.7's two roots). Factory kits share their
            audio into the global library, so without this the panel could only ever reach
            it by way of a folder-tree click made over in Browser mode. */}
        <SegmentControl
          label="Library"
          size="sm"
          value={browsingGlobal ? 'global' : 'project'}
          options={[
            { value: 'project', label: 'Project' },
            { value: 'global', label: 'Global library' },
          ]}
          onChange={(value) => setLocation(value === 'global')}
          data-testid="sample-location"
        />
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
          className="max-h-56 overflow-auto overscroll-contain rounded-bb-sm border border-bb-line"
          aria-label={browsingGlobal ? 'Global library samples' : 'Project samples'}
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
          {samplesError !== null && (
            <li role="alert" className="px-2 py-2 text-xs text-bb-danger">
              Could not read the {locationLabel}: {samplesError} Your samples have not been lost — reload the
              app rather than re-importing.
            </li>
          )}
          {samplesError === null && samples.length === 0 && (
            <EmptyState
              as="li"
              message={`No samples in the ${locationLabel} yet.`}
              hint={
                browsingGlobal
                  ? 'Install a factory kit in Browser mode, or import one here.'
                  : 'Import one with the button above, or switch to the global library.'
              }
            />
          )}
        </ul>

        <div>
          <WaveformEditor
            pyramid={pyramid}
            totalFrames={frames}
            sampleRate={sampleRate}
            interaction={chopMode === 'markers' ? 'markers' : 'select'}
            selection={selection}
            onSelectionChange={setSelection}
            markers={markers}
            onMarkersChange={setMarkers}
            minSpacingFrames={msToFrames(MIN_SLICE_MS, sampleRate)}
            ariaLabel={selected ? `Waveform of ${selected.name}` : 'No sample selected'}
          />
          {/* A waveform that would not load must not look like an empty one (spec §5.1). */}
          {selected && waveformError !== null && (
            <p role="alert" data-testid="waveform-error" className="mt-2 text-xs text-bb-danger">
              Could not read the audio for {selected.name}: {waveformError} The editing tools are unavailable
              for it — the file may be missing from storage.
            </p>
          )}
          {selected && (
            <div className="mt-2 space-y-2">
              <div className="flex flex-wrap gap-1.5">
                <Button
                  label="Audition"
                  variant="quiet"
                  size="sm"
                  disabled={busy}
                  onClick={() => void auditionSample(selected.opfs_path, selected.name)}
                />
                <Button
                  size="sm"
                  disabled={toolsBlocked}
                  label="Normalise"
                  onClick={() => edit('Normalise', (c) => normalise(c))}
                />
                <Button
                  size="sm"
                  disabled={toolsBlocked}
                  label="Reverse"
                  onClick={() => edit('Reverse', reverse)}
                />
                <Button
                  size="sm"
                  disabled={toolsBlocked}
                  label="Fade in"
                  onClick={() => edit('Fade in', (c) => fadeIn(c, msToFrames(fadeMs, selected.sample_rate)))}
                />
                <Button
                  size="sm"
                  disabled={toolsBlocked}
                  label="Fade out"
                  onClick={() =>
                    edit('Fade out', (c) => fadeOut(c, msToFrames(fadeMs, selected.sample_rate)))
                  }
                />
                <Button
                  size="sm"
                  disabled={toolsBlocked || !selection}
                  label="Trim to selection"
                  title={selection ? undefined : 'Drag a selection on the waveform first.'}
                  onClick={() => {
                    if (!selection) return;
                    // Trim replaces the file with the selection, so it is applied directly
                    // rather than through the region wrapper the other tools use.
                    if (!selected) return;
                    void run('Trim', () =>
                      applyEditToNewSample(
                        selected,
                        (c) => trim(c, selection.startFrame, selection.endFrame),
                        'Trim',
                        sampleEditContext(),
                      ),
                    );
                  }}
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
                {/* Baking a groove rewrites a specific track's timing, so the track is
                    chosen rather than assumed — picking `tracks[0]` gave no way to tell
                    where the groove had landed, let alone to direct it (issue #55). */}
                <label className="flex items-center gap-1">
                  Groove track
                  <select
                    aria-label="Track to bake the groove into"
                    value={grooveTarget?.id ?? ''}
                    disabled={grooveTracks.length === 0}
                    onChange={(e) => setGrooveTrackId(e.target.value || null)}
                    data-testid="sample-groove-track"
                    className="max-w-40 rounded-bb-sm border border-bb-line bg-bb-raised px-1 py-0.5 disabled:opacity-40"
                  >
                    {grooveTracks.length === 0 && <option value="">No tracks</option>}
                    {grooveTracks.map((track) => (
                      <option key={track.id} value={track.id}>
                        {track.name}
                      </option>
                    ))}
                  </select>
                </label>
                <Button
                  size="sm"
                  disabled={toolsBlocked || grooveTarget === undefined}
                  label="Groove → bake to track"
                  title={grooveTarget ? undefined : 'Add a track to bake the groove into.'}
                  data-testid="sample-groove"
                  onClick={() => {
                    if (!grooveTarget) return;
                    void run(`Groove bake to ${grooveTarget.name}`, () =>
                      extractAndBakeGroove(selected, grooveTarget.id, useTransportStore.getState().bpm),
                    );
                  }}
                />
              </div>

              {/* Chop — all three §8.5.4 modes; the selector drives both the parameter shown
                  here and whether the waveform drags a selection or places markers. */}
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <SegmentControl
                  label="Chop mode"
                  size="sm"
                  value={chopMode}
                  options={CHOP_MODES}
                  onChange={setChopMode}
                  data-testid="chop-mode"
                />
                {chopMode === 'transients' && (
                  <label className="flex items-center gap-1">
                    Sensitivity
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
                )}
                {chopMode === 'equal' && (
                  <label className="flex items-center gap-1">
                    Slices
                    <input
                      type="number"
                      min={1}
                      max={128}
                      step={1}
                      value={sliceCount}
                      data-testid="chop-slice-count"
                      onChange={(e) =>
                        setSliceCount(Math.max(1, Math.min(128, Math.round(Number(e.target.value)))))
                      }
                      className="w-16 rounded-bb-sm border border-bb-line bg-bb-raised px-1 py-0.5"
                    />
                  </label>
                )}
                {chopMode === 'markers' && (
                  <span className="text-bb-muted">
                    {markers.length} marker{markers.length === 1 ? '' : 's'} — click the waveform to place,
                    drag to move, alt-click to remove.
                  </span>
                )}
                <Button
                  size="sm"
                  disabled={toolsBlocked || chopBlockedReason !== null}
                  label="Chop"
                  data-testid="sample-chop"
                  title={chopBlockedReason ?? undefined}
                  onClick={() =>
                    void run('Chop', () => chopSampleToNewSamples(selected, chopSpec(), sampleEditContext()))
                  }
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
                <Button
                  size="sm"
                  disabled={toolsBlocked}
                  label="Time-stretch render"
                  data-testid="sample-stretch"
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
