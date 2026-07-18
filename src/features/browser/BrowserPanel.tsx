/**
 * Browser mode (spec §8.5, mode 7) — the library/interchange surface. It wires the folder tree
 * over the §9.1 project and global-library roots, the query-backed sample list with its text,
 * tag and favourites filters, sample import into the browsed location (§9.4), the project
 * interchange (`.mpcweb` export/import, §9.6), audition through the preview channel (§5.9),
 * and the "Purge unused samples" maintenance action (§8.5.7). Every control is wired end to
 * end (§3.4).
 */
import { useEffect, useState } from 'react';
import { getActiveRepositories, getAudioEngine, projectService } from '@/core/project';
import { bounceActiveSequence } from '@/core/audio/bounceService';
import { importAudioFile } from '@/core/audio/sampleImport';
import { deleteFile, projectSamplesRoot, readFile } from '@/core/storage/opfs';
import { useBrowserStore, useProjectStore, useUIStore } from '@/store';
import { Toggle } from '@/ui/primitives';
import { refreshSamples, sampleEditContext } from '../sample-edit/sampleContext';
import { FactorySection } from './FactorySection';
import { FolderTree } from './FolderTree';
import { isGlobalLibraryPath, scopeOfPath } from './libraryLocation';

/** Trigger a browser download of a Blob (spec §9.6 export → download). */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function BrowserPanel() {
  const samples = useBrowserStore((state) => state.samples);
  const textFilter = useBrowserStore((state) => state.textFilter);
  const tagFilter = useBrowserStore((state) => state.tagFilter);
  const favourites = useBrowserStore((state) => state.favourites);
  const currentPath = useBrowserStore((state) => state.currentPath);
  const [favouritesOnly, setFavouritesOnly] = useState(false);
  /** sampleId → its tags, loaded alongside the sample list (spec §8.5.7 tag chips). */
  const [tagsBySample, setTagsBySample] = useState<Record<string, string[]>>({});
  const projectName = useProjectStore((state) => state.projectName);
  const projectId = useProjectStore((state) => state.projectId);
  const pushToast = useUIStore((state) => state.pushToast);
  const [busy, setBusy] = useState(false);

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
    void refreshSamples();
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
    setBusy(true);
    try {
      const blob = await projectService.exportMpcweb();
      downloadBlob(blob, `${(projectName || 'project').replace(/\s+/g, '-')}.mpcweb`);
      pushToast('Project exported.', 'success');
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Export failed.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const importProject = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setBusy(true);
    void (async () => {
      try {
        await projectService.importMpcweb(file);
        await refreshSamples();
        pushToast('Project imported.', 'success');
      } catch (error) {
        pushToast(error instanceof Error ? error.message : 'Import failed.', 'error');
      } finally {
        setBusy(false);
      }
    })();
  };

  /**
   * Import an audio file into the browsed location (spec §9.4). The folder-tree selection
   * chooses the destination, so this is how a sample gets into the global library (§9.3).
   */
  const importSample = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const engine = getAudioEngine();
    if (!engine) {
      pushToast('Start the audio engine before importing.', 'warning');
      return;
    }
    setBusy(true);
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
        setBusy(false);
      }
    })();
  };

  /** Bounce the active sequence to a `/bounces/` WAV and download it (spec §9.5). */
  const bounce = async () => {
    setBusy(true);
    try {
      const path = await bounceActiveSequence('bounce', sampleEditContext());
      const file = await readFile(path);
      downloadBlob(file, `${(projectName || 'project').replace(/\s+/g, '-')}-bounce.wav`);
      pushToast('Sequence bounced.', 'success');
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Bounce failed.', 'error');
    } finally {
      setBusy(false);
    }
  };

  /**
   * Delete samples not referenced by any program payload (spec §8.5.7 purge unused).
   * Project-scoped only: "unused" is decided against this project's programs, which says
   * nothing about a global-library sample that other projects may reference.
   */
  const purgeUnused = async () => {
    setBusy(true);
    try {
      const repos = getActiveRepositories();
      const programs = await repos.programs.listByProject(projectId);
      const referenced = new Set<string>();
      for (const program of programs.rows) {
        for (const sample of samples) if (program.payload.includes(sample.id)) referenced.add(sample.id);
      }
      const unused = samples.filter((sample) => !referenced.has(sample.id));
      for (const sample of unused) {
        await deleteFile(sample.opfs_path);
        await repos.samples.remove(sample.id);
      }
      await refreshSamples();
      pushToast(`Purged ${unused.length} unused sample${unused.length === 1 ? '' : 's'}.`, 'success');
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Purge failed.', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="browser-heading" className="flex min-h-0 flex-col gap-3">
      <h2 id="browser-heading" className="sr-only">
        Browser
      </h2>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy || !projectId}
          data-testid="project-export"
          onClick={() => void exportProject()}
          className="rounded-bb-sm border border-bb-line bg-bb-raised px-3 py-1.5 text-xs disabled:opacity-50"
        >
          Export .mpcweb
        </button>
        <label className="cursor-pointer rounded-bb-sm border border-bb-line bg-bb-raised px-3 py-1.5 text-xs">
          Import .mpcweb…
          <input
            type="file"
            accept=".mpcweb,application/zip"
            className="sr-only"
            data-testid="project-import"
            onChange={importProject}
          />
        </label>
        <button
          type="button"
          disabled={busy || !projectId}
          data-testid="bounce-sequence"
          onClick={() => void bounce()}
          className="rounded-bb-sm border border-bb-line bg-bb-raised px-3 py-1.5 text-xs disabled:opacity-50"
        >
          Bounce sequence
        </button>
        <label className="cursor-pointer rounded-bb-sm border border-bb-line bg-bb-raised px-3 py-1.5 text-xs">
          Import sample…
          <input
            type="file"
            accept="audio/*"
            className="sr-only"
            data-testid="sample-import"
            onChange={importSample}
          />
        </label>
        <button
          type="button"
          disabled={busy || browsingGlobal || samples.length === 0}
          title={browsingGlobal ? 'Purge applies to the project library only.' : undefined}
          data-testid="purge-unused"
          onClick={() => void purgeUnused()}
          className="rounded-bb-sm border border-bb-line bg-bb-raised px-3 py-1.5 text-xs disabled:opacity-50"
        >
          Purge unused samples
        </button>
      </div>

      {/* Factory content (spec §8.5 item 7, §9.8) — browsed and installed from here. */}
      <FactorySection />

      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-[0.625rem] font-semibold text-bb-muted uppercase">
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
        </label>
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
          className="min-h-0 flex-1 overflow-auto rounded-bb-sm border border-bb-line"
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
              <span className="flex-1 truncate">{row.name}</span>
              {/* Drag-to-pad assignment (spec §8.5.7 `dragDropPayload`). */}
              <span
                draggable
                role="button"
                tabIndex={0}
                aria-label={`Drag ${row.name} to a pad`}
                onDragStart={() =>
                  useUIStore.getState().setDragDropPayload({ sampleId: row.id, name: row.name })
                }
                onDragEnd={() => useUIStore.getState().setDragDropPayload(null)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.preventDefault();
                  useUIStore.getState().setDragDropPayload({ sampleId: row.id, name: row.name });
                  pushToast(`${row.name} ready to assign — open Program Edit and choose a pad.`, 'info');
                }}
                className="shrink-0 cursor-grab rounded-bb-sm border border-bb-line px-2 py-0.5 text-bb-muted"
              >
                Assign
              </span>
              <button
                type="button"
                aria-label={`Audition ${row.name}`}
                onClick={() => void getAudioEngine()?.auditionSample(row.opfs_path)}
                className="shrink-0 rounded-bb-sm border border-bb-line px-2 py-0.5"
              >
                Audition
              </button>
            </li>
          ))}
          {visibleSamples.length === 0 && (
            <li className="px-2 py-2 text-xs text-bb-muted">
              {samples.length === 0 ? `No samples in the ${locationLabel}.` : 'No samples match the filter.'}
            </li>
          )}
        </ul>
      </div>
    </section>
  );
}
