/**
 * Song mode does everything sequence mode does (spec §7.9, issue #94).
 *
 * `scheduleSong` used to schedule bare notes and nothing else: no note repeat (§7.3), no
 * arpeggiator (§7.3), no automation (§7.8), no live erase (§7.7), and no capture flush
 * until the transport stopped — so a crash mid-song lost the whole take. None of the five
 * was scoped to sequence mode by the spec; they were simply never called.
 *
 * Every test here drives a song map across at least one entry boundary, because the seam
 * between two segments is where a song-mode implementation differs from a sequence-mode one.
 */
import { describe, expect, it } from 'vitest';
import type { AutomationPoint, MidiEvent } from '@/core/project/schemas';
import type { ScheduledEvent } from './messages';
import { SchedulerCore, type SchedulerTickResult } from './schedulerCore';

function note(id: string, tickStart: number, pitch = 36, durationTicks = 120): MidiEvent {
  return { id, tickStart, durationTicks, note: pitch, velocity: 100, extra: null };
}

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
    merged.erased.push(...r.erased);
    merged.loopWrapped.push(...r.loopWrapped);
    merged.songAdvanced.push(...r.songAdvanced);
    merged.songEnded ||= r.songEnded;
  }
  return merged;
}

const notes = (r: SchedulerTickResult): ScheduledEvent[] => r.batch.filter((e) => e.kind === 'noteOn');
const ramps = (r: SchedulerTickResult): ScheduledEvent[] =>
  r.batch.filter((e) => e.kind === 'automationRamp');

/** A two-entry song of one-bar sequences: 4 s total at 120 bpm. */
function twoEntrySong(core: SchedulerCore): void {
  oneBarMeta(core, ['A', 'B']);
  core.setSongSequence(['A', 'B']);
  core.setTempo(120);
}

function point(
  scope: AutomationPoint['scope'],
  ownerId: string,
  tick: number,
  value: number,
): AutomationPoint {
  return {
    id: `${scope}-${ownerId}-${tick}`,
    scope,
    ownerId,
    targetPath: 'mixer.track:t1.level',
    tick,
    value,
    curve: 'linear',
  };
}

describe('song mode — note repeat (spec §7.3, §7.9)', () => {
  it('generates held-pad repeats on the division grid', () => {
    const core = new SchedulerCore();
    twoEntrySong(core);
    core.setNoteRepeat(true, { value: 8, triplet: false }); // every 480 ticks
    core.pushLiveNote(40, 90, true, 0, 'ta');
    core.setTransport(true, false, 0);

    const repeats = notes(run(core, 1.0)).filter((e) => e.note === 40);
    expect(repeats.length).toBeGreaterThanOrEqual(2);
    expect(repeats.map((e) => e.tick)).toContain(0);
    expect(repeats.map((e) => e.tick)).toContain(480);
    expect(repeats.every((e) => e.trackId === 'ta')).toBe(true);
  });

  it('repeats across an entry boundary at the next segment’s own tempo', () => {
    const core = new SchedulerCore();
    core.setSequenceMeta(
      {
        A: { lengthBars: 1, timeSigNumerator: 4, timeSigDenominator: 4, tempo: 120 },
        B: { lengthBars: 1, timeSigNumerator: 4, timeSigDenominator: 4, tempo: 60 },
      },
      120,
      'A',
      'song',
    );
    core.setSongSequence(['A', 'B']);
    core.setTempo(120);
    core.setNoteRepeat(true, { value: 4, triplet: false }); // every 960 ticks
    core.pushLiveNote(40, 90, true, 0, 'ta');
    core.setTransport(true, false, 0);

    const repeats = notes(run(core, 3.2)).filter((e) => e.note === 40);
    // A is 2 s long (4 beats at 120), so its four repeats land at 0, 0.5, 1.0, 1.5 s.
    // B runs at 60 bpm, so its first repeat is at 2.0 s and its second a whole second later.
    const afterBoundary = repeats.filter((e) => e.when >= 1.99);
    expect(afterBoundary[0]!.when).toBeCloseTo(2, 3);
    expect(afterBoundary[0]!.bpm).toBe(60);
    expect(afterBoundary[0]!.tick).toBe(0); // the segment's own sequence tick, not the song tick
    expect(afterBoundary[1]!.when).toBeCloseTo(3, 3);
  });
});

