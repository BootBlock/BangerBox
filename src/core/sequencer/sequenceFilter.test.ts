/**
 * Sequence mode plays ONE sequence (spec §7.7, §7.9, issue #132).
 *
 * `scheduleSequence` iterated the whole track map with no filter where `emitSongPass` has
 * one, so every sequence in the project sounded at once and a §7.7 live erase took the held
 * pad out of all of them. The second half is data loss: `result.erased` reaches the store
 * through `removeEvents`, so the deletion persists.
 *
 * The rule these tests pin: a track sounds in sequence mode when its sequence IS the
 * transport's active sequence. `null` is not any track's sequence, so it matches nothing.
 */
import { describe, expect, it } from 'vitest';
import type { MidiEvent } from '@/core/project/schemas';
import type { ScheduledEvent } from './messages';
import { SchedulerCore, type SchedulerTickResult } from './schedulerCore';

function note(id: string, tickStart: number, noteNumber = 36): MidiEvent {
  return { id, tickStart, durationTicks: 120, note: noteNumber, velocity: 100, extra: null };
}

/** Metadata for a set of 1-bar 4/4 sequences at the project tempo. */
function meta(
  core: SchedulerCore,
  ids: string[],
  activeId: string | null,
  mode: 'sequence' | 'song' = 'sequence',
): void {
  const sequences: Record<
    string,
    { lengthBars: number; timeSigNumerator: number; timeSigDenominator: 4; tempo: null }
  > = {};
  for (const id of ids) {
    sequences[id] = { lengthBars: 1, timeSigNumerator: 4, timeSigDenominator: 4, tempo: null };
  }
  core.setSequenceMeta(sequences, 120, activeId, mode);
}

function run(core: SchedulerCore, times: number[]): SchedulerTickResult {
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

const steps = (to: number, by = 0.1): number[] =>
  Array.from({ length: Math.round(to / by) + 1 }, (_, i) => i * by);
const notes = (result: SchedulerTickResult): ScheduledEvent[] =>
  result.batch.filter((event) => event.kind === 'noteOn');
const trackIds = (result: SchedulerTickResult): string[] => [
  ...new Set(notes(result).map((event) => event.trackId ?? '')),
];
const LOOP_1_BAR = { enabled: true, startTick: 0, endTick: 3840 };

/** Two 1-bar sequences, a track each, one note each on tick 0. Sequence A is active. */
function twoSequences(activeId: string | null): SchedulerCore {
  const core = new SchedulerCore();
  meta(core, ['A', 'B'], activeId);
  core.setTempo(120);
  core.setLoop(LOOP_1_BAR);
  core.applyEventsDiff('ta', 'A', [note('a1', 0, 36)], []);
  core.applyEventsDiff('tb', 'B', [note('b1', 0, 38)], []);
  return core;
}

describe('sequence mode plays only the active sequence (spec §7.9, issue #132)', () => {
  it('schedules the active sequence’s track and no other', () => {
    const core = twoSequences('A');
    core.setTransport(true, false, 0);

    const result = run(core, steps(0.5));
    expect(trackIds(result)).toEqual(['ta']);
    expect(notes(result).map((event) => event.note)).toEqual([36]);
  });

  it('schedules nothing when no sequence is active', () => {
    // `tracksOfSequence(tracks, null)` already answers this question with the empty list for
    // the §8.5.1 track panel. Playing every track instead is what the defect did, and §7.7's
    // erase makes the permissive reading destructive rather than merely loud.
    const core = twoSequences(null);
    core.setTransport(true, false, 0);

    expect(notes(run(core, steps(0.5)))).toEqual([]);
  });

  it('follows a switch of active sequence while the transport rolls', () => {
    // The worker holds the WHOLE project's events, so a sequence becoming active later needs
    // no re-send: the switch changes one field and the very next wake schedules the right
    // track. A sender-side filter would instead leave a window in which the worker holds no
    // events for the sequence it has just been told to play.
    const core = twoSequences('A');
    core.setTransport(true, false, 0);
    const before = run(core, steps(0.4));
    expect(trackIds(before)).toEqual(['ta']);

    meta(core, ['A', 'B'], 'B'); // the only message a switch sends (spec §7.1.3 `sequenceMeta`)
    const after = run(core, [2.0, 2.1, 2.2]); // the next loop pass
    expect(trackIds(after)).toEqual(['tb']);
    expect(notes(after).map((event) => event.note)).toEqual([38]);
  });

  it('still plays every segment’s own sequence in song mode (spec §7.9)', () => {
    // The guard against over-correcting: the worker keeps every track precisely because song
    // mode selects per segment. A filter in the sender would empty this.
    const core = new SchedulerCore();
    meta(core, ['A', 'B'], 'A', 'song');
    core.setSongSequence([
      { sequenceId: 'A', repeats: 1 },
      { sequenceId: 'B', repeats: 1 },
    ]);
    core.setTempo(120);
    core.applyEventsDiff('ta', 'A', [note('a1', 0, 36)], []);
    core.applyEventsDiff('tb', 'B', [note('b1', 0, 38)], []);
    core.setTransport(true, false, 0);

    const result = run(core, steps(2.2));
    expect(trackIds(result).sort()).toEqual(['ta', 'tb']);
  });
});

/**
 * Both tracks carry note 36 a beat into the bar, and Erase is armed on both — the shape a
 * real gesture takes, since a pad held over Erase arms that pad on every track the UI offers
 * it on. The notes sit at tick 480 rather than 0 so the first `tick(0)` cannot sweep them
 * before the arm lands: an erase test whose notes are already past is unfalsifiable.
 */
function twoSequencesSharingAPad(activeId: string | null): SchedulerCore {
  const core = new SchedulerCore();
  meta(core, ['A', 'B'], activeId);
  core.setTempo(120);
  core.setLoop(LOOP_1_BAR);
  core.applyEventsDiff('ta', 'A', [note('a1', 480, 36)], []);
  core.applyEventsDiff('tb', 'B', [note('b1', 480, 36)], []);
  core.setTransport(true, false, 0);
  core.tick(0);
  core.setLiveErase('ta', 36, true);
  core.setLiveErase('tb', 36, true);
  return core;
}

describe('a live erase reaches only the active sequence (spec §7.7, issue #132)', () => {
  it('erases the held pad from the active sequence and leaves the others alone', () => {
    const result = run(twoSequencesSharingAPad('A'), [0.1, 0.2, 0.3, 0.4]);
    expect(result.erased).toEqual([{ trackId: 'ta', eventIds: ['a1'] }]);
  });

  it('erases nothing when no sequence is active', () => {
    expect(run(twoSequencesSharingAPad(null), [0.1, 0.2, 0.3, 0.4]).erased).toEqual([]);
  });
});
