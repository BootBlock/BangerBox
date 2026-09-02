/**
 * AssignTargetDialog (spec §8.5.7) — choose the pad or keygroup zone a sample lands on.
 *
 * The mirror image of {@link SamplePicker}: opened from a Browser row, where the user already
 * has the sample and is missing a target. It is what makes the Browser's "ready to assign"
 * promise land somewhere real — that message used to send the user to Program Edit, which had
 * no affordance to receive them (issue #37).
 *
 * Pads are ordinary buttons in a bank grid rather than the `Pad` primitive: the primitive
 * sounds a voice on press (spec §7.6) and carries a velocity strike position, neither of which
 * belongs in a chooser. Selecting a target here must not also play something.
 */
import { useState } from 'react';
import { assignSampleToTarget } from '@/core/project';
import type { SampleRow } from '@/core/storage/repositories';
import { useProgramStore, useUIStore } from '@/store';
import { announce, Button, EmptyState, FieldLabel, Modal, SegmentControl } from '@/ui/primitives';

/** Pads per bank (spec §1.3.1 — 128 pads as 8 banks × 16). */
const BANK_SIZE = 16;
const BANK_OPTIONS = Array.from({ length: 8 }, (_, index) => ({
  value: index,
  label: String.fromCharCode(65 + index),
}));

export interface AssignTargetDialogProps {
  /** The sample to assign; null closes the dialog. */
  sample: SampleRow | null;
  onClose: () => void;
}

export function AssignTargetDialog({ sample, onClose }: AssignTargetDialogProps) {
  const programs = useProgramStore((state) => state.programs);
  const activeProgramId = useProgramStore((state) => state.activeProgramId);
  /**
   * The program the user picked in this dialog, or null to follow the active one. Held as an
   * override rather than as the answer, so opening the dialog lands on whatever the user is
   * working on without an effect syncing the two — the picked value is cleared on close,
   * which is an event and not a render-time reconciliation.
   */
  const [override, setOverride] = useState<string | null>(null);
  const [bank, setBank] = useState(0);

  const list = Object.values(programs).sort((a, b) => a.name.localeCompare(b.name));
  const target =
    (override !== null ? programs[override] : undefined) ??
    (activeProgramId !== null ? programs[activeProgramId] : undefined) ??
    list[0];

  const close = () => {
    setOverride(null);
    setBank(0);
    onClose();
  };

  const padsWithLayers = new Set<number>();
  if (target?.type === 'drum') {
    for (const pad of target.pads) if (pad.layers.length > 0) padsWithLayers.add(pad.padIndex);
  }

  const assign = (padIndex: number) => {
    if (!sample || !target) return;
    if (assignSampleToTarget(target.id, sample, { kind: 'pad', padIndex })) close();
  };

  /**
   * Arm the sample and hand the user over to Program Edit (spec §8.5.7 `dragDropPayload`).
   *
   * The grid above is a bare chooser — sixteen numbered squares. The real pad grid shows pad
   * names, which pads already hold sounds and the pad being edited, and it is where a user
   * deciding *where a sound belongs* is actually working. This is also the only route by which
   * `dragDropPayload` is reachable at all: a pointer drag between the two modes cannot happen,
   * because only one mode is on screen at a time.
   */
  const armForPadGrid = () => {
    if (!sample) return;
    const ui = useUIStore.getState();
    ui.setDragDropPayload({ sampleId: sample.id, name: sample.name, rootNote: sample.root_note });
    if (target !== undefined) useProgramStore.getState().setActiveProgram(target.id);
    ui.setActiveMode('program-edit');
    announce(`${sample.name} armed — choose a pad or zone in Program Edit.`);
    close();
  };

  return (
    <Modal
      open={sample !== null}
      title={sample ? `Assign ${sample.name}` : 'Assign sample'}
      onClose={close}
      size="md"
      data-testid="assign-target-dialog"
      footer={
        list.length > 0 ? (
          <Button
            label="Choose on the pad grid…"
            variant="quiet"
            data-testid="assign-arm-for-grid"
            onClick={armForPadGrid}
          />
        ) : undefined
      }
    >
      <div className="flex flex-col gap-3">
        {list.length === 0 ? (
          <EmptyState
            message="This project has no programs."
            hint="Add a drum or keygroup program in Program Edit, then assign the sample to it."
            data-testid="assign-no-programs"
          />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1 text-xs text-bb-muted">
                <span>Program</span>
                <select
                  aria-label="Program to assign into"
                  className="rounded-bb-sm border border-bb-line bg-bb-raised px-2 py-1 text-xs text-bb-text"
                  value={target?.id ?? ''}
                  data-testid="assign-program"
                  onChange={(event) => setOverride(event.target.value || null)}
                >
                  {list.map((program) => (
                    <option key={program.id} value={program.id}>
                      {program.name} ({program.type})
                    </option>
                  ))}
                </select>
              </label>
              {target?.type === 'drum' && (
                <FieldLabel as="span">
                  Bank
                  <SegmentControl
                    label="Pad bank"
                    value={bank}
                    options={BANK_OPTIONS}
                    size="sm"
                    onChange={setBank}
                    data-testid="assign-bank"
                  />
                </FieldLabel>
              )}
            </div>

            {target?.type === 'drum' ? (
              <>
                <p className="text-xs text-bb-muted">
                  Choose a pad. An already-assigned pad gains the sample as another velocity layer.
                </p>
                <div role="group" aria-label="Choose a pad" className="grid grid-cols-8 gap-1">
                  {Array.from({ length: BANK_SIZE }, (_, slot) => {
                    const padIndex = bank * BANK_SIZE + slot;
                    const filled = padsWithLayers.has(padIndex);
                    return (
                      <button
                        key={padIndex}
                        type="button"
                        aria-label={`Assign to pad ${padIndex + 1}${filled ? '' : ' (empty)'}`}
                        data-testid={`assign-pad-${padIndex}`}
                        onClick={() => assign(padIndex)}
                        className={`aspect-square rounded-bb-sm border text-bb-micro font-semibold transition-colors duration-150 hover:border-bb-accent-strong ${
                          filled
                            ? 'border-bb-line bg-bb-raised text-bb-text'
                            : 'border-bb-line bg-bb-surface text-bb-muted'
                        }`}
                      >
                        {padIndex + 1}
                      </button>
                    );
                  })}
                </div>
              </>
            ) : (
              <>
                <p className="text-xs text-bb-muted">
                  A keygroup program holds zones rather than pads. The new zone takes the widest free stretch
                  of keyboard, and plays at the sample&rsquo;s own root note.
                </p>
                <div>
                  <Button
                    label="Add as key zone"
                    variant="accent"
                    data-testid="assign-zone"
                    onClick={() => {
                      if (!sample || !target) return;
                      if (assignSampleToTarget(target.id, sample, { kind: 'zone' })) close();
                    }}
                  />
                </div>
              </>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
