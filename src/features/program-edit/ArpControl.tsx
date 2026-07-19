/**
 * Arpeggiator performance control (spec §7.3, §8.5.5). A small live control that drives the
 * running scheduler's arpeggiator directly (`engine.scheduler.setArpeggiator`) — the arp is
 * a worker-side performance feature shared with note repeat (spec §7.3). This is the arp's
 * settings surface; Pad Perform mode (§8.5.9) plays into the same running arpeggiator.
 */
import { useEffect, useState } from 'react';
import { getAudioEngine } from '@/core/project';
import type { ArpConfig, ArpMode } from '@/core/sequencer';
import { NumberField, SelectField, ToggleField } from './controls';

const MODES: readonly { value: ArpMode; label: string }[] = [
  { value: 'up', label: 'Up' },
  { value: 'down', label: 'Down' },
  { value: 'upDown', label: 'Up / down' },
  { value: 'played', label: 'As played' },
  { value: 'random', label: 'Random' },
];

const DIVISIONS = [
  { value: '16', label: '1/16' },
  { value: '8', label: '1/8' },
  { value: '4', label: '1/4' },
  { value: '16t', label: '1/16 triplet' },
] as const;

type DivisionValue = (typeof DIVISIONS)[number]['value'];

function toDivision(value: DivisionValue): ArpConfig['division'] {
  if (value === '16t') return { value: 16, triplet: true };
  return { value: Number(value) as 4 | 8 | 16, triplet: false };
}

export function ArpControl() {
  const [enabled, setEnabled] = useState(false);
  const [mode, setMode] = useState<ArpMode>('up');
  const [octaves, setOctaves] = useState(1);
  const [gate, setGate] = useState(0.5);
  const [division, setDivision] = useState<DivisionValue>('16');

  // Push the current arp settings to the running scheduler whenever they change (spec §7.3).
  useEffect(() => {
    getAudioEngine()?.scheduler.setArpeggiator(enabled, {
      mode,
      octaves,
      gate,
      division: toDivision(division),
    });
  }, [enabled, mode, octaves, gate, division]);

  return (
    <section aria-label="Arpeggiator" className="rounded-bb-sm border border-bb-line bg-bb-surface p-3">
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-xs font-semibold text-bb-text">Arpeggiator</h4>
        <ToggleField label="Enabled" checked={enabled} onChange={setEnabled} />
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <SelectField label="Mode" value={mode} options={MODES} onChange={setMode} />
        <NumberField label="Octaves" value={octaves} min={1} max={4} step={1} onChange={setOctaves} />
        <NumberField label="Gate" value={gate} min={0.05} max={1} step={0.05} onChange={setGate} />
        <SelectField label="Division" value={division} options={DIVISIONS} onChange={setDivision} />
      </div>
      <p className="mt-2 text-xs text-bb-muted">
        Drives a keygroup track&rsquo;s held chord while the transport plays (start the engine first).
      </p>
    </section>
  );
}
