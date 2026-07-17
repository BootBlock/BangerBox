import { describe, expect, it } from 'vitest';
import {
  eventsInWindow,
  loopActive,
  loopPassAt,
  segmentWindow,
  sequenceTickAt,
  type LoopRegion,
} from './lookahead';

const NO_LOOP: LoopRegion = { enabled: false, startTick: 0, endTick: 0 };
const LOOP_0_1000: LoopRegion = { enabled: true, startTick: 0, endTick: 1000 };
const LOOP_500_1500: LoopRegion = { enabled: true, startTick: 500, endTick: 1500 };

interface Ev {
  id: string;
  tick: number;
}
const tickOf = (e: Ev) => e.tick;

describe('loopActive / sequenceTickAt (spec §7.1.4)', () => {
  it('treats a disabled or empty loop as linear', () => {
    expect(loopActive(NO_LOOP)).toBe(false);
    expect(loopActive({ enabled: true, startTick: 100, endTick: 100 })).toBe(false);
    expect(sequenceTickAt(2500, NO_LOOP)).toBe(2500);
  });

  it('wraps a linear position onto the loop region', () => {
    expect(sequenceTickAt(0, LOOP_0_1000)).toBe(0);
    expect(sequenceTickAt(999, LOOP_0_1000)).toBe(999);
    expect(sequenceTickAt(1000, LOOP_0_1000)).toBe(0); // wraps at end
    expect(sequenceTickAt(1200, LOOP_0_1000)).toBe(200);
    expect(sequenceTickAt(2000, LOOP_0_1000)).toBe(0);
  });

  it('wraps within an offset loop region and plays the pre-roll linearly', () => {
    expect(sequenceTickAt(100, LOOP_500_1500)).toBe(100); // pre-roll before loop start
    expect(sequenceTickAt(1499, LOOP_500_1500)).toBe(1499);
    expect(sequenceTickAt(1500, LOOP_500_1500)).toBe(500); // wraps to loop start
    expect(sequenceTickAt(1700, LOOP_500_1500)).toBe(700);
  });
});

describe('loopPassAt (spec §7.1.3 loopWrapped)', () => {
  it('counts completed passes', () => {
    expect(loopPassAt(500, LOOP_0_1000)).toBe(0);
    expect(loopPassAt(1000, LOOP_0_1000)).toBe(1);
    expect(loopPassAt(2500, LOOP_0_1000)).toBe(2);
    expect(loopPassAt(400, NO_LOOP)).toBe(0);
  });
});

describe('segmentWindow (spec §7.1.4)', () => {
  it('is a single identity segment without a loop', () => {
    expect(segmentWindow(100, 300, NO_LOOP)).toEqual([
      { seqStart: 100, seqEnd: 300, linearStart: 100 },
    ]);
  });

  it('splits a window that straddles the loop boundary', () => {
    const segs = segmentWindow(900, 1200, LOOP_0_1000);
    expect(segs).toEqual([
      { seqStart: 900, seqEnd: 1000, linearStart: 900 },
      { seqStart: 0, seqEnd: 200, linearStart: 1000 },
    ]);
  });
});

describe('eventsInWindow (spec §7.1.5 once-per-pass)', () => {
  const events: Ev[] = [
    { id: 'a', tick: 0 },
    { id: 'b', tick: 250 },
    { id: 'c', tick: 950 },
  ];

  it('selects events in a non-looping window once', () => {
    const out = eventsInWindow(events, tickOf, 0, 300, NO_LOOP);
    expect(out.map((w) => w.item.id)).toEqual(['a', 'b']);
    expect(out[0]).toMatchObject({ tick: 0, linearTick: 0 });
    expect(out[1]).toMatchObject({ tick: 250, linearTick: 250 });
  });

  it('schedules an event across the loop boundary exactly once per pass', () => {
    // Window crossing the wrap: c (tick 950) in pass 0, a (tick 0) at linear 1000 in pass 1.
    const out = eventsInWindow(events, tickOf, 900, 1100, LOOP_0_1000);
    expect(out.map((w) => ({ id: w.item.id, linearTick: w.linearTick }))).toEqual([
      { id: 'c', linearTick: 950 },
      { id: 'a', linearTick: 1000 },
    ]);
  });

  it('does not double-schedule when consecutive windows abut the boundary', () => {
    // Two abutting windows must together yield each occurrence exactly once.
    const first = eventsInWindow(events, tickOf, 0, 1000, LOOP_0_1000);
    const second = eventsInWindow(events, tickOf, 1000, 2000, LOOP_0_1000);
    const firstIds = first.map((w) => `${w.item.id}@${w.linearTick}`);
    const secondIds = second.map((w) => `${w.item.id}@${w.linearTick}`);
    expect(firstIds).toEqual(['a@0', 'b@250', 'c@950']);
    expect(secondIds).toEqual(['a@1000', 'b@1250', 'c@1950']);
    // No overlap between the two windows.
    expect(firstIds.filter((x) => secondIds.includes(x))).toEqual([]);
  });

  it('excludes an event exactly on the exclusive loop end', () => {
    const atEnd: Ev[] = [{ id: 'x', tick: 1000 }];
    // tick 1000 is outside [0,1000); it never plays during the loop.
    expect(eventsInWindow(atEnd, tickOf, 0, 3000, LOOP_0_1000)).toEqual([]);
  });

  it('handles an offset loop region', () => {
    const evs: Ev[] = [{ id: 'p', tick: 600 }];
    const out = eventsInWindow(evs, tickOf, 500, 2600, LOOP_500_1500);
    // tick 600 recurs at linear 600 (pass 0) and 1600 (pass 1) and 2600 excluded.
    expect(out.map((w) => w.linearTick)).toEqual([600, 1600, 2600].filter((t) => t < 2600));
  });
});
