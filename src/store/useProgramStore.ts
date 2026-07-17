/**
 * useProgramStore — drum/keygroup program data (spec §4.2, §6). Plain data only: no
 * audio nodes live here (spec §4.2) — the sync layer builds them (spec §4.3). Program
 * and pad edits are undoable (spec §4.5 "program parameter commits", "pad assignment")
 * and mark the owning program dirty for autosave (spec §4.4). The generic
 * {@link updateProgram} carries the deep §6 editing surface that Phase 5 builds upon.
 */
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
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
  renameProgram: (id: string, name: string) => void;

  /** UI selection — not undoable/persisted (spec §4.5). */
  setActiveProgram: (id: string | null) => void;
  setActivePad: (padIndex: number | null) => void;

  /** Apply a pure transform to a program as one undoable commit (spec §4.5). */
  updateProgram: (id: string, updater: (program: Program) => Program, label?: string) => void;

  /** Assign or replace a drum pad (spec §4.5 pad assignment). */
  upsertPad: (programId: string, pad: Pad) => void;
  removePad: (programId: string, padIndex: number) => void;
}

export const useProgramStore = create<ProgramState>()(
  subscribeWithSelector((set, get) => ({
    programs: {},
    activeProgramId: null,
    activePadId: null,

    setPrograms: (programs) => set({ programs: { ...programs } }),

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
  })),
);

/** Re-exported so callers can seed a fresh pad before assigning it (spec §6). */
export { createDefaultPad };
