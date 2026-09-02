/**
 * Keygroup-program editor (spec §8.5.5, §6). Edits the program-scope sound-design surface a
 * keygroup shares (amp envelope, filter, mod matrix) plus the keygroup-specific voice
 * settings (polyphony, glide, pitch-bend range) and its key/velocity zones. Zones are
 * assigned here — "Add sample…" opens the picker, and the zone list is a drop target for a
 * sample armed in the Browser (spec §8.5.7). Commits go through the program store as
 * undoable edits (spec §4.5).
 *
 * A new zone takes an equal share of the keyboard rather than spanning all of it: §6 lets
 * zones overlap and `selectKeygroupZone` takes the first that covers a note, so leaving every
 * zone at 0..127 would make each one after the first unreachable (spec §3.4).
 *
 * The zones lead with the §8.5.5 keyboard editor, which is the only view that shows where a
 * zone actually sits on the keys, which zones overlap and which notes are silent. The numeric
 * fields below it stay: the keyboard is `role="img"`, so they are what keep zone editing
 * possible without a pointer (spec §8.2), and a zone selected in either place lights up in both.
 */
import { useState } from 'react';
import type { SampleRow } from '@/core/storage/repositories';
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
import { useProgramStore, useUIStore } from '@/store';
import { announce, Button, EmptyState } from '@/ui/primitives';
import { ControlGroup, NumberField } from './controls';
import { EnvelopeEditor, FilterEditor } from './soundDesign';
import { KeyZoneEditor } from './KeyZoneEditor';
import { LfoEditor } from './LfoEditor';
import { ModMatrixEditor } from './ModMatrixEditor';
import { SamplePicker } from './SamplePicker';

/** Which assignment the open picker is filling: a new zone, or an existing one's sample. */
type PickerTarget = { readonly kind: 'add' } | { readonly kind: 'replace'; readonly zoneIndex: number };