describe('song mode — arpeggiator (spec §7.3, §7.9)', () => {
  it('arpeggiates a held chord across the division grid', () => {
    const core = new SchedulerCore();
    twoEntrySong(core);
    core.setArpeggiator(true, { mode: 'up', octaves: 1, gate: 0.5, division: { value: 8, triplet: false } });
    core.pushLiveNote(60, 100, true, 0, 'ta');
    core.pushLiveNote(64, 100, true, 0, 'ta');
    core.setTransport(true, false, 0);

    const arped = notes(run(core, 1.0));
    const byTick = new Map(arped.map((e) => [e.tick, e.note]));
    expect(byTick.get(0)).toBe(60);
    expect(byTick.get(480)).toBe(64);
    expect(byTick.get(960)).toBe(60);
  });

  it('keeps each track’s chord to its own track', () => {
    const core = new SchedulerCore();
    twoEntrySong(core);
    core.setArpeggiator(true, { mode: 'up', octaves: 1, gate: 0.5, division: { value: 8, triplet: false } });
    core.pushLiveNote(60, 100, true, 0, 'ta');
    core.pushLiveNote(72, 100, true, 0, 'tb');
    core.setTransport(true, false, 0);

    const arped = notes(run(core, 0.6));
    const low = arped.filter((e) => e.note === 60);
    const high = arped.filter((e) => e.note === 72);
    expect(low.length).toBeGreaterThan(0);
    expect(high.length).toBeGreaterThan(0);
    expect(low.every((e) => e.trackId === 'ta')).toBe(true);
    expect(high.every((e) => e.trackId === 'tb')).toBe(true);
  });
});

describe('song mode — automation (spec §7.8, §7.9)', () => {
  it('schedules ramps toward the lane value', () => {
    const core = new SchedulerCore();
    twoEntrySong(core);
    core.applyAutomationDiff('sequence', 'A', 'mixer.track:t1.level', [
      point('sequence', 'A', 0, 0),
      point('sequence', 'A', 3840, 1),
    ]);
    core.setTransport(true, false, 0);

    const scheduled = ramps(run(core, 1.0));
    expect(scheduled.length).toBeGreaterThan(0);
    expect(scheduled[0]!.target).toBe('mixer.track:t1.level');
    const last = scheduled[scheduled.length - 1]!;
    expect(last.value!).toBeGreaterThan(0);
    expect(last.value!).toBeLessThanOrEqual(1);
  });

  it('plays each segment’s own sequence-scope lane, not only the active sequence’s', () => {
    // §7.8 scopes sequence automation to the pattern it belongs to, and in song mode the
    // pattern playing changes at every entry boundary. Resolving against the transport's
    // `activeSequenceId` would silence B's lane for the whole song.
    const core = new SchedulerCore();
    twoEntrySong(core);
    core.applyAutomationDiff('sequence', 'A', 'mixer.track:t1.level', [point('sequence', 'A', 0, 0.25)]);
    core.applyAutomationDiff('sequence', 'B', 'mixer.track:t1.level', [point('sequence', 'B', 0, 0.75)]);
    core.setTransport(true, false, 0);

    const scheduled = ramps(run(core, 3.5));
    expect(scheduled.find((e) => e.when < 1.5)?.value).toBeCloseTo(0.25, 6);
    expect(scheduled.find((e) => e.when >= 2.05)?.value).toBeCloseTo(0.75, 6);
  });

  it('lets a track-scope lane span the arrangement rather than loop with the pattern', () => {
    // §7.8: track automation "spans the song arrangement". The song is 4 s / 7680 ticks
    // long, so a lane running 0 → 1 across it must still be climbing during entry 2 —
    // where a lane sampled at the segment's own sequence tick would have restarted at 0.
    const core = new SchedulerCore();
    twoEntrySong(core);
    core.applyAutomationDiff('track', 't1', 'mixer.track:t1.level', [
      point('track', 't1', 0, 0),
      point('track', 't1', 7680, 1),
    ]);
    core.setTransport(true, false, 0);

    const scheduled = ramps(run(core, 3.5));
    const late = scheduled.filter((e) => e.when >= 3);
    expect(late.length).toBeGreaterThan(0);
    expect(late[late.length - 1]!.value!).toBeGreaterThan(0.7);
  });
});

