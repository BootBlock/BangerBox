import { describe, expect, it } from 'vitest';
import { PPQN } from '@/core/constants';
import type { AutomationPoint, MidiEvent } from '@/core/project/schemas';
import type { ScheduledEvent } from './messages';
import { SchedulerCore, type SchedulerTickResult } from './schedulerCore';

function note(id: string, tickStart: number, note = 36, durationTicks = 120): MidiEvent {
  return { id, tickStart, durationTicks, note, velocity: 100, extra: null };
}

/** Metadata message for a single 1-bar 4/4 sequence at the project tempo. */
function oneBarMeta(core: SchedulerCore, ids: string[], activeId: string | null, mode: 'sequence' | 'song') {
  const sequences: Record<
    string,
    { lengthBars: number; timeSigNumerator: number; timeSigDenominator: 4; tempo: null }
  > = {};
  for (const id of ids) {
    sequences[id] = { lengthBars: 1, timeSigNumerator: 4, timeSigDenominator: 4, tempo: null };
  }
  core.setSequenceMeta(sequences, 120, activeId, mode);
}

/** Run tick() across a series of context times and merge the results. */
function run(core: SchedulerCore, times: number[]): SchedulerTickResult {
  const merged: SchedulerTickResult = {
    batch: [],
    recorded: [],
    erased: [],
    loopWrapped: [],
    songAdvanced: [],
    songEnded: false,
  };
  for (const t of times) {
    const r = core.tick(t);
    merged.batch.push(...r.batch);
    merged.recorded.push(...r.recorded);
    merged.erased.push(...r.erased);
    merged.loopWrapped.push(...r.loopWrapped);
    merged.songAdvanced.push(...r.songAdvanced);
    merged.songEnded ||= r.songEnded;
  }
  return merged;
}

const steps = (to: number, by = 0.1) => Array.from({ length: Math.round(to / by) + 1 }, (_, i) => i * by);
const notes = (r: SchedulerTickResult): ScheduledEvent[] => r.batch.filter((e) => e.kind === 'noteOn');

// BAR = 3840 ticks; at 120 bpm one quarter (960 ticks) = 0.5 s, one bar = 2 s.
const LOOP_1_BAR = { enabled: true, startTick: 0, endTick: 3840 };

describe('SchedulerCore — sequence playback (spec §7.1.4)', () => {
  it('schedules events at their context times', () => {
    const core = new SchedulerCore();
    oneBarMeta(core, ['S'], 'S', 'sequence');
    core.setTempo(120);
    core.setLoop(LOOP_1_BAR);
    core.applyEventsDiff('t1', 'S', [note('a', 0), note('b', 960), note('c', 1920)], []);
    core.setTransport(true, false, 0);

    const result = run(core, steps(1.0));
    const scheduled = notes(result);
    // Beat 1 at ~0 s, beat 2 at ~0.5 s, beat 3 at ~1.0 s.
    expect(scheduled.find((e) => e.tick === 0)?.when).toBeCloseTo(0, 3);
    expect(scheduled.find((e) => e.tick === 960)?.when).toBeCloseTo(0.5, 3);
    expect(scheduled.find((e) => e.tick === 1920)?.when).toBeCloseTo(1.0, 3);
    // Each event scheduled exactly once in one pass.
    expect(scheduled.filter((e) => e.tick === 0)).toHaveLength(1);
  });

  it('applies swing to off-beat subdivisions (spec §7.4)', () => {
    const core = new SchedulerCore();
    oneBarMeta(core, ['S'], 'S', 'sequence');
    core.setTempo(120);
    core.setSwing(75, 16);
    core.setLoop(LOOP_1_BAR);
    // Event on the odd 1/16 subdivision (tick 240) is delayed by 60 ticks → 300 ticks.
    core.applyEventsDiff('t1', 'S', [note('x', 240)], []);
    core.setTransport(true, false, 0);
    const result = run(core, steps(0.5));
    const when = notes(result).find((e) => e.tick === 240)?.when;
    // 300 ticks at 120 bpm = 300 / 1920 s.
    expect(when).toBeCloseTo(300 / 1920, 3);
  });
});

