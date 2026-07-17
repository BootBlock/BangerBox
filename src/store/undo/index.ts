/** Undo core barrel (spec §4.5). */
export { CommandStack } from './commandStack';
export type { UndoCommand, UndoSnapshot } from './commandStack';
export { useUndoStore, pushUndo, endUndoGesture, clearUndoHistory } from './useUndoStore';
