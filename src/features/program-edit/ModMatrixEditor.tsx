/**
 * Modulation-matrix editor (spec §8.5.5, §6) — add/remove routes with source/target/amount
 * pickers from the §6 model. Insert-parameter targets are addressed in the Mixer mode's
 * {@link InsertPanel}; this picker covers the fixed sound-design targets. Every change is
 * committed by the parent through the program store (spec §3.4, §4.5).
 */
import { MOD_AMOUNT_RANGE, type ModRoute, type ModSource } from '@/core/project/schemas';
import { Button } from '@/ui/primitives';
import { IconRemove } from '@/ui/icons';
import { NumberField, SelectField } from './controls';

const SOURCES: readonly { value: ModSource; label: string }[] = [
  { value: 'lfo1', label: 'LFO 1' },
  { value: 'lfo2', label: 'LFO 2' },
  { value: 'ampEnv', label: 'Amp env' },
  { value: 'pitchEnv', label: 'Pitch env' },
  { value: 'filterEnv', label: 'Filter env' },
  { value: 'velocity', label: 'Velocity' },
  { value: 'random', label: 'Random' },
  { value: 'noteNumber', label: 'Note number' },
];

/** The fixed sound-design targets offered by the picker (spec §6 ModTarget). */
const TARGETS = [
  { value: 'pitch', label: 'Pitch' },
  { value: 'filterCutoff', label: 'Filter cutoff' },
  { value: 'filterResonance', label: 'Filter resonance' },
  { value: 'pan', label: 'Pan' },
  { value: 'amp', label: 'Amp' },
  { value: 'layerStart', label: 'Layer start' },
  { value: 'lfo1Rate', label: 'LFO 1 rate' },
  { value: 'lfo2Rate', label: 'LFO 2 rate' },
] as const;

type FixedTarget = (typeof TARGETS)[number]['value'];

export function ModMatrixEditor({
  routes,
  onChange,
}: {
  routes: readonly ModRoute[];
  onChange: (routes: ModRoute[]) => void;
}) {
  const setRoute = (index: number, patch: Partial<ModRoute>) => {
    onChange(routes.map((route, i) => (i === index ? { ...route, ...patch } : route)));
  };
  const addRoute = () => onChange([...routes, { source: 'lfo1', target: 'pitch', amount: 0.5 }]);
  const removeRoute = (index: number) => onChange(routes.filter((_, i) => i !== index));

  return (
    <section aria-label="Modulation matrix" className="rounded-bb-sm border border-bb-line bg-bb-surface p-3">
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-xs font-semibold text-bb-text">Mod matrix</h4>
        <Button label="Add route" size="sm" onClick={addRoute} />
      </div>
      {routes.length === 0 ? (
        <p className="text-xs text-bb-muted">No routes. Add one to modulate a parameter.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {routes.map((route, index) => (
            <li key={index} className="grid grid-cols-2 items-end gap-2 sm:grid-cols-4">
              <SelectField
                label="Source"
                value={route.source}
                options={SOURCES}
                onChange={(source) => setRoute(index, { source })}
              />
              <SelectField
                label="Target"
                value={route.target as FixedTarget}
                options={TARGETS}
                onChange={(target) => setRoute(index, { target })}
              />
              <NumberField
                label="Amount"
                value={route.amount}
                min={MOD_AMOUNT_RANGE[0]}
                max={MOD_AMOUNT_RANGE[1]}
                step={0.05}
                onChange={(amount) => setRoute(index, { amount })}
              />
              <Button
                label={`Remove route ${index + 1}`}
                variant="danger"
                size="sm"
                iconOnly
                icon={<IconRemove size={14} aria-hidden="true" />}
                onClick={() => removeRoute(index)}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
