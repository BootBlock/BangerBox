/**
 * SamplePicker (spec §8.5.5, §8.5.7) — pick a sample for a pad layer or a keygroup zone.
 *
 * This is the tap-and-keyboard assignment route §8.5.7's pointer drag cannot be. A drag from
 * the Browser to a pad can never complete on this shell anyway: Browser and Program Edit are
 * two of the twelve §8.5 modes and only one is on screen at a time, so there is no moment at
 * which a sample row and a pad are both visible to a pointer. The drop targets in `PadEditor`
 * and `KeygroupEditor` still exist for a drag that starts and ends inside one mode; this
 * dialog is what actually completes the loop, and it is operable with a keyboard alone.
 *
 * It lists BOTH §9.1 roots rather than following `useBrowserStore.currentPath`. A pad plays
 * whichever root holds its sample, factory kit audio installs globally (§9.8), and a picker
 * that showed one root would hide half the library behind a folder click made in a different
 * mode.
 */
import { useEffect, useMemo, useState } from 'react';
import { getActiveRepositories } from '@/core/project';
import type { SampleRow } from '@/core/storage/repositories';
import { useProjectStore } from '@/store';
import { IconPlay } from '@/ui/icons';
import { Button, EmptyState, Modal, TextField, useAnnounce } from '@/ui/primitives';
import { auditionSample } from '../sample-edit/sampleContext';

export interface SamplePickerProps {
  open: boolean;
  /** Names the target being filled — "Add a layer to pad 3". */
  title: string;
  onClose: () => void;
  /** The chosen sample. The dialog stays open, so a refusal can be read and retried. */
  onChoose: (sample: SampleRow) => void;
  'data-testid'?: string;
}

/** A sample row tagged with the §9.1 root it came from, so the list can say which. */
interface ScopedSample {
  readonly row: SampleRow;
  readonly scope: 'project' | 'global';
}

export function SamplePicker({ open, title, onClose, onChoose, 'data-testid': testId }: SamplePickerProps) {
  const projectId = useProjectStore((state) => state.projectId);
  const [samples, setSamples] = useState<ScopedSample[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Reported through the single §8.2 announcer rather than through a `role="alert"` of
  // its own, which is a live region competing with it (issue #34).
  useAnnounce(error, 'assertive');
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('');

  // Both roots, queried when the dialog opens rather than on every render. The inline async
  // IIFE with a cancelled flag is the established shape here — `react-hooks/set-state-in-effect`
  // fires on any effect-reachable setState, so extracting this into a callback does not help.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      // Inside the async body, not the effect body: `react-hooks/set-state-in-effect` fires
      // on any setState an effect reaches synchronously, and extracting it into a callback
      // does not satisfy it. The established shape here is this IIFE plus a cancelled flag.
      setLoading(true);
      try {
        const repos = getActiveRepositories();
        const [project, global] = await Promise.all([
          projectId ? repos.samples.listByProject(projectId) : Promise.resolve({ rows: [] }),
          repos.samples.listGlobal(),
        ]);
        if (cancelled) return;
        setSamples([
          ...project.rows.map((row) => ({ row, scope: 'project' as const })),
          ...global.rows.map((row) => ({ row, scope: 'global' as const })),
        ]);
        setError(null);
      } catch (caught) {
        // An empty list and a failed query look identical on screen, and reporting the second
        // as the first tells the user their library is gone (spec §5.1).
        if (cancelled) return;
        setSamples([]);
        setError(
          caught instanceof Error && caught.message ? caught.message : 'The library could not be read.',
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, projectId]);

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (needle === '') return samples;
    return samples.filter((entry) => entry.row.name.toLowerCase().includes(needle));
  }, [samples, filter]);

  return (
    <Modal open={open} title={title} onClose={onClose} size="md" data-testid={testId}>
      <div className="flex flex-col gap-3">
        <TextField
          label="Filter samples by name"
          value={filter}
          placeholder="Search samples…"
          onChange={setFilter}
          data-testid="sample-picker-filter"
        />
        <ul
          aria-label="Samples available to assign"
          className="max-h-72 overflow-auto overscroll-contain rounded-bb-sm border border-bb-line"
        >
          {visible.map(({ row, scope }) => (
            <li
              key={row.id}
              className="flex items-center gap-2 border-b border-bb-line px-2 py-1.5 text-xs last:border-b-0"
            >
              <span className="flex-1 truncate">{row.name}</span>
              <span className="shrink-0 text-bb-micro uppercase text-bb-muted">
                {scope === 'global' ? 'library' : 'project'}
              </span>
              <Button
                label="Audition"
                accessibleName={`Audition ${row.name}`}
                icon={<IconPlay size={12} aria-hidden="true" />}
                title={`Play ${row.name}`}
                variant="quiet"
                size="sm"
                onClick={() => void auditionSample(row.opfs_path, row.name)}
              />
              <Button
                label="Assign"
                accessibleName={`Assign ${row.name}`}
                variant="accent"
                size="sm"
                data-testid={`sample-picker-assign-${row.id}`}
                onClick={() => onChoose(row)}
              />
            </li>
          ))}
          {error !== null && (
            <li className="px-2 py-2 text-xs text-bb-danger">
              Could not read the sample library: {error} Your samples have not been lost — reload the app
              rather than re-importing.
            </li>
          )}
          {error === null && !loading && visible.length === 0 && (
            <EmptyState
              as="li"
              message={samples.length === 0 ? 'No samples to assign yet.' : 'No samples match the filter.'}
              hint={
                samples.length === 0
                  ? 'Import one in Browser mode, or install a factory kit there.'
                  : undefined
              }
              data-testid="sample-picker-empty"
            />
          )}
          {loading && <li className="px-2 py-2 text-xs text-bb-muted">Reading the library…</li>}
        </ul>
      </div>
    </Modal>
  );
}
