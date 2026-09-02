/**
 * Drum-pad editor (spec §8.5.5, §6). A bank pad grid (16 pads per bank, 8 banks — spec
 * §1.3.1) selects the active pad; tapping an empty pad creates it. The active pad's §6
 * sound-design surface (name, choke, playback mode, warp, amp envelope, filter, mod matrix,
 * velocity layers) edits through the program store as undoable commits (spec §4.5).
 *
 * The grid is also where a sample armed in the Browser lands (spec §8.5.7): it is a drop
 * target, and while `dragDropPayload` holds a sample, pressing a pad assigns it rather than
 * only selecting it. That press route is the one that matters — Browser and Program Edit are
 * separate §8.5 modes, so a pointer drag between them cannot happen, and the drop handlers
 * only serve a drag that begins and ends inside this mode.
 */
import { useState } from 'react';
import { CHOKE_GROUP_RANGE, createDefaultPad, type DrumProgram, type Pad } from '@/core/project/schemas';
import { useProgramStore, useUIStore } from '@/store';
import { announce, Button, FieldLabel, SegmentControl } from '@/ui/primitives';
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

/** Banks A–H (spec §1.3.1) — the letter is the label, the index is the value. */
const BANK_OPTIONS = Array.from({ length: 8 }, (_, index) => ({
  value: index,
  label: String.fromCharCode(65 + index),
}));

export function PadEditor({ program }: { program: DrumProgram }) {
  const [bank, setBank] = useState(0);
  const activePadId = useProgramStore((state) => state.activePadId);
  const setActivePad = useProgramStore((state) => state.setActivePad);
  const upsertPad = useProgramStore((state) => state.upsertPad);
  const removePad = useProgramStore((state) => state.removePad);
  const addPadLayer = useProgramStore((state) => state.addPadLayer);
  /** The sample armed by a Browser drag or tap, waiting for a pad (spec §8.5.7). */
  const dragDropPayload = useUIStore((state) => state.dragDropPayload);

  const padByIndex = new Map(program.pads.map((pad) => [pad.padIndex, pad]));
  const activePad = activePadId !== null ? padByIndex.get(activePadId) : undefined;

  /**
   * Assign the armed sample to a pad and disarm (spec §8.5.7). Shared by the drop handler and
   * by an ordinary press while a payload is armed, so the pointer and keyboard routes end in
   * exactly the same commit.
   */
  const assignArmed = (padIndex: number) => {
    if (dragDropPayload === null) return;
    const result = addPadLayer(program.id, padIndex, dragDropPayload.sampleId);
    const message = result.ok ? `${dragDropPayload.name} assigned to pad ${padIndex + 1}.` : result.reason;
    useUIStore.getState().pushToast(message, result.ok ? 'success' : 'warning');
    announce(message);
    // Disarm either way: a refusal that left the payload armed would re-fire on the next
    // press, so selecting a different pad would silently try the same assignment again.
    useUIStore.getState().setDragDropPayload(null);
    setActivePad(padIndex);
  };

  const selectPad = (padIndex: number) => {
    if (dragDropPayload !== null) {
      assignArmed(padIndex);
      return;
    }
    if (!padByIndex.has(padIndex)) upsertPad(program.id, createDefaultPad(padIndex));
    setActivePad(padIndex);
  };

  const patchPad = (patch: Partial<Pad>) => {
    if (!activePad) return;
    upsertPad(program.id, { ...activePad, ...patch });
  };

  return (
    <div className="flex flex-col gap-3">
      {/* Eight banks, exactly one live: a radio group, which is what SegmentControl is
          (spec §8.2). Hand-rolled before, with `aria-pressed` — that announces a toggle
          the user can turn off, and no bank can be turned off. The row wrapper is load
          bearing: SegmentControl hugs its options, but as a direct child of the column
          below it would be stretched to the panel width by `align-items: stretch`. */}
      <div className="flex items-center gap-2">
        <FieldLabel as="span">
          Bank
          <SegmentControl
            label="Bank"
            value={bank}
            options={BANK_OPTIONS}
            size="sm"
            onChange={setBank}
            data-testid="pad-bank"
          />
        </FieldLabel>
      </div>

      {/* The armed-sample banner (spec §8.5.7). A drag from the Browser cannot reach here —
          the two are separate §8.5 modes, so the pointer never sees both — which is why the
          payload behaves as an armed selection rather than as a live drag. Saying so on
          screen is what turns the Browser's promise into an instruction the user can follow.

          Deliberately NOT a live region: §8.2 allows exactly one, the shell's `LiveRegion`,
          and a second would compete with it. The pad labels below carry the same news to
          assistive tech instead — each reads "Assign to pad N" while a sample is armed. */}
      {dragDropPayload !== null && (
        <div
          data-testid="pad-assign-armed"
          className="flex flex-wrap items-center gap-2 rounded-bb-sm border border-bb-accent bg-bb-surface p-2 text-xs"
        >
          <span className="flex-1">
            Assigning <strong className="font-semibold">{dragDropPayload.name}</strong> — choose a pad below.
          </span>
          <Button
            label="Cancel assignment"
            variant="quiet"
            size="sm"
            data-testid="pad-assign-cancel"
            onClick={() => useUIStore.getState().setDragDropPayload(null)}
          />
        </div>
      )}

      <div role="group" aria-label="Pad grid" className="grid grid-cols-8 gap-1">
        {Array.from({ length: BANK_SIZE }, (_, i) => {
          const padIndex = bank * BANK_SIZE + i;
          const exists = padByIndex.has(padIndex);
          const active = activePadId === padIndex;
          return (
            <button
              key={padIndex}
              type="button"
              data-testid={`program-pad-${padIndex}`}
              // Drop target for a drag that starts and ends inside this mode (spec §8.5.7).
              // `preventDefault` on dragover is what marks an element as a valid drop target;
              // without it the browser refuses the drop and nothing fires.
              onDragOver={(event) => {
                if (dragDropPayload === null) return;
                event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                assignArmed(padIndex);
              }}
              aria-label={`${dragDropPayload !== null ? 'Assign to pad' : 'Pad'} ${padIndex + 1}${
                exists ? '' : ' (empty)'
              }`}
              // One of the sixteen is the pad being edited — `aria-current`, the app's
              // idiom for a one-of-many selection (see the note on ModeRail). This read
              // `aria-pressed`, which describes an independently toggleable control and
              // made a screen reader announce fifteen pads as "not pressed".
              aria-current={active}
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
          <LayersEditor
            programId={program.id}
            padIndex={activePad.padIndex}
            layers={activePad.layers}
            onChange={(layers) => patchPad({ layers })}
          />
        </div>
      ) : (
        <p className="text-xs text-bb-muted">Select a pad to edit its sound.</p>
      )}
    </div>
  );
}
