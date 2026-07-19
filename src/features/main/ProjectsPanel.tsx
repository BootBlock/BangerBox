/**
 * Main-mode project panel (issue #40, spec §8.5.1): the open project's name and format
 * settings, a New Project action, and the recent-projects list §8.5.1 requires.
 *
 * Before this, `newProject` and `loadProject` were reachable only from the boot path's
 * `loadOrCreateActiveProject`, so a user could never start a second project or return to
 * an earlier one — the first project they were given was the only one they would ever have.
 *
 * Switching project flushes the outgoing project's autosave before hydrating the incoming
 * one (`projectService.loadProject`), so no confirmation is needed for unsaved work; the
 * buttons are disabled while the switch is in flight because a second switch part-way
 * through the first would interleave two hydrations over the same stores.
 */
import { useState } from 'react';
import { useProjectStore, useUIStore } from '@/store';
import { SAMPLE_RATES, type SampleRate } from '@/store/useProjectStore';
import type { BitDepth } from '@/core/project/schemas';
import { Button, EmptyState, FieldLabel, Modal, TextField } from '@/ui/primitives';
import { Panel } from '@/ui/shell/Panel';
import { IconAdd } from '@/ui/icons';
import { useRecentProjects } from './useRecentProjects';

const SELECT =
  'rounded-bb-sm border border-bb-line bg-bb-raised px-2 py-1 text-xs font-normal text-bb-text normal-case';

/** Project bit-depth options (spec §1.3 #18); `32f` is 32-bit float. */
const BIT_DEPTHS: readonly { value: BitDepth; label: string }[] = [
  { value: '16', label: '16-bit' },
  { value: '24', label: '24-bit' },
  { value: '32f', label: '32-bit float' },
];

/** Row timestamps are stored as epoch milliseconds (spec §9.3); en-GB, no date library. */
const WHEN = new Intl.DateTimeFormat('en-GB', { dateStyle: 'short', timeStyle: 'short' });

export function ProjectsPanel() {
  const projectId = useProjectStore((s) => s.projectId);
  const projectName = useProjectStore((s) => s.projectName);
  const sampleRate = useProjectStore((s) => s.sampleRate);
  const bitDepth = useProjectStore((s) => s.bitDepth);
  const { rows, loading, refresh } = useRecentProjects();

  const [busy, setBusy] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState('');

  const pushToast = useUIStore((s) => s.pushToast);

  /** Run a project switch, reporting failure rather than leaving the button stuck. */
  const runSwitch = (what: string, action: () => Promise<unknown>) => {
    setBusy(true);
    void action()
      .then(() => {
        refresh();
        pushToast(`${what}.`, 'success');
      })
      .catch((error: unknown) =>
        pushToast(`${what} failed: ${error instanceof Error ? error.message : 'unknown error'}`, 'error'),
      )
      .finally(() => setBusy(false));
  };

  const confirmNew = () => {
    const name = newName.trim();
    setNewOpen(false);
    setNewName('');
    runSwitch('New project created', () =>
      useProjectStore.getState().newProject(name === '' ? undefined : name),
    );
  };

  return (
    <>
      <Panel
        title="Project"
        actions={
          <Button
            label="New project"
            icon={<IconAdd size={14} aria-hidden="true" />}
            disabled={busy}
            onClick={() => setNewOpen(true)}
            data-testid="main-new-project"
          />
        }
      >
        <div className="flex flex-col gap-3">
          <TextField
            label="Project name"
            value={projectName}
            onChange={(value) => useProjectStore.getState().setProjectName(value)}
            // Empty until the boot path opens a project; typing before then names nothing
            // and is overwritten the moment hydration lands.
            disabled={projectId === '' || busy}
            showLabel
            block
            data-testid="main-project-name"
          />

          {/* Format is a project-level setting (spec §1.3 #18); it lives with the project
              rather than in a global preferences screen the app does not have. */}
          <div className="flex flex-wrap gap-3">
            <FieldLabel>
              Sample rate
              <select
                aria-label="Sample rate"
                value={sampleRate}
                onChange={(event) =>
                  useProjectStore.getState().setSampleRate(Number(event.target.value) as SampleRate)
                }
                className={SELECT}
                data-testid="main-sample-rate"
              >
                {SAMPLE_RATES.map((rate) => (
                  <option key={rate} value={rate}>
                    {new Intl.NumberFormat('en-GB').format(rate)} Hz
                  </option>
                ))}
              </select>
            </FieldLabel>
            <FieldLabel>
              Bit depth
              <select
                aria-label="Bit depth"
                value={bitDepth}
                onChange={(event) => useProjectStore.getState().setBitDepth(event.target.value as BitDepth)}
                className={SELECT}
                data-testid="main-bit-depth"
              >
                {BIT_DEPTHS.map((depth) => (
                  <option key={depth.value} value={depth.value}>
                    {depth.label}
                  </option>
                ))}
              </select>
            </FieldLabel>
          </div>
        </div>
      </Panel>

      <Panel title="Recent projects" scroll>
        {loading ? (
          <EmptyState message="Loading…" />
        ) : rows.length === 0 ? (
          <EmptyState message="No projects stored yet." hint="Create one above." />
        ) : (
          <ul className="flex flex-col gap-1">
            {rows.map((row) => {
              const isOpen = row.id === projectId;
              return (
                <li
                  key={row.id}
                  className="flex items-center gap-2 rounded-bb-sm border border-bb-line bg-bb-raised px-2 py-1.5"
                  data-testid={`main-recent-${row.id}`}
                >
                  <span className="min-w-0 flex-1 truncate text-xs text-bb-text">
                    {/* The open project's name comes from the store: a rename is not in
                        storage until autosave flushes, and the row would show the old one. */}
                    {isOpen ? projectName : row.name}
                  </span>
                  <span className="shrink-0 font-mono text-bb-micro tabular-nums text-bb-muted">
                    {WHEN.format(new Date(row.modified_at))}
                  </span>
                  {isOpen ? (
                    <span className="shrink-0 text-bb-micro font-semibold tracking-wide text-bb-accent uppercase">
                      Open
                    </span>
                  ) : (
                    <Button
                      label="Open"
                      accessibleName={`Open ${row.name}`}
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        runSwitch(`Opened ${row.name}`, () => useProjectStore.getState().loadProject(row.id))
                      }
                      data-testid={`main-open-${row.id}`}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      <Modal
        open={newOpen}
        title="New project"
        onClose={() => setNewOpen(false)}
        size="sm"
        data-testid="main-new-project-dialog"
        footer={
          <>
            <Button label="Cancel" variant="quiet" onClick={() => setNewOpen(false)} />
            <Button
              label="Create"
              variant="accent"
              onClick={confirmNew}
              data-testid="main-new-project-confirm"
            />
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <TextField
            label="Project name"
            value={newName}
            onChange={setNewName}
            onSubmit={confirmNew}
            placeholder="New Project"
            showLabel
            focusOnMount
            block
            data-testid="main-new-project-name"
          />
          <p className="text-xs text-bb-muted">
            The current project is saved before the new one opens. It stays in the recent list.
          </p>
        </div>
      </Modal>
    </>
  );
}
