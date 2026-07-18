import { describe, expect, it } from 'vitest';
import { CHORD_SETS, SCALES, chordNotes, noteName, scaleNotes, type ScaleId } from './scales';

describe('scales (spec §8.5.9)', () => {
  it('offers every scale the spec names', () => {
    const required: ScaleId[] = [
      'chromatic',
      'major',
      'naturalMinor',
      'harmonicMinor',
      'melodicMinor',
      'majorPentatonic',
      'minorPentatonic',
      'blues',
      'dorian',
      'phrygian',
      'lydian',
      'mixolydian',
      'locrian',
    ];
    for (const id of required) expect(SCALES[id]).toBeDefined();
  });

  it('builds a C major scale from the root upward', () => {
    // 16 pads of C major starting at middle C (MIDI 60).
    const notes = scaleNotes('major', 60, 16);
    expect(notes.slice(0, 8)).toEqual([60, 62, 64, 65, 67, 69, 71, 72]);
  });

  it('continues into the next octave beyond the scale degrees', () => {
    const notes = scaleNotes('major', 60, 9);
    expect(notes[7]).toBe(72); // octave
    expect(notes[8]).toBe(74); // ninth
  });

  it('chromatic is every semitone', () => {
    expect(scaleNotes('chromatic', 60, 4)).toEqual([60, 61, 62, 63]);
  });

  it('minor pentatonic has five degrees per octave', () => {
    const notes = scaleNotes('minorPentatonic', 60, 6);
    expect(notes).toEqual([60, 63, 65, 67, 70, 72]);
  });

  it('blues adds the flattened fifth to the minor pentatonic', () => {
    expect(scaleNotes('blues', 60, 7)).toEqual([60, 63, 65, 66, 67, 70, 72]);
  });

  it('never emits a note outside the MIDI range', () => {
    for (const note of scaleNotes('major', 120, 16)) {
      expect(note).toBeGreaterThanOrEqual(0);
      expect(note).toBeLessThanOrEqual(127);
    }
  });
});

describe('chord sets (spec §8.5.9)', () => {
  it('builds major and minor triads', () => {
    expect(chordNotes('triads', 'major', 60)).toEqual([60, 64, 67]);
    expect(chordNotes('triads', 'minor', 60)).toEqual([60, 63, 67]);
  });

  it('builds seventh chords', () => {
    expect(chordNotes('sevenths', 'major7', 60)).toEqual([60, 64, 67, 71]);
    expect(chordNotes('sevenths', 'dominant7', 60)).toEqual([60, 64, 67, 70]);
  });

  it('exposes the qualities each set contains', () => {
    expect(CHORD_SETS.triads.map((chord) => chord.id)).toContain('diminished');
    expect(CHORD_SETS.sevenths.map((chord) => chord.id)).toContain('minor7');
  });
});

describe('noteName (en-GB pitch spelling)', () => {
  it('names notes with their octave, middle C being C4', () => {
    expect(noteName(60)).toBe('C4');
    expect(noteName(61)).toBe('C♯4');
    // Concert-pitch A440 is MIDI 69, and sits in the same octave as middle C.
    expect(noteName(69)).toBe('A4');
    expect(noteName(72)).toBe('C5');
  });
});
