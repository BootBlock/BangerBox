/**
 * Main-mode sequence list with CRUD (issue #40, spec §8.5.1, §8.5.12).
 *
 * Replaces the read-only list Main used to show. Song mode defines an arrangement as an
 * ordered playlist *of sequences* (§8.5.12), which needs more than the one sequence
 * `newProject` seeds; this is where the others come from.
 *
 * Selecting a row sets the active sequence — the same click the old list performed — so
 * the row stays a single control and the row's own actions sit beside it rather than
 * nesting inside it, which would put a button inside a button.
 */
import { useState } from 'react';
import { useProjectStore, useSequenceStore, useTransportStore } from '@/store';
import { Button, TextField } from '@/ui/primitives';
import { Panel } from '@/ui/shell/Panel';
import { IconAdd, IconRemove } from '@/ui/icons';
import {
  createSequence,
  deleteSequence,
  duplicateSequence,
  orderedSequences,
  renameSequence,
} from './projectCrud';

export function SequencesPanel() {
  const sequences = useSequenceStore((s) => s.sequences);
  const activeSequenceId = useTransportStore((s) => s.activeSequenceId);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');

  // Main renders before the boot path finishes opening a project, so the panel is on
  // screen with nothing to edit for a moment. Adding then would build a sequence with no
  // project to belong to, and hydration would discard it the instant it arrived.
  const projectOpen = useProjectStore((s) => s.projectId) !== '';

  const list = orderedSequences(sequences);
  // The last sequence cannot be deleted — every other mode addresses the active one.
  const canDelete = list.length > 1;

  const beginRename = (id: string, name: string) => {
    setRenamingId(id);
    setDraftName(name);
  };

  const commitRename = () => {
    if (renamingId !== null) renameSequence(renamingId, draftName);
    setRenamingId(null);
  };

  return (
    <Panel
      title="Sequences"
      scroll
      actions={
        <Button
          label="Add sequence"
          icon={<IconAdd size={14} aria-hidden="true" />}
          disabled={!projectOpen}
          onClick={() => createSequence()}
          data-testid="main-add-sequence"
        />
      }
    >
      <ul className="flex flex-col gap-1">
        {list.map((sequence) => (
          <li key={sequence.id} className="flex items-center gap-1">
            {renamingId === sequence.id ? (
              <TextField
                label={`Rename ${sequence.name}`}
                value={draftName}
                onChange={setDraftName}
                onSubmit={commitRename}
                onCancel={() => setRenamingId(null)}
                focusOnMount
                block
                data-testid="main-sequence-rename-input"
              />
            ) : (
              <button
                type="button"
                aria-current={sequence.id === activeSequenceId}
                onClick={() => useTransportStore.getState().setActiveSequenceId(sequence.id)}
                className={`flex min-w-0 flex-1 items-center justify-between rounded-bb-sm border px-2 py-1.5 text-left text-xs transition-colors duration-150 ${
                  sequence.id === activeSequenceId
                    ? 'border-bb-accent bg-bb-raised text-bb-text'
                    : 'border-bb-line text-bb-muted hover:text-bb-text'
                }`}
                data-testid={`main-sequence-${sequence.id}`}
              >
                <span className="truncate">{sequence.name}</span>
                <span className="ml-2 shrink-0 font-mono tabular-nums">{sequence.lengthBars} bars</span>
              </button>
            )}

            {renamingId === sequence.id ? (
              <Button label="Save name" variant="accent" size="sm" onClick={commitRename} />
            ) : (
              <>
                <Button
                  label="Rename"
                  accessibleName={`Rename ${sequence.name}`}
                  variant="quiet"
                  size="sm"
                  onClick={() => beginRename(sequence.id, sequence.name)}
                />
                <Button
                  label="Duplicate"
                  accessibleName={`Duplicate ${sequence.name}`}
                  variant="quiet"
                  size="sm"
                  onClick={() => duplicateSequence(sequence.id)}
                />
                <Button
                  label={`Delete ${sequence.name}`}
                  variant="danger"
                  size="sm"
                  iconOnly
                  icon={<IconRemove size={14} aria-hidden="true" />}
                  disabled={!canDelete}
                  title={canDelete ? undefined : 'A project keeps at least one sequence'}
                  onClick={() => deleteSequence(sequence.id)}
                  data-testid={`main-sequence-delete-${sequence.id}`}
                />
              </>
            )}
          </li>
        ))}
      </ul>
    </Panel>
  );
}
