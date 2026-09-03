/**
 * Mid-playback tempo changes (spec §7.2, §7.1.5, issue #74). §7.1.5 requires the timing
 * suite to cover "tempo changes mid-loop"; every other test in this folder sets the tempo
 * once, before `setTransport`.
 *
 * `setTempo` updated the tempo but never re-anchored the playback origin, so position was
 * recomputed as though the *entire elapsed history* had been played at the new tempo. Two
 * seconds at 120 bpm is one bar (3840 ticks); halving the tempo re-read that same instant as
 * half a bar, and the playhead jumped backwards with no time having passed. The error scales
 * with how long the transport has been running.
 *
 * The tempo is applied at the next scheduler wake rather than inside `setTempo`, because the
 * core has no clock of its own: `tick(now)` is the only place a trustworthy context time
 * arrives (spec §11.3 — the worker file is a thin message shell).
 */
import { describe, expect, it } from 'vitest';
import { PPQN } from '@/core/constants';
import type { MidiEvent } from '@/core/project/schemas';
import { SchedulerCore } from './schedulerCore';

const BAR_TICKS = 4 * PPQN;

function note(id: string, tickStart: number): MidiEvent {
  return { id, tickStart, durationTicks: 120, note: 36, velocity: 100, extra: null };
}

function oneBarMeta(core: SchedulerCore, id: string, bpm = 120): void {
  core.setSequenceMeta(
    { [id]: { lengthBars: 1, timeSigNumerator: 4, timeSigDenominator: 4, tempo: null } },
    bpm,
    id,
    'sequence',
  );
}

/** A core playing from tick 0 at 120 bpm, already ticked once. */
function playing(): SchedulerCore {
  const core = new SchedulerCore();
  oneBarMeta(core, 's1');
  core.setTempo(120);
  core.setTransport(true, false, 0);
  core.tick(0);
  return core;
}

