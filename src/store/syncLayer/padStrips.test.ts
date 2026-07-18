/**
 * Pad mixer-strip derivation (spec §4.2, §8.5.6) — turning a program's per-pad §6 mixer
 * values into the channel strips the Mixer mode edits and the sync layer pushes to the
 * graph. Pure, so the mapping is testable without a program store or an audio context.
 */
import { describe, expect, it } from 'vitest';
import { createDefaultPad } from '@/store/useProgramStore';
import { padStripsForProgram } from './padStrips';
import type { DrumProgram, KeygroupProgram } from '@/core/project/schemas';

function drumProgram(padIndices: number[]): DrumProgram {
  return {
    id: 'prog-1',
    name: 'Kit',
    type: 'drum',
    pads: padIndices.map((padIndex) => createDefaultPad(padIndex)),
  };
}

describe('padStripsForProgram (spec §4.2 channel ids)', () => {
  it('builds one strip per assigned pad, keyed by the canonical channel id', () => {
    const strips = padStripsForProgram(drumProgram([0, 5]));
    expect(strips.map((strip) => strip.id)).toEqual(['pad:prog-1:0', 'pad:prog-1:5']);
  });

  it('carries the pad’s §6 mixer values onto the strip', () => {
    const program = drumProgram([0]);
    const pad = program.pads[0]!;
    const customised: DrumProgram = {
      ...program,
      pads: [{ ...pad, mixer: { level: 0.7, pan: -0.4, sendLevels: [0.1, 0.2, 0.3, 0.4] } }],
    };
    const [strip] = padStripsForProgram(customised);
    expect(strip).toMatchObject({
      level: 0.7,
      pan: -0.4,
      sendLevels: [0.1, 0.2, 0.3, 0.4],
      mute: false,
      solo: false,
    });
  });

  it('carries the pad’s insert slots through unchanged', () => {
    const program = drumProgram([0]);
    const [strip] = padStripsForProgram(program);
    expect(strip?.inserts).toEqual(program.pads[0]!.inserts);
  });

  it('returns no strips for a keygroup program — its mixer is program-scope (spec §6)', () => {
    const keygroup = {
      id: 'kg-1',
      name: 'Pad',
      type: 'keygroup',
      zones: [],
    } as unknown as KeygroupProgram;
    expect(padStripsForProgram(keygroup)).toEqual([]);
  });

  it('returns no strips for a null program', () => {
    expect(padStripsForProgram(undefined)).toEqual([]);
  });
});