describe('SchedulerCore — applyEventsDiff ordering (spec §7.1.3)', () => {
  // A diff may carry a delete and an upsert for the same id — an edit the store expresses
  // as "remove the old row, write the new one". Deletes are therefore applied FIRST, so the
  // upsert wins; the other order would drop an edited note entirely (issue #96).
  it('applies deletes before upserts, so an id in both survives with its new value', () => {
    const core = new SchedulerCore();
    oneBarMeta(core, ['S'], 'S', 'sequence');
    core.setTempo(120);
    core.setLoop(LOOP_1_BAR);
    core.applyEventsDiff('t1', 'S', [note('a', 0, 36)], []);
    core.applyEventsDiff('t1', 'S', [note('a', 960, 38)], ['a']);
    core.setTransport(true, false, 0);

    const scheduled = notes(run(core, steps(1.2)));
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.note).toBe(38);
    expect(scheduled[0]!.tick).toBe(960);
  });

  it('deletes an id the same message does not re-upsert', () => {
    const core = new SchedulerCore();
    oneBarMeta(core, ['S'], 'S', 'sequence');
    core.setTempo(120);
    core.setLoop(LOOP_1_BAR);
    core.applyEventsDiff('t1', 'S', [note('a', 0, 36), note('b', 960, 38)], []);
    core.applyEventsDiff('t1', 'S', [], ['a']);
    core.setTransport(true, false, 0);

    expect(notes(run(core, steps(1.2))).map((e) => e.note)).toEqual([38]);
  });
});

describe('SchedulerCore — the count-in boundary (spec §7.7)', () => {
  it('drops a note played during the count-in rather than capturing it at the start tick', () => {
    // §7.7 starts playback after `countInBars` of metronome, so a pad struck during the
    // count-in is a rehearsal, not part of the take. Deliberate, and now verified (#96).
    const core = new SchedulerCore();
    oneBarMeta(core, ['S'], 'S', 'sequence');
    core.setTempo(120);
    core.setMetronome(true, 1); // one bar = 2 s at 120 bpm
    core.setTransport(true, true, 0);
    core.tick(0);

    core.pushLiveNote(36, 100, true, 0.5, 't1'); // inside the count-in
    core.pushLiveNote(36, 100, false, 0.9, 't1');
    core.pushLiveNote(38, 100, true, 2.5, 't1'); // after it
    core.pushLiveNote(38, 100, false, 2.9, 't1');
    core.setTransport(false, false, 0);

    const captured = core.tick(3.0).recorded.flatMap((f) => f.events);
    expect(captured.map((e) => e.note)).toEqual([38]);
  });
});

describe('SchedulerCore — loop boundary (spec §7.1.5)', () => {
  it('re-schedules the pattern each pass exactly once and emits loopWrapped', () => {
    const core = new SchedulerCore();
    oneBarMeta(core, ['S'], 'S', 'sequence');
    core.setTempo(120);
    core.setLoop(LOOP_1_BAR);
    core.applyEventsDiff('t1', 'S', [note('a', 0)], []);
    core.setTransport(true, false, 0);

    const result = run(core, steps(2.2));
    const firstBar = notes(result).filter((e) => e.tick === 0);
    // The tick-0 event fires at the start of pass 0 (~0 s) and pass 1 (~2 s), once each.
    expect(firstBar).toHaveLength(2);
    expect(firstBar[0]!.when).toBeCloseTo(0, 3);
    expect(firstBar[1]!.when).toBeCloseTo(2, 3);
    expect(result.loopWrapped).toContain(0); // wrapped to loop start
    expect(result.loopWrapped).toHaveLength(1);
  });
});

