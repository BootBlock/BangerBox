/**
 * useBrowserStore — Browser-mode navigation and audition state (spec §4.2, §8.5.7).
 * A view/cache store over SQLite-backed sample queries: current OPFS path, cached
 * results, tag/text filters, favourites and preview state. Runtime only (never
 * undoable); the query-backed Browser UI and favourite persistence land in Phase 6.
 */
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import type { SampleRow } from '@/core/storage/repositories';

interface BrowserState {
  /** Current OPFS/library location being browsed (spec §9.1). */
  currentPath: string;
  /** Cached sample rows for the current view (paged at 200 — spec §9.2). */
  samples: SampleRow[];
  tagFilter: string[];
  textFilter: string;
  favourites: string[];
  previewSampleId: string | null;
  previewPlaying: boolean;

  setCurrentPath: (path: string) => void;
  setSamples: (samples: readonly SampleRow[]) => void;
  setTagFilter: (tags: readonly string[]) => void;
  setTextFilter: (text: string) => void;
  toggleFavourite: (sampleId: string) => void;
  setPreview: (sampleId: string | null, playing: boolean) => void;
}

export const useBrowserStore = create<BrowserState>()(
  subscribeWithSelector((set) => ({
    currentPath: '/',
    samples: [],
    tagFilter: [],
    textFilter: '',
    favourites: [],
    previewSampleId: null,
    previewPlaying: false,

    setCurrentPath: (currentPath) => set({ currentPath }),
    setSamples: (samples) => set({ samples: [...samples] }),
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