describe('a mid-playback tempo change applies from the change onward (spec §7.2, issue #74)', () => {
  it('does not move the playhead at the instant the tempo changes', () => {
    const core = playing();
    core.tick(2);
    const before = core.playheadTick(2);
    expect(before).toBeCloseTo(BAR_TICKS, 0); // 2 s at 120 bpm is one bar

    core.setTempo(60);
    core.tick(2); // the wake that applies it
    expect(core.playheadTick(2)).toBeCloseTo(before, 0);
  });

  it('never jumps the playhead backwards, however long the transport has run', () => {
    const core = playing();
    core.tick(20);
    const before = core.playheadTick(20);
    core.setTempo(40);
    core.tick(20);
    expect(core.playheadTick(20)).toBeGreaterThanOrEqual(before - 1);
  });

  it('advances at the NEW tempo after the change', () => {
    const core = playing();
    core.tick(2);
    const at2 = core.playheadTick(2);
    core.setTempo(60);
    core.tick(2);
    // One more second at 60 bpm is one beat, not two.
    core.tick(3);
    expect(core.playheadTick(3) - at2).toBeCloseTo(PPQN, 0);
  });

  it('advances at the new tempo on a speed-up too', () => {
    const core = playing();
    core.tick(2);
    const at2 = core.playheadTick(2);
    core.setTempo(240);
    core.tick(2);
    core.tick(3);
    expect(core.playheadTick(3) - at2).toBeCloseTo(4 * PPQN, 0);
  });

  it('leaves a tempo set before playback exactly as it was', () => {
    const core = new SchedulerCore();
    oneBarMeta(core, 's1');
    core.setTempo(60);
    core.setTransport(true, false, 0);
    core.tick(0);
    core.tick(2); // 2 s at 60 bpm is half a bar
    expect(core.playheadTick(2)).toBeCloseTo(BAR_TICKS / 2, 0);
  });

  it('schedules every note exactly once across the change (spec §7.1.5)', () => {
    const core = new SchedulerCore();
    oneBarMeta(core, 's1');
    core.setTempo(120);
    const events = [note('n0', 0), note('n1', PPQN), note('n2', 2 * PPQN), note('n3', 3 * PPQN)];
    core.applyEventsDiff('t1', 's1', events, []);
    core.setTransport(true, false, 0);

    const ids: string[] = [];
    const collect = (at: number): void => {
      for (const event of core.tick(at).batch) {
        if (event.kind === 'noteOn') ids.push(`${event.note}@${event.tick}`);
      }
    };
    collect(0);
    collect(0.5);
    core.setTempo(60);
    for (let at = 1; at <= 6; at += 0.25) collect(at);

    // One bar has four notes, each scheduled once whatever the tempo did in between.
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(4);
  });

  it('keeps the metronome grid moving forward across the change', () => {
    const core = new SchedulerCore();
    oneBarMeta(core, 's1');
    core.setTempo(120);
    core.setMetronome(true, 0);
    core.setTransport(true, false, 0);

    const clickTimes: number[] = [];
    const collect = (at: number): void => {
      for (const event of core.tick(at).batch) if (event.kind === 'click') clickTimes.push(event.when);
    };
    collect(0);
    collect(1);
    core.setTempo(60);
    for (let at = 1.5; at <= 6; at += 0.5) collect(at);

    for (let i = 1; i < clickTimes.length; i++) {
      expect(clickTimes[i]!).toBeGreaterThan(clickTimes[i - 1]!);
    }
    // No click may be scheduled in the past relative to the wake that emitted it.
    expect(Math.min(...clickTimes)).toBeGreaterThanOrEqual(0);
  });

  it('still captures a live note timestamped just before the change', () => {
    const core = new SchedulerCore();
    oneBarMeta(core, 's1');
    core.setTempo(120);
    core.setTransport(true, true, 0);
    core.tick(0);
    core.tick(2);
    core.setTempo(60);
    core.tick(2);
    // A BLE note is timestamped with input-latency compensation (spec §10.2), so it arrives
    // dated slightly BEFORE the wake that delivers it.
    core.pushLiveNote(36, 100, true, 1.98, 't1');
    core.pushLiveNote(36, 100, false, 2.1, 't1');
    core.setTransport(false, false, 0);
    const stopped = core.tick(2.5);
    expect(stopped.recorded.flatMap((flush) => flush.events)).toHaveLength(1);
  });
});

describe('a tempo change during the count-in re-times the count-in (spec §7.7, issue #74)', () => {
  it('starts content two bars after the gesture at the tempo in force', () => {
    const core = new SchedulerCore();
    oneBarMeta(core, 's1');
    core.setTempo(120);
    core.setMetronome(true, 2);
    core.setTransport(true, true, 0); // recording arms the count-in
    core.tick(0);
    // Two bars of 4/4 at 120 bpm is 4 s; the playhead stays parked until then.
    expect(core.playheadTick(3.5)).toBe(0);

    core.setTempo(60);
    core.tick(0.5); // applies the change while still inside the count-in
    // Two bars at 60 bpm is 8 s, so at 5 s the count-in is still running.
    expect(core.playheadTick(5)).toBe(0);
    expect(core.playheadTick(9)).toBeGreaterThan(0);
  });

  it('never schedules a count-in click in the past after the change', () => {
    const core = new SchedulerCore();
    oneBarMeta(core, 's1');
    core.setTempo(240);
    core.setMetronome(true, 2);
    core.setTransport(true, true, 0);
    const clicks: number[] = [];
    const collect = (at: number): void => {
      for (const event of core.tick(at).batch) if (event.kind === 'click') clicks.push(event.when);
    };
    collect(0);
    collect(0.4);
    core.setTempo(60);
    for (let at = 0.5; at <= 10; at += 0.25) collect(at);
    for (let i = 1; i < clicks.length; i++) expect(clicks[i]!).toBeGreaterThan(clicks[i - 1]!);
  });
});