describe('SchedulerCore — song transition (spec §7.9)', () => {
  it('schedules across an entry boundary and advances the song', () => {
    const core = new SchedulerCore();
    oneBarMeta(core, ['A', 'B'], 'A', 'song');
    core.setSongSequence([
      { sequenceId: 'A', repeats: 1 },
      { sequenceId: 'B', repeats: 1 },
    ]);
    core.setTempo(120);
    core.applyEventsDiff('ta', 'A', [note('a', 0, 36)], []);
    core.applyEventsDiff('tb', 'B', [note('b', 0, 38)], []);
    core.setTransport(true, false, 0);

    const result = run(core, steps(2.2));
    const scheduled = notes(result);
    // A's note plays at song start (~0 s); B's note plays at the boundary (~2 s).
    expect(scheduled.find((e) => e.note === 36)?.when).toBeCloseTo(0, 3);
    const bHit = scheduled.find((e) => e.note === 38);
    expect(bHit?.when).toBeCloseTo(2, 3);
    expect(result.songAdvanced).toEqual([0, 1]); // entered entry 0, then entry 1
  });

  it('swings in song mode exactly as in sequence mode (spec §7.4, §7.9)', () => {
    // §7.4 applies swing "at schedule time" with no song-mode exemption: the same pattern
    // must not sound straight just because a song is playing it rather than the sequencer.
    const core = new SchedulerCore();
    oneBarMeta(core, ['A'], 'A', 'song');
    core.setSongSequence([{ sequenceId: 'A', repeats: 1 }]);
    core.setTempo(120);
    core.setSwing(75, 16);
    core.applyEventsDiff('ta', 'A', [note('x', 240)], []);
    core.setTransport(true, false, 0);

    const when = notes(run(core, steps(0.5))).find((e) => e.tick === 240)?.when;
    // Same as the sequence-mode case: 240 ticks delayed by 60 → 300 ticks at 120 bpm.
    expect(when).toBeCloseTo(300 / 1920, 3);
  });

  it('applies a track groove in song mode (spec §7.5)', () => {
    const core = new SchedulerCore();
    oneBarMeta(core, ['A'], 'A', 'song');
    core.setSongSequence([{ sequenceId: 'A', repeats: 1 }]);
    core.setTempo(120);
    core.setGroove('ta', {
      ppqn: PPQN,
      lengthTicks: PPQN * 4,
      division: 16,
      points: [{ gridTick: 0, offsetTicks: 30, velocityScale: 0.8 }],
    });
    core.applyEventsDiff('ta', 'A', [note('a', 0)], []);
    core.setTransport(true, false, 0);

    const hit = notes(run(core, steps(0.5)))[0];
    expect(hit?.velocity).toBe(80);
    expect(hit!.when).toBeCloseTo(30 / 1920, 4);
  });
});

describe('SchedulerCore — note repeat (spec §7.3)', () => {
  it('generates held notes on the division grid', () => {
    const core = new SchedulerCore();
    oneBarMeta(core, ['S'], 'S', 'sequence');
    core.setTempo(120);
    core.setLoop(LOOP_1_BAR);
    core.setNoteRepeat(true, { value: 8, triplet: false }); // every 480 ticks
    core.pushLiveNote(40, 90, true, 0, 't1');
    core.setTransport(true, false, 0);

    const result = run(core, steps(1.0));
    const repeats = notes(result).filter((e) => e.note === 40);
    // 1/8 grid over ~1 s → ticks 0, 480, 960, 1440, 1920 (whichever fall in the window).
    const ticks = repeats.map((e) => e.tick);
    expect(ticks).toContain(0);
    expect(ticks).toContain(480);
    expect(ticks).toContain(960);
  });
});

describe('SchedulerCore — arpeggiator (spec §7.3)', () => {
  it('arpeggiates a held chord across the division grid', () => {
    const core = new SchedulerCore();
    oneBarMeta(core, ['S'], 'S', 'sequence');
    core.setTempo(120);
    core.setLoop(LOOP_1_BAR);
    core.setArpeggiator(true, { mode: 'up', octaves: 1, gate: 0.5, division: { value: 8, triplet: false } });
    core.pushLiveNote(60, 100, true, 0, 't1');
    core.pushLiveNote(64, 100, true, 0, 't1');
    core.setTransport(true, false, 0);

    const arped = notes(run(core, steps(1.0)));
    // 1/8 grid (480 ticks): step 0 → 60, step 1 → 64, step 2 → 60 … cycling the 2-note chord.
    const byTick = new Map(arped.map((e) => [e.tick, e.note]));
    expect(byTick.get(0)).toBe(60);
    expect(byTick.get(480)).toBe(64);
    expect(byTick.get(960)).toBe(60);
  });

  it('does nothing when disabled or no note is held', () => {
    const core = new SchedulerCore();
    oneBarMeta(core, ['S'], 'S', 'sequence');
    core.setTempo(120);
    core.setLoop(LOOP_1_BAR);
    core.setArpeggiator(false, { mode: 'up', octaves: 1, gate: 0.5, division: { value: 8, triplet: false } });
    core.pushLiveNote(60, 100, true, 0, 't1');
    core.setTransport(true, false, 0);
    expect(notes(run(core, steps(1.0)))).toHaveLength(0);
  });
});

