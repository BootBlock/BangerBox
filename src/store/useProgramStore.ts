/**
 * useProgramStore — drum/keygroup program data (spec §4.2, §6). Plain data only: no
 * audio nodes live here (spec §4.2) — the sync layer builds them (spec §4.3). Program
 * and pad edits are undoable (spec §4.5 "program parameter commits", "pad assignment")
 * and mark the owning program dirty for autosave (spec §4.4). The generic
 * {@link updateProgram} carries the deep §6 editing surface that Phase 5 builds upon.
 */
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { clamp } from '@/core/math';
import { parseParamTarget, targetRange } from '@/core/audio/params/registry';
import { dirtyKey } from '@/core/project/dirty';
import { createDefaultPad, type Pad, type Program } from '@/core/project/schemas';
import { commit } from './commit';

interface ProgramState {
  programs: Record<string, Program>;
  activeProgramId: string | null;
  activePadId: number | null;

  /** Replace every program on project load (spec §4.4). */
  setPrograms: (programs: Record<string, Program>) => void;

  addProgram: (program: Program) => void;
  removeProgram: (id: string) => void;

  /**
   * Add/remove programs WITHOUT recording undo or marking dirty — for callers that write
   * the rows themselves and own a single composite undo entry covering the whole operation
   * (the §9.8 kit merge: one "Install …" step, not one per program). Going through
   * {@link addProgram} there would push a stray per-program entry underneath the composite
   * one, whose redo would resurrect a program whose samples the composite undo had deleted.
   */
  mergePrograms: (programs: readonly Program[]) => void;
  dropPrograms: (ids: readonly string[]) => void;
  renameProgram: (id: string, name: string) => void;

  /** UI selection — not undoable/persisted (spec §4.5). */
  setActiveProgram: (id: string | null) => void;
  setActivePad: (padIndex: number | null) => void;

  /** Apply a pure transform to a program as one undoable commit (spec §4.5). */
  updateProgram: (id: string, updater: (program: Program) => Program, label?: string) => void;

  /** Assign or replace a drum pad (spec §4.5 pad assignment). */
  upsertPad: (programId: string, pad: Pad) => void;
  removePad: (programId: string, padIndex: number) => void;

  /**
   * Continuous-gesture update of a registered §7.8 program leaf: the value moves (and the
   * sync layer follows it to the sounding voices) with no undo entry or autosave write
   * (spec §4.1). `path` is a `program:<id>.pad:<idx>.<leaf>` address.
   */
  setPadParamTransient: (path: string, value: number) => void;
  /** Gesture end: one undo entry back to the pre-gesture value + autosave (spec §4.1). */
  commitPadParam: (path: string, value: number) => void;
}

/** Pre-gesture origin per program-parameter path — module-level, so it never re-renders. */
const padGestureOrigins = new Map<string, number>();

/**
 * Read a registered §7.8 leaf off a pad, or null when the address does not apply.
 * `pitch` is the pad tune, which §6 stores per velocity layer (spec §5.5 "pad tune"), so
 * the pad's tune reads from its first layer.
 */
function readPadLeaf(pad: Pad, leaf: string): number | null {
  switch (leaf) {
    case 'filter.cutoff':
      return pad.filter.cutoff;
    case 'filter.resonance':
      return pad.filter.resonance;
    case 'pitch':
      return pad.layers[0]?.tuneSemitones ?? 0;
    case 'amp':
      return pad.mixer.level;
    case 'pan':
      return pad.mixer.pan;
    case 'amp.attack':
      return pad.envelopes.amp.attack;
    case 'amp.release':
      return pad.envelopes.amp.release;
    default:
      return null;
  }
}

/** Return a pad with one registered §7.8 leaf replaced (immutably). */
function writePadLeaf(pad: Pad, leaf: string, value: number): Pad {
  switch (leaf) {
    case 'filter.cutoff':
      return { ...pad, filter: { ...pad.filter, cutoff: value } };
    case 'filter.resonance':
      return { ...pad, filter: { ...pad.filter, resonance: value } };
    case 'pitch':
      // Pad tune is a property of the pad, so every layer moves together (spec §5.5).
      return { ...pad, layers: pad.layers.map((layer) => ({ ...layer, tuneSemitones: value })) };
    case 'amp':
      return { ...pad, mixer: { ...pad.mixer, level: value } };
    case 'pan':
      return { ...pad, mixer: { ...pad.mixer, pan: value } };
    case 'amp.attack':
      return { ...pad, envelopes: { ...pad.envelopes, amp: { ...pad.envelopes.amp, attack: value } } };
    case 'amp.release':
      return { ...pad, envelopes: { ...pad.envelopes, amp: { ...pad.envelopes.amp, release: value } } };
    default:
      return pad;
  }
}

interface ResolvedPadLeaf {
  readonly programId: string;
  readonly padIndex: number;
  readonly leaf: string;
  readonly value: number;
  readonly current: number;
}

