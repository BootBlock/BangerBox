/**
 * Keygroup-program editor (spec §8.5.5, §6). Edits the program-scope sound-design surface a
 * keygroup shares (amp envelope, filter, mod matrix) plus the keygroup-specific voice
 * settings (polyphony, glide, pitch-bend range) and its key/velocity zones. Zone sample
 * assignment is via the Browser (Phase 6, spec §8.5.7). Commits go through the program store
 * as undoable edits (spec §4.5).
 */
import {
  GAIN_DB_RANGE,
  GLIDE_MS_MIN,
  NOTE_RANGE,
  PITCH_BEND_RANGE_SEMITONES,
  POLYPHONY_RANGE,
  ROOT_NOTE_RANGE,
  TUNE_CENTS_RANGE,
  type KeygroupProgram,
  type KeygroupZone,
} from '@/core/project/schemas';
import { useProgramStore } from '@/store';
import { ControlGroup, NumberField } from './controls';
import { EnvelopeEditor, FilterEditor } from './soundDesign';
import { ModMatrixEditor } from './ModMatrixEditor';

export function KeygroupEditor({ program }: { program: KeygroupProgram }) {
  const updateProgram = useProgramStore((state) => state.updateProgram);

  const patch = (next: Partial<KeygroupProgram>, label: string) =>
    updateProgram(program.id, (current) => (current.type === 'keygroup' ? { ...current, ...next } : current), label);

  const setZone = (index: number, zonePatch: Partial<KeygroupZone>) =>
    patch({ zones: program.zones.map((zone, i) => (i === index ? { ...zone, ...zonePatch } : zone)) }, 'Edit zone');

  return (
    <div className="flex flex-col gap-3">
      <ControlGroup title="Keygroup voice">
        <NumberField
          label="Polyphony"
          value={program.polyphony}
          min={POLYPHONY_RANGE[0]}
          max={POLYPHONY_RANGE[1]}
          step={1}
          onChange={(polyphony) => patch({ polyphony }, 'Set polyphony')}
        />
        <NumberField
          label="Glide"
          suffix="ms"
          value={program.glideMs}
          min={GLIDE_MS_MIN}
          max={2000}
          step={5}
          onChange={(glideMs) => patch({ glideMs }, 'Set glide')}
        />
        <NumberField
          label="Bend range"
          suffix="st"
          value={program.pitchBendRange}
          min={PITCH_BEND_RANGE_SEMITONES[0]}
          max={PITCH_BEND_RANGE_SEMITONES[1]}
          step={1}
          onChange={(pitchBendRange) => patch({ pitchBendRange }, 'Set bend range')}
        />
      </ControlGroup>

      <EnvelopeEditor
        envelope={program.envelopes.amp}
        onChange={(amp) => patch({ envelopes: { ...program.envelopes, amp } }, 'Edit envelope')}
      />
      <FilterEditor filter={program.filter} onChange={(filter) => patch({ filter }, 'Edit filter')} />
      <ModMatrixEditor routes={program.modMatrix} onChange={(modMatrix) => patch({ modMatrix }, 'Edit mod matrix')} />

      <section aria-label="Key zones" className="rounded-bb-sm border border-bb-line bg-bb-surface p-3">
        <h4 className="mb-2 text-xs font-semibold text-bb-text">Key zones</h4>
        {program.zones.length === 0 ? (
          <p className="text-xs text-bb-muted">No zones yet — assign a sample from the Browser (Phase 6).</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {program.zones.map((zone, index) => (
              <li key={index} className="rounded-bb-sm border border-bb-line p-2">
                <span className="mb-1 block text-xs text-bb-muted">Sample {zone.sampleId.slice(0, 8)}</span>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  <NumberField label="Root" value={zone.rootNote} min={ROOT_NOTE_RANGE[0]} max={ROOT_NOTE_RANGE[1]} step={1} onChange={(rootNote) => setZone(index, { rootNote })} />
                  <NumberField label="Low note" value={zone.lowNote} min={NOTE_RANGE[0]} max={NOTE_RANGE[1]} step={1} onChange={(lowNote) => setZone(index, { lowNote })} />
                  <NumberField label="High note" value={zone.highNote} min={NOTE_RANGE[0]} max={NOTE_RANGE[1]} step={1} onChange={(highNote) => setZone(index, { highNote })} />
                  <NumberField label="Fine" suffix="cents" value={zone.tuneCents} min={TUNE_CENTS_RANGE[0]} max={TUNE_CENTS_RANGE[1]} step={1} onChange={(tuneCents) => setZone(index, { tuneCents })} />
                  <NumberField label="Gain" suffix="dB" value={zone.gainDb} min={GAIN_DB_RANGE[0]} max={GAIN_DB_RANGE[1]} step={0.5} onChange={(gainDb) => setZone(index, { gainDb })} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
