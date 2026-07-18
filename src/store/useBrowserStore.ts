/**
 * useBrowserStore — Browser-mode navigation and audition state (spec §4.2, §8.5.7).
 * A view/cache store over SQLite-backed sample queries: current OPFS path, cached
 * results, tag/text filters, favourites and preview state. Runtime only (never
 * undoable); the query-backed Browser UI and favourite persistence land in Phase 6.
 */
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import type { SampleRow } from '@/core/storage/repositories';

/**
 * The path held before the folder tree has resolved a real location (spec §8.5.7). No
 * project id exists at module load, so the Browser panel replaces this on its first render.
 */
export const BROWSER_INITIAL_PATH = '/';

interface BrowserState {
  /** Current OPFS/library location being browsed (spec §9.1). */
  currentPath: string;
  /** Cached sample rows for the current view (paged at 200 — spec §9.2). */
  samples: SampleRow[];
  /**
   * Why the last sample query failed, or null when it succeeded. An empty `samples` means
   * two very different things — "this location holds nothing" and "the query never ran" —
   * and reporting the second as the first is a false data-loss report (spec §5.1).
   */
  samplesError: string | null;
  tagFilter: string[];
  textFilter: string;
  favourites: string[];
  previewSampleId: string | null;
  previewPlaying: boolean;

  setCurrentPath: (path: string) => void;
  setSamples: (samples: readonly SampleRow[]) => void;
  setSamplesError: (message: string | null) => void;
  setTagFilter: (tags: readonly string[]) => void;
  setTextFilter: (text: string) => void;
  toggleFavourite: (sampleId: string) => void;
  setPreview: (sampleId: string | null, playing: boolean) => void;
}

export const useBrowserStore = create<BrowserState>()(
  subscribeWithSelector((set) => ({
    currentPath: BROWSER_INITIAL_PATH,
    samples: [],
    samplesError: null,
    tagFilter: [],
    textFilter: '',
    favourites: [],
    previewSampleId: null,
    previewPlaying: false,

    setCurrentPath: (currentPath) => set({ currentPath }),
    // A successful query is what clears the error — the list and its status always agree.
    setSamples: (samples) => set({ samples: [...samples], samplesError: null }),
    setSamplesError: (samplesError) => set({ samplesError }),
    setTagFilter: (tags) => set({ tagFilter: [...tags] }),
    setTextFilter: (textFilter) => set({ textFilter }),
    toggleFavourite: (sampleId) =>
      set((state) => ({
        favourites: state.favourites.includes(sampleId)
          ? state.favourites.filter((id) => id !== sampleId)
          : [...state.favourites, sampleId],
      })),
    setPreview: (previewSampleId, previewPlaying) => set({ previewSampleId, previewPlaying }),
  })),
);
