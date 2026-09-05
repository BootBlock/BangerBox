/**
 * A deleted track is WITHDRAWN from the worker (spec §7.1.3, §7.1.4, issue #137).
 *
 * `removeTrack` deletes the store's track and its events, and nothing told the worker: the
 * events subscriber in `sequencerSync` iterated the map it was handed and never handled a
 * REMOVED key, where the automation subscriber beside it does. So the worker kept the
 * track's events and kept scheduling them until the project was reloaded.
 *
 * The rule these tests pin: `removeTrack { trackId }` (spec §7.1.3) means the track does
 * NOT EXIST, so every map the core keys by that id is dropped — its events, its §7.5
 * groove, its §7.6 held notes, its §7.7 open capture and armed erase. A withdrawal is not
 * a selection (spec §14 (aq)): no mode ever plays it again, in any segment, so the rule
 * belongs on the sender's side of the wire and the worker simply forgets.
 *
 * Driven through `parseSchedulerRequest` + `applySchedulerRequest` rather than by calling
 * the core, because a sender whose kind has no schema member is dropped in silence at the
 * worker boundary with nothing to see (issue #71).
 */
import { describe, expect, it } from 'vitest';
import type { MidiEvent } from '@/core/project/schemas';
import type { ScheduledEvent, SchedulerRequest } from './messages';
import { parseSchedulerRequest } from './messages';
import { applySchedulerRequest } from './schedulerDispatch';
import { SchedulerCore, type SchedulerTickResult } from './schedulerCore';
import type { GrooveTemplate } from './groove';

function note(id: string, tickStart: number, noteNumber = 36): MidiEvent {
  return { id, tickStart, durationTicks: 120, note: noteNumber, velocity: 100, extra: null };
}

/** Apply one request the way the worker does — guard first, then dispatch (spec §7.1.3). */
function send(core: SchedulerCore, request: SchedulerRequest): void {
  const parsed = parseSchedulerRequest(request);
  expect(parsed, `${request.kind} was dropped by the guard`).not.toBeNull();
  applySchedulerRequest(
    {
      core,
      toContextTime: (timestamp) => timestamp,
      onInit: () => {},
      onClockSync: () => {},
    },
    parsed!,
  );
}

function run(core: SchedulerCore, times: readonly number[]): SchedulerTickResult {
  const merged: SchedulerTickResult = {
    batch: [],
    recorded: [],
    erased: [],
    loopWrapped: [],
    songAdvanced: [],
    songEnded: false,
  };
  for (const at of times) {
    const result = core.tick(at);
    merged.batch.push(...result.batch);
    merged.recorded.push(...result.recorded);
    merged.erased.push(...result.erased);
    merged.loopWrapped.push(...result.loopWrapped);
    merged.songAdvanced.push(...result.songAdvanced);
    merged.songEnded ||= result.songEnded;
  }
  return merged;
}

const steps = (from: number, to: number, by = 0.1): number[] =>
  Array.from({ length: Math.round((to - from) / by) + 1 }, (_, i) => from + i * by);
const notesOf = (result: SchedulerTickResult): ScheduledEvent[] =>
  result.batch.filter((event) => event.kind === 'noteOn');
const trackIdsOf = (result: SchedulerTickResult): string[] => [
  ...new Set(notesOf(result).map((event) => event.trackId ?? '')),
];

const LOOP_1_BAR = { enabled: true, startTick: 0, endTick: 3840 };

/** One 1-bar 4/4 sequence, two tracks, a note each on tick 0. */
function twoTracks(): SchedulerCore {
  const core = new SchedulerCore();
  core.setSequenceMeta(
    { A: { lengthBars: 1, timeSigNumerator: 4, timeSigDenominator: 4, tempo: null } },
    120,
    'A',
    'sequence',
  );
  core.setTempo(120);
  core.setLoop(LOOP_1_BAR);
  send(core, {
    kind: 'eventsDiff',
    trackId: 'ta',
    sequenceId: 'A',
    upserts: [note('a1', 0, 36)],
    deletes: [],
  });
  send(core, {
    kind: 'eventsDiff',
    trackId: 'tb',
    sequenceId: 'A',
    upserts: [note('b1', 0, 38)],
    deletes: [],
  });
  return core;
}

