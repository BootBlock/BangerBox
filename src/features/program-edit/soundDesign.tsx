/**
 * Shared §6 sound-design editors — the amp AHDSR envelope and the filter — reused by the
 * drum pad editor and the keygroup editor (spec §8.5.5, §6). Every control is wired to an
 * `onChange` the parent commits through the program store (spec §3.4 no dead controls).
 */
import {
  ENVELOPE_LEVEL_RANGE,
  FILTER_CUTOFF_RANGE,
  FILTER_ENV_DEPTH_RANGE,
  FILTER_RESONANCE_RANGE,
  type AhdsrEnvelope,
  type PadFilter,
} from '@/core/project/schemas';
import { ControlGroup, NumberField, SelectField } from './controls';

const FILTER_TYPES = [
  { value: 'off', label: 'Off' },
  { value: 'lp', label: 'Low-pass' },
  { value: 'hp', label: 'High-pass' },
  { value: 'bp', label: 'Band-pass' },
] as const;

const CURVES = [
  { value: 'linear', label: 'Linear' },
  { value: 'exponential', label: 'Exponential' },
] as const;

/** Amp AHDSR editor (spec §6 AhdsrEnvelope). Times in ms, sustain 0..1. */
export function EnvelopeEditor({
  envelope,
  onChange,
}: {
  envelope: AhdsrEnvelope;
  onChange: (envelope: AhdsrEnvelope) => void;
}) {
  const set = (patch: Partial<AhdsrEnvelope>) => onChange({ ...envelope, ...patch });
  return (
    <ControlGroup title="Amp envelope">
      <NumberField label="Attack" suffix="ms" value={envelope.attack} min={0} max={20_000} step={1} onChange={(attack) => set({ attack })} />
      <NumberField label="Hold" suffix="ms" value={envelope.hold} min={0} max={20_000} step={1} onChange={(hold) => set({ hold })} />
      <NumberField label="Decay" suffix="ms" value={envelope.decay} min={0} max={20_000} step={1} onChange={(decay) => set({ decay })} />
      <NumberField
        label="Sustain"
        value={envelope.sustain}
        min={ENVELOPE_LEVEL_RANGE[0]}
        max={ENVELOPE_LEVEL_RANGE[1]}
        step={0.01}
        onChange={(sustain) => set({ sustain })}
      />
      <NumberField label="Release" suffix="ms" value={envelope.release} min={0} max={20_000} step={1} onChange={(release) => set({ release })} />
      <SelectField label="Curve" value={envelope.curve} options={CURVES} onChange={(curve) => set({ curve })} />
    </ControlGroup>
  );
}

/** Filter editor (spec §6 pad filter). */
export function FilterEditor({
  filter,
  onChange,
}: {
  filter: PadFilter;
  onChange: (filter: PadFilter) => void;
}) {
  const set = (patch: Partial<PadFilter>) => onChange({ ...filter, ...patch });
  return (
    <ControlGroup title="Filter">
      <SelectField label="Type" value={filter.type} options={FILTER_TYPES} onChange={(type) => set({ type })} />
      <NumberField
        label="Cutoff"
        suffix="Hz"
        value={filter.cutoff}
        min={FILTER_CUTOFF_RANGE[0]}
        max={FILTER_CUTOFF_RANGE[1]}
        step={10}
        onChange={(cutoff) => set({ cutoff })}
      />
      <NumberField
        label="Resonance"
        value={filter.resonance}
        min={FILTER_RESONANCE_RANGE[0]}
        max={FILTER_RESONANCE_RANGE[1]}
        step={0.1}
        onChange={(resonance) => set({ resonance })}
      />
      <NumberField
        label="Env depth"
        value={filter.envDepth}
        min={FILTER_ENV_DEPTH_RANGE[0]}
        max={FILTER_ENV_DEPTH_RANGE[1]}
        step={0.05}
        onChange={(envDepth) => set({ envDepth })}
      />
    </ControlGroup>
  );
}
