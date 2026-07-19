/**
 * Sequence and track structural operations (issue #40, spec §8.5.1, §8.5.12).
 *
 * The store actions these compose already existed and were tested, but no component
 * called any of them, so the app was frozen at the one-sequence/one-track skeleton
 * `newProject` seeds. This module is the layer between the panels and those actions: it holds
 * the rules an individual `addTrack` cannot know — what a new sequence should be called,
 * that duplicating a sequence must bring its tracks and notes with it, that deleting one
 * must not strand the transport pointing at it — so the panels stay presentational and
 * the rules are testable without rendering anything (spec §11.1).
 *
 * Every compound operation runs inside {@link commitAsOne}: duplicating a sequence with
 * four tracks is one action the user took, so it is one undo entry, not nine (spec §4.5).
 *
 * Persistence needs no help here. `flushDirtyKeys` upserts, so a sequence or track that
 * exists only in the store is INSERTed on the next autosave and one that has left the
 * store is DELETEd — the dirty keys the store actions already mark are enough (spec §4.4).
 */
import {
  createDefaultChannelStrip,
  createDefaultSequence,
  createDefaultTrack,
  type MidiEvent,
  type Sequence,
  type Track,
} from '@/core/project/schemas';
import { dirtyKey } from '@/core/project/dirty';
import { commit, commitAsOne } from '@/store/commit';
import {
  useMixerStore,
  useProgramStore,
  useProjectStore,
  useSequenceStore,
  useTransportStore,
} from '@/store';

/**
 * Create or drop a track's mixer strip as an undoable step, so it joins the enclosing
 * {@link commitAsOne} and is restored with the track it belongs to.
 *
 * `upsertChannel`/`removeChannel` are bare `set`s — deliberately, since hydration and the
 * insert reorder that also call them are not undoable events. Reverting a track delete
 * without its strip would leave Mixer mode showing a fader wired to nothing, so the strip
 * is committed here rather than set.
 */
function commitTrackStrip(trackId: string, present: boolean): void {
  const channelId = `track:${trackId}`;
  const mixer = useMixerStore.getState();
  const previous = mixer.channels[channelId];
  const strip = previous ?? createDefaultChannelStrip(channelId);
  const write = (exists: boolean) => {
    if (exists) useMixerStore.getState().upsertChannel(strip);
    else useMixerStore.getState().removeChannel(channelId);
  };
  commit({
    label: present ? 'Add track' : 'Delete track',
    apply: () => write(present),
    revert: () => write(!present),
    dirtyKeys: [dirtyKey.track(trackId)],
  });
}

/** Sequences of the open project, in their display order (spec §8.5.1). */
export function orderedSequences(sequences: Record<string, Sequence>): Sequence[] {
  return Object.values(sequences).sort((a, b) => a.position - b.position);
}

/** Tracks of one sequence, in their display order. */
export function tracksOfSequence(tracks: Record<string, Track>, sequenceId: string | null): Track[] {
  if (sequenceId === null) return [];
  return Object.values(tracks)
    .filter((track) => track.sequenceId === sequenceId)
    .sort((a, b) => a.position - b.position);
}

/**
 * A name no sibling already carries: `stem`, else `stem 2`, `stem 3`… Duplicating "Verse"
 * twice gives "Verse copy" and "Verse copy 2" rather than two rows the user cannot tell
 * apart in the Song playlist, where the name is all they have to go on (spec §8.5.12).
 */
