/**
 * Browser mode (spec §8.5, mode 7) — the library/interchange surface. It wires the folder tree
 * over the §9.1 project and global-library roots, the query-backed sample list with its text,
 * tag and favourites filters, sample import into the browsed location (§9.4), the project
 * interchange (`.mpcweb` export/import, §9.6), audition through the preview channel (§5.9),
 * the "Purge unused samples" maintenance action (§8.5.7), and sample assignment — a pointer
 * drag arming `dragDropPayload` for the Program Edit drop targets, or a tap opening the target
 * chooser. Every control is wired end to end (§3.4).
 */
import { useEffect, useState } from 'react';
import { getActiveRepositories, getAudioEngine, projectService } from '@/core/project';
import { bounceActiveSequence, resampleSequenceToSample } from '@/core/audio/bounceService';
import { importAudioFile } from '@/core/audio/sampleImport';
import { downloadBlob, downloadFileStem } from '@/core/platform/download';
import { deleteFile, projectSamplesRoot, readFile } from '@/core/storage/opfs';
import type { SampleRow } from '@/core/storage/repositories';
import { BROWSER_INITIAL_PATH, useBrowserStore, useProjectStore, useUIStore } from '@/store';
import { IconPlay } from '@/ui/icons';
import { Button, FieldLabel, FilePickerButton, Modal, Toggle, useAnnounce } from '@/ui/primitives';
import {
  auditionSample,
  refreshSamples,
  reloadSampleList,
  sampleEditContext,
} from '../sample-edit/sampleContext';
import { AssignTargetDialog } from '../program-edit/AssignTargetDialog';
import { FactorySection } from './FactorySection';
import { FolderTree } from './FolderTree';
import { SampleWaveformThumb } from './SampleWaveformThumb';
import { findUnusedSamples } from './purge';
import { isGlobalLibraryPath, scopeOfPath } from './libraryLocation';

