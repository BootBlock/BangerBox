/**
 * Browser mode (spec §8.5, mode 7) — the Phase 6 functional library/interchange surface
 * (unpolished; the folder tree, tag chips, favourites and waveform micro-previews are Phase 7).
 * It wires the project interchange (`.mpcweb` export/import, §9.6), sample audition through the
 * preview channel (§5.9), and the "Purge unused samples" maintenance action (§8.5.7). Every
 * control is wired end to end (§3.4).
 */
import { useEffect, useState } from 'react';
import { getActiveRepositories, getAudioEngine, projectService } from '@/core/project';
import { deleteFile } from '@/core/storage/opfs';
import { useBrowserStore, useProjectStore, useUIStore } from '@/store';
import { refreshSamples } from '../sample-edit/sampleContext';

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
  const projectName = useProjectStore((state) => state.projectName);
  const projectId = useProjectStore((state) => state.projectId);
  const pushToast = useUIStore((state) => state.pushToast);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void refreshSamples();
  }, [projectId]);

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

  /** Delete samples not referenced by any program payload (spec §8.5.7 purge unused). */
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
    <section aria-labelledby="browser-heading" className="mt-6">
      <h2 id="browser-heading" className="text-lg font-bold">
        Browser
      </h2>
      <p className="mt-1 text-xs leading-relaxed text-bb-muted">
        Library and interchange: export or import a project as a portable <code>.mpcweb</code> archive, audition
        samples, and purge unused ones.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
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
          disabled={busy || samples.length === 0}
          data-testid="purge-unused"
          onClick={() => void purgeUnused()}
          className="rounded-bb-sm border border-bb-line bg-bb-raised px-3 py-1.5 text-xs disabled:opacity-50"
        >
          Purge unused samples
        </button>
      </div>

      <ul className="mt-3 max-h-40 overflow-auto rounded-bb-sm border border-bb-line" aria-label="Library samples">
        {samples.map((row) => (
          <li key={row.id} className="flex items-center justify-between px-2 py-1 text-xs">
            <span className="truncate">{row.name}</span>
            <button
              type="button"
              onClick={() => void getAudioEngine()?.auditionSample(row.opfs_path)}
              className="ml-2 shrink-0 rounded-bb-sm border border-bb-line px-2 py-0.5"
            >
              Audition
            </button>
          </li>
        ))}
        {samples.length === 0 && <li className="px-2 py-2 text-xs text-bb-muted">No samples in this project.</li>}
      </ul>
    </section>
  );
}
