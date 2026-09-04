/**
 * §7.9's end of song — the stop path, the loop path, and the zero-length refusal.
 *
 * Before this existed `songSecondsToTick` clamped at `songTotalTicks`, so `scheduleSong`
 * early-returned on every wake past the end and the transport rolled on with nothing
 * scheduled — indistinguishable from a hung playhead (issue #101).
 */
import { describe, expect, it } from 'vitest';
import type { MidiEvent } from '@/core/project/schemas';
import { SchedulerCore, type SchedulerTickResult } from './schedulerCore';

function note(id: string, tickStart: number, pitch = 36): MidiEvent {
  return { id, tickStart, durationTicks: 120, note: pitch, velocity: 100, extra: null };
}

/** One-bar 4/4 sequences at the project tempo — a bar is 2 s at 120 bpm. */
function oneBarMeta(core: SchedulerCore, ids: string[], mode: 'sequence' | 'song' = 'song'): void {
  const sequences: Record<
    string,
    { lengthBars: number; timeSigNumerator: number; timeSigDenominator: 4; tempo: null }
  > = {};
  for (const id of ids) {
    sequences[id] = { lengthBars: 1, timeSigNumerator: 4, timeSigDenominator: 4, tempo: null };
  }
  core.setSequenceMeta(sequences, 120, ids[0] ?? null, mode);
}

interface Merged extends SchedulerTickResult {
  /** Number of ticks whose result carried `songEnded` — §7.9 allows exactly one. */
  endedCount: number;
}

function run(core: SchedulerCore, to: number, by = 0.05): Merged {
  const merged: Merged = {
    batch: [],
    recorded: [],
    erased: [],
    loopWrapped: [],
    songAdvanced: [],
    songEnded: false,
    endedCount: 0,
  };
  for (let i = 0; i <= Math.round(to / by); i++) {
    const r = core.tick(i * by);
    merged.batch.push(...r.batch);
    merged.recorded.push(...r.recorded);
    merged.erased.push(...r.erased);
    merged.loopWrapped.push(...r.loopWrapped);
    merged.songAdvanced.push(...r.songAdvanced);
    if (r.songEnded) {
      merged.songEnded = true;
      merged.endedCount += 1;
    }
  }
  return merged;
}

/** A two-entry song of one-bar sequences: 4 s total at 120 bpm. */
function twoEntrySong(core: SchedulerCore): void {
  oneBarMeta(core, ['A', 'B']);
  core.setSongSequence([
    { sequenceId: 'A', repeats: 1 },
    { sequenceId: 'B', repeats: 1 },
  ]);
  core.setTempo(120);
  core.applyEventsDiff('ta', 'A', [note('a', 0, 36)], []);
  core.applyEventsDiff('tb', 'B', [note('b', 0, 38)], []);
}

describe('end of song — stop (spec §7.9, songLoopEnabled false)', () => {
  it('posts songEnded exactly once and stops the transport', () => {
    const core = new SchedulerCore();
    twoEntrySong(core);
    core.setTransport(true, false, 0);

    const result = run(core, 6);
    expect(result.endedCount).toBe(1);
    expect(core.isPlaying).toBe(false);
  });

  it('returns the playhead to tick 0', () => {
    const core = new SchedulerCore();
    twoEntrySong(core);
    core.setTransport(true, false, 0);
    run(core, 6);
    expect(core.playheadTick(6)).toBe(0);
  });

  it('does not stop before the playhead reaches the end, only before the lookahead does', () => {
    const core = new SchedulerCore();
    twoEntrySong(core);
    core.setTransport(true, false, 0);
    // 3.9 s is inside a 4 s song, but the 100 ms lookahead window has already run past it.
    expect(run(core, 3.9).songEnded).toBe(false);
  });

  it('schedules every note of the song before ending it', () => {
    const core = new SchedulerCore();
    twoEntrySong(core);
    core.setTransport(true, false, 0);
    const hits = run(core, 6).batch.filter((e) => e.kind === 'noteOn');
    expect(hits.map((e) => e.note)).toEqual([36, 38]);
    expect(hits[1]!.when).toBeCloseTo(2, 3);
  });

  it('flushes a recording in progress in the same result as songEnded (spec §7.9)', () => {
    const core = new SchedulerCore();
    twoEntrySong(core);
    core.setTransport(true, true, 0);
    // Run into the last entry first, so the note below is played after the scheduler has
    // already crossed into it. A take from an earlier entry is merged by the per-pass flush
    // (issue #94); what §7.9 pins is that whatever is STILL uncommitted at the end goes out
    // with the end, which is the last chance to persist it.
    for (let i = 0; i <= 60; i++) core.tick(i * 0.05); // to 3.0 s of a 4 s song
    core.pushLiveNote(40, 100, true, 3.1, 'tb');
    core.pushLiveNote(40, 100, false, 3.4, 'tb');

    let ending: SchedulerTickResult | null = null;
    for (let i = 61; i <= 120; i++) {
      const r = core.tick(i * 0.05);
      if (r.songEnded) {
        ending = r;
        break;
      }
    }
    expect(ending).not.toBeNull();
    // The take is carried by the very result that reports the end, so the worker shell
    // posts `recorded` before `songEnded` — the last chance to persist it (spec §7.9).
    expect(ending!.recorded).toHaveLength(1);
    expect(ending!.recorded[0]!.events[0]!.note).toBe(40);
  });
});

