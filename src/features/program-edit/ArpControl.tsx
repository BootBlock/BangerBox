/**
 * Arpeggiator performance control (spec §7.3, §8.5.5). A small live control that drives the
 * running scheduler's arpeggiator directly (`engine.scheduler.setArpeggiator`) — the arp is
 * a worker-side performance feature shared with note repeat (spec §7.3). This is the arp's
 * settings surface; Pad Perform mode (§8.5.9) plays into the same running arpeggiator.
 *
 * The settings live in `useTransportStore`, not here (spec §1.3 #16). `AppShell` mounts only
 * the active mode, so component state would be destroyed on leaving Program Edit and this
 * effect would re-run on return with `enabled: false`, silently switching the arp off
 * mid-performance (issue #55).
 */
import { useEffect } from 'react';
import { getAudioEngine } from '@/core/project';
import type { ArpMode, NoteRepeatDivision } from '@/core/sequencer';
import { useTransportStore } from '@/store';
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

function toDivision(value: DivisionValue): NoteRepeatDivision {
  if (value === '16t') return { value: 16, triplet: true };
  return { value: Number(value) as 4 | 8 | 16, triplet: false };
}

/** The stored division as the select's value; anything unlisted reads as plain 1/16. */
function fromDivision(division: NoteRepeatDivision): DivisionValue {
  if (division.triplet) return division.value === 16 ? '16t' : '16';
  const value = String(division.value);
  return DIVISIONS.some((option) => option.value === value) ? (value as DivisionValue) : '16';
}

export function ArpControl() {
  const enabled = useTransportStore((state) => state.arpEnabled);
  const config = useTransportStore((state) => state.arpConfig);
  const setEnabled = useTransportStore((state) => state.setArpEnabled);
  const setConfig = useTransportStore((state) => state.setArpConfig);
  const { mode, octaves, gate, division } = config;

  // Push the current arp settings to the running scheduler whenever they change (spec §7.3).
  // Re-running this on remount is now harmless: it re-sends what the scheduler already has.
  useEffect(() => {
    getAudioEngine()?.scheduler.setArpeggiator(enabled, config);
  }, [enabled, config]);

  return (
    <section aria-label="Arpeggiator" className="rounded-bb-sm border border-bb-line bg-bb-surface p-3">
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-xs font-semibold text-bb-text">Arpeggiator</h4>
        <ToggleField label="Enabled" checked={enabled} onChange={setEnabled} />
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <SelectField
          label="Mode"
          value={mode}
          options={MODES}
          onChange={(next: ArpMode) => setConfig({ mode: next })}
        />
        <NumberField
          label="Octaves"
          value={octaves}
          min={1}
          max={4}
          step={1}
          onChange={(next) => setConfig({ octaves: next })}
        />
        <NumberField
          label="Gate"
          value={gate}
          min={0.05}
          max={1}
          step={0.05}
          onChange={(next) => setConfig({ gate: next })}
        />
        <SelectField
          label="Division"
          value={fromDivision(division)}
          options={DIVISIONS}
          onChange={(next: DivisionValue) => setConfig({ division: toDivision(next) })}
        />
      </div>
      <p className="mt-2 text-xs text-bb-muted">
        Drives a keygroup track&rsquo;s held chord while the transport plays (start the engine first).
      </p>
    </section>
  );
}
