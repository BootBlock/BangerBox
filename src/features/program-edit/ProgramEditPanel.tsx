/**
 * Program Edit mode (spec §8.5.5) — the deep editor for the §6 program model. Manages the
 * project's programs (create Drum/Keygroup, rename, delete, select) and edits the active
 * program's sound design via {@link PadEditor} (drum) or {@link KeygroupEditor} (keygroup),
 * plus the live arpeggiator control (spec §7.3). All state flows through the program store
 * (spec §4.2/§4.5).
 *
 * The §8.5.5 graphical editors — the AHDSR envelope graph, the velocity-range bar and the
 * keygroup zone keyboard — pair a pointer-driven canvas with the numeric fields beside it
 * rather than replacing them; the canvases are `role="img"`, so the fields are what keep the
 * editor operable without a pointer (spec §8.2). Program Edit still uses plain inputs rather
 * than the bespoke `Knob`/`Fader` primitives the rest of the shell uses — see `controls.tsx`.
 */
import { createDefaultDrumProgram, createDefaultKeygroupProgram } from '@/core/project/schemas';
import { useProgramStore } from '@/store';
import { Button } from '@/ui/primitives';
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
    // The deep editor is taller than any viewport by nature (layers, envelopes, mod
    // matrix), so it owns its scrolling rather than making the shell scroll (spec §8.4).
    <section aria-labelledby="program-edit-heading" className="min-h-0 flex-1 overflow-y-auto">
      <h3 id="program-edit-heading" className="text-sm font-semibold">
        Program edit
      </h3>
      {/* Spec §6 is the surface this describes; the reference belongs here, not in the
          sentence a musician reads. */}
      <p className="mt-1 text-xs leading-relaxed text-bb-muted">
        The instrument: build drum and keygroup programs — layers, envelopes, filter, LFOs and the mod matrix.
        Edits are undoable and autosaved.
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
        <Button label="Add drum" size="sm" onClick={() => createProgram('drum')} />
        <Button label="Add keygroup" size="sm" onClick={() => createProgram('keygroup')} />
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
            <Button
              label="Delete program"
              variant="danger"
              size="sm"
              onClick={() => {
                removeProgram(active.id);
                setActiveProgram(null);
              }}
            />
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
