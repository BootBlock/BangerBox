/**
 * Store barrel (spec §4.2) — the eight Zustand slices plus the undo core. One import
 * site for the runtime state layer used by the sync layer, hydration and the UI.
 */
export { useTransportStore } from './useTransportStore';
export { useProjectStore } from './useProjectStore';
export { useSequenceStore } from './useSequenceStore';
export { useProgramStore } from './useProgramStore';
export { useMixerStore, mixerChannelDirtyKey } from './useMixerStore';
export { useUIStore, MODES } from './useUIStore';
export { useHardwareStore } from './useHardwareStore';
export { useBrowserStore } from './useBrowserStore';
export { useUndoStore, pushUndo, endUndoGesture, clearUndoHistory } from './undo';
export type { Mode } from './useUIStore';
