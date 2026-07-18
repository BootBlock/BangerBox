/**
 * Program Edit mode (spec §8.5.5) — the functional (unpolished, Phase 5) deep editor for the
 * §6 program model. Manages the project's programs (create Drum/Keygroup, rename, delete,
 * select) and edits the active program's sound design via {@link PadEditor} (drum) or
 * {@link KeygroupEditor} (keygroup), plus the live arpeggiator control (spec §7.3). All state
 * flows through the program store (spec §4.2/§4.5); the polished 12-mode shell is Phase 7.
 */
import { createDefaultDrumProgram, createDefaultKeygroupProgram } from '@/core/project/schemas';
import { useProgramStore } from '@/store';
import { ArpControl } from './ArpControl';
import { KeygroupEditor } from './KeygroupEditor';
import { PadEditor } from './PadEditor';

export function ProgramEditPanel() {
  const programs = useProgramStore((state) => state.programs);
  const activeProgramId = useProgramStore((state) => state.activeProgramId);
  const setActiveProgram = useProgramStore((state) => state.setActiveProgram);
  const addProgram = useProgramStore((state) => state.addProgram);
  const removeProgram = useProgramStore((state) => state.removeProgram);
  const renameProgram = useProgramStore((state) => state.renameProgram);

  const list = Object.values(programs).sort((a, b) => a.name.localeCompare(b.name));
  const active = activeProgramId !== null ? programs[activeProgramId] : undefined;

  const createProgram = (type: 'drum' | 'keygroup') => {
    const program = type === 'drum' ? createDefaultDrumProgram() : createDefaultKeygroupProgram();
    addProgram(program);
    setActiveProgram(program.id);
  };

  return (
    <section aria-labelledby="program-edit-heading" className="mt-6">
      <h3 id="program-edit-heading" className="text-sm font-semibold">
        Program edit
      </h3>
      <p className="mt-1 text-xs leading-relaxed text-bb-muted">
        The instrument: build drum and keygroup programs — layers, envelopes, filter, LFOs and the mod matrix
        (spec §6). Edits are undoable and autosaved.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1 text-xs text-bb-muted">
          <span>Program</span>
          <select
            aria-label="Active program"
            className="rounded-bb-sm border border-bb-line bg-bb-raised px-2 py-1 text-xs text-bb-text"
            value={activeProgramId ?? ''}
            onChange={(event) => setActiveProgram(event.target.value || null)}
          >
            <option value="">— none —</option>
            {list.map((program) => (
              <option key={program.id} value={program.id}>
                {program.name} ({program.type})
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => createProgram('drum')}
          className="rounded-bb-sm border border-bb-line px-2 py-1 text-xs font-semibold hover:bg-bb-raised"
        >
          Add drum
        </button>
        <button
          type="button"
          onClick={() => createProgram('keygroup')}
          className="rounded-bb-sm border border-bb-line px-2 py-1 text-xs font-semibold hover:bg-bb-raised"
        >
          Add keygroup
        </button>
      </div>

      {active ? (
        <div className="mt-3 flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1 text-xs text-bb-muted">
              <span>Name</span>
              <input
                aria-label="Program name"
                className="rounded-bb-sm border border-bb-line bg-bb-raised px-2 py-1 text-xs text-bb-text"
                value={active.name}
                onChange={(event) => renameProgram(active.id, event.target.value)}
              />
            </label>
            <button
              type="button"
              onClick={() => {
                removeProgram(active.id);
                setActiveProgram(null);
              }}
              className="rounded-bb-sm border border-bb-line px-2 py-1 text-xs font-semibold hover:bg-bb-raised"
            >
              Delete program
            </button>
          </div>

          {active.type === 'drum' ? <PadEditor program={active} /> : <KeygroupEditor program={active} />}
          <ArpControl />
        </div>
      ) : (
        <p className="mt-3 text-xs text-bb-muted">No program selected. Add or choose one to begin.</p>
      )}
    </section>
  );
}