describe('song mode — live erase (spec §7.7, §7.9)', () => {
  it('removes a held pad’s events as the song passes over them', () => {
    const core = new SchedulerCore();
    twoEntrySong(core);
    core.applyEventsDiff('ta', 'A', [note('keep', 500, 38), note('erase', 600, 36)], []);
    core.setTransport(true, false, 0);
    core.setLiveErase('ta', 36, true);

    const result = run(core, 1.0);
    expect(result.erased).toEqual([{ trackId: 'ta', eventIds: ['erase'] }]);
    expect(notes(result).some((e) => e.note === 38)).toBe(true);
  });

  it('erases only the segment the playhead is over', () => {
    const core = new SchedulerCore();
    twoEntrySong(core);
    core.applyEventsDiff('ta', 'A', [note('a', 600, 36)], []);
    core.applyEventsDiff('tb', 'B', [note('b', 600, 36)], []);
    core.setTransport(true, false, 0);
    core.setLiveErase('ta', 36, true);
    core.setLiveErase('tb', 36, true);

    // Entry A occupies 0–2 s. Stop short of B and only A's note may be gone.
    const result = run(core, 1.0);
    expect(result.erased).toEqual([{ trackId: 'ta', eventIds: ['a'] }]);
  });
});

describe('song mode — recording (spec §7.7, §7.9)', () => {
  it('flushes the take as each entry passes, not only at stop', () => {
    const core = new SchedulerCore();
    twoEntrySong(core);
    core.setMetronome(false, 0);
    core.setTransport(true, true, 0);
    core.tick(0);
    // A note played and released inside entry A (0–2 s).
    core.pushLiveNote(40, 100, true, 0.5, 'ta');
    core.pushLiveNote(40, 100, false, 0.8, 'ta');

    // Run to 3 s: still inside a 4 s song, so the transport has not stopped.
    let flushed: { trackId: string; events: MidiEvent[] }[] = [];
    for (let i = 1; i <= 60; i++) flushed = flushed.concat(core.tick(i * 0.05).recorded);

    expect(core.isPlaying).toBe(true);
    expect(flushed).toHaveLength(1);
    expect(flushed[0]!.trackId).toBe('ta');
    expect(flushed[0]!.events[0]!.note).toBe(40);
  });

  it('captures at the segment’s sequence tick, not the absolute song tick', () => {
    // `midi_events.tick_start` is a position inside the track's own pattern (§9.3), and a
    // one-bar sequence has only 3840 of them. A song tick would put a take recorded during
    // entry 2 at tick ~4800 — past the end of the pattern it belongs to, so it never sounds.
    const core = new SchedulerCore();
    twoEntrySong(core);
    core.setMetronome(false, 0);
    core.setTransport(true, true, 0);
    core.tick(0);
    // 2.5 s in: half a second into entry B, i.e. sequence tick 960.
    core.pushLiveNote(40, 100, true, 2.5, 'tb');
    core.pushLiveNote(40, 100, false, 2.6, 'tb');

    let flushed: { trackId: string; events: MidiEvent[] }[] = [];
    for (let i = 1; i <= 120; i++) flushed = flushed.concat(core.tick(i * 0.05).recorded);

    const captured = flushed.flatMap((f) => f.events);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.tickStart).toBeCloseTo(960, -1);
  });
});
