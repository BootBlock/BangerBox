/**
 * Velocity-layer editor for a drum pad (spec §6, §8.5.5). Lists the pad's velocity layers
 * with editable velocity range, tune and gain, and owns the two assignment routes into a pad:
 * "Add sample…" adds a layer, and each layer's "Change…" repoints an existing one. Both go
 * through the program store's assignment actions, which own the §6 rules — layers may not
 * overlap, and a pad holds at most `maxLayers` of them (spec §4.5, §6).
 *
 * Ranges are edited here, but never *chosen* here: adding a layer re-splits the whole 0..127
 * axis across the layers, so an assignment cannot produce an overlap or a velocity nothing
 * answers. The spinners then let the user move the boundaries deliberately.
 *
 * The §8.5.5 drag-ranges bar sits above the list and shows every layer on one 0..127 axis,
 * which is the only view that makes an overlap or an uncovered velocity band visible — reading
 * that off a column of spinners means comparing every row against every other. The spinners
 * stay: the bar is `role="img"` and pointer-only, so they remain the keyboard route to the same
 * values (spec §8.2), and selecting a layer in either place highlights it in both.
 */
import { useState } from 'react';
import type { SampleRow } from '@/core/storage/repositories';
import {
  DEFAULT_MAX_VELOCITY_LAYERS,
  GAIN_DB_RANGE,
  TUNE_CENTS_RANGE,
  TUNE_SEMITONES_RANGE,
  type VelocityLayer,
} from '@/core/project/schemas';
import { useProgramStore, useUIStore } from '@/store';
import { announce, Button, EmptyState } from '@/ui/primitives';
import { IconRemove } from '@/ui/icons';
import { NumberField, ToggleField } from './controls';
import { SamplePicker } from './SamplePicker';
import { VelocityRangeBar } from './VelocityRangeBar';

/** Which assignment the open picker is filling: a new layer, or an existing one's sample. */
type PickerTarget = { readonly kind: 'add' } | { readonly kind: 'replace'; readonly layerIndex: number };