describe('SchedulerCore — recording (spec §7.7)', () => {
  it('captures a played note and flushes it on stop', () => {
    const core = new SchedulerCore();
    oneBarMeta(core, ['S'], 'S', 'sequence');
    core.setTempo(120);
    core.setMetronome(false, 0); // no count-in
    core.setTransport(true, true, 0); // play + record
    core.tick(0);
    // Play a note from tick 192 (0.1 s) to tick 384 (0.2 s).
    core.pushLiveNote(36, 100, true, 0.1, 't1');
    core.pushLiveNote(36, 100, false, 0.2, 't1');
    core.setTransport(false, false, 0); // stop → flush
    const result = core.tick(0.25);

    expect(result.recorded).toHaveLength(1);
    const captured = result.recorded[0]!;
    expect(captured.trackId).toBe('t1');
    expect(captured.events).toHaveLength(1);
    expect(captured.events[0]!.tickStart).toBeCloseTo(192, -1); // ~0.1 s in
    expect(captured.events[0]!.durationTicks).toBeGreaterThanOrEqual(150);
    expect(captured.events[0]!.note).toBe(36);
  });

  it('plays a count-in of metronome clicks before content (spec §7.7)', () => {
    const core = new SchedulerCore();
    oneBarMeta(core, ['S'], 'S', 'sequence');
    core.setTempo(120);
    core.setMetronome(false, 1); // one bar count-in, click-off otherwise
    core.setTransport(true, true, 0);

    // Cover the whole count-in bar (2 s at 120 bpm): 4 clicks at 0, 0.5, 1.0, 1.5 s.
    const result = run(core, steps(1.7));
    const clicks = result.batch.filter((e) => e.kind === 'click');
    expect(clicks).toHaveLength(4);
    expect(clicks[0]!.accented).toBe(true); // beat 1 accented
    expect(clicks[1]!.accented).toBe(false);
    expect(clicks.map((c) => c.when)).toEqual([0, 0.5, 1, 1.5].map((v) => expect.closeTo(v, 3)));
  });

  it('accents the bar line, not the play gesture, when starting mid-bar (spec §5.9)', () => {
    // Loop start is user-placeable at any tick (§7.1.5) and becomes the transport start tick,
    // so playback can begin on beat 3. The accent must still land on beat 1.
    const core = new SchedulerCore();
    oneBarMeta(core, ['S'], 'S', 'sequence');
    core.setTempo(120);
    core.setLoop({ enabled: true, startTick: 1920, endTick: 3840 }); // beat 3 of the bar
    core.setMetronome(true, 0);
    core.setTransport(true, false, 1920);

    const clicks = run(core, steps(1.7)).batch.filter((e) => e.kind === 'click');
    // Beats 3, 4, 1, 2 — only the third click (beat 1) is accented.
    expect(clicks.map((c) => c.accented)).toEqual([false, false, true, false]);
  });
});

