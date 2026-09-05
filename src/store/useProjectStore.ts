/**
 * useProjectStore — the open project's identity and settings (spec §4.2). Runtime
 * truth; SQLite is durable truth (spec §1.3 #16). The heavy lifecycle actions delegate
 * to the registered project service (spec §4.4) so the store stays plain data; settings
 * setters mark the project dirty for write-behind autosave (spec §4.4).
 */
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { clamp, clampInt } from '@/core/math';
import { dirtyKey, markDirty } from '@/core/project/dirty';
import { getProjectService } from '@/core/project/service';
import type { SaveOutcome } from '@/core/project/autosave';
import { BPM_RANGE, DEFAULT_BPM, GLOBAL_INSERT_LIMIT_RANGE, type BitDepth } from '@/core/project/schemas';

/** Project sample-rate options (spec §1.3 #18). */
export const SAMPLE_RATES = [44_100, 48_000, 96_000] as const;
export type SampleRate = (typeof SAMPLE_RATES)[number];

/** The identity + settings fields hydrated from the `projects` row (spec §9.3). */
export interface ProjectSettings {
  readonly projectId: string;
  readonly projectName: string;
  readonly sampleRate: number;
  readonly bitDepth: BitDepth;
  readonly globalInsertLimit: number;
  /**
   * The project's default tempo — the §9.3 `projects.bpm_default` column (issue #93).
   *
   * It is here rather than only being read at hydration because it is the OTHER half of the
   * §4.2 effective tempo: `sequences.tempo` is nullable, and NULL means this. Something has
   * to hold it for the mirror to be re-derivable at all, and a project with no sequence yet
   * has nowhere else to record a tempo the user set.
   */
  readonly bpmDefault: number;
}

interface ProjectState extends ProjectSettings {
  /** True while unsaved edits await the autosave flush — drives the unsaved dot (spec §4.4). */
  modifiedSinceLastSave: boolean;

  /** Replace identity + settings from a hydrated row and mark the project clean (spec §4.4). */
  applyProject: (settings: ProjectSettings) => void;
  /** Autosave lifecycle raises/clears the unsaved dot (spec §4.4). */
  setModified: (modified: boolean) => void;
  setProjectName: (name: string) => void;
  setSampleRate: (sampleRate: SampleRate) => void;
  setBitDepth: (bitDepth: BitDepth) => void;
  setGlobalInsertLimit: (limit: number) => void;
  /** Set the §9.3 project default tempo (spec §7.2; issue #93). */
  setBpmDefault: (bpm: number) => void;

  // Lifecycle — delegated to the registered service (spec §4.2, §4.4).
  newProject: (name?: string) => Promise<string>;
  loadProject: (id: string) => Promise<void>;
  saveNow: () => Promise<SaveOutcome>;
  exportMpcweb: () => Promise<Blob>;
  importMpcweb: (file: File) => Promise<string>;
}

const UNLOADED: ProjectSettings = {
  projectId: '',
  projectName: '',
  sampleRate: 48_000,
  bitDepth: '24',
  globalInsertLimit: 4,
  bpmDefault: DEFAULT_BPM,
};

/** Mark the open project dirty (settings edits persist — spec §4.4). */
function markProjectDirty(projectId: string): void {
  if (projectId !== '') markDirty(dirtyKey.project(projectId));
}

export const useProjectStore = create<ProjectState>()(
  subscribeWithSelector((set, get) => ({
    ...UNLOADED,
    modifiedSinceLastSave: false,

    /**
     * spec §4.1 — an action validates its input before committing, and the §1.3.1 limit is
     * the one field here that BOUNDS something (issue #135). §9.3 declares no CHECK on
     * `projects.insert_limit`, `rowToProjectSettings` copies it through, and §9.6's manifest
     * types it as a bare number — so a hand-edited row or an imported project could otherwise
     * put `20` here and `addInsert` would build chains no §7.8 address can reach, or `0` and
     * lock every channel out of inserts. Clamped where the settings ENTER, which is the same
     * shape as `withCompleteInserts` and covers hydration, a §9.6 import and a §9.8 pack at
     * once.
     */
    applyProject: (settings) =>
      set({
        ...settings,
        globalInsertLimit: clampInt(
          settings.globalInsertLimit,
          GLOBAL_INSERT_LIMIT_RANGE[0],
          GLOBAL_INSERT_LIMIT_RANGE[1],
        ),
        modifiedSinceLastSave: false,
      }),
    setModified: (modifiedSinceLastSave) => set({ modifiedSinceLastSave }),

    setProjectName: (projectName) => {
      set({ projectName });
      markProjectDirty(get().projectId);
    },
    setSampleRate: (sampleRate) => {
      set({ sampleRate });
      markProjectDirty(get().projectId);
    },
    setBitDepth: (bitDepth) => {
      set({ bitDepth });
      markProjectDirty(get().projectId);
    },
    setGlobalInsertLimit: (limit) => {
      set({ globalInsertLimit: clampInt(limit, GLOBAL_INSERT_LIMIT_RANGE[0], GLOBAL_INSERT_LIMIT_RANGE[1]) });
      markProjectDirty(get().projectId);
    },
    setBpmDefault: (bpm) => {
      set({ bpmDefault: clamp(bpm, BPM_RANGE[0], BPM_RANGE[1]) });
      markProjectDirty(get().projectId);
    },

    newProject: (name) => getProjectService().newProject(name),
    loadProject: (id) => getProjectService().loadProject(id),
    saveNow: () => getProjectService().saveNow(),
    exportMpcweb: () => getProjectService().exportMpcweb(),
    importMpcweb: (file) => getProjectService().importMpcweb(file),
  })),
);