export function LayersEditor({
  programId,
  padIndex,
  layers,
  onChange,
}: {
  programId: string;
  padIndex: number;
  layers: readonly VelocityLayer[];
  onChange: (layers: VelocityLayer[]) => void;
}) {
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [picking, setPicking] = useState<PickerTarget | null>(null);
  const addPadLayer = useProgramStore((state) => state.addPadLayer);
  const setLayerSample = useProgramStore((state) => state.setLayerSample);
  const removePadLayer = useProgramStore((state) => state.removePadLayer);

  const setLayer = (index: number, patch: Partial<VelocityLayer>) =>
    onChange(layers.map((layer, i) => (i === index ? { ...layer, ...patch } : layer)));
  const removeLayer = (index: number) => {
    // The selection is positional, so removing a layer above the selected one would otherwise
    // leave the highlight pointing at a different layer than the user picked.
    setSelectedIndex((current) => (current === index ? -1 : current > index ? current - 1 : current));
    // Through the store, not `onChange`: removing a layer opens a hole in the velocity axis,
    // and the pad would go silent across it. The store closes the hole (spec §6).
    const result = removePadLayer(programId, padIndex, index);
    // Deliberately NOT confirmed (issue #54): the whole subject of this button is the row it
    // sits in, and the user can see exactly what goes. What was missing is that nothing said
    // the removal was recoverable, so the toast names Undo — see `ConfirmDialog` for the rule
    // that decides which deletions get a dialog instead.
    const message = result.ok ? `Removed layer ${index + 1}. Undo with Ctrl+Z.` : result.reason;
    useUIStore.getState().pushToast(message, result.ok ? 'success' : 'warning');
    announce(message);
  };

  /** Apply the picked sample to whichever target opened the picker, and report either way. */
  const applyPick = (sample: SampleRow) => {
    if (picking === null) return;
    const result =
      picking.kind === 'add'
        ? addPadLayer(programId, padIndex, sample.id)
        : setLayerSample(programId, padIndex, picking.layerIndex, sample.id);
    const message = result.ok
      ? picking.kind === 'add'
        ? `${sample.name} added to pad ${padIndex + 1}.`
        : `Layer ${picking.layerIndex + 1} now plays ${sample.name}.`
      : result.reason;
    useUIStore.getState().pushToast(message, result.ok ? 'success' : 'warning');
    announce(message);
    // A refusal leaves the picker open so the user can choose again or read why not.
    if (result.ok) setPicking(null);
  };

  const full = layers.length >= DEFAULT_MAX_VELOCITY_LAYERS;

  return (
    <section aria-label="Velocity layers" className="rounded-bb-sm border border-bb-line bg-bb-surface p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h4 className="text-xs font-semibold text-bb-text">Velocity layers</h4>
        <Button
          label="Add sample…"
          variant="accent"
          size="sm"
          disabled={full}
          title={
            full
              ? `A pad holds ${DEFAULT_MAX_VELOCITY_LAYERS} velocity layers. Remove one to add another.`
              : undefined
          }
          data-testid="layer-add"
          onClick={() => setPicking({ kind: 'add' })}
        />
      </div>
      {layers.length === 0 ? (
        <EmptyState
          message="No layers yet, so this pad makes no sound."
          hint="Add a sample with the button above, or drag one from the Browser onto the pad grid."
          data-testid="layers-empty"
        />
      ) : (
        <>
          <div className="mb-3">
            <VelocityRangeBar
              layers={layers}
              onChange={onChange}
              selectedIndex={selectedIndex}
              onSelect={setSelectedIndex}
            />
          </div>
          <ul className="flex flex-col gap-3">
            {layers.map((layer, index) => (
              <li
                key={index}
                onFocusCapture={() => setSelectedIndex(index)}
                className={`rounded-bb-sm border p-2 ${
                  index === selectedIndex ? 'border-bb-accent' : 'border-bb-line'
                }`}
              >
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="text-xs text-bb-muted">Sample {layer.sampleId.slice(0, 8)}</span>
                  <div className="flex items-center gap-1">
                    <Button
                      label="Change sample"
                      accessibleName={`Change sample on layer ${index + 1}`}
                      variant="quiet"
                      size="sm"
                      data-testid={`layer-change-${index}`}
                      onClick={() => setPicking({ kind: 'replace', layerIndex: index })}
                    />
                    <Button
                      label={`Remove layer ${index + 1}`}
                      variant="danger"
                      size="sm"
                      iconOnly
                      icon={<IconRemove size={14} aria-hidden="true" />}
                      onClick={() => removeLayer(index)}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  <NumberField
                    label="Vel start"
                    value={layer.velocityStart}
                    min={0}
                    max={127}
                    step={1}
                    onChange={(velocityStart) => setLayer(index, { velocityStart })}
                  />
                  <NumberField
                    label="Vel end"
                    value={layer.velocityEnd}
                    min={0}
                    max={127}
                    step={1}
                    onChange={(velocityEnd) => setLayer(index, { velocityEnd })}
                  />
                  <NumberField
                    label="Tune"
                    suffix="st"
                    value={layer.tuneSemitones}
                    min={TUNE_SEMITONES_RANGE[0]}
                    max={TUNE_SEMITONES_RANGE[1]}
                    step={1}
                    onChange={(tuneSemitones) => setLayer(index, { tuneSemitones })}
                  />
                  <NumberField
                    label="Fine"
                    suffix="cents"
                    value={layer.tuneCents}
                    min={TUNE_CENTS_RANGE[0]}
                    max={TUNE_CENTS_RANGE[1]}
                    step={1}
                    onChange={(tuneCents) => setLayer(index, { tuneCents })}
                  />
                  <NumberField
                    label="Gain"
                    suffix="dB"
                    value={layer.gainDb}
                    min={GAIN_DB_RANGE[0]}
                    max={GAIN_DB_RANGE[1]}
                    step={0.5}
                    onChange={(gainDb) => setLayer(index, { gainDb })}
                  />
                  <ToggleField
                    label="Reverse"
                    checked={layer.reverse}
                    onChange={(reverse) => setLayer(index, { reverse })}
                  />
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      <SamplePicker
        open={picking !== null}
        title={
          picking?.kind === 'replace'
            ? `Change the sample on layer ${picking.layerIndex + 1}`
            : `Add a layer to pad ${padIndex + 1}`
        }
        onClose={() => setPicking(null)}
        onChoose={applyPick}
        data-testid="layer-sample-picker"
      />
    </section>
  );
}
