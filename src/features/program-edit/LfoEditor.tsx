/**
 * LFO editor for the Program Edit deep editors (spec §8.5.5 "2 LFOs", §6 LfoConfig) — the
 * `lfos` tuple carried by both `Pad` and `KeygroupProgram`. Until this existed a user could
 * route `lfo1` in the mod matrix and hear a modulation with no way to shape it (issue #56).
 *
 * The engine applies `rate`, `sync`, `shape`, `phaseOffset` and `retrigger` (issue #107);
 * `lfoOscillator` still approximates `sampleHold` and `drift` with a square and a sine, and
 * the panel names those two rather than implying a shape the user will not get.
 *
 * `rate` is disabled while a note division is selected, because the division is what decides
 * the rate then — leaving the field live would offer a value nothing reads.
 */
import { LFO_PHASE_RANGE, LFO_RATE_RANGE, NOTE_DIVISIONS, type LfoConfig } from '@/core/project/schemas';
import { ControlGroup, NumberField, SelectField, ToggleField } from './controls';

const SYNC_OPTIONS: readonly { value: LfoConfig['sync']; label: string }[] = [
  { value: 'free', label: 'Free' },
  ...NOTE_DIVISIONS.map((division) => ({ value: division, label: division })),
];

const SHAPES: readonly { value: LfoConfig['shape']; label: string }[] = [
  { value: 'sine', label: 'Sine' },
  { value: 'triangle', label: 'Triangle' },
  { value: 'sawUp', label: 'Saw up' },
  { value: 'sawDown', label: 'Saw down' },
  { value: 'square', label: 'Square' },
  { value: 'sampleHold', label: 'Sample & hold' },
  { value: 'drift', label: 'Drift' },
];

/** The parts of this LFO's settings the current engine stores but does not render exactly. */
function engineCaveats(lfo: LfoConfig): string[] {
  const caveats: string[] = [];
  if (lfo.shape === 'sampleHold') caveats.push('Sample & hold is approximated by a square wave.');
  if (lfo.shape === 'drift') caveats.push('Drift is approximated by a sine wave.');
  return caveats;
}

function LfoPanel({
  index,
  lfo,
  onChange,
}: {
  index: number;
  lfo: LfoConfig;
  onChange: (lfo: LfoConfig) => void;
}) {
  const set = (patch: Partial<LfoConfig>) => onChange({ ...lfo, ...patch });
  // Two LFOs share a screen, so every accessible name is qualified (spec §8.2).
  const name = `LFO ${index + 1}`;
  const caveats = engineCaveats(lfo);
  return (
    <ControlGroup title={name}>
      <NumberField
        label={`${name} rate`}
        suffix="Hz"
        value={lfo.rate}
        min={LFO_RATE_RANGE[0]}
        max={LFO_RATE_RANGE[1]}
        step={0.01}
        // A synced LFO takes its rate from the division and the transport tempo (spec §6),
        // so the Hz field is not what is heard while one is chosen.
        disabled={lfo.sync !== 'free'}
        onChange={(rate) => set({ rate })}
      />
      <SelectField
        label={`${name} sync`}
        value={lfo.sync}
        options={SYNC_OPTIONS}
        onChange={(sync) => set({ sync })}
      />
      <SelectField
        label={`${name} shape`}
        value={lfo.shape}
        options={SHAPES}
        onChange={(shape) => set({ shape })}
      />
      <NumberField
        label={`${name} phase offset`}
        value={lfo.phaseOffset}
        min={LFO_PHASE_RANGE[0]}
        max={LFO_PHASE_RANGE[1]}
        step={0.01}
        onChange={(phaseOffset) => set({ phaseOffset })}
      />
      <div className="col-span-full flex flex-col gap-1">
        <ToggleField
          label={`${name} retrigger`}
          checked={lfo.retrigger}
          onChange={(retrigger) => set({ retrigger })}
        />
        {caveats.length > 0 && (
          <ul aria-label={`${name} engine notes`} className="flex flex-col gap-1 text-xs text-bb-muted">
            {caveats.map((caveat) => (
              <li key={caveat}>{caveat}</li>
            ))}
          </ul>
        )}
      </div>
    </ControlGroup>
  );
}

/** Both §6 LFOs. Controlled — the parent commits the new tuple through the program store. */
export function LfoEditor({
  lfos,
  onChange,
}: {
  lfos: readonly [LfoConfig, LfoConfig];
  onChange: (lfos: [LfoConfig, LfoConfig]) => void;
}) {
  return (
    <>
      <LfoPanel index={0} lfo={lfos[0]} onChange={(lfo) => onChange([lfo, lfos[1]])} />
      <LfoPanel index={1} lfo={lfos[1]} onChange={(lfo) => onChange([lfos[0], lfo])} />
    </>
  );
}
