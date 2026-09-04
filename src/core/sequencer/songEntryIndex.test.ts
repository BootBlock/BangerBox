/**
 * `songAdvanced { entryIndex }` addresses §7.9's position-sorted ENTRY list (issue #130).
 *
 * §7.9 is explicit: the index is into the position-sorted entry list, entries skipped for a
 * missing sequence still consume an index, and "consumers MUST index the same sorted
 * projection rather than the raw `songEntries` array". `sequencerSync` used to expand
 * `repeats` before the playlist reached the worker, so an entry played twice consumed two
 * indices and every consumer downstream of the first repeated entry read the wrong row.
 *
 * The entry index is deliberately NOT the same number as the segment ordinal `emitSongPass`
 * counts for the §7.7 capture flush: a take is merged at each PLAY of a sequence, and an
 * entry that repeats is several plays of one entry. The last test here pins the two apart.
 */
import { describe, expect, it } from 'vitest';
import type { MidiEvent } from '@/core/project/schemas';
import type { SchedulerSongEntry } from './messages';
import { SchedulerCore, type SchedulerTickResult } from './schedulerCore';

/** One-bar 4/4 sequences at the project tempo — a bar is 2 s at 120 bpm. */
function oneBarMeta(core: SchedulerCore, ids: string[]): void {
  const sequences: Record<
    string,
    { lengthBars: number; timeSigNumerator: number; timeSigDenominator: 4; tempo: null }
  > = {};
  for (const id of ids) {
    sequences[id] = { lengthBars: 1, timeSigNumerator: 4, timeSigDenominator: 4, tempo: null };
  }
  core.setSequenceMeta(sequences, 120, ids[0] ?? null, 'song');
}

function song(core: SchedulerCore, known: string[], entries: SchedulerSongEntry[]): void {
  oneBarMeta(core, known);
  core.setSongSequence(entries);
  core.setTempo(120);
}

function run(core: SchedulerCore, to: number, by = 0.05): SchedulerTickResult {
  const merged: SchedulerTickResult = {
    batch: [],
    recorded: [],
    erased: [],
    loopWrapped: [],
    songAdvanced: [],
    songEnded: false,
  };
  for (let i = 0; i <= Math.round(to / by); i++) {
    const r = core.tick(i * by);
    merged.batch.push(...r.batch);
    merged.recorded.push(...r.recorded);
    merged.songAdvanced.push(...r.songAdvanced);
    merged.songEnded ||= r.songEnded;
  }
  return merged;
}

describe('songAdvanced entry index (spec §7.9, issue #130)', () => {
  it('gives a repeated entry ONE index, not one per repeat', () => {
    const core = new SchedulerCore();
    // Two entries, six bars of music: A played three times, then B once.
    song(
      core,
      ['A', 'B'],
      [
        { sequenceId: 'A', repeats: 3 },
        { sequenceId: 'B', repeats: 1 },
      ],
    );
    core.setTransport(true, false, 0);

    // 8 s covers all four passes (6 s of A + 2 s of B) with room to spare.
    const result = run(core, 8.0);
    expect(result.songAdvanced).toEqual([0, 1]);
  });

  it('still plays every repeat it announced once', () => {
    const core = new SchedulerCore();
    song(
      core,
      ['A', 'B'],
      [
        { sequenceId: 'A', repeats: 3 },
        { sequenceId: 'B', repeats: 1 },
      ],
    );
    const beat: MidiEvent = {
      id: 'a1',
      tickStart: 0,
      durationTicks: 120,
      note: 36,
      velocity: 100,
      extra: null,
    };
    core.applyEventsDiff('ta', 'A', [beat], []);
    core.setTransport(true, false, 0);

    const played = run(core, 8.0).batch.filter((e) => e.kind === 'noteOn');
    // One index was announced for A, and A sounded three times: the index counts entries,
    // the song map counts plays, and the arrangement is the second of the two.
    expect(played).toHaveLength(3);
  });

  it('lets an entry whose sequence is missing consume its index', () => {
    const core = new SchedulerCore();
    // Only 'B' has metadata, so the first entry contributes no segments at all (spec §7.9).
    song(
      core,
      ['B'],
      [
        { sequenceId: 'gone', repeats: 2 },
        { sequenceId: 'B', repeats: 1 },
      ],
    );
    core.setTransport(true, false, 0);

    // The surviving entry is index 1, never index 0 — a consumer indexing the map's
    // segments rather than the entry list would highlight the wrong row for the whole song.
    expect(run(core, 3.0).songAdvanced).toEqual([1]);
  });

  it('keeps the §7.7 capture flush counting PLAYS while the index counts entries', () => {
    const core = new SchedulerCore();
    song(core, ['A'], [{ sequenceId: 'A', repeats: 3 }]);
    core.setMetronome(false, 0);
    core.setTransport(true, true, 0);
    const first = core.tick(0); // establishes the anchor, and announces entry 0
    // A note played and released inside A's first pass (0–2 s).
    core.pushLiveNote(40, 100, true, 0.5, 'ta');
    core.pushLiveNote(40, 100, false, 0.8, 'ta');

    const result = run(core, 5.0);
    // One entry, so one announcement…
    expect([...first.songAdvanced, ...result.songAdvanced]).toEqual([0]);
    // …and the take is still merged while the transport rolls, at the pass boundary rather
    // than at the stop — a repeat is a play, and §7.7 merges an overdub at each play.
    expect(core.isPlaying).toBe(true);
    expect(result.recorded).toHaveLength(1);
    expect(result.recorded[0]!.events[0]!.note).toBe(40);
  });
});
