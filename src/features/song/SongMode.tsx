/**
 * Song mode — spec §8.5.12: an ordered playlist of sequences with per-entry repeat counts,
 * add/remove/reorder, a song duration readout, and the "Bounce song" action (spec §9.5).
 *
 * Entries live in `useSequenceStore.songEntries` (spec §4.2) and every edit goes through
 * its actions, so reordering is undoable and autosaved like any other structural change
 * (spec §4.5). Duration is computed from each entry's sequence length and tempo using the
 * same PPQN maths the scheduler uses (spec §7.2) rather than a parallel calculation.
 */
import { useState } from 'react';
import { useSequenceStore, useTransportStore, useUIStore } from '@/store';
import { bounceSong } from '@/core/audio/bounceService';
import { sampleEditContext } from '../sample-edit/sampleContext';
import { Button, SegmentControl, ValueReadout } from '@/ui/primitives';
import { Panel } from '@/ui/shell/Panel';
import { IconAdd, IconChevronDown, IconChevronUp, IconRemove } from '@/ui/icons';

const REPEAT_OPTIONS = [1, 2, 4, 8, 16].map((value) => ({ value, label: `×${value}` }));

/** Seconds for one pass of a sequence at its effective tempo (spec §7.2). */
function sequenceSeconds(lengthBars: number, numerator: number, denominator: number, bpm: number): number {
  // Beats per bar in the sequence's own time signature; a beat is a quarter note at `bpm`.
  const beatsPerBar = numerator * (4 / denominator);
  return (lengthBars * beatsPerBar * 60) / bpm;
}

/** Format a duration as m:ss for the song readout (en-GB, no date library — spec §1.3.1). */
function formatDuration(totalSeconds: number): string {
  const rounded = Math.round(totalSeconds);
  const minutes = Math.floor(rounded / 60);
  const seconds = rounded % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function SongMode() {
  const sequences = useSequenceStore((s) => s.sequences);
  const songEntries = useSequenceStore((s) => s.songEntries);
  const playbackMode = useTransportStore((s) => s.playbackMode);
  const projectBpm = useTransportStore((s) => s.bpm);
  const [bouncing, setBouncing] = useState(false);

  const sequenceList = Object.values(sequences).sort((a, b) => a.position - b.position);

  const totalSeconds = songEntries.reduce((sum, entry) => {
    const sequence = sequences[entry.sequenceId];
    if (!sequence) return sum;
    const bpm = sequence.tempo ?? projectBpm;
    return (
      sum +
      sequenceSeconds(sequence.lengthBars, sequence.timeSig.numerator, sequence.timeSig.denominator, bpm) *
        entry.repeats
    );
  }, 0);

  const writeEntries = (entries: typeof songEntries) => {
    useSequenceStore.getState().setSongEntries(entries);
  };

  const addEntry = (sequenceId: string) => {
    writeEntries([
      ...songEntries,
      { id: crypto.randomUUID(), position: songEntries.length, sequenceId, repeats: 1 },
    ]);
  };

  const removeEntry = (id: string) => {
    writeEntries(
      songEntries.filter((entry) => entry.id !== id).map((entry, index) => ({ ...entry, position: index })),
    );
  };

  /** Move an entry one slot; positions are renumbered so they stay dense (spec §9.3). */
  const moveEntry = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= songEntries.length) return;
    const reordered = [...songEntries];
    const [moved] = reordered.splice(index, 1);
    if (!moved) return;
    reordered.splice(target, 0, moved);
    writeEntries(reordered.map((entry, position) => ({ ...entry, position })));
  };

  const setRepeats = (id: string, repeats: number) => {
    writeEntries(songEntries.map((entry) => (entry.id === id ? { ...entry, repeats } : entry)));
  };

  const handleBounce = () => {
    setBouncing(true);
    void bounceSong('song', sampleEditContext())
      .then((path) => useUIStore.getState().pushToast(`Song bounced to ${path}`, 'success'))
      .catch((error: unknown) =>
        useUIStore
          .getState()
          .pushToast(`Bounce failed: ${error instanceof Error ? error.message : 'unknown error'}`, 'error'),
      )
      .finally(() => setBouncing(false));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <Panel
        title="Song"
        actions={
          <div className="flex items-center gap-2">
            <SegmentControl
              label="Playback mode"
              value={playbackMode}
              options={[
                { value: 'sequence', label: 'Sequence' },
                { value: 'song', label: 'Song' },
              ]}
              size="sm"
              onChange={(mode) => useTransportStore.getState().setPlaybackMode(mode)}
              data-testid="song-playback-mode"
            />
            <Button
              label={bouncing ? 'Bouncing…' : 'Bounce song'}
              disabled={bouncing || songEntries.length === 0}
              onClick={handleBounce}
              data-testid="song-bounce"
            />
          </div>
        }
      >
        <ValueReadout
          label="Song duration"
          value={formatDuration(totalSeconds)}
          showLabel
          data-testid="song-duration"
        />
      </Panel>

      <Panel title="Playlist" scroll className="flex-1">
        {songEntries.length === 0 ? (
          <p className="text-xs text-bb-muted">
            The song is empty. Add a sequence below to start the arrangement.
          </p>
        ) : (
          <ol className="flex flex-col gap-1">
            {songEntries.map((entry, index) => {
              const sequence = sequences[entry.sequenceId];
              return (
                <li
                  key={entry.id}
                  data-testid={`song-entry-${index}`}
                  className="flex items-center gap-2 rounded-bb-sm border border-bb-line bg-bb-raised px-2 py-1.5"
                >
                  <span className="w-6 shrink-0 font-mono text-xs tabular-nums text-bb-muted">
                    {index + 1}
                  </span>
                  <span className="flex-1 truncate text-xs text-bb-text">
                    {sequence?.name ?? 'Missing sequence'}
                  </span>
                  <SegmentControl
                    label={`Repeats for entry ${index + 1}`}
                    value={entry.repeats}
                    options={REPEAT_OPTIONS}
                    size="sm"
                    onChange={(repeats) => setRepeats(entry.id, repeats)}
                  />
                  <Button
                    label={`Move entry ${index + 1} earlier`}
                    variant="quiet"
                    size="sm"
                    iconOnly
                    icon={<IconChevronUp size={14} aria-hidden="true" />}
                    disabled={index === 0}
                    onClick={() => moveEntry(index, -1)}
                  />
                  <Button
                    label={`Move entry ${index + 1} later`}
                    variant="quiet"
                    size="sm"
                    iconOnly
                    icon={<IconChevronDown size={14} aria-hidden="true" />}
                    disabled={index === songEntries.length - 1}
                    onClick={() => moveEntry(index, 1)}
                  />
                  <Button
                    label={`Remove entry ${index + 1}`}
                    variant="danger"
                    size="sm"
                    iconOnly
                    icon={<IconRemove size={14} aria-hidden="true" />}
                    onClick={() => removeEntry(entry.id)}
                  />
                </li>
              );
            })}
          </ol>
        )}
      </Panel>

      <Panel title="Add sequence">
        {sequenceList.length === 0 ? (
          <p className="text-xs text-bb-muted">No sequences to add yet.</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {sequenceList.map((sequence) => (
              <li key={sequence.id}>
                <Button
                  label={sequence.name}
                  icon={<IconAdd size={14} aria-hidden="true" />}
                  onClick={() => addEntry(sequence.id)}
                  data-testid={`song-add-${sequence.id}`}
                />
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
