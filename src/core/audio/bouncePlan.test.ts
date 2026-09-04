/**
 * What a §9.5 render contains (spec §9.5, §7.8, issue #134).
 *
 * The audible half of #134 is proven by an offline render in the browser (`bounceMixProof`,
 * spec §11.2/§13.5). What is pinned here is the half a render cannot show without being run
 * four times: which strips a variant covers, and which tick each §7.8 scope is sampled at.
 */
import { describe, expect, it } from 'vitest';
import { PPQN } from '@/core/constants';
import { automationLaneKey, type AutomationPoint } from '@/core/project/schemas';
import type { SongSegment } from '@/core/sequencer/songMap';
import { bounceAutomationRamps, bounceIncludesChannel, type BounceScope } from './bouncePlan';
import { channelLevelPath } from './params/registry';

const FULL_MIX: BounceScope = { mode: 'sequence', stemTrackId: null };
const STEM: BounceScope = { mode: 'sequence', stemTrackId: 't1' };
const SONG: BounceScope = { mode: 'song', stemTrackId: null };

/** One bar of 4/4 at 120 bpm: 3840 ticks, two seconds. */
const BAR_TICKS = PPQN * 4;

function segment(overrides: Partial<SongSegment> = {}): SongSegment {
  return {
    entryIndex: 0,
    sequenceId: 'seq1',
    startTick: 0,
    lengthTicks: BAR_TICKS,
    bpm: 120,
    startSeconds: 0,
    ...overrides,
  };
}

/** A ramp from `from` to `to` across one bar, as the Grid's lane editor would write it. */
function ramp(from: number, to: number, lengthTicks = BAR_TICKS): AutomationPoint[] {
  return [
    { id: 'a', scope: 'sequence', ownerId: 'seq1', targetPath: 'x', tick: 0, value: from, curve: 'linear' },
    {
      id: 'b',
      scope: 'sequence',
      ownerId: 'seq1',
      targetPath: 'x',
      tick: lengthTicks,
      value: to,
      curve: 'linear',
    },
  ];
}

const MASTER_LEVEL = channelLevelPath('master');
const TRACK_LEVEL = channelLevelPath('track:t1');

describe('which §5.2 strips a §9.5 render covers', () => {
  it('carries the master strip in a full mix', () => {
    expect(bounceIncludesChannel('master', FULL_MIX)).toBe(true);
  });

  // §9.5 places the stem tap "post-insert, pre-master", so stage 9 is what a stem drops.
  it('leaves the master strip out of a stem', () => {
    expect(bounceIncludesChannel('master', STEM)).toBe(false);
  });

  // The one judgement rather than a reading: a stem set has to sum back to what the master
  // bus was fed, and dropping the returns loses every send effect from that sum.
  it('keeps the returns and the track strip in a stem', () => {
    expect(bounceIncludesChannel('return:0', STEM)).toBe(true);
    expect(bounceIncludesChannel('track:t1', STEM)).toBe(true);
    expect(bounceIncludesChannel('pad:prog:0', STEM)).toBe(true);
  });
});