/** Resolve a program address against the live programs, clamped to its registered range. */
function resolvePadLeaf(
  programs: Record<string, Program>,
  path: string,
  value: number,
): ResolvedPadLeaf | null {
  const target = parseParamTarget(path);
  if (target?.kind !== 'programParam') return null;
  const range = targetRange(target);
  if (range === null) return null;
  const program = programs[target.programId];
  if (program?.type !== 'drum') return null;
  const pad = program.pads.find((candidate) => candidate.padIndex === target.padIndex);
  if (pad === undefined) return null;
  const current = readPadLeaf(pad, target.param);
  if (current === null) return null;
  return {
    programId: target.programId,
    padIndex: target.padIndex,
    leaf: target.param,
    value: clamp(value, range[0], range[1]),
    current,
  };
}

/** Replace one pad inside a drum program (immutably). */
function withPad(program: Program, padIndex: number, leaf: string, value: number): Program {
  if (program.type !== 'drum') return program;
  return {
    ...program,
    pads: program.pads.map((pad) => (pad.padIndex === padIndex ? writePadLeaf(pad, leaf, value) : pad)),
  };
}

export const useProgramStore = create<ProgramState>()(
  subscribeWithSelector((set, get) => ({
    programs: {},
    activeProgramId: null,
    activePadId: null,

    setPrograms: (programs) => set({ programs: { ...programs } }),

    mergePrograms: (incoming) =>
      set((state) => {
        const programs = { ...state.programs };
        for (const program of incoming) programs[program.id] = program;
        return { programs };
      }),

    dropPrograms: (ids) =>
      set((state) => {
        const programs = { ...state.programs };
        for (const id of ids) delete programs[id];
        return { programs };
      }),

    addProgram: (program) => {
      const write = (value: Program | undefined) =>
        set((state) => {
          const programs = { ...state.programs };
          if (value === undefined) delete programs[program.id];
          else programs[program.id] = value;
          return { programs };
        });
      commit({
        label: 'Add program',
        apply: () => write(program),
        revert: () => write(undefined),
        dirtyKeys: [dirtyKey.program(program.id)],
      });
    },

    removeProgram: (id) => {
      const prev = get().programs[id];
      if (prev === undefined) return;
      const write = (value: Program | undefined) =>
        set((state) => {
          const programs = { ...state.programs };
          if (value === undefined) delete programs[id];
          else programs[id] = value;
          return { programs };
        });
      commit({
        label: 'Delete program',
        apply: () => write(undefined),
        revert: () => write(prev),
        dirtyKeys: [dirtyKey.program(id)],
      });
    },

    renameProgram: (id, name) => {
      get().updateProgram(id, (program) => ({ ...program, name }), 'Rename program');
    },

    setActiveProgram: (activeProgramId) => set({ activeProgramId }),
    setActivePad: (activePadId) => set({ activePadId }),

    updateProgram: (id, updater, label = 'Edit program') => {
      const prev = get().programs[id];
      if (prev === undefined) return;
      const next = updater(prev);
      const write = (value: Program) => set((state) => ({ programs: { ...state.programs, [id]: value } }));
      commit({
        label,
        apply: () => write(next),
        revert: () => write(prev),
        dirtyKeys: [dirtyKey.program(id)],
      });
    },

    upsertPad: (programId, pad) => {
      get().updateProgram(
        programId,
        (program) => {
          if (program.type !== 'drum') return program; // pads exist only on drum programs (spec §6)
          const pads = program.pads.filter((existing) => existing.padIndex !== pad.padIndex);
          return { ...program, pads: [...pads, pad].sort((a, b) => a.padIndex - b.padIndex) };
        },
        'Assign pad',
      );
    },

    removePad: (programId, padIndex) => {
      get().updateProgram(
        programId,
        (program) => {
          if (program.type !== 'drum') return program;
          return { ...program, pads: program.pads.filter((pad) => pad.padIndex !== padIndex) };
        },
        'Clear pad',
      );
    },

    setPadParamTransient: (path, value) => {
      const resolved = resolvePadLeaf(get().programs, path, value);
      if (resolved === null) return;
      // Record the pre-gesture value the first time this path moves (spec §4.1).
      if (!padGestureOrigins.has(path)) padGestureOrigins.set(path, resolved.current);
      set((state) => ({
        programs: {
          ...state.programs,
          [resolved.programId]: withPad(
            state.programs[resolved.programId]!,
            resolved.padIndex,
            resolved.leaf,
            resolved.value,
          ),
        },
      }));
    },

    commitPadParam: (path, value) => {
      const resolved = resolvePadLeaf(get().programs, path, value);
      if (resolved === null) return;
      const origin = padGestureOrigins.get(path) ?? resolved.current;
      padGestureOrigins.delete(path);
      const write = (next: number) =>
        set((state) => ({
          programs: {
            ...state.programs,
            [resolved.programId]: withPad(
              state.programs[resolved.programId]!,
              resolved.padIndex,
              resolved.leaf,
              next,
            ),
          },
        }));
      // One gesture = one undo entry back to the pre-gesture origin (spec §3.3, §4.5).
      commit({
        label: 'Edit program parameter',
        apply: () => write(resolved.value),
        revert: () => write(origin),
        dirtyKeys: [dirtyKey.program(resolved.programId)],
      });
    },
  })),
);

/** Re-exported so callers can seed a fresh pad before assigning it (spec §6). */
export { createDefaultPad };
