/**
 * useSequenceStore — the sequence / track / event / automation runtime model
 * (spec §4.2; the superseded draft's `useTrackStore`, renamed for accuracy in §4.2).
 * Every structural or note/automation mutation records an undo entry (spec §4.5) and
 * marks its owning entity dirty for autosave (spec §4.4). Posting the incremental diff
 * to the scheduler worker (spec §7.1.3) is wired in Phase 4 — the scheduler does not
 * exist yet (handover §7).
 */
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { clamp, clampInt } from '@/core/math';
import { dirtyKey } from '@/core/project/dirty';
import {
  automationLaneKey,
  BPM_RANGE,
  LENGTH_BARS_RANGE,
  SWING_RANGE,
  type AutomationPoint,
  type MidiEvent,
  type Sequence,
  type SongEntry,
  type Track,
} from '@/core/project/schemas';
import { commit } from './commit';
import { useProjectStore } from './useProjectStore';

/** Snapshot passed to hydration (spec §4.4). */
export interface SequenceHydration {
  readonly sequences: Record<string, Sequence>;
  readonly tracks: Record<string, Track>;
  readonly events: Record<string, MidiEvent[]>;
  readonly automation: Record<string, AutomationPoint[]>;
  readonly songEntries: SongEntry[];
}

interface SequenceState extends SequenceHydration {
  /** Replace the whole model on project load (spec §4.4). Clears no undo — that is the loader's job. */
  hydrate: (snapshot: SequenceHydration) => void;

  addSequence: (sequence: Sequence) => void;
  updateSequence: (id: string, patch: Partial<Omit<Sequence, 'id' | 'projectId'>>) => void;
  removeSequence: (id: string) => void;

  addTrack: (track: Track) => void;
  updateTrack: (id: string, patch: Partial<Omit<Track, 'id' | 'sequenceId'>>) => void;
  removeTrack: (id: string) => void;

  /** Atomically replace a track's events (recording pass / quantise — spec §7.4, §7.7). */
  setTrackEvents: (trackId: string, events: readonly MidiEvent[]) => void;
  addEvents: (trackId: string, events: readonly MidiEvent[]) => void;
  removeEvents: (trackId: string, ids: readonly string[]) => void;

  /** Atomically replace one automation lane (owner + target path — spec §7.8). */
  setAutomationLane: (
    scope: AutomationPoint['scope'],
    ownerId: string,
    targetPath: string,
    points: readonly AutomationPoint[],
  ) => void;

  setSongEntries: (entries: readonly SongEntry[]) => void;
}

const EMPTY: SequenceHydration = {
  sequences: {},
  tracks: {},
  events: {},
  automation: {},
  songEntries: [],
};

/** Events are kept in tick order for hydration and scheduling (spec §4.2). */
function sortEvents(events: readonly MidiEvent[]): MidiEvent[] {
  return [...events].sort((a, b) => a.tickStart - b.tickStart || a.id.localeCompare(b.id));
}

/** Clamp the numeric sequence fields into their spec ranges (spec §4.1). */
function clampSequencePatch(patch: Partial<Sequence>): Partial<Sequence> {
  const next: Partial<Sequence> = { ...patch };
  if (next.lengthBars !== undefined) {
    next.lengthBars = clampInt(next.lengthBars, LENGTH_BARS_RANGE[0], LENGTH_BARS_RANGE[1]);
  }
  if (next.swingAmount !== undefined) {
    next.swingAmount = clamp(next.swingAmount, SWING_RANGE[0], SWING_RANGE[1]);
  }
  if (next.tempo !== undefined && next.tempo !== null) {
    next.tempo = clamp(next.tempo, BPM_RANGE[0], BPM_RANGE[1]);
  }
  return next;
}

