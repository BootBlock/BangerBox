/**
 * Musical scale and chord tables for Pad Perform (spec §8.5.9). Pure and dependency-free
 * so it is trivially unit-testable (spec §2.5) — no DOM or audio types appear here.
 *
 * Scales are semitone offsets from the root within one octave; `scaleNotes` repeats the
 * pattern upward so a 16-pad grid spans as many octaves as it needs.
 */

export type ScaleId =
  | 'chromatic'
  | 'major'
  | 'naturalMinor'
  | 'harmonicMinor'
  | 'melodicMinor'
  | 'majorPentatonic'
  | 'minorPentatonic'
  | 'blues'
  | 'dorian'
  | 'phrygian'
  | 'lydian'
  | 'mixolydian'
  | 'locrian';

export interface ScaleDefinition {
  readonly label: string;
  /** Semitone offsets from the root, ascending, within one octave. */
  readonly intervals: readonly number[];
}

/** Every scale spec §8.5.9 requires, in the order it lists them. */
export const SCALES: Readonly<Record<ScaleId, ScaleDefinition>> = Object.freeze({
  chromatic: { label: 'Chromatic', intervals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
  major: { label: 'Major', intervals: [0, 2, 4, 5, 7, 9, 11] },
  naturalMinor: { label: 'Natural minor', intervals: [0, 2, 3, 5, 7, 8, 10] },
  harmonicMinor: { label: 'Harmonic minor', intervals: [0, 2, 3, 5, 7, 8, 11] },
  melodicMinor: { label: 'Melodic minor', intervals: [0, 2, 3, 5, 7, 9, 11] },
  majorPentatonic: { label: 'Major pentatonic', intervals: [0, 2, 4, 7, 9] },
  minorPentatonic: { label: 'Minor pentatonic', intervals: [0, 3, 5, 7, 10] },
  blues: { label: 'Blues', intervals: [0, 3, 5, 6, 7, 10] },
  dorian: { label: 'Dorian', intervals: [0, 2, 3, 5, 7, 9, 10] },
  phrygian: { label: 'Phrygian', intervals: [0, 1, 3, 5, 7, 8, 10] },
  lydian: { label: 'Lydian', intervals: [0, 2, 4, 6, 7, 9, 11] },
  mixolydian: { label: 'Mixolydian', intervals: [0, 2, 4, 5, 7, 9, 10] },
  locrian: { label: 'Locrian', intervals: [0, 1, 3, 5, 6, 8, 10] },
});

export const SCALE_IDS = Object.keys(SCALES) as ScaleId[];

const MIDI_MIN = 0;
const MIDI_MAX = 127;
const SEMITONES_PER_OCTAVE = 12;

/**
 * `count` ascending notes of `scale` from `root`, continuing into higher octaves once the
 * scale's degrees are exhausted. Notes are clamped into the MIDI range, so a high root
 * cannot emit an unplayable note.
 */
export function scaleNotes(scale: ScaleId, root: number, count: number): number[] {
  const { intervals } = SCALES[scale];
  const notes: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const octave = Math.floor(i / intervals.length);
    const degree = intervals[i % intervals.length]!;
    const note = root + degree + octave * SEMITONES_PER_OCTAVE;
    notes.push(Math.min(MIDI_MAX, Math.max(MIDI_MIN, note)));
  }
  return notes;
}

export type ChordSetId = 'triads' | 'sevenths';

export interface ChordDefinition {
  readonly id: string;
  readonly label: string;
  /** Semitone offsets from the chord root. */
  readonly intervals: readonly number[];
}

/** Chord sets spec §8.5.9 names: triads and 7ths. */
export const CHORD_SETS: Readonly<Record<ChordSetId, readonly ChordDefinition[]>> = Object.freeze({
  triads: [
    { id: 'major', label: 'Major', intervals: [0, 4, 7] },
    { id: 'minor', label: 'Minor', intervals: [0, 3, 7] },
    { id: 'diminished', label: 'Diminished', intervals: [0, 3, 6] },
    { id: 'augmented', label: 'Augmented', intervals: [0, 4, 8] },
    { id: 'sus2', label: 'Sus2', intervals: [0, 2, 7] },
    { id: 'sus4', label: 'Sus4', intervals: [0, 5, 7] },
  ],
  sevenths: [
    { id: 'major7', label: 'Major 7', intervals: [0, 4, 7, 11] },
    { id: 'minor7', label: 'Minor 7', intervals: [0, 3, 7, 10] },
    { id: 'dominant7', label: 'Dominant 7', intervals: [0, 4, 7, 10] },
    { id: 'halfDiminished7', label: 'Half-diminished 7', intervals: [0, 3, 6, 10] },
    { id: 'diminished7', label: 'Diminished 7', intervals: [0, 3, 6, 9] },
    { id: 'minorMajor7', label: 'Minor-major 7', intervals: [0, 3, 7, 11] },
  ],
});

/** The notes of one chord, clamped into the MIDI range. Unknown ids yield the root alone. */
export function chordNotes(set: ChordSetId, chordId: string, root: number): number[] {
  const chord = CHORD_SETS[set].find((candidate) => candidate.id === chordId);
  if (!chord) return [Math.min(MIDI_MAX, Math.max(MIDI_MIN, root))];
  return chord.intervals.map((interval) => Math.min(MIDI_MAX, Math.max(MIDI_MIN, root + interval)));
}

/** Pitch-class names using the sharp spelling and a typographic ♯ (spec §8.2 readable text). */
const PITCH_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'] as const;

/** Name a MIDI note, e.g. 60 → "C4" (middle C = C4, the convention this app displays). */
export function noteName(note: number): string {
  const pitch = PITCH_NAMES[((note % SEMITONES_PER_OCTAVE) + SEMITONES_PER_OCTAVE) % SEMITONES_PER_OCTAVE];
  const octave = Math.floor(note / SEMITONES_PER_OCTAVE) - 1;
  return `${pitch}${octave}`;
}
