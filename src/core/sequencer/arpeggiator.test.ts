import { describe, expect, it } from 'vitest';
import { PPQN } from '@/core/constants';
import { arpeggiatorHits, arpSequence, type ArpConfig, type ArpHeldNote } from './arpeggiator';

const CHORD: ArpHeldNote[] = [
  { note: 60, velocity: 100 },
  { note: 64, velocity: 100 },
  { note: 67, velocity: 100 },
];

describe('arpSequence (spec §7.3 modes)', () => {
  it('up sorts ascending and repeats across octaves', () => {
    expect(arpSequence(CHORD, 'up', 2).map((n) => n.note)).toEqual([60, 64, 67, 72, 76, 79]);
  });

  it('down is the reverse of up', () => {
    expect(arpSequence(CHORD, 'down', 1).map((n) => n.note)).toEqual([67, 64, 60]);
  });

  it('played preserves the held order', () => {
    const held: ArpHeldNote[] = [
      { note: 67, velocity: 1 },
      { note: 60, velocity: 1 },
    ];
    expect(arpSequence(held, 'played', 1).map((n) => n.note)).toEqual([67, 60]);
  });

  it('upDown walks up then down without repeating the endpoints', () => {
    expect(arpSequence(CHORD, 'upDown', 1).map((n) => n.note)).toEqual([60, 64, 67, 64]);
  });

  it('is empty for no held notes', () => {
    expect(arpSequence([], 'up', 2)).toEqual([]);
  });
});

describe('arpeggiatorHits (spec §7.3)', () => {
  const config: ArpConfig = { mode: 'up', octaves: 1, gate: 0.5, division: { value: 16, triplet: false } };
  const step = (PPQN * 4) / 16; // 1/16 = 240 ticks

  it('emits one hit per grid step, cycling the sequence phase-locked to the bar', () => {
    const hits = arpeggiatorHits(CHORD, config, 0, step * 4);
    expect(hits.map((h) => h.tick)).toEqual([0, step, step * 2, step * 3]);
    // step 0→60, 1→64, 2→67, 3→60 (cycles the 3-note sequence)
    expect(hits.map((h) => h.note)).toEqual([60, 64, 67, 60]);
  });

  it('gates the note duration to gate × step', () => {
    const hits = arpeggiatorHits(CHORD, config, 0, step);
    expect(hits[0]?.durationTicks).toBe(step * 0.5);
  });

  it('stays phase-locked when the window does not start at zero', () => {
    const hits = arpeggiatorHits(CHORD, config, step * 3, step * 4);
    expect(hits[0]?.tick).toBe(step * 3);
    expect(hits[0]?.note).toBe(60); // step index 3 → 3 % 3 = 0 → first note
  });

  it('is deterministic in random mode for a given step', () => {
    const randomConfig: ArpConfig = { ...config, mode: 'random' };
    const a = arpeggiatorHits(CHORD, randomConfig, 0, step * 4).map((h) => h.note);
    const b = arpeggiatorHits(CHORD, randomConfig, 0, step * 4).map((h) => h.note);
    expect(a).toEqual(b); // repeatable (spec §7.1.5)
  });

  it('is empty with no held notes', () => {
    expect(arpeggiatorHits([], config, 0, step * 4)).toEqual([]);
  });
});
