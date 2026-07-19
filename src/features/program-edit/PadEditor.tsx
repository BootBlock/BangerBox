/**
 * Drum-pad editor (spec §8.5.5, §6). A bank pad grid (16 pads per bank, 8 banks — spec
 * §1.3.1) selects the active pad; tapping an empty pad creates it. The active pad's §6
 * sound-design surface (name, choke, playback mode, warp, amp envelope, filter, mod matrix,
 * velocity layers) edits through the program store as undoable commits (spec §4.5).
 */
import { useState } from 'react';
import { CHOKE_GROUP_RANGE, createDefaultPad, type DrumProgram, type Pad } from '@/core/project/schemas';
import { useProgramStore } from '@/store';
import { Button } from '@/ui/primitives';
import { NumberField, SelectField, ToggleField } from './controls';
import { EnvelopeEditor, FilterEditor } from './soundDesign';
import { LayersEditor } from './LayersEditor';
import { LfoEditor } from './LfoEditor';
import { ModMatrixEditor } from './ModMatrixEditor';

const PLAYBACK_MODES = [
  { value: 'poly', label: 'Poly' },
  { value: 'mono', label: 'Mono' },
  { value: 'oneShot', label: 'One-shot' },
] as const;

const BANK_SIZE = 16;

export function PadEditor({ program }: { program: DrumProgram }) {
  const [bank, setBank] = useState(0);
  const activePadId = useProgramStore((state) => state.activePadId);
  const setActivePad = useProgramStore((state) => state.setActivePad);
  const upsertPad = useProgramStore((state) => state.upsertPad);
  const removePad = useProgramStore((state) => state.removePad);

  const padByIndex = new Map(program.pads.map((pad) => [pad.padIndex, pad]));
  const activePad = activePadId !== null ? padByIndex.get(activePadId) : undefined;

  const selectPad = (padIndex: number) => {
    if (!padByIndex.has(padIndex)) upsertPad(program.id, createDefaultPad(padIndex));
    setActivePad(padIndex);
  };

  const patchPad = (patch: Partial<Pad>) => {
    if (!activePad) return;
    upsertPad(program.id, { ...activePad, ...patch });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="text-xs text-bb-muted">Bank</span>
        {Array.from({ length: 8 }, (_, index) => (
          <button
            key={index}
            type="button"
            aria-pressed={bank === index}
            onClick={() => setBank(index)}
            className={`rounded-bb-sm border border-bb-line px-2 py-1 text-xs font-semibold ${bank === index ? 'bg-bb-accent text-bb-bg' : 'hover:bg-bb-raised'}`}
          >
            {String.fromCharCode(65 + index)}
          </button>
        ))}
      </div>

      <div role="group" aria-label="Pad grid" className="grid grid-cols-8 gap-1">
        {Array.from({ length: BANK_SIZE }, (_, i) => {
          const padIndex = bank * BANK_SIZE + i;
          const exists = padByIndex.has(padIndex);
          const active = activePadId === padIndex;
          return (
            <button
              key={padIndex}
              type="button"
              aria-label={`Pad ${padIndex + 1}${exists ? '' : ' (empty)'}`}
              aria-pressed={active}
              onClick={() => selectPad(padIndex)}
              className={`aspect-square rounded-bb-sm border text-bb-micro font-semibold ${
                active
                  ? 'border-bb-accent bg-bb-accent text-bb-bg'
                  : exists
                    ? 'border-bb-line bg-bb-raised text-bb-text'
                    : 'border-bb-line bg-bb-surface text-bb-muted'
              }`}
            >
              {padIndex + 1}
            </button>
          );
        })}
      </div>

      {activePad ? (
        <div className="flex flex-col gap-3">
          <section
            aria-label="Pad settings"
            className="rounded-bb-sm border border-bb-line bg-bb-surface p-3"
          >
            <div className="mb-2 flex items-center justify-between">
              <h4 className="text-xs font-semibold text-bb-text">Pad {activePad.padIndex + 1}</h4>
              <Button
                label="Clear pad"
                variant="danger"
                size="sm"
                onClick={() => {
                  removePad(program.id, activePad.padIndex);
                  setActivePad(null);
                }}
              />
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <label className="flex flex-col gap-1 text-xs text-bb-muted">
                <span>Name</span>
                <input
                  className="w-full rounded-bb-sm border border-bb-line bg-bb-raised px-2 py-1 text-xs text-bb-text"
                  value={activePad.name}
                  onChange={(event) => patchPad({ name: event.target.value })}
                />
              </label>
              <NumberField
                label="Choke group"
                value={activePad.chokeGroup}
                min={CHOKE_GROUP_RANGE[0]}
                max={CHOKE_GROUP_RANGE[1]}
                step={1}
                onChange={(chokeGroup) => patchPad({ chokeGroup })}
              />
              <SelectField
                label="Mode"
                value={activePad.playbackMode}
                options={PLAYBACK_MODES}
                onChange={(playbackMode) => patchPad({ playbackMode })}
              />
              <ToggleField label="Warp" checked={activePad.warp} onChange={(warp) => patchPad({ warp })} />
            </div>
          </section>

          <EnvelopeEditor
            envelope={activePad.envelopes.amp}
            onChange={(amp) => patchPad({ envelopes: { ...activePad.envelopes, amp } })}
          />
          <FilterEditor filter={activePad.filter} onChange={(filter) => patchPad({ filter })} />
          {/* Before the mod matrix: the matrix routes lfo1/lfo2 somewhere, so their shape is
              the thing you set first and the thing the matrix's source names refer back to. */}
          <LfoEditor lfos={activePad.lfos} onChange={(lfos) => patchPad({ lfos })} />
          <ModMatrixEditor routes={activePad.modMatrix} onChange={(modMatrix) => patchPad({ modMatrix })} />
          <LayersEditor layers={activePad.layers} onChange={(layers) => patchPad({ layers })} />
        </div>
      ) : (
        <p className="text-xs text-bb-muted">Select a pad to edit its sound.</p>
      )}
    </div>
  );
}
