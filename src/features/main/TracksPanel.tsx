/**
 * Main-mode track list for the active sequence, with CRUD (issue #40, spec §8.5.1).
 *
 * Until this existed, four modes told the user to "add a track to the active sequence"
 * and nothing in the app could. Grid's track picker, Muting's cells and Mixer's tracks
 * tab all read the same list, so they gain their second row from here.
 *
 * The program picker is the one Grid already offers per track, placed on the row that
 * owns the choice: a track's program decides what its notes sound (spec §6), and picking
 * it at creation time only would leave a wrong guess unfixable.
 */
import { useState } from 'react';
import { useProgramStore, useSequenceStore, useTransportStore } from '@/store';
import { Button, EmptyState, TextField } from '@/ui/primitives';
import { Panel } from '@/ui/shell/Panel';
import { IconAdd, IconRemove } from '@/ui/icons';
import { createTrack, deleteTrack, renameTrack, setTrackProgram, tracksOfSequence } from './projectCrud';

const SELECT =
  'min-w-0 max-w-40 rounded-bb-sm border border-bb-line bg-bb-raised px-2 py-1 text-xs text-bb-text';

export function TracksPanel() {
  const tracks = useSequenceStore((s) => s.tracks);
  const sequences = useSequenceStore((s) => s.sequences);
  const activeSequenceId = useTransportStore((s) => s.activeSequenceId);
  const programs = useProgramStore((s) => s.programs);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');

  const activeSequence = activeSequenceId ? sequences[activeSequenceId] : undefined;
  const list = tracksOfSequence(tracks, activeSequenceId);
  const programList = Object.values(programs);

  const commitRename = () => {
    if (renamingId !== null) renameTrack(renamingId, draftName);
    setRenamingId(null);
  };

  return (
    <Panel
      title={activeSequence ? `Tracks · ${activeSequence.name}` : 'Tracks'}
      scroll
      actions={
        <Button
          label="Add track"
          icon={<IconAdd size={14} aria-hidden="true" />}
          disabled={activeSequenceId === null}
          onClick={() => activeSequenceId && createTrack(activeSequenceId)}
          data-testid="main-add-track"
        />
      }
    >
      {list.length === 0 ? (
        activeSequenceId === null ? (
          <EmptyState message="No sequence is active." hint="Select one in the Sequences panel." />
        ) : (
          <EmptyState
            message="No tracks in this sequence."
            hint="Add one to play pads and edit notes."
            data-testid="main-no-tracks"
          />
        )
      ) : (
        <ul className="flex flex-col gap-1">
          {list.map((track) => (
            <li
              key={track.id}
              className="flex items-center gap-1 rounded-bb-sm border border-bb-line bg-bb-raised px-2 py-1.5"
              data-testid={`main-track-${track.id}`}
            >
              {renamingId === track.id ? (
                <TextField
                  label={`Rename ${track.name}`}
                  value={draftName}
                  onChange={setDraftName}
                  onSubmit={commitRename}
                  onCancel={() => setRenamingId(null)}
                  focusOnMount
                  block
                  data-testid="main-track-rename-input"
                />
              ) : (
                <span className="min-w-0 flex-1 truncate text-xs text-bb-text">{track.name}</span>
              )}

              {renamingId === track.id ? (
                <Button label="Save name" variant="accent" size="sm" onClick={commitRename} />
              ) : (
                <>
                  <select
                    aria-label={`Program for ${track.name}`}
                    value={track.programId ?? ''}
                    onChange={(event) => setTrackProgram(track.id, event.target.value || null)}
                    className={SELECT}
                    data-testid={`main-track-program-${track.id}`}
                  >
                    <option value="">No program</option>
                    {programList.map((program) => (
                      <option key={program.id} value={program.id}>
                        {program.name}
                      </option>
                    ))}
                  </select>
                  <Button
                    label="Rename"
                    accessibleName={`Rename ${track.name}`}
                    variant="quiet"
                    size="sm"
                    onClick={() => {
                      setRenamingId(track.id);
                      setDraftName(track.name);
                    }}
                  />
                  <Button
                    label={`Delete ${track.name}`}
                    variant="danger"
                    size="sm"
                    iconOnly
                    icon={<IconRemove size={14} aria-hidden="true" />}
                    onClick={() => deleteTrack(track.id)}
                    data-testid={`main-track-delete-${track.id}`}
                  />
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