describe('§7.8 automation across a §9.5 render', () => {
  const lanes = { [automationLaneKey('sequence', 'seq1', MASTER_LEVEL)]: ramp(0.2, 1) };

  it('ramps the lane across the segment, at the live scheduler resolution', () => {
    const ramps = bounceAutomationRamps([segment()], lanes, FULL_MIX);
    // One bar at 120 bpm is 2 s; the live scheduler reaches the graph every 25 ms.
    expect(ramps.length).toBe(80);
    expect(ramps[0]!.targetPath).toBe(MASTER_LEVEL);
    // Contiguous windows: no tick of the segment is left unwritten and none is written
    // twice, which is what makes the staircase track the curve rather than skip parts of it.
    // (Each write is still the §4.3 dezipper, not a glide across the window — see
    // `applyAutomation`. The property asserted here is coverage, not ramp shape.)
    for (let i = 1; i < ramps.length; i += 1) {
      expect(ramps[i]!.when).toBeCloseTo(ramps[i - 1]!.rampEnd, 9);
    }
    // The value climbs monotonically from just above the first point to the last.
    expect(ramps[0]!.value).toBeGreaterThan(0.2);
    expect(ramps[0]!.value).toBeLessThan(0.3);
    expect(ramps[ramps.length - 1]!.value).toBeCloseTo(1, 6);
  });

  it('emits nothing when no lane addresses a registered parameter', () => {
    expect(bounceAutomationRamps([segment()], {}, FULL_MIX)).toEqual([]);
    const bogus = { [automationLaneKey('sequence', 'seq1', 'mixer.master.gain')]: ramp(0, 1) };
    expect(bounceAutomationRamps([segment()], bogus, FULL_MIX)).toEqual([]);
  });

  // The static pass and the automation pass read ONE predicate, or a stem would sit at unity
  // while its lane rode the master fader for the whole render.
  it('drops a lane on the master strip from a stem, and keeps one on the track', () => {
    const both = {
      [automationLaneKey('sequence', 'seq1', MASTER_LEVEL)]: ramp(0.2, 1),
      [automationLaneKey('sequence', 'seq1', TRACK_LEVEL)]: ramp(0.2, 1),
    };
    const paths = new Set(bounceAutomationRamps([segment()], both, STEM).map((r) => r.targetPath));
    expect([...paths]).toEqual([TRACK_LEVEL]);
  });

  it('offers a sequence lane only to the sequence it belongs to', () => {
    const other = { [automationLaneKey('sequence', 'seq2', MASTER_LEVEL)]: ramp(0.2, 1) };
    expect(bounceAutomationRamps([segment()], other, FULL_MIX)).toEqual([]);
    expect(bounceAutomationRamps([segment({ sequenceId: 'seq2' })], other, FULL_MIX).length).toBe(80);
  });

  // §7.8: a sequence lane "loops with the pattern", so its second repeat starts over.
  it('restarts a sequence lane on every repeat of its own pattern', () => {
    const song = [segment(), segment({ startTick: BAR_TICKS, startSeconds: 2 })];
    const ramps = bounceAutomationRamps(song, lanes, SONG);
    const secondPass = ramps.filter((r) => r.when >= 2);
    expect(secondPass[0]!.value).toBeLessThan(0.3);
    expect(secondPass[secondPass.length - 1]!.value).toBeCloseTo(1, 6);
  });

  // §7.8: a track lane "spans the song arrangement", so it keeps climbing across a boundary.
  it('carries a track lane across a song entry boundary', () => {
    const trackLane = {
      [automationLaneKey('track', 't1', MASTER_LEVEL)]: ramp(0.2, 1, BAR_TICKS * 2),
    };
    const song = [segment(), segment({ startTick: BAR_TICKS, startSeconds: 2 })];
    const ramps = bounceAutomationRamps(song, trackLane, SONG);
    const firstPassEnd = ramps.filter((r) => r.when < 2).pop()!;
    const secondPassStart = ramps.find((r) => r.when >= 2)!;
    expect(secondPassStart.value).toBeGreaterThan(firstPassEnd.value);
    expect(ramps[ramps.length - 1]!.value).toBeCloseTo(1, 6);
  });

  // A sequence render has no arrangement to span: there the pattern IS the arrangement, so
  // both scopes sample the sequence tick, exactly as `scheduleSequenceAutomation` does.
  it('samples a track lane at the pattern tick in a sequence render', () => {
    const trackLane = {
      [automationLaneKey('track', 't1', MASTER_LEVEL)]: ramp(0.2, 1),
    };
    const ramps = bounceAutomationRamps([segment({ startTick: BAR_TICKS })], trackLane, FULL_MIX);
    expect(ramps[ramps.length - 1]!.value).toBeCloseTo(1, 6);
  });

  // §7.8's override rule, unchanged by where it is read from: track scope wins outright.
  it('lets a track lane override a sequence lane on the same target', () => {
    const both = {
      [automationLaneKey('sequence', 'seq1', MASTER_LEVEL)]: ramp(0.2, 0.2),
      [automationLaneKey('track', 't1', MASTER_LEVEL)]: ramp(0.9, 0.9),
    };
    const ramps = bounceAutomationRamps([segment()], both, FULL_MIX);
    expect(ramps.every((r) => r.value === 0.9)).toBe(true);
  });

  it('times a segment against its own §7.9 tempo', () => {
    const half = bounceAutomationRamps([segment({ bpm: 240 })], lanes, FULL_MIX);
    // Half the wall-clock time, so half as many 25 ms windows.
    expect(half.length).toBe(40);
    expect(half[half.length - 1]!.rampEnd).toBeCloseTo(1, 6);
  });
});