describe('end of song — loop (spec §7.9, songLoopEnabled true)', () => {
  it('wraps to tick 0 and never posts songEnded', () => {
    const core = new SchedulerCore();
    twoEntrySong(core);
    core.setSongLoop(true);
    core.setTransport(true, false, 0);

    const result = run(core, 9);
    expect(result.songEnded).toBe(false);
    expect(core.isPlaying).toBe(true);
    // Two full passes of a 4 s song inside 9 s: entry 0 is re-announced after each wrap.
    expect(result.songAdvanced).toEqual([0, 1, 0, 1, 0]);
  });

  it('re-schedules the song on the second pass', () => {
    const core = new SchedulerCore();
    twoEntrySong(core);
    core.setSongLoop(true);
    core.setTransport(true, false, 0);

    const hits = run(core, 7).batch.filter((e) => e.kind === 'noteOn');
    expect(hits.map((e) => e.note)).toEqual([36, 38, 36, 38]);
    expect(hits[2]!.when).toBeCloseTo(4, 3); // first note of the second pass
    expect(hits[3]!.when).toBeCloseTo(6, 3);
  });

  it('wraps the playhead rather than clamping it at the end', () => {
    const core = new SchedulerCore();
    twoEntrySong(core);
    core.setSongLoop(true);
    core.setTransport(true, false, 0);
    run(core, 5);
    // 4.5 s into a 4 s song is half a second into the second pass — a quarter note in.
    expect(core.playheadTick(4.5)).toBeCloseTo(960, 0);
  });

  it('schedules each pass exactly once across a wrap inside one lookahead window', () => {
    // A song shorter than the 100 ms lookahead is the worst case for double-scheduling
    // (spec §7.1.5: an event may be scheduled exactly once per pass).
    const core = new SchedulerCore();
    core.setSequenceMeta(
      { A: { lengthBars: 1, timeSigNumerator: 1, timeSigDenominator: 16, tempo: 960 } },
      960,
      'A',
      'song',
    );
    core.setSongSequence([{ sequenceId: 'A', repeats: 1 }]);
    core.setTempo(960);
    core.setSongLoop(true);
    core.applyEventsDiff('ta', 'A', [note('a', 0)], []);
    core.setTransport(true, false, 0);

    // One pass is 240 ticks at 960 bpm = 0.0156 s, so a 100 ms window spans six passes.
    const hits = run(core, 1, 0.1).batch.filter((e) => e.kind === 'noteOn');
    const times = hits.map((e) => Math.round(e.when * 10_000));
    expect(new Set(times).size).toBe(times.length); // no repeated `when`
  });
});

describe('end of song — a zero-length map (spec §7.9)', () => {
  it('stops rather than spinning when the playlist is empty', () => {
    const core = new SchedulerCore();
    oneBarMeta(core, ['A']);
    core.setSongSequence([]);
    core.setTempo(120);
    core.setTransport(true, false, 0);

    const result = run(core, 1);
    expect(result.endedCount).toBe(1);
    expect(core.isPlaying).toBe(false);
  });

  it('stops even with looping on — there is nothing to loop over', () => {
    const core = new SchedulerCore();
    oneBarMeta(core, ['A']);
    core.setSongSequence([]);
    core.setTempo(120);
    core.setSongLoop(true);
    core.setTransport(true, false, 0);

    expect(run(core, 1).endedCount).toBe(1);
    expect(core.isPlaying).toBe(false);
  });

  it('stops when every entry names a sequence the project no longer has', () => {
    const core = new SchedulerCore();
    oneBarMeta(core, ['A']);
    core.setSongSequence([
      { sequenceId: 'deleted', repeats: 1 },
      { sequenceId: 'also-deleted', repeats: 1 },
    ]);
    core.setTempo(120);
    core.setTransport(true, false, 0);

    expect(run(core, 1).endedCount).toBe(1);
  });
});

