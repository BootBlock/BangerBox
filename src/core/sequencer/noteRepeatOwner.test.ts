/**
 * Note repeat attributes every hit to the pad that produced it (spec §7.3, issue #25).
 *
 * `heldNotes` is keyed `${trackId}:${note}`, so the same pad held on two tracks is two
 * entries — but the scheduler resolved a hit's owner with `held.find(h => h.note === …)`,
 * which matches on the note number alone and returned the first entry for both hits. Two
 * note-ons then fired on the first track, the second track sounded nothing, and while
 * recording both captured notes were written into the first track's events.
 *
 * §1.3.1 maps a pad index straight to a MIDI note number, so layering two drum programs
 * and holding one pad on both is ordinary practice rather than a corner case.
 */
import { describe, expect, it } from 'vitest';
import { noteRepeatHits, type HeldNote } from './noteRepeat';
import { SchedulerCore, type SchedulerTickResult } from './schedulerCore';

function oneBarMeta(core: SchedulerCore): void {
  core.setSequenceMeta(
    { S: { lengthBars: 1, timeSigNumerator: 4, timeSigDenominator: 4, tempo: null } },
    120,
    'S',
    'sequence',
  );
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

const LOOP_1_BAR = { enabled: true, startTick: 0, endTick: 3840 };

describe('noteRepeatHits carries the pad it came from (spec §7.3)', () => {
  it('hands back the held entry rather than leaving the caller to match on note number', () => {
    interface Pad extends HeldNote {
      readonly trackId: string;
    }
    const held: Pad[] = [
      { note: 36, velocity: 100, trackId: 't1' },
      { note: 36, velocity: 80, trackId: 't2' },
    ];
    const hits = noteRepeatHits(held, { value: 4, triplet: false }, 0, 960);
    expect(hits).toHaveLength(2);
    expect(hits.map((h) => h.pad.trackId)).toEqual(['t1', 't2']);
    expect(hits.map((h) => h.pad)).toEqual(held);
  });
});

describe('SchedulerCore — note repeat with one pad held on two tracks (issue #25)', () => {
  it('fires each track’s repeat on its own track', () => {
    const core = new SchedulerCore();
    oneBarMeta(core);
    core.setTempo(120);
    core.setLoop(LOOP_1_BAR);
    core.setNoteRepeat(true, { value: 4, triplet: false }); // every 960 ticks
    core.pushLiveNote(36, 100, true, 0, 't1');
    core.pushLiveNote(36, 80, true, 0, 't2');
    core.setTransport(true, false, 0);

    const hits = run(core, 1.0).batch.filter((e) => e.kind === 'noteOn');
    const atZero = hits.filter((e) => e.tick === 0);
    expect(atZero).toHaveLength(2);
    expect(atZero.map((e) => e.trackId).sort()).toEqual(['t1', 't2']);
    // Velocity travels with the pad, so a mismatch would show a track playing at the
    // other's velocity even where the track ids happened to be right.
    expect(atZero.find((e) => e.trackId === 't1')?.velocity).toBe(100);
    expect(atZero.find((e) => e.trackId === 't2')?.velocity).toBe(80);
  });

  it('records each track’s repeats into its own track', () => {
    const core = new SchedulerCore();
    oneBarMeta(core);
    core.setTempo(120);
    core.setLoop(LOOP_1_BAR);
    core.setMetronome(false, 0); // no count-in
    core.setNoteRepeat(true, { value: 4, triplet: false });
    core.setTransport(true, true, 0); // play + record
    core.tick(0);
    core.pushLiveNote(36, 100, true, 0, 't1');
    core.pushLiveNote(36, 80, true, 0, 't2');
    run(core, 1.0);
    core.setTransport(false, false, 0);

    const flushed = core.tick(1.1).recorded;
    const byTrack = new Map(flushed.map((f) => [f.trackId, f.events]));
    expect([...byTrack.keys()].sort()).toEqual(['t1', 't2']);
    expect(byTrack.get('t1')!.length).toBe(byTrack.get('t2')!.length);
    expect(byTrack.get('t1')!.every((e) => e.velocity === 100)).toBe(true);
    expect(byTrack.get('t2')!.every((e) => e.velocity === 80)).toBe(true);
  });
});
