/**
 * Pad Perform mode — spec §8.5.9: a 16-pad grid locked to a scale (or to chord sets), with
 * root and octave selectors, routing notes to the active keygroup program.
 *
 * Notes leave through the shared dual-path trigger (spec §7.6), so a performance here is
 * auditioned immediately and captured by the scheduler when recording — the same path the
 * BLE controller uses (spec §10.4), not a parallel one.
 */
import { useCallback, useRef, useState } from 'react';
import { useProgramStore } from '@/store';
import { FieldLabel, Pad, SegmentControl } from '@/ui/primitives';
import { Panel } from '@/ui/shell/Panel';
import { usePadTrigger } from '@/ui/usePadTrigger';
import {
  CHORD_SETS,
  SCALES,
  SCALE_IDS,
  chordNotes,
  noteName,
  scaleNotes,
  type ChordSetId,
  type ScaleId,
} from './scales';

const PAD_COUNT = 16;
const SEMITONES_PER_OCTAVE = 12;

type PerformMode = 'scale' | 'chords';

const PITCH_CLASS_OPTIONS = [
  { value: 0, label: 'C' },
  { value: 1, label: 'C♯' },
  { value: 2, label: 'D' },
  { value: 3, label: 'D♯' },
  { value: 4, label: 'E' },
  { value: 5, label: 'F' },
  { value: 6, label: 'F♯' },
  { value: 7, label: 'G' },
  { value: 8, label: 'G♯' },
  { value: 9, label: 'A' },
  { value: 10, label: 'A♯' },
  { value: 11, label: 'B' },
];

const OCTAVE_OPTIONS = [1, 2, 3, 4, 5, 6].map((octave) => ({ value: octave, label: `${octave}` }));

export function PadPerformMode() {
  const activeProgramId = useProgramStore((s) => s.activeProgramId);
  const programs = useProgramStore((s) => s.programs);
  const { trigger, release, trackId } = usePadTrigger();

  const [performMode, setPerformMode] = useState<PerformMode>('scale');
  const [scale, setScale] = useState<ScaleId>('major');
  const [chordSet, setChordSet] = useState<ChordSetId>('triads');
  const [pitchClass, setPitchClass] = useState(0);
  const [octave, setOctave] = useState(4);

  /** Notes a chord pad sounded, so release can close exactly those (spec §7.7). */
  const soundingChords = useRef(new Map<number, number[]>());

  // MIDI note for the chosen root: C4 is 60, so octave o starts at (o + 1) * 12.
  const root = (octave + 1) * SEMITONES_PER_OCTAVE + pitchClass;

  const activeProgram = activeProgramId ? programs[activeProgramId] : undefined;
  const chords = CHORD_SETS[chordSet];
  const notes = scaleNotes(scale, root, PAD_COUNT);

  const handleTrigger = useCallback(
    (padIndex: number, velocity: number) => {
      if (performMode === 'scale') {
        const note = notes[padIndex];
        if (note === undefined) return;
        trigger(note, velocity);
        return;
      }
      // Chord pads: each pad is one chord quality, voiced from the current root.
      const chord = chords[padIndex % chords.length];
      if (!chord) return;
      const chordRoot = root + Math.floor(padIndex / chords.length) * SEMITONES_PER_OCTAVE;
      const voiced = chordNotes(chordSet, chord.id, chordRoot);
      soundingChords.current.set(padIndex, voiced);
      for (const note of voiced) trigger(note, velocity);
    },
    [chordSet, chords, notes, performMode, root, trigger],
  );

  const handleRelease = useCallback(
    (padIndex: number) => {
      if (performMode === 'scale') {
        const note = notes[padIndex];
        if (note !== undefined) release(note);
        return;
      }
      const voiced = soundingChords.current.get(padIndex);
      if (!voiced) return;
      soundingChords.current.delete(padIndex);
      for (const note of voiced) release(note);
    },
    [notes, performMode, release],
  );

  /** Pad face: the note name, or the chord quality with its root. */
  const padLabel = (padIndex: number): string => {
    if (performMode === 'scale') {
      const note = notes[padIndex];
      return note === undefined ? '—' : noteName(note);
    }
    const chord = chords[padIndex % chords.length];
    if (!chord) return '—';
    const chordRoot = root + Math.floor(padIndex / chords.length) * SEMITONES_PER_OCTAVE;
    return `${noteName(chordRoot)} ${chord.label}`;
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <Panel
        title="Performance"
        actions={
          <SegmentControl
            label="Perform with"
            value={performMode}
            options={[
              { value: 'scale', label: 'Scale' },
              { value: 'chords', label: 'Chords' },
            ]}
            size="sm"
            onChange={setPerformMode}
            data-testid="perform-mode"
          />
        }
      >
        <div className="flex flex-wrap items-center gap-4">
          <FieldLabel as="span">
            Root
            <SegmentControl
              label="Root note"
              value={pitchClass}
              options={PITCH_CLASS_OPTIONS}
              size="sm"
              onChange={setPitchClass}
              data-testid="perform-root"
            />
          </FieldLabel>
          <FieldLabel as="span">
            Octave
            <SegmentControl
              label="Octave"
              value={octave}
              options={OCTAVE_OPTIONS}
              size="sm"
              onChange={setOctave}
              data-testid="perform-octave"
            />
          </FieldLabel>

          {performMode === 'scale' ? (
            <FieldLabel>
              Scale
              <select
                aria-label="Scale"
                value={scale}
                onChange={(event) => setScale(event.target.value as ScaleId)}
                data-testid="perform-scale"
                className="rounded-bb-sm border border-bb-line bg-bb-raised px-2 py-1 text-xs font-normal text-bb-text normal-case"
              >
                {SCALE_IDS.map((id) => (
                  <option key={id} value={id}>
                    {SCALES[id].label}
                  </option>
                ))}
              </select>
            </FieldLabel>
          ) : (
            <FieldLabel as="span">
              Chord set
              <SegmentControl
                label="Chord set"
                value={chordSet}
                options={[
                  { value: 'triads', label: 'Triads' },
                  { value: 'sevenths', label: '7ths' },
                ]}
                size="sm"
                onChange={setChordSet}
                data-testid="perform-chord-set"
              />
            </FieldLabel>
          )}
        </div>

        {activeProgram?.type !== 'keygroup' && (
          // Spec §8.5.9.
          <p className="mt-3 text-xs text-bb-muted">
            Notes route to the active program. Select a keygroup program for pitched playing; a drum program
            will map these notes to its pads.
          </p>
        )}
      </Panel>

      <Panel title="Pads" fill>
        <div className="grid min-h-0 flex-1 grid-cols-4 grid-rows-4 gap-2">
          {Array.from({ length: PAD_COUNT }, (_, padIndex) => (
            <Pad
              key={padIndex}
              label={padLabel(padIndex)}
              padIndex={padIndex}
              assigned
              disabled={trackId === null}
              onTrigger={handleTrigger}
              onRelease={handleRelease}
              fill
              data-testid={`perform-pad-${padIndex}`}
            />
          ))}
        </div>
        {trackId === null && (
          <p className="mt-3 shrink-0 text-xs text-bb-muted">Add a track to the active sequence to play.</p>
        )}
      </Panel>
    </div>
  );
}