export function KeygroupEditor({ program }: { program: KeygroupProgram }) {
  const updateProgram = useProgramStore((state) => state.updateProgram);
  const addKeygroupZone = useProgramStore((state) => state.addKeygroupZone);
  const setZoneSample = useProgramStore((state) => state.setZoneSample);
  const dragDropPayload = useUIStore((state) => state.dragDropPayload);
  const [selectedZone, setSelectedZone] = useState(-1);
  const [picking, setPicking] = useState<PickerTarget | null>(null);

  /** Report an assignment both on screen and through the shell's single live region (§8.2). */
  const report = (ok: boolean, message: string) => {
    useUIStore.getState().pushToast(message, ok ? 'success' : 'warning');
    announce(message);
  };

  /** Apply the picked sample to whichever target opened the picker (spec §6). */
  const applyPick = (sample: SampleRow) => {
    if (picking === null) return;
    const result =
      picking.kind === 'add'
        ? addKeygroupZone(program.id, sample.id, sample.root_note)
        : setZoneSample(program.id, picking.zoneIndex, sample.id);
    report(
      result.ok,
      result.ok
        ? picking.kind === 'add'
          ? `${sample.name} added as a key zone.`
          : `Zone ${picking.zoneIndex + 1} now plays ${sample.name}.`
        : result.reason,
    );
    // A refusal leaves the picker open so the user can choose again or read why not.
    if (result.ok) setPicking(null);
  };

  /** Take the sample armed in the Browser as a new zone, and disarm (spec §8.5.7). */
  const assignArmed = () => {
    if (dragDropPayload === null) return;
    const result = addKeygroupZone(program.id, dragDropPayload.sampleId);
    report(result.ok, result.ok ? `${dragDropPayload.name} added as a key zone.` : result.reason);
    // Disarm either way, so a refusal cannot silently re-fire on the next interaction.
    useUIStore.getState().setDragDropPayload(null);
  };

  const patch = (next: Partial<KeygroupProgram>, label: string) =>
    updateProgram(
      program.id,
      (current) => (current.type === 'keygroup' ? { ...current, ...next } : current),
      label,
    );

  const setZone = (index: number, zonePatch: Partial<KeygroupZone>) =>
    patch(
      { zones: program.zones.map((zone, i) => (i === index ? { ...zone, ...zonePatch } : zone)) },
      'Edit zone',
    );

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
      {/* Before the mod matrix: the matrix routes lfo1/lfo2 somewhere, so their shape is
          the thing you set first and the thing the matrix's source names refer back to. */}
      <LfoEditor lfos={program.lfos} onChange={(lfos) => patch({ lfos }, 'Edit LFO')} />
      <ModMatrixEditor
        routes={program.modMatrix}
        onChange={(modMatrix) => patch({ modMatrix }, 'Edit mod matrix')}
      />

      <section
        aria-label="Key zones"
        className="rounded-bb-sm border border-bb-line bg-bb-surface p-3"
        // Drop target for a drag that starts and ends inside this mode (spec §8.5.7).
        // `preventDefault` on dragover is what marks an element as a valid drop target.
        onDragOver={(event) => {
          if (dragDropPayload === null) return;
          event.preventDefault();
        }}
        onDrop={(event) => {
          event.preventDefault();
          assignArmed();
        }}
      >
        <div className="mb-2 flex items-center justify-between gap-2">
          <h4 className="text-xs font-semibold text-bb-text">Key zones</h4>
          <Button
            label="Add sample…"
            variant="accent"
            size="sm"
            data-testid="zone-add"
            onClick={() => setPicking({ kind: 'add' })}
          />
        </div>
        {/* The armed-sample banner (spec §8.5.7). Not a live region: §8.2 allows one, the
            shell's. The button below carries the same news to assistive tech by name. */}
        {dragDropPayload !== null && (
          <div
            data-testid="zone-assign-armed"
            className="mb-2 flex flex-wrap items-center gap-2 rounded-bb-sm border border-bb-accent p-2 text-xs"
          >
            <span className="flex-1">
              Assigning <strong className="font-semibold">{dragDropPayload.name}</strong>.
            </span>
            <Button
              label="Add as key zone"
              accessibleName={`Add as key zone: ${dragDropPayload.name}`}
              variant="accent"
              size="sm"
              data-testid="zone-assign-armed-confirm"
              onClick={assignArmed}
            />
            <Button
              label="Cancel assignment"
              variant="quiet"
              size="sm"
              data-testid="zone-assign-cancel"
              onClick={() => useUIStore.getState().setDragDropPayload(null)}
            />
          </div>
        )}
        {program.zones.length === 0 ? (
          <EmptyState
            message="No zones yet, so this program makes no sound."
            hint="Add a sample with the button above, or drag one from the Browser onto this panel."
            data-testid="zones-empty"
          />
        ) : (
          <>
            <div className="mb-3">
              <KeyZoneEditor
                zones={program.zones}
                onChange={(zones) => patch({ zones }, 'Edit zone')}
                selectedIndex={selectedZone}
                onSelect={setSelectedZone}
              />
            </div>
            <ul className="flex flex-col gap-3">
              {program.zones.map((zone, index) => (
                <li
                  key={index}
                  onFocusCapture={() => setSelectedZone(index)}
                  className={`rounded-bb-sm border p-2 ${
                    index === selectedZone ? 'border-bb-accent' : 'border-bb-line'
                  }`}
                >
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="text-xs text-bb-muted">Sample {zone.sampleId.slice(0, 8)}</span>
                    <Button
                      label="Change sample"
                      accessibleName={`Change sample on zone ${index + 1}`}
                      variant="quiet"
                      size="sm"
                      data-testid={`zone-change-${index}`}
                      onClick={() => setPicking({ kind: 'replace', zoneIndex: index })}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    <NumberField
                      label="Root"
                      value={zone.rootNote}
                      min={ROOT_NOTE_RANGE[0]}
                      max={ROOT_NOTE_RANGE[1]}
                      step={1}
                      onChange={(rootNote) => setZone(index, { rootNote })}
                    />
                    <NumberField
                      label="Low note"
                      value={zone.lowNote}
                      min={NOTE_RANGE[0]}
                      max={NOTE_RANGE[1]}
                      step={1}
                      onChange={(lowNote) => setZone(index, { lowNote })}
                    />
                    <NumberField
                      label="High note"
                      value={zone.highNote}
                      min={NOTE_RANGE[0]}
                      max={NOTE_RANGE[1]}
                      step={1}
                      onChange={(highNote) => setZone(index, { highNote })}
                    />
                    <NumberField
                      label="Fine"
                      suffix="cents"
                      value={zone.tuneCents}
                      min={TUNE_CENTS_RANGE[0]}
                      max={TUNE_CENTS_RANGE[1]}
                      step={1}
                      onChange={(tuneCents) => setZone(index, { tuneCents })}
                    />
                    <NumberField
                      label="Gain"
                      suffix="dB"
                      value={zone.gainDb}
                      min={GAIN_DB_RANGE[0]}
                      max={GAIN_DB_RANGE[1]}
                      step={0.5}
                      onChange={(gainDb) => setZone(index, { gainDb })}
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
              ? `Change the sample on zone ${picking.zoneIndex + 1}`
              : `Add a key zone to ${program.name}`
          }
          onClose={() => setPicking(null)}
          onChoose={applyPick}
          data-testid="zone-sample-picker"
        />
      </section>
    </div>
  );
}
