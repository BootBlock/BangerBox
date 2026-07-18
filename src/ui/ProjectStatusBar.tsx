/**
 * Project status readout (spec §4.4, §4.5). Store-driven: the active project name, the
 * unsaved-changes dot (spec §4.4), and undo/redo toolbar buttons (spec §4.5 exposure).
 * A slice of the persistent transport bar (spec §8.1) that later phases flesh out —
 * here it proves the state layer is wired end-to-end (spec §3.4).
 */
import { useProjectStore } from '@/store/useProjectStore';
import { useUndoStore } from '@/store/undo';
import { Button } from './primitives';
import { useUndoKeyboard } from './useUndoKeyboard';

export function ProjectStatusBar() {
  useUndoKeyboard();
  const projectName = useProjectStore((state) => state.projectName);
  const modified = useProjectStore((state) => state.modifiedSinceLastSave);
  const canUndo = useUndoStore((state) => state.canUndo);
  const canRedo = useUndoStore((state) => state.canRedo);
  const undoLabel = useUndoStore((state) => state.undoLabel);
  const redoLabel = useUndoStore((state) => state.redoLabel);

  return (
    <section
      aria-label="Project status"
      className="mt-6 flex items-center justify-between gap-3 rounded-bb-md border border-bb-line bg-bb-raised px-4 py-3"
    >
      <div className="flex items-center gap-2 text-sm">
        <span className="text-bb-muted">Project</span>
        <span data-testid="active-project-name" className="font-semibold text-bb-text">
          {projectName === '' ? 'None loaded' : projectName}
        </span>
        <span
          data-testid="unsaved-dot"
          aria-hidden={!modified}
          title={modified ? 'Unsaved changes' : 'All changes saved'}
          className={`ml-1 inline-block h-2 w-2 rounded-full ${modified ? 'bg-bb-warn' : 'bg-transparent'}`}
        />
        {modified && <span className="sr-only">Unsaved changes</span>}
      </div>

      <div className="flex items-center gap-2">
        {/* The visible text stays the bare verb; `accessibleName` adds what is being undone
            so the name still distinguishes the button out of context (spec §8.2). It is
            omitted when there is nothing to name, leaving the visible label as the name. */}
        <Button
          label="Undo"
          accessibleName={canUndo && undoLabel ? `Undo ${undoLabel}` : undefined}
          onClick={() => useUndoStore.getState().undo()}
          disabled={!canUndo}
        />
        <Button
          label="Redo"
          accessibleName={canRedo && redoLabel ? `Redo ${redoLabel}` : undefined}
          onClick={() => useUndoStore.getState().redo()}
          disabled={!canRedo}
        />
      </div>
    </section>
  );
}