describe('changing the loop toggle or the playback mode mid-song (spec §7.9, §8.5.12)', () => {
  it('ends the pass in progress rather than stopping the moment the loop is turned off', () => {
    const core = new SchedulerCore();
    twoEntrySong(core);
    core.setSongLoop(true);
    core.setTransport(true, false, 0);
    // Run into the second pass of a 4 s song, then turn looping off.
    for (let i = 0; i <= 100; i++) core.tick(i * 0.05);
    core.setSongLoop(false);

    // The pass in progress must finish: stopping here would cut it off part-way through.
    expect(core.tick(5.05).songEnded).toBe(false);
    expect(core.isPlaying).toBe(true);

    let ended = false;
    for (let i = 102; i <= 200; i++) ended ||= core.tick(i * 0.05).songEnded;
    expect(ended).toBe(true);
    expect(core.isPlaying).toBe(false);
  });

  it('does not replay the whole elapsed span when playback switches to sequence mode', () => {
    // The mode picker is live while the transport rolls (spec §8.5.12). A sequence cursor
    // left behind at the song's start would make the first sequence-mode wake schedule
    // every tick since then in one burst, with a loop wrap and a capture flush per pass.
    const core = new SchedulerCore();
    twoEntrySong(core);
    core.setSongLoop(true);
    core.setLoop({ enabled: true, startTick: 0, endTick: 3840 });
    core.setTransport(true, false, 0);
    for (let i = 0; i <= 200; i++) core.tick(i * 0.05); // ten seconds of song

    core.setSequenceMeta(
      {
        A: { lengthBars: 1, timeSigNumerator: 4, timeSigDenominator: 4, tempo: null },
        B: { lengthBars: 1, timeSigNumerator: 4, timeSigDenominator: 4, tempo: null },
      },
      120,
      'A',
      'sequence',
    );
    const first = core.tick(10.05);
    expect(first.loopWrapped.length).toBeLessThanOrEqual(1);
    expect(first.batch.filter((e) => e.kind === 'noteOn').length).toBeLessThanOrEqual(2);
  });
});

describe('the tempo a scheduled note carries (spec §7.2, §7.9)', () => {
  it('stamps a sequence-mode note with the transport tempo', () => {
    const core = new SchedulerCore();
    oneBarMeta(core, ['A'], 'sequence');
    core.setTempo(140);
    core.setLoop({ enabled: true, startTick: 0, endTick: 3840 });
    core.applyEventsDiff('ta', 'A', [note('a', 0)], []);
    core.setTransport(true, false, 0);
    const hit = run(core, 0.5).batch.find((e) => e.kind === 'noteOn');
    expect(hit?.bpm).toBe(140);
  });

  it('stamps a song-mode note with its own segment’s tempo, not the transport’s', () => {
    // A sequence with a tempo of its own plays at it (spec §7.9), and a §6 tempo-synced
    // LFO on that note has to follow the same tempo the note is placed against.
    const core = new SchedulerCore();
    core.setSequenceMeta(
      {
        A: { lengthBars: 1, timeSigNumerator: 4, timeSigDenominator: 4, tempo: 60 },
        B: { lengthBars: 1, timeSigNumerator: 4, timeSigDenominator: 4, tempo: 180 },
      },
      120,
      'A',
      'song',
    );
    core.setSongSequence([
      { sequenceId: 'A', repeats: 1 },
      { sequenceId: 'B', repeats: 1 },
    ]);
    core.setTempo(120);
    core.applyEventsDiff('ta', 'A', [note('a', 0, 36)], []);
    core.applyEventsDiff('tb', 'B', [note('b', 0, 38)], []);
    core.setTransport(true, false, 0);

    const hits = run(core, 6).batch.filter((e) => e.kind === 'noteOn');
    expect(hits.find((e) => e.note === 36)?.bpm).toBe(60);
    expect(hits.find((e) => e.note === 38)?.bpm).toBe(180);
  });
});
