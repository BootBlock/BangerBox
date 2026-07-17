import { describe, expect, it } from 'vitest';
import { selectChokeVictims, selectStealVictim, type ChokeCandidate, type VoiceRef } from './voiceSelection';

describe('voice stealing policy (spec §5.4)', () => {
  it('returns null for an empty pool', () => {
    expect(selectStealVictim([])).toBeNull();
  });

  it('steals the oldest released voice before any sustaining voice', () => {
    const voices: VoiceRef[] = [
      { id: 'a', startTime: 0, released: false },
      { id: 'b', startTime: 1, released: true },
      { id: 'c', startTime: 2, released: true },
    ];
    // 'b' is the oldest of the released voices, even though 'a' is older overall.
    expect(selectStealVictim(voices)).toBe('b');
  });

  it('steals the oldest voice overall when none are released', () => {
    const voices: VoiceRef[] = [
      { id: 'a', startTime: 5, released: false },
      { id: 'b', startTime: 2, released: false },
      { id: 'c', startTime: 9, released: false },
    ];
    expect(selectStealVictim(voices)).toBe('b');
  });
});

describe('choke group policy (spec §5.4)', () => {
  const active: ChokeCandidate[] = [
    { id: 'openhat', programId: 'p1', padKey: 'p1:2', chokeGroup: 1 },
    { id: 'kick', programId: 'p1', padKey: 'p1:0', chokeGroup: 0 },
    { id: 'otherprog', programId: 'p2', padKey: 'p2:2', chokeGroup: 1 },
  ];

  it('chokes other pads sharing the group within the same program', () => {
    const victims = selectChokeVictims(active, { programId: 'p1', padKey: 'p1:3', chokeGroup: 1 });
    expect(victims).toEqual(['openhat']);
  });

  it('never chokes voices of the same pad', () => {
    const victims = selectChokeVictims(active, { programId: 'p1', padKey: 'p1:2', chokeGroup: 1 });
    expect(victims).toEqual([]);
  });

  it('chokes nothing for group 0', () => {
    expect(selectChokeVictims(active, { programId: 'p1', padKey: 'p1:3', chokeGroup: 0 })).toEqual([]);
  });

  it('does not cross program boundaries', () => {
    const victims = selectChokeVictims(active, { programId: 'p2', padKey: 'p2:9', chokeGroup: 1 });
    expect(victims).toEqual(['otherprog']);
  });
});