function uniqueName(stem: string, taken: readonly string[]): string {
  if (!taken.includes(stem)) return stem;
  for (let n = 2; ; n++) {
    const candidate = `${stem} ${n}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

/** One past the highest sibling position, so a new row lands at the end. */
function nextPosition(siblings: readonly { position: number }[]): number {
  return siblings.reduce((max, item) => Math.max(max, item.position + 1), 0);
}

// --- Sequences -------------------------------------------------------------------

/**
 * Create an empty sequence, make it active, and return its id — or null when no project
 * is open yet. Empty rather than pre-populated with a track: §8.5.12 arrangement is the
 * reason to want a second sequence, and the Tracks panel is right there to fill it.
 *
 * The empty-project guard is not theoretical. Main renders before the boot path's
 * `loadOrCreateActiveProject` resolves, so the Add button is on screen for a moment
 * before there is a project to add to. A sequence built then would carry
 * `projectId: ''`, and hydration would immediately discard it — but not before autosave
 * could try to INSERT a row whose foreign key names no project.
 */
export function createSequence(): string | null {
  const projectId = useProjectStore.getState().projectId;
  if (projectId === '') return null;
  const existing = orderedSequences(useSequenceStore.getState().sequences);
  const sequence = createDefaultSequence(
    projectId,
    nextPosition(existing),
    uniqueName(
      `Sequence ${existing.length + 1}`,
      existing.map((item) => item.name),
    ),
  );
  commitAsOne('Add sequence', () => {
    useSequenceStore.getState().addSequence(sequence);
  });
  useTransportStore.getState().setActiveSequenceId(sequence.id);
  return sequence.id;
}

export function renameSequence(id: string, name: string): void {
  const trimmed = name.trim();
  if (trimmed === '') return; // an unnamed row is unidentifiable in Song mode
  useSequenceStore.getState().updateSequence(id, { name: trimmed });
}

/**
 * Copy a sequence with its tracks, their notes and their mixer strips, and make the copy
 * active. Fresh ids throughout — sharing an id with the source would make the two rows
 * the same entity to the scheduler, the autosave layer and the undo stack alike.
 */
export function duplicateSequence(id: string): string | null {
  const state = useSequenceStore.getState();
  const source = state.sequences[id];
  if (source === undefined) return null;

  const existing = orderedSequences(state.sequences);
  const copy: Sequence = {
    ...source,
    id: crypto.randomUUID(),
    position: nextPosition(existing),
    name: uniqueName(
      `${source.name} copy`,
      existing.map((item) => item.name),
    ),
  };
  const sourceTracks = tracksOfSequence(state.tracks, id);

  commitAsOne('Duplicate sequence', () => {
    const store = useSequenceStore.getState();
    store.addSequence(copy);
    for (const track of sourceTracks) {
      const newTrack: Track = { ...track, id: crypto.randomUUID(), sequenceId: copy.id };
      store.addTrack(newTrack);
      commitTrackStrip(newTrack.id, true);
      const events: MidiEvent[] = (state.events[track.id] ?? []).map((event) => ({
        ...event,
        id: crypto.randomUUID(),
      }));
      if (events.length > 0) store.setTrackEvents(newTrack.id, events);
    }
  });

  useTransportStore.getState().setActiveSequenceId(copy.id);
  return copy.id;
}

/**
 * Delete a sequence with its tracks, their notes, and every song-playlist entry that
 * referenced it. The last sequence cannot go: the transport, Grid and Pad Perform all
 * address the active sequence, and a project with none is a state no other surface in
 * the app is built to render.
 */
export function deleteSequence(id: string): boolean {
  const state = useSequenceStore.getState();
  if (state.sequences[id] === undefined) return false;
  const remaining = orderedSequences(state.sequences).filter((sequence) => sequence.id !== id);
  if (remaining.length === 0) return false;

  const doomedTracks = tracksOfSequence(state.tracks, id);
  const survivingEntries = state.songEntries.filter((entry) => entry.sequenceId !== id);

  commitAsOne('Delete sequence', () => {
    const store = useSequenceStore.getState();
    // A playlist entry pointing at a deleted sequence renders as "Missing sequence" and
    // silently contributes nothing to the song, so it goes with the sequence (spec §7.9).
    if (survivingEntries.length !== state.songEntries.length) {
      store.setSongEntries(survivingEntries.map((entry, position) => ({ ...entry, position })));
    }
    for (const track of doomedTracks) {
      store.removeTrack(track.id);
      commitTrackStrip(track.id, false);
    }
    store.removeSequence(id);
  });

  // Retarget the transport before it is left addressing a sequence that no longer exists.
  if (useTransportStore.getState().activeSequenceId === id) {
    useTransportStore.getState().setActiveSequenceId(remaining[0]!.id);
  }
  return true;
}

// --- Tracks ----------------------------------------------------------------------

/**
 * Add a track to `sequenceId`, playing `programId` (defaulting to the active program, so
 * the pads the user can already see are what the new track sounds).
 *
 * The mixer strip is created alongside it: the graph builds a track's channel lazily on
 * first trigger, but Mixer mode reads the strip from the store, so a track without one
 * would show a fader that moves nothing.
 */
export function createTrack(sequenceId: string, programId?: string | null): string | null {
  if (sequenceId === '') return null;
  const state = useSequenceStore.getState();
  const siblings = tracksOfSequence(state.tracks, sequenceId);
  const resolvedProgramId = programId ?? useProgramStore.getState().activeProgramId;
  const program = resolvedProgramId ? useProgramStore.getState().programs[resolvedProgramId] : undefined;

  const track = createDefaultTrack(
    sequenceId,
    resolvedProgramId,
    nextPosition(siblings),
    uniqueName(
      `Track ${siblings.length + 1}`,
      siblings.map((item) => item.name),
    ),
    program?.type === 'keygroup' ? 'keygroup' : 'drum',
  );

  commitAsOne('Add track', () => {
    useSequenceStore.getState().addTrack(track);
    commitTrackStrip(track.id, true);
  });
  return track.id;
}

export function renameTrack(id: string, name: string): void {
  const trimmed = name.trim();
  if (trimmed === '') return;
  useSequenceStore.getState().updateTrack(id, { name: trimmed });
}

/** Point a track at a different program (spec §4.2 tracks.programId). */
export function setTrackProgram(id: string, programId: string | null): void {
  const program = programId ? useProgramStore.getState().programs[programId] : undefined;
  useSequenceStore.getState().updateTrack(id, {
    programId,
    // The track type follows the program it plays; leaving it stale would route a
    // keygroup program's notes through the drum voice resolver (spec §6).
    ...(program !== undefined ? { type: program.type === 'keygroup' ? 'keygroup' : 'drum' } : {}),
  });
}

/** Delete a track with its notes and its mixer strip. */
export function deleteTrack(id: string): boolean {
  if (useSequenceStore.getState().tracks[id] === undefined) return false;
  commitAsOne('Delete track', () => {
    useSequenceStore.getState().removeTrack(id);
    commitTrackStrip(id, false);
  });
  return true;
}