describe('a withdrawn track stops sounding (spec §7.1.3, issue #137)', () => {
  it('schedules nothing for the track after it is removed', () => {
    const core = twoTracks();
    core.setTransport(true, false, 0);
    // Two bars at 120 bpm, so each track's tick-0 note comes round twice if nothing stops it.
    const before = run(core, steps(0, 1.0));
    expect(trackIdsOf(before).sort()).toEqual(['ta', 'tb']);

    send(core, { kind: 'removeTrack', trackId: 'ta' });
    const after = run(core, steps(1.1, 4.5));
    expect(trackIdsOf(after)).toEqual(['tb']);
  });

  it('leaves every other track exactly where it was', () => {
    const core = twoTracks();
    send(core, { kind: 'removeTrack', trackId: 'ta' });
    core.setTransport(true, false, 0);
    const result = run(core, steps(0, 2.5));
    expect(notesOf(result).every((event) => event.trackId === 'tb')).toBe(true);
    expect(notesOf(result).length).toBeGreaterThan(0);
  });

  it('ignores a withdrawal for a track it never held', () => {
    const core = twoTracks();
    expect(() => send(core, { kind: 'removeTrack', trackId: 'ghost' })).not.toThrow();
    core.setTransport(true, false, 0);
    expect(trackIdsOf(run(core, steps(0, 1.0))).sort()).toEqual(['ta', 'tb']);
  });

  it('cannot be made to sound again by an events diff that arrives after it', () => {
    // The store deletes the track and its events in one `set`, so the two subscribers fire
    // from one write and their order does not matter. This pins that: a trailing diff for a
    // withdrawn track contributes no notes whichever way round the two arrive.
    const core = twoTracks();
    send(core, { kind: 'removeTrack', trackId: 'ta' });
    send(core, { kind: 'eventsDiff', trackId: 'ta', sequenceId: 'A', upserts: [], deletes: ['a1'] });
    core.setTransport(true, false, 0);
    expect(trackIdsOf(run(core, steps(0, 1.0)))).toEqual(['tb']);
  });
});

describe('a withdrawal drops everything the worker keys by the track (spec §7.1.3)', () => {
  const TEMPLATE: GrooveTemplate = {
    ppqn: 960,
    lengthTicks: 1920,
    division: 16,
    points: [{ gridTick: 0, offsetTicks: 240, velocityScale: 1 }],
  };

  it('forgets the track’s §7.5 groove', () => {
    const core = twoTracks();
    send(core, { kind: 'groove', trackId: 'ta', template: TEMPLATE });
    send(core, { kind: 'removeTrack', trackId: 'ta' });
    // Re-admit the id as a fresh track. A groove left behind would shape it, which is what
    // makes the leftover observable rather than merely untidy.
    send(core, {
      kind: 'eventsDiff',
      trackId: 'ta',
      sequenceId: 'A',
      upserts: [note('a2', 0, 36)],
      deletes: [],
    });
    core.setTransport(true, false, 0);
    const hits = notesOf(run(core, steps(0, 1.0))).filter((event) => event.trackId === 'ta');
    expect(hits.length).toBeGreaterThan(0);
    // The template shifts tick 0 by 240 ticks (an eighth at 960 PPQN); ungrooved it is 0.
    expect(hits[0]!.when).toBeCloseTo(0, 5);
  });

  it('forgets a §7.6 held note, so note repeat stops firing on it', () => {
    const core = twoTracks();
    core.setTransport(true, false, 0);
    core.tick(0);
    send(core, { kind: 'noteRepeat', enabled: true, division: { value: 16, triplet: false } });
    send(core, { kind: 'liveNote', note: 40, velocity: 100, on: true, timestamp: 0, trackId: 'ta' });
    const held = run(core, steps(0.1, 0.6));
    expect(notesOf(held).some((event) => event.trackId === 'ta' && event.note === 40)).toBe(true);

    send(core, { kind: 'removeTrack', trackId: 'ta' });
    const after = run(core, steps(0.7, 2.0));
    expect(notesOf(after).some((event) => event.trackId === 'ta')).toBe(false);
  });

  it('forgets a §7.7 capture, so no take is flushed for a track that is gone', () => {
    const core = twoTracks();
    core.setTransport(true, true, 0);
    core.tick(0);
    send(core, { kind: 'noteRepeat', enabled: true, division: { value: 16, triplet: false } });
    send(core, { kind: 'liveNote', note: 40, velocity: 100, on: true, timestamp: 0, trackId: 'ta' });
    run(core, steps(0.1, 0.6));

    send(core, { kind: 'removeTrack', trackId: 'ta' });
    // A flush reaches the store through `commitRecordedTake`, which would write the events
    // map key back for a track the project no longer has.
    const after = run(core, steps(0.7, 5.0));
    expect(after.recorded.some((take) => take.trackId === 'ta')).toBe(false);
  });

  it('forgets a §7.7 armed erase, so a withdrawn track reports no deletions', () => {
    const core = twoTracks();
    send(core, { kind: 'liveErase', trackId: 'ta', note: 36, active: true });
    core.setTransport(true, false, 0);
    send(core, { kind: 'removeTrack', trackId: 'ta' });
    const result = run(core, steps(0, 4.5));
    expect(result.erased.some((entry) => entry.trackId === 'ta')).toBe(false);
  });
});