describe('SchedulerCore — live erase (spec §7.7)', () => {
  it('removes a held pad’s events as the loop passes', () => {
    const core = new SchedulerCore();
    oneBarMeta(core, ['S'], 'S', 'sequence');
    core.setTempo(120);
    core.setLoop(LOOP_1_BAR);
    core.applyEventsDiff('t1', 'S', [note('keep', 500, 38), note('erase', 600, 36)], []);
    core.setTransport(true, false, 0);
    core.setLiveErase('t1', 36, true);

    const result = run(core, steps(1.0));
    expect(result.erased).toHaveLength(1);
    expect(result.erased[0]).toEqual({ trackId: 't1', eventIds: ['erase'] });
    // The kept note (different pad) is untouched and still schedules.
    expect(notes(result).some((e) => e.note === 38)).toBe(true);
  });

  it('erases only the ticks under the playhead when the window straddles the loop end', () => {
    const core = new SchedulerCore();
    oneBarMeta(core, ['S'], 'S', 'sequence');
    core.setTempo(120);
    core.setLoop(LOOP_1_BAR);
    // Same pad on both sides of the bar: one just before the loop end, one early next pass.
    core.applyEventsDiff('t1', 'S', [note('early', 100), note('late', 3800)], []);
    core.setTransport(true, false, 0);

    // Play up to just before the wrap with erase disarmed, then arm it. The offsets keep the
    // lookahead window off the 3840-tick boundary so the next wake genuinely straddles it.
    run(core, [0, 1.86]);
    core.setLiveErase('t1', 36, true);
    const result = run(core, [1.91]);

    // Window is linear [3763.2, 3859.2) → sequence [3763.2, 3840) ∪ [0, 19.2): 'late' only.
    expect(result.erased).toEqual([{ trackId: 't1', eventIds: ['late'] }]);
  });

  /**
   * What a sweep longer than one loop pass means (spec §7.7 does not say).
   *
   * §7.7 removes a held pad's events "as the loop passes", which answers the ordinary case
   * — a window narrower than the loop — and says nothing about a window that laps it. The
   * rule this pins is the one the wrap-aware window already implies: what goes is the UNION
   * of the sequence ticks the window passed over, and each event goes exactly ONCE however
   * many passes swept it. A count would make the number of `erased` reports depend on the
   * scheduler's wake rate, which is a §7.1.4 implementation detail rather than a musical one.
   */
  it('erases the union of a sweep that laps the loop, reporting each event once', () => {
    const core = new SchedulerCore();
    oneBarMeta(core, ['S'], 'S', 'sequence');
    core.setTempo(120);
    // A one-beat loop: 960 ticks, 0.5 s at 120 bpm.
    core.setLoop({ enabled: true, startTick: 0, endTick: 960 });
    core.applyEventsDiff('t1', 'S', [note('at0', 0), note('other', 240, 38), note('at480', 480)], []);
    core.setTransport(true, false, 0);
    core.setLiveErase('t1', 36, true);

    // One wake covering 2.2 passes: linear [192, 2304) → pass 0 [192, 960), pass 1 [0, 960),
    // pass 2 [0, 384). Tick 480 is swept twice and tick 0 twice; neither may be reported twice.
    const result = run(core, [0, 1.1]);
    const ids = result.erased.flatMap((entry) => entry.eventIds);
    expect(ids.toSorted()).toEqual(['at0', 'at480']);
    // The other pad is never swept away, however many passes the window laps.
    expect(notes(result).some((e) => e.note === 38)).toBe(true);
  });
});

describe('SchedulerCore — automation (spec §7.8)', () => {
  function point(
    scope: AutomationPoint['scope'],
    ownerId: string,
    tick: number,
    value: number,
  ): AutomationPoint {
    return {
      id: `${scope}-${tick}`,
      scope,
      ownerId,
      targetPath: 'mixer.track:t1.level',
      tick,
      value,
      curve: 'linear',
    };
  }

  it('schedules automation ramps toward the lane value', () => {
    const core = new SchedulerCore();
    oneBarMeta(core, ['S'], 'S', 'sequence');
    core.setTempo(120);
    core.setLoop(LOOP_1_BAR);
    core.applyAutomationDiff('sequence', 'S', 'mixer.track:t1.level', [
      point('sequence', 'S', 0, 0),
      point('sequence', 'S', 3840, 1),
    ]);
    core.setTransport(true, false, 0);

    const result = run(core, steps(0.5));
    const ramps = result.batch.filter((e) => e.kind === 'automationRamp');
    expect(ramps.length).toBeGreaterThan(0);
    expect(ramps[0]!.target).toBe('mixer.track:t1.level');
    // Value rises from 0 as the window advances.
    const last = ramps[ramps.length - 1]!;
    expect(last.value!).toBeGreaterThan(0);
    expect(last.value!).toBeLessThanOrEqual(1);
  });

  it('lets track scope override sequence scope for the same target', () => {
    const core = new SchedulerCore();
    oneBarMeta(core, ['S'], 'S', 'sequence');
    core.setTempo(120);
    core.setLoop(LOOP_1_BAR);
    core.applyAutomationDiff('sequence', 'S', 'mixer.track:t1.level', [point('sequence', 'S', 0, 0.2)]);
    core.applyAutomationDiff('track', 't1', 'mixer.track:t1.level', [point('track', 't1', 0, 0.9)]);
    core.setTransport(true, false, 0);
    const result = core.tick(0);
    const ramp = result.batch.find((e) => e.kind === 'automationRamp');
    expect(ramp?.value).toBe(0.9); // track wins
  });
});