export function BrowserPanel() {
  const samples = useBrowserStore((state) => state.samples);
  const textFilter = useBrowserStore((state) => state.textFilter);
  const tagFilter = useBrowserStore((state) => state.tagFilter);
  const favourites = useBrowserStore((state) => state.favourites);
  const currentPath = useBrowserStore((state) => state.currentPath);
  const samplesError = useBrowserStore((state) => state.samplesError);
  // Reported through the single §8.2 announcer rather than through a `role="alert"` of
  // its own, which is a live region competing with it (issue #34).
  useAnnounce(samplesError, 'assertive');
  const [favouritesOnly, setFavouritesOnly] = useState(false);
  /** sampleId → its tags, loaded alongside the sample list (spec §8.5.7 tag chips). */
  const [tagsBySample, setTagsBySample] = useState<Record<string, string[]>>({});
  const projectName = useProjectStore((state) => state.projectName);
  const projectId = useProjectStore((state) => state.projectId);
  const pushToast = useUIStore((state) => state.pushToast);
  /**
   * Which long operation is running, or null (spec §8.5.7, issue #54).
   *
   * A single boolean gated every control correctly and labelled them all wrongly: bouncing
   * relabelled the import pickers "Importing…" and marked them `aria-disabled`, which is the
   * opposite of the missing-progress problem #54 is about. The name is what each control
   * shows; `busy` below is what every control is gated on.
   */
  const [running, setRunning] = useState<
    null | 'project-export' | 'project-import' | 'sample-import' | 'bounce' | 'resample' | 'purge'
  >(null);
  const busy = running !== null;
  /**
   * The samples the purge would delete, held between the review pass and the confirmation
   * (spec §8.5.7). `null` means no purge is being confirmed; a non-empty array opens the
   * dialog. Holding the rows — not just a count — is what lets the dialog name them.
   */
  const [purgeCandidates, setPurgeCandidates] = useState<SampleRow[] | null>(null);
  /** The sample whose assignment target is being chosen, or null (spec §8.5.7). */
  const [assigning, setAssigning] = useState<SampleRow | null>(null);

  const browsingGlobal = isGlobalLibraryPath(currentPath);
  const locationLabel = browsingGlobal ? 'global library' : 'project';

  // Point the tree at the active project's samples whenever a project opens or changes, unless
  // the global library — which outlives any one project — is the node being browsed.
  useEffect(() => {
    if (!projectId) return;
    const { currentPath: path, setCurrentPath } = useBrowserStore.getState();
    if (!isGlobalLibraryPath(path)) setCurrentPath(projectSamplesRoot(projectId));
  }, [projectId]);

  // The list follows the selected node (spec §8.5.7); `refreshSamples` reads the path itself.
  useEffect(() => {
    // On first render the store still holds its placeholder path and the effect above is about
    // to point it at the project — querying now would only repeat itself a tick later.
    if (projectId && currentPath === BROWSER_INITIAL_PATH) return;
    void reloadSampleList();
  }, [currentPath, projectId]);

  // Load each sample's tags so the chips reflect the library rather than a fixed list
  // (spec §8.5.7). Runs when the sample set changes, not per render.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // No samples means nothing to tag — and, importantly, no reason to reach for the
      // repositories, which would spin up the DB worker in environments that have none.
      // The clear runs inside the async body so no setState happens synchronously in the
      // effect, which would trigger a cascading render.
      if (samples.length === 0) {
        if (!cancelled) setTagsBySample({});
        return;
      }
      try {
        const repos = getActiveRepositories();
        const entries = await Promise.all(
          samples.map(async (row) => [row.id, await repos.samples.tagsFor(row.id)] as const),
        );
        if (!cancelled) setTagsBySample(Object.fromEntries(entries));
      } catch {
        // Tags are a filter affordance, not data — the list still works without them.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [samples]);

  /** Tags present in the loaded library, sorted for a stable chip order. */
  const availableTags = [...new Set(Object.values(tagsBySample).flat())].sort();

  /** The sample list after the text, tag, and favourites filters (spec §8.5.7). */
  const visibleSamples = samples.filter((row) => {
    if (favouritesOnly && !favourites.includes(row.id)) return false;
    if (textFilter && !row.name.toLowerCase().includes(textFilter.toLowerCase())) return false;
    if (tagFilter.length > 0) {
      const tags = tagsBySample[row.id] ?? [];
      // A sample must carry every selected tag — chips narrow, they do not widen.
      if (!tagFilter.every((tag) => tags.includes(tag))) return false;
    }
    return true;
  });

  const exportProject = async () => {
    setRunning('project-export');
    try {
      const blob = await projectService.exportMpcweb();
      downloadBlob(blob, `${downloadFileStem(projectName)}.mpcweb`);
      pushToast('Project exported.', 'success');
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Export failed.', 'error');
    } finally {
      setRunning(null);
    }
  };

  const importProject = (file: File) => {
    setRunning('project-import');
    void (async () => {
      try {
        await projectService.importMpcweb(file);
        await refreshSamples();
        pushToast('Project imported.', 'success');
      } catch (error) {
        pushToast(error instanceof Error ? error.message : 'Import failed.', 'error');
      } finally {
        setRunning(null);
      }
    })();
  };

  /**
   * Import an audio file into the browsed location (spec §9.4). The folder-tree selection
   * chooses the destination, so this is how a sample gets into the global library (§9.3).
   */
  const importSample = (file: File) => {
    const engine = getAudioEngine();
    if (!engine) {
      pushToast('Start the audio engine before importing.', 'warning');
      return;
    }
    setRunning('sample-import');
    void (async () => {
      try {
        await importAudioFile(file, {
          ...sampleEditContext(),
          context: engine.context,
          scope: scopeOfPath(currentPath),
        });
        await refreshSamples();
        pushToast(`Imported into the ${locationLabel}.`, 'success');
      } catch (error) {
        pushToast(error instanceof Error ? error.message : 'Import failed.', 'error');
      } finally {
        setRunning(null);
      }
    })();
  };

  /** Bounce the active sequence to a `/bounces/` WAV and download it (spec §9.5). */
  const bounce = async () => {
    setRunning('bounce');
    try {
      const path = await bounceActiveSequence('bounce', sampleEditContext());
      const file = await readFile(path);
      downloadBlob(file, `${downloadFileStem(projectName)}-bounce.wav`);
      pushToast('Sequence bounced.', 'success');
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Bounce failed.', 'error');
    } finally {
      setRunning(null);
    }
  };

  /**
   * Resample the active sequence into a new sample and offer it to a pad (spec §9.5
   * "resample-to-pad", issue #104).
   *
   * The other three §9.5 paths write a file the user downloads; this one lands in the
   * library instead, which is the surface this very mode lists — so the result is reachable
   * the moment it exists. The assignment dialog opens on it straight away because §9.5 names
   * the feature resample-to-**pad**: stopping at a library row would leave a user who wanted
   * a sequence on one pad to go and find it themselves.
   */
  const resample = async () => {
    setRunning('resample');
    try {
      // `sampleEditContext()` carries no scope, so the write lands under the project's own
      // `/samples/` root (spec §9.1) whichever node the folder tree has selected. That is
      // deliberate: this audio is a render of THIS project's sequence and means nothing in
      // another, so it must not go into the shared library the way §9.8 factory audio does.
      const row = await resampleSequenceToSample(
        `${downloadFileStem(projectName)}-resample`,
        sampleEditContext(),
      );
      await refreshSamples();
      setAssigning(row);
      pushToast(`Resampled to “${row.name}”. Choose where it lands.`, 'success');
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Resample failed.', 'error');
    } finally {
      setRunning(null);
    }
  };

  /**
   * Work out what "Purge unused samples" would delete, and show it for confirmation
   * (spec §8.5.7, §8.1 double confirmation for a destructive action).
   *
   * The reference set depends on WHERE the sample lives (spec §9.1). A project-scoped sample is
   * judged against its own project's programs. A global-library sample is shared — factory
   * content de-duplicates into it (§9.8), so a kit's audio may be the very sample another
   * project's demo plays — and is judged against EVERY program in the database. Asking the
   * narrower question about a shared sample would delete audio still in use elsewhere.
   *
   * This half only reads. Deletion happens in `confirmPurge`, against the very list the
   * dialog showed — recomputing it there would delete something the user never saw.
   */
  const reviewPurge = async () => {
    setRunning('purge');
    try {
      const unused = await findUnusedSamples(
        samples,
        getActiveRepositories(),
        browsingGlobal ? 'global' : 'project',
        projectId,
      );
      // Nothing to confirm, so asking would be pure ceremony.
      if (unused.length === 0) {
        pushToast(`No unused samples in the ${locationLabel}.`, 'info');
        return;
      }
      setPurgeCandidates(unused);
    } catch (error) {
      // A reference set that could not be read must delete nothing: an empty answer is
      // indistinguishable from "every sample is unused" (spec §5.1).
      pushToast(error instanceof Error ? error.message : 'Could not work out what is unused.', 'error');
    } finally {
      setRunning(null);
    }
  };

  /** Delete the reviewed samples — irreversible, and outside the undo stack (spec §8.5.7). */
  const confirmPurge = async () => {
    if (!purgeCandidates) return;
    setRunning('purge');
    try {
      const repos = getActiveRepositories();
      let deleted = 0;
      const failed: string[] = [];
      for (const sample of purgeCandidates) {
        try {
          await deleteFile(sample.opfs_path);
          await repos.samples.remove(sample.id);
          deleted += 1;
        } catch {
          // One unreadable file must not strand the rest of the purge half-done, with the
          // audio gone but its rows still listed.
          failed.push(sample.name);
        }
      }
      setPurgeCandidates(null);
      await refreshSamples();
      if (failed.length > 0) {
        pushToast(`Purged ${deleted}; could not delete ${failed.join(', ')}.`, 'warning');
      } else {
        pushToast(`Purged ${deleted} unused sample${deleted === 1 ? '' : 's'}.`, 'success');
      }
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Purge failed.', 'error');
    } finally {
      setRunning(null);
    }
  };

  return (
    // No heading of its own: the mode's name comes from the shell's `h2` (§8.2), and a
    // second sr-only "Browser" would just read the mode out twice.
    <div className="flex min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          label={running === 'project-export' ? 'Exporting…' : 'Export .mpcweb'}
          disabled={busy || !projectId}
          data-testid="project-export"
          onClick={() => void exportProject()}
        />
        <FilePickerButton
          label="Import .mpcweb…"
          busyLabel="Importing…"
          accept=".mpcweb,application/zip"
          // `busy` is what this control is doing; `disabled` is every other reason it cannot
          // start. Only the first changes the label, so a bounce no longer claims to be an
          // import (issue #54).
          busy={running === 'project-import'}
          disabled={busy}
          data-testid="project-import"
          onPick={importProject}
        />
        <Button
          label={running === 'bounce' ? 'Bouncing…' : 'Bounce sequence'}
          disabled={busy || !projectId}
          data-testid="bounce-sequence"
          onClick={() => void bounce()}
        />
        {/* spec §9.5 resample-to-pad — the fourth bounce path, and the only one whose result
            is a sample rather than a downloaded file (issue #104). */}
        <Button
          label={running === 'resample' ? 'Resampling…' : 'Resample to pad…'}
          disabled={busy || !projectId}
          title="Render the active sequence to a new sample and choose the pad it lands on"
          data-testid="resample-to-pad"
          onClick={() => void resample()}
        />
        <FilePickerButton
          label="Import sample…"
          busyLabel="Importing…"
          accept="audio/*"
          busy={running === 'sample-import'}
          disabled={busy}
          data-testid="sample-import"
          onPick={importSample}
        />
        <Button
          // The trailing ellipsis promises the review step, matching Safe Mode's
          // "Hard reset…" (spec §8.1) — this button no longer deletes on its own.
          label={running === 'purge' ? 'Purging…' : 'Purge unused samples…'}
          variant="danger"
          // Purging judges what is unused from the loaded list, so a failed query would have
          // it delete against a stale or empty picture of the library. Without an open project
          // there are no programs to judge against, which would mark everything unused.
          disabled={busy || samples.length === 0 || samplesError !== null || (!browsingGlobal && !projectId)}
          title={
            samplesError !== null
              ? 'Unavailable while the sample list cannot be read.'
              : browsingGlobal
                ? 'Deletes global samples no project uses.'
                : 'Deletes samples this project does not use.'
          }
          data-testid="purge-unused"
          onClick={() => void reviewPurge()}
        />
      </div>

      {/* Factory content (spec §8.5 item 7, §9.8) — browsed and installed from here. */}
      <FactorySection />

      <div className="flex flex-wrap items-center gap-2">
        <FieldLabel>
          Filter
          <input
            type="search"
            value={textFilter}
            placeholder="Search samples…"
            aria-label="Filter samples by name"
            data-testid="browser-filter"
            onChange={(event) => useBrowserStore.getState().setTextFilter(event.target.value)}
            className="rounded-bb-sm border border-bb-line bg-bb-raised px-2 py-1 text-xs font-normal text-bb-text normal-case"
          />
        </FieldLabel>
        <Toggle
          label="Favourites only"
          pressed={favouritesOnly}
          size="sm"
          onChange={setFavouritesOnly}
          data-testid="browser-favourites-only"
        />
      </div>

      {/* Tag chips (spec §8.5.7) — derived from the loaded samples' own tags. */}
      {availableTags.length > 0 && (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by tag">
          {availableTags.map((tag) => (
            <Toggle
              key={tag}
              label={tag}
              pressed={tagFilter.includes(tag)}
              size="sm"
              onChange={(pressed) =>
                useBrowserStore
                  .getState()
                  .setTagFilter(
                    pressed ? [...tagFilter, tag] : tagFilter.filter((existing) => existing !== tag),
                  )
              }
              data-testid={`browser-tag-${tag}`}
            />
          ))}
        </div>
      )}

      {/* Folder tree (spec §8.5.7) beside the contents of the node it has selected. */}
      <div className="flex min-h-0 flex-1 gap-3">
        <FolderTree />
        <ul
          className="min-h-0 flex-1 overflow-auto overscroll-contain rounded-bb-sm border border-bb-line"
          aria-label={browsingGlobal ? 'Global library samples' : 'Project samples'}
        >
          {visibleSamples.map((row) => (
            <li
              key={row.id}
              className="flex items-center justify-between gap-2 border-b border-bb-line px-2 py-1.5 text-xs last:border-b-0"
            >
              <button
                type="button"
                aria-pressed={favourites.includes(row.id)}
                aria-label={`${favourites.includes(row.id) ? 'Remove' : 'Add'} ${row.name} ${
                  favourites.includes(row.id) ? 'from' : 'to'
                } favourites`}
                onClick={() => useBrowserStore.getState().toggleFavourite(row.id)}
                className={`shrink-0 rounded-bb-sm px-1 ${
                  favourites.includes(row.id) ? 'text-bb-accent' : 'text-bb-muted hover:text-bb-text'
                }`}
              >
                ★
              </button>
              {/* Waveform micro-preview (spec §8.5.7), drawn from the cached §8.5.4 pyramid. */}
              <SampleWaveformThumb opfsPath={row.opfs_path} />
              <span className="flex-1 truncate">{row.name}</span>
              {/*
                Assignment (spec §8.5.7). Two routes on one control: a pointer drag arms
                `dragDropPayload` for the Program Edit drop targets, and a tap or Enter opens
                the target chooser. The tap route is the one that completes the loop — Browser
                and Program Edit are separate §8.5 modes, so a pointer never sees a sample row
                and a pad at the same time, and this used to be a keyboard path that only
                raised a toast telling the user to do something the UI could not do (#37).

                A plain button rather than the `Button` primitive: that chassis is a
                `motion.button`, whose gesture `onDragStart`/`onDragEnd` types collide with the
                DOM drag events this needs. The classes are the primitive's quiet variant.
              */}
              <button
                type="button"
                draggable
                aria-label={`Assign ${row.name} to a pad or zone`}
                title={`Assign ${row.name}`}
                data-testid={`browser-assign-${row.id}`}
                onDragStart={(event) => {
                  // Some engines abort a drag that carries no data before any dragover fires,
                  // so the payload is advertised here as well as put in the store.
                  event.dataTransfer.setData('text/plain', row.name);
                  event.dataTransfer.effectAllowed = 'copy';
                  useUIStore
                    .getState()
                    .setDragDropPayload({ sampleId: row.id, name: row.name, rootNote: row.root_note });
                }}
                onDragEnd={() => useUIStore.getState().setDragDropPayload(null)}
                onClick={() => setAssigning(row)}
                className="shrink-0 cursor-grab rounded-bb-sm border border-bb-line px-2 py-0.5 text-bb-muted transition-colors duration-150 hover:text-bb-text"
              >
                Assign…
              </button>
              {/* Audition through the preview channel (spec §5.9). The play glyph carries the
                  affordance: "Audition" alone did not read as "hear this", and the row was
                  reported as having no way to play a sample at all (issue #109). */}
              <Button
                label="Audition"
                accessibleName={`Audition ${row.name}`}
                icon={<IconPlay size={12} aria-hidden="true" />}
                title={`Play ${row.name}`}
                variant="quiet"
                size="sm"
                onClick={() => void auditionSample(row.opfs_path, row.name)}
              />
            </li>
          ))}
          {/* A failed query must never render as an empty library: telling the user their
              samples are gone invites them to re-import — or to purge (spec §5.1). */}
          {samplesError !== null && (
            <li className="px-2 py-2 text-xs text-bb-danger">
              Could not read the {locationLabel}: {samplesError} Your samples have not been lost — do not
              re-import or purge. Reload the app, and export a backup once the list returns.
            </li>
          )}
          {samplesError === null && visibleSamples.length === 0 && (
            <li className="px-2 py-2 text-xs text-bb-muted">
              {samples.length === 0 ? `No samples in the ${locationLabel}.` : 'No samples match the filter.'}
            </li>
          )}
        </ul>
      </div>

      {/* Where a sample the user tapped Assign on actually lands (spec §8.5.7). */}
      <AssignTargetDialog sample={assigning} onClose={() => setAssigning(null)} />

      {/* Purge confirmation (spec §8.5.7, §8.1). The list is the point: this deletes audio
          permanently and outside the undo stack, so the user gets to read the names first. */}
      <Modal
        open={purgeCandidates !== null}
        title={`Delete ${purgeCandidates?.length ?? 0} unused sample${purgeCandidates?.length === 1 ? '' : 's'}?`}
        onClose={() => setPurgeCandidates(null)}
        data-testid="purge-confirm-dialog"
        footer={
          <>
            <Button label="Cancel" variant="quiet" disabled={busy} onClick={() => setPurgeCandidates(null)} />
            <Button
              label={`Delete ${purgeCandidates?.length ?? 0} permanently`}
              variant="danger"
              disabled={busy}
              data-testid="purge-confirm"
              onClick={() => void confirmPurge()}
            />
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-xs leading-relaxed text-bb-muted">
            {browsingGlobal
              ? 'No project in this database references these global-library samples.'
              : 'No program in this project references these samples.'}{' '}
            Deleting them erases the audio from this device. This cannot be undone, and Undo will not bring it
            back — export a .mpcweb backup first if you are unsure.
          </p>
          <ul
            aria-label="Samples to be deleted"
            className="max-h-64 overflow-auto overscroll-contain rounded-bb-sm border border-bb-line"
          >
            {purgeCandidates?.map((row) => (
              <li
                key={row.id}
                className="flex items-center gap-2 border-b border-bb-line px-2 py-1.5 text-xs last:border-b-0"
              >
                <span className="flex-1 truncate">{row.name}</span>
                {/* Auditioning from the dialog is the cheapest way to answer "wait, what is
                    that one?" without cancelling out of the confirmation. */}
                <Button
                  label="Audition"
                  accessibleName={`Audition ${row.name}`}
                  icon={<IconPlay size={12} aria-hidden="true" />}
                  title={`Play ${row.name}`}
                  variant="quiet"
                  size="sm"
                  onClick={() => void auditionSample(row.opfs_path, row.name)}
                />
              </li>
            ))}
          </ul>
        </div>
      </Modal>
    </div>
  );
}
