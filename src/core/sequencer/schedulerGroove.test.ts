/**
 * Schedule-time groove application (spec §7.5) — a groove template shifts timing and
 * scales velocity as notes are scheduled, exactly like swing (spec §7.4) and equally
 * non-destructively: the stored events never change.
 */
import { describe, expect, it } from 'vitest';
import { PPQN } from '@/core/constants';
import { SchedulerCore, type SchedulerTickResult } from './schedulerCore';
import type { GrooveTemplate } from './groove';
import type { MidiEvent } from '@/core/project/schemas';
import type { ScheduledEvent } from './messages';

/** A groove that pushes every note 30 ticks late and softens it to 80 % velocity. */
const LATE_GROOVE: GrooveTemplate = {
  ppqn: PPQN,
  lengthTicks: PPQN * 4,
  division: 16,
  points: [{ gridTick: 0, offsetTicks: 30, velocityScale: 0.8 }],
};

function note(id: string, tickStart: number): MidiEvent {
  return { id, tickStart, durationTicks: 120, note: 36, velocity: 100, extra: null };
}

/** Metadata for a single 1-bar 4/4 sequence at the project tempo. */
function oneBarMeta(core: SchedulerCore) {
  core.setSequenceMeta(
    { S: { lengthBars: 1, timeSigNumerator: 4, timeSigDenominator: 4, tempo: null } },
    120,
    'S',
    'sequence',
  );
}

function run(core: SchedulerCore, times: number[]): SchedulerTickResult {
  const merged: SchedulerTickResult = {
    batch: [],
    recorded: [],
    erased: [],
    loopWrapped: [],
    songAdvanced: [],
  };
  for (const time of times) {
    const result = core.tick(time);
    merged.batch.push(...result.batch);
  }
  return merged;
}

function noteEvents(result: SchedulerTickResult): ScheduledEvent[] {
  return result.batch.filter((event) => event.kind === 'noteOn');
}

/** A core with one note at tick 0 on `track-1`, ready to play. */
function coreWithNote(extraTrack = false): SchedulerCore {
  const core = new SchedulerCore();
  oneBarMeta(core);
  core.setTempo(120);
  core.setLoop({ enabled: true, startTick: 0, endTick: PPQN * 4 });
  core.applyEventsDiff('track-1', 'S', [note('a', 0)], []);
  if (extraTrack) core.applyEventsDiff('track-2', 'S', [note('b', 0)], []);
  return core;
}

const TICK_TIMES = [0, 0.05, 0.1, 0.15];

describe('SchedulerCore groove (spec §7.5)', () => {
  it('schedules a note unshifted when no groove is set', () => {
    const core = coreWithNote();
    core.setTransport(true, false, 0);
    const notes = noteEvents(run(core, TICK_TIMES));
    expect(notes.length).toBeGreaterThan(0);
    expect(notes[0]?.velocity).toBe(100);
    expect(notes[0]?.when).toBeCloseTo(0, 3);
  });

  it('delays a note and scales its velocity when a groove is assigned to its track', () => {
    const core = coreWithNote();
    core.setGroove('track-1', LATE_GROOVE);
    core.setTransport(true, false, 0);
    const notes = noteEvents(run(core, TICK_TIMES));

    expect(notes.length).toBeGreaterThan(0);
    expect(notes[0]?.velocity).toBe(80);
    // 30 ticks late at 120 bpm / 960 PPQN = 30 * (60 / (120 * 960)) s ≈ 15.6 ms.
    expect(notes[0]!.when).toBeCloseTo(30 * (60 / (120 * PPQN)), 4);
  });

  it('leaves other tracks untouched — groove is assigned per track (spec §7.5)', () => {
    const core = coreWithNote(true);
    core.setGroove('track-1', LATE_GROOVE);
    core.setTransport(true, false, 0);
    const notes = noteEvents(run(core, TICK_TIMES));

    const grooved = notes.find((event) => event.trackId === 'track-1');
    const plain = notes.find((event) => event.trackId === 'track-2');
    expect(grooved?.velocity).toBe(80);
    expect(plain?.velocity).toBe(100);
    expect(grooved!.when).toBeGreaterThan(plain!.when);
  });

  it('clearing the groove restores unshifted scheduling', () => {
    const core = coreWithNote();
    core.setGroove('track-1', LATE_GROOVE);
    core.setGroove('track-1', null);
    core.setTransport(true, false, 0);
    const notes = noteEvents(run(core, TICK_TIMES));
    expect(notes[0]?.velocity).toBe(100);
    expect(notes[0]?.when).toBeCloseTo(0, 3);
  });

  it('never drives velocity outside the valid 1..127 range', () => {
    const core = coreWithNote();
    core.setGroove('track-1', {
      ppqn: PPQN,
      lengthTicks: PPQN * 4,
      division: 16,
      points: [{ gridTick: 0, offsetTicks: 0, velocityScale: 10 }],
    });
    core.setTransport(true, false, 0);
    const notes = noteEvents(run(core, TICK_TIMES));
    expect(notes[0]?.velocity).toBeLessThanOrEqual(127);
    expect(notes[0]?.velocity).toBeGreaterThanOrEqual(1);
  });
});
