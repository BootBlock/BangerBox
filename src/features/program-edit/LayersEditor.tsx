/**
 * Velocity-layer editor for a drum pad (spec §6, §8.5.5). Lists the pad's velocity layers
 * with editable velocity range, tune and gain; sample assignment is done by dragging from
 * the Browser (spec §8.5.7), so this edits the layers a pad already has. Every
 * change is committed by the parent through the program store (spec §3.4, §4.5).
 */
import {
  GAIN_DB_RANGE,
  TUNE_CENTS_RANGE,
  TUNE_SEMITONES_RANGE,
  type VelocityLayer,
} from '@/core/project/schemas';
import { Button, EmptyState } from '@/ui/primitives';
import { IconRemove } from '@/ui/icons';
import { NumberField, ToggleField } from './controls';

export function LayersEditor({
  layers,
  onChange,
}: {
  layers: readonly VelocityLayer[];
  onChange: (layers: VelocityLayer[]) => void;
}) {
  const setLayer = (index: number, patch: Partial<VelocityLayer>) =>
    onChange(layers.map((layer, i) => (i === index ? { ...layer, ...patch } : layer)));
  const removeLayer = (index: number) => onChange(layers.filter((_, i) => i !== index));

  return (
    <section aria-label="Velocity layers" className="rounded-bb-sm border border-bb-line bg-bb-surface p-3">
      <h4 className="mb-2 text-xs font-semibold text-bb-text">Velocity layers</h4>
      {layers.length === 0 ? (
        <EmptyState message="No layers yet." />
      ) : (
        <ul className="flex flex-col gap-3">
          {layers.map((layer, index) => (
            <li key={index} className="rounded-bb-sm border border-bb-line p-2">
              <div className="mb-1 flex items-center justify-between">
                <span className="text-xs text-bb-muted">Sample {layer.sampleId.slice(0, 8)}</span>
                <Button
                  label={`Remove layer ${index + 1}`}
                  variant="danger"
                  size="sm"
                  iconOnly
                  icon={<IconRemove size={14} aria-hidden="true" />}
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
      )}
    </section>
  );
}