export const useSequenceStore = create<SequenceState>()(
  subscribeWithSelector((set, get) => ({
    ...EMPTY,

    hydrate: (snapshot) =>
      set({
        sequences: { ...snapshot.sequences },
        tracks: { ...snapshot.tracks },
        events: Object.fromEntries(
          Object.entries(snapshot.events).map(([trackId, list]) => [trackId, sortEvents(list)]),
        ),
        automation: { ...snapshot.automation },
        songEntries: [...snapshot.songEntries],
      }),

    // --- Sequences (structure changes are undoable — spec §4.5) --------------------
    addSequence: (sequence) => {
      const setSeq = (value: Sequence | undefined) =>
        set((state) => {
          const sequences = { ...state.sequences };
          if (value === undefined) delete sequences[sequence.id];
          else sequences[sequence.id] = value;
          return { sequences };
        });
      commit({
        label: 'Add sequence',
        apply: () => setSeq(sequence),
        revert: () => setSeq(undefined),
        dirtyKeys: [dirtyKey.sequence(sequence.id)],
      });
    },
    updateSequence: (id, patch) => {
      const prev = get().sequences[id];
      if (prev === undefined) return;
      const next = { ...prev, ...clampSequencePatch(patch) };
      const setSeq = (value: Sequence) =>
        set((state) => ({ sequences: { ...state.sequences, [id]: value } }));
      commit({
        label: 'Edit sequence',
        apply: () => setSeq(next),
        revert: () => setSeq(prev),
        dirtyKeys: [dirtyKey.sequence(id)],
      });
    },
    removeSequence: (id) => {
      const prev = get().sequences[id];
      if (prev === undefined) return;
      const setSeq = (value: Sequence | undefined) =>
        set((state) => {
          const sequences = { ...state.sequences };
          if (value === undefined) delete sequences[id];
          else sequences[id] = value;
          return { sequences };
        });
      commit({
        label: 'Delete sequence',
        apply: () => setSeq(undefined),
        revert: () => setSeq(prev),
        dirtyKeys: [dirtyKey.sequence(id)],
      });
    },

    // --- Tracks -------------------------------------------------------------------
    addTrack: (track) => {
      const setTrack = (value: Track | undefined) =>
        set((state) => {
          const tracks = { ...state.tracks };
          if (value === undefined) delete tracks[track.id];
          else tracks[track.id] = value;
          return { tracks };
        });
      commit({
        label: 'Add track',
        apply: () => setTrack(track),
        revert: () => setTrack(undefined),
        dirtyKeys: [dirtyKey.track(track.id)],
      });
    },
    updateTrack: (id, patch) => {
      const prev = get().tracks[id];
      if (prev === undefined) return;
      const next = { ...prev, ...patch };
      const setTrack = (value: Track) => set((state) => ({ tracks: { ...state.tracks, [id]: value } }));
      commit({
        label: 'Edit track',
        apply: () => setTrack(next),
        revert: () => setTrack(prev),
        dirtyKeys: [dirtyKey.track(id)],
      });
    },
    removeTrack: (id) => {
      const prevTrack = get().tracks[id];
      if (prevTrack === undefined) return;
      const prevEvents = get().events[id];
      const setState = (track: Track | undefined, events: MidiEvent[] | undefined) =>
        set((state) => {
          const tracks = { ...state.tracks };
          const eventMap = { ...state.events };
          if (track === undefined) delete tracks[id];
          else tracks[id] = track;
          if (events === undefined) delete eventMap[id];
          else eventMap[id] = events;
          return { tracks, events: eventMap };
        });
      commit({
        label: 'Delete track',
        apply: () => setState(undefined, undefined),
        revert: () => setState(prevTrack, prevEvents),
        dirtyKeys: [dirtyKey.track(id), dirtyKey.events(id)],
      });
    },

    // --- Events (note edits are undoable — spec §4.5) -----------------------------
    setTrackEvents: (trackId, events) => {
      const prev = get().events[trackId] ?? [];
      const next = sortEvents(events);
      const setEvents = (value: MidiEvent[]) =>
        set((state) => ({ events: { ...state.events, [trackId]: value } }));
      commit({
        label: 'Edit notes',
        apply: () => setEvents(next),
        revert: () => setEvents(prev),
        dirtyKeys: [dirtyKey.events(trackId)],
      });
    },
    addEvents: (trackId, events) => {
      const prev = get().events[trackId] ?? [];
      const next = sortEvents([...prev, ...events]);
      const setEvents = (value: MidiEvent[]) =>
        set((state) => ({ events: { ...state.events, [trackId]: value } }));
      commit({
        label: 'Add notes',
        apply: () => setEvents(next),
        revert: () => setEvents(prev),
        dirtyKeys: [dirtyKey.events(trackId)],
      });
    },
    removeEvents: (trackId, ids) => {
      const prev = get().events[trackId] ?? [];
      const removeSet = new Set(ids);
      const next = prev.filter((event) => !removeSet.has(event.id));
      const setEvents = (value: MidiEvent[]) =>
        set((state) => ({ events: { ...state.events, [trackId]: value } }));
      commit({
        label: 'Delete notes',
        apply: () => setEvents(next),
        revert: () => setEvents(prev),
        dirtyKeys: [dirtyKey.events(trackId)],
      });
    },

    // --- Automation (spec §7.8) ---------------------------------------------------
    setAutomationLane: (scope, ownerId, targetPath, points) => {
      const key = automationLaneKey(scope, ownerId, targetPath);
      const prev = get().automation[key];
      const next = [...points].sort((a, b) => a.tick - b.tick);
      const setLane = (value: AutomationPoint[] | undefined) =>
        set((state) => {
          const automation = { ...state.automation };
          if (value === undefined) delete automation[key];
          else automation[key] = value;
          return { automation };
        });
      commit({
        label: 'Edit automation',
        apply: () => setLane(next),
        revert: () => setLane(prev),
        dirtyKeys: [dirtyKey.automation(scope, ownerId, targetPath)],
      });
    },

    // --- Song mode (spec §7.9) ----------------------------------------------------
    setSongEntries: (entries) => {
      const prev = get().songEntries;
      const next = [...entries];
      const projectId = useProjectStore.getState().projectId;
      const setEntries = (value: SongEntry[]) => set({ songEntries: value });
      commit({
        label: 'Edit song',
        apply: () => setEntries(next),
        revert: () => setEntries(prev),
        // Song entries persist as a project-scoped playlist (spec §9.3 song_entries).
        dirtyKeys: [dirtyKey.song(projectId)],
      });
    },
  })),
);
