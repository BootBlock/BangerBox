/**
 * The three §7.1 silent-failure modes (issue #95): each produced plausible-looking output
 * instead of an error, so nothing upstream could detect it.
 *
 *  1. `segmentWindow`'s iteration guard truncated the window and returned a short list, while
 *     `scheduleSequence` advanced its cursor to the *requested* end regardless — every event
 *     between the truncation point and that end was dropped with no signal.
 *  2. `PlayheadReader.read()` returned tick 0 as though it were a real reading when all eight
 *     seqlock attempts caught the writer mid-write — the playhead snapped to bar 1.
 *  3. `resetPlayback` cleared the open and held notes but not the armed live erases, so a
 *     stop → start silently deleted notes the user never asked to erase.
 */
import { describe, expect, it, vi } from 'vitest';
import { PPQN } from '@/core/constants';
import type { MidiEvent } from '@/core/project/schemas';
import { segmentWindow, type LoopRegion } from './lookahead';
import { createPlayheadSab, PlayheadReader, PlayheadWriter } from './playheadSab';
import { SchedulerCore, type SchedulerTickResult } from './schedulerCore';

const NO_LOOP: LoopRegion = { enabled: false, startTick: 0, endTick: 0 };

function note(id: string, tickStart: number): MidiEvent {
  return { id, tickStart, durationTicks: 120, note: 36, velocity: 100, extra: null };
}

function oneBarMeta(core: SchedulerCore, id: string): void {
  core.setSequenceMeta(
    { [id]: { lengthBars: 1, timeSigNumerator: 4, timeSigDenominator: 4, tempo: null } },
    120,
    id,
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

describe('segmentWindow reports how far it reached (spec §7.1.4, issue #95)', () => {
  it('reaches the requested end for an ordinary window', () => {
    const { segments, reachedTo, truncated } = segmentWindow(0, 960, NO_LOOP);
    expect(truncated).toBe(false);
    expect(reachedTo).toBe(960);
    expect(segments).toHaveLength(1);
  });

  it('reaches the requested end across many loop passes', () => {
    const loop: LoopRegion = { enabled: true, startTick: 0, endTick: 960 };
    const { reachedTo, truncated } = segmentWindow(0, 960 * 10, loop);
    expect(truncated).toBe(false);
    expect(reachedTo).toBe(960 * 10);
  });

  it('stops at the guard and says so, rather than returning a short window silently', () => {
    // A one-tick loop and a window of 200 000 ticks needs 200 000 segments — twice the guard.
    const loop: LoopRegion = { enabled: true, startTick: 0, endTick: 1 };
    const { segments, reachedTo, truncated } = segmentWindow(0, 200_000, loop);
    expect(truncated).toBe(true);
    expect(reachedTo).toBeLessThan(200_000);
    expect(reachedTo).toBe(segments.length);
  });

  it('reports an empty window as reaching its own start', () => {
    expect(segmentWindow(500, 500, NO_LOOP)).toEqual({ segments: [], reachedTo: 500, truncated: false });
    expect(segmentWindow(500, 100, NO_LOOP)).toEqual({ segments: [], reachedTo: 500, truncated: false });
  });
});

describe('a truncated window defers rather than drops (spec §7.1.4, issue #95)', () => {
  it('schedules the events past the truncation point on a later wake', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const core = new SchedulerCore();
    oneBarMeta(core, 's1');
    // A one-tick loop is the only shape that trips the guard, and it is exactly the shape the
    // guard was written for. The note sits on the single tick the loop contains.
    core.setLoop({ enabled: true, startTick: 0, endTick: 1 });
    core.applyEventsDiff('t1', 's1', [note('n1', 0)], []);
    core.setTransport(true, false, 0);

    // 200 s at 120 bpm is 400 000 ticks — far past the 100 000-segment guard.
    const first = core.tick(0);
    const scheduledFirst = first.batch.filter((event) => event.kind === 'noteOn').length;
    const second = core.tick(200);
    const scheduledSecond = second.batch.filter((event) => event.kind === 'noteOn').length;

    // Truncation must not swallow the rest: the second wake picks up where the first stopped.
    expect(scheduledFirst).toBeGreaterThan(0);
    expect(scheduledSecond).toBeGreaterThan(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('PlayheadReader reports a failed snapshot (spec §7.1.4, issue #95)', () => {
  it('marks an ordinary reading as fresh', () => {
    const sab = createPlayheadSab();
    new PlayheadWriter(sab).write(1920, true, false, false);
    const reading = new PlayheadReader(sab).read();
    expect(reading.currentTick).toBe(1920);
    expect(reading.stale).toBe(false);
  });

  it('holds the previous tick instead of reporting bar 1 when every attempt tears', () => {
    const sab = createPlayheadSab();
    const writer = new PlayheadWriter(sab);
    const reader = new PlayheadReader(sab);
    writer.write(3840, true, false, false);
    expect(reader.read().currentTick).toBe(3840);

    // Leave the generation odd — a write in progress that never completes.
    const header = new Int32Array(sab, 0, 2);
    Atomics.store(header, 0, Atomics.load(header, 0) + 1);

    const reading = reader.read();
    expect(reading.stale).toBe(true);
    expect(reading.currentTick).toBe(3840); // held, not snapped to 0
    expect(reading.isPlaying).toBe(true);
  });

  it('reports the very first reading as stale rather than inventing tick 0', () => {
    const sab = createPlayheadSab();
    const header = new Int32Array(sab, 0, 2);
    Atomics.store(header, 0, 1); // odd from the outset
    const reading = new PlayheadReader(sab).read();
    expect(reading.stale).toBe(true);
    expect(reading.currentTick).toBe(0);
  });
});

describe('a stop disarms live erase (spec §7.7, issue #95)', () => {
  it('does not erase on the next playback after the transport stopped', () => {
    const core = new SchedulerCore();
    oneBarMeta(core, 's1');
    core.applyEventsDiff('t1', 's1', [note('n1', 0), note('n2', PPQN)], []);

    core.setTransport(true, false, 0);
    core.tick(0);
    core.setLiveErase('t1', 36, true); // pad held over Erase
    core.setTransport(false, false, 0);
    core.tick(0.2); // the stop pass

    // A fresh pass with nothing held: the events must survive it.
    core.setTransport(true, false, 0);
    const result = run(core, [1, 1.2, 1.4]);
    expect(result.erased).toEqual([]);
  });

  it('still erases while the pad is genuinely held (the behaviour §7.7 asks for)', () => {
    const core = new SchedulerCore();
    oneBarMeta(core, 's1');
    core.applyEventsDiff('t1', 's1', [note('n1', 0), note('n2', PPQN)], []);
    core.setTransport(true, false, 0);
    core.tick(0);
    core.setLiveErase('t1', 36, true);
    const result = run(core, [0.2, 0.4, 0.6]);
    expect(result.erased.flatMap((entry) => entry.eventIds).length).toBeGreaterThan(0);
  });
});
