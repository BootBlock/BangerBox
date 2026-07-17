/**
 * Project status readout (spec §4.4, §4.5). Store-driven: the active project name, the
 * unsaved-changes dot (spec §4.4), and undo/redo toolbar buttons (spec §4.5 exposure).
 * A slice of the persistent transport bar (spec §8.1) that later phases flesh out —
 * here it proves the state layer is wired end-to-end (spec §3.4).
 */
import { useProjectStore } from '@/store/useProjectStore';
import { useUndoStore } from '@/store/undo';
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
        <button
          type="button"
          onClick={() => useUndoStore.getState().undo()}
          disabled={!canUndo}
          aria-label={canUndo && undoLabel ? `Undo ${undoLabel}` : 'Undo'}
          className="rounded-bb-sm border border-bb-line px-3 py-1 text-xs font-semibold text-bb-text transition-colors duration-150 hover:bg-bb-surface disabled:cursor-not-allowed disabled:opacity-50"
        >
          Undo
        </button>
        <button
          type="button"
          onClick={() => useUndoStore.getState().redo()}
          disabled={!canRedo}
          aria-label={canRedo && redoLabel ? `Redo ${redoLabel}` : 'Redo'}
          className="rounded-bb-sm border border-bb-line px-3 py-1 text-xs font-semibold text-bb-text transition-colors duration-150 hover:bg-bb-surface disabled:cursor-not-allowed disabled:opacity-50"
        >
          Redo
        </button>
      </div>
    </section>
  );
}
