/**
 * Velocity-layer editor for a drum pad (spec §6, §8.5.5). Lists the pad's velocity layers
 * with editable velocity range, tune and gain; sample assignment is done by dragging from
 * the Browser (spec §8.5.7), so this edits the layers a pad already has. Every
 * change is committed by the parent through the program store (spec §3.4, §4.5).
 *
 * The §8.5.5 drag-ranges bar sits above the list and shows every layer on one 0..127 axis,
 * which is the only view that makes an overlap or an uncovered velocity band visible — reading
 * that off a column of spinners means comparing every row against every other. The spinners
 * stay: the bar is `role="img"` and pointer-only, so they remain the keyboard route to the same
 * values (spec §8.2), and selecting a layer in either place highlights it in both.
 */
import { useState } from 'react';
import {
  GAIN_DB_RANGE,
  TUNE_CENTS_RANGE,
  TUNE_SEMITONES_RANGE,
  type VelocityLayer,
} from '@/core/project/schemas';
import { Button } from '@/ui/primitives';
import { NumberField, ToggleField } from './controls';
import { VelocityRangeBar } from './VelocityRangeBar';

export function LayersEditor({
  layers,
  onChange,
}: {
  layers: readonly VelocityLayer[];
  onChange: (layers: VelocityLayer[]) => void;
}) {
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const setLayer = (index: number, patch: Partial<VelocityLayer>) =>
    onChange(layers.map((layer, i) => (i === index ? { ...layer, ...patch } : layer)));
  const removeLayer = (index: number) => {
    // The selection is positional, so removing a layer above the selected one would otherwise
    // leave the highlight pointing at a different layer than the user picked.
    setSelectedIndex((current) => (current === index ? -1 : current > index ? current - 1 : current));
    onChange(layers.filter((_, i) => i !== index));
  };

  return (
    <section aria-label="Velocity layers" className="rounded-bb-sm border border-bb-line bg-bb-surface p-3">
      <h4 className="mb-2 text-xs font-semibold text-bb-text">Velocity layers</h4>
      {layers.length === 0 ? (
        <p className="text-xs text-bb-muted">No layers yet — assign a sample by dragging from the Browser.</p>
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
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs text-bb-muted">Sample {layer.sampleId.slice(0, 8)}</span>
                  <Button
                    label="Remove"
                    accessibleName={`Remove layer ${index + 1}`}
                    variant="danger"
                    size="sm"
                    onClick={() => removeLayer(index)}
                  />
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
    </section>
  );
}
