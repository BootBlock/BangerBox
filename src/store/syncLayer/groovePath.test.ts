/**
 * The §7.5 groove path, end to end: assigning a template in the store must shift the ticks
 * the scheduler emits.
 *
 * Every existing groove test calls `SchedulerCore.setGroove` directly, so the whole path
 * looked covered while the `groove` message was in fact dropped by the worker's Zod guard
 * and no template ever reached the core (issue #71). This test spans the real chain —
 * store action → sync subscriber → `SchedulerClient` → `parseSchedulerRequest` →
 * `applySchedulerRequest` → `SchedulerCore` — so nothing between the two ends can be
 * bypassed by the test itself.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerLike } from '@/core/storage/rpc';
import { createDefaultSequence, createDefaultTrack, type MidiEvent } from '@/core/project/schemas';
import { PPQN } from '@/core/constants';
import { createPlayheadSab, SchedulerClient, type ScheduledEvent } from '@/core/sequencer';
import { parseSchedulerRequest, type SchedulerRequest } from '@/core/sequencer/messages';
import type { GrooveTemplate } from '@/core/sequencer/groove';
import { applySchedulerRequest } from '@/core/sequencer/schedulerDispatch';
import { SchedulerCore } from '@/core/sequencer/schedulerCore';
import { useSequenceStore } from '../useSequenceStore';
import { useTransportStore } from '../useTransportStore';
import { subscribeSequencerSync } from './sequencerSync';

/** A one-bar groove that drags every hit 30 ticks late and softens it to 80 % velocity. */
const LATE_GROOVE: GrooveTemplate = {
  ppqn: PPQN,
  lengthTicks: PPQN * 4,
  division: 16,
  points: [{ gridTick: 0, offsetTicks: 30, velocityScale: 0.8 }],
};

const SEQ = createDefaultSequence('proj', 0, 'Seq', 'S');
const TRACK = createDefaultTrack('S', 'prog', 0, 'Track', 'drum', 't1');
const NOTE: MidiEvent = { id: 'n1', tickStart: 0, durationTicks: 120, note: 36, velocity: 100, extra: null };

/**
 * A worker stand-in running the real guard and the real dispatch, so a message the guard
 * rejects reaches the core no more here than it would in a browser.
 */
function guardedWorker(core: SchedulerCore) {
  const dropped: SchedulerRequest[] = [];
  const worker: WorkerLike = {
    postMessage: (message) => {
      const request = parseSchedulerRequest(message);
      if (!request) {
        dropped.push(message as SchedulerRequest);
        return;
      }
      applySchedulerRequest(
        { core, toContextTime: (t) => t, onInit: () => {}, onClockSync: () => {} },
        request,
      );
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    terminate: vi.fn(),
  };
  return { worker, dropped };
}

function seed() {
  useSequenceStore.getState().hydrate({
    sequences: { S: SEQ },
    tracks: { t1: TRACK },
    events: { t1: [NOTE] },
    automation: {},
    songEntries: [],
  });
  useTransportStore.setState({
    isPlaying: false,
    isRecording: false,
    bpm: 120,
    swingAmount: 50,
    swingDivision: 16,
    loopEnabled: false,
    metronomeEnabled: false,
    countInBars: 0,
    activeSequenceId: 'S',
    playbackMode: 'sequence',
    songLoopEnabled: false,
  });
}

let dispose: (() => void) | null = null;
let core: SchedulerCore;
let dropped: SchedulerRequest[];
let client: SchedulerClient;

beforeEach(() => {
  seed();
  core = new SchedulerCore();
  const guarded = guardedWorker(core);
  dropped = guarded.dropped;
  client = new SchedulerClient({
    playheadSab: createPlayheadSab(),
    getClockPair: () => ({ contextTime: 0, performanceTime: 0 }),
    worker: guarded.worker,
    dispatch: vi.fn(),
    onRecorded: vi.fn(),
    onErased: vi.fn(),
  });
});

/** Collect the notes the core schedules across the first half-second of playback. */
function scheduledNotes(): ScheduledEvent[] {
  useTransportStore.getState().play();
  const hits: ScheduledEvent[] = [];
  for (let i = 0; i <= 5; i++) hits.push(...core.tick(i * 0.1).batch.filter((e) => e.kind === 'noteOn'));
  return hits;
}

describe('groove reaches the scheduler (spec §7.5, §4.3)', () => {
  it('shifts a scheduled event once a template is assigned to its track', () => {
    useSequenceStore.getState().setGrooveTemplate('g1', LATE_GROOVE);
    dispose = subscribeSequencerSync(client);
    useSequenceStore.getState().assignTrackGroove('t1', 'g1');

    const hits = scheduledNotes();
    expect(dropped, 'a message the worker guard rejected').toEqual([]);
    expect(hits).toHaveLength(1);
    // 30 ticks late at 120 bpm: one bar is 3840 ticks over 2 s, so a tick is 1/1920 s.
    expect(hits[0]!.when).toBeCloseTo(30 / 1920, 5);
    expect(hits[0]!.velocity).toBe(80);
    dispose?.();
  });

  it('carries an assignment made before the subscriber registers (start-up resync)', () => {
    useSequenceStore.getState().setGrooveTemplate('g1', LATE_GROOVE);
    useSequenceStore.getState().assignTrackGroove('t1', 'g1');
    dispose = subscribeSequencerSync(client);

    const hits = scheduledNotes();
    expect(dropped).toEqual([]);
    expect(hits[0]!.when).toBeCloseTo(30 / 1920, 5);
    dispose?.();
  });

  it('re-pushes a template that is saved again under the same key', () => {
    // A template is keyed by its source sample's name, so re-extracting REPLACES one that
    // tracks are already assigned to. Watching only the assignment would leave the worker
    // shaping notes with the template it was handed first.
    useSequenceStore.getState().setGrooveTemplate('g1', LATE_GROOVE);
    dispose = subscribeSequencerSync(client);
    useSequenceStore.getState().assignTrackGroove('t1', 'g1');
    useSequenceStore.getState().setGrooveTemplate('g1', {
      ...LATE_GROOVE,
      points: [{ gridTick: 0, offsetTicks: 60, velocityScale: 1 }],
    });

    const hits = scheduledNotes();
    expect(dropped).toEqual([]);
    expect(hits[0]!.when).toBeCloseTo(60 / 1920, 5);
    expect(hits[0]!.velocity).toBe(100);
    dispose?.();
  });

  it('ignores a template no track is assigned to', () => {
    dispose = subscribeSequencerSync(client);
    useSequenceStore.getState().setGrooveTemplate('unused', LATE_GROOVE);

    const hits = scheduledNotes();
    expect(dropped).toEqual([]);
    expect(hits[0]!.when).toBeCloseTo(0, 5);
    dispose?.();
  });

  it('restores straight timing when the assignment is cleared', () => {
    useSequenceStore.getState().setGrooveTemplate('g1', LATE_GROOVE);
    dispose = subscribeSequencerSync(client);
    useSequenceStore.getState().assignTrackGroove('t1', 'g1');
    useSequenceStore.getState().assignTrackGroove('t1', null);

    const hits = scheduledNotes();
    expect(dropped).toEqual([]);
    expect(hits[0]!.when).toBeCloseTo(0, 5);
    expect(hits[0]!.velocity).toBe(100);
    dispose?.();
  });
});

describe('songLoopEnabled reaches the scheduler (spec §7.9, §4.3)', () => {
  it('forwards the toggle so the worker knows which end of song to take', () => {
    dispose = subscribeSequencerSync(client);
    useTransportStore.getState().setSongLoopEnabled(true);
    expect(dropped).toEqual([]);

    // A one-entry song of a 2-bar sequence is 4 s at 120 bpm; with looping on the core
    // must still be playing past it rather than reporting `songEnded`.
    useTransportStore.getState().setPlaybackMode('song');
    useSequenceStore.getState().setSongEntries([{ id: 'e1', position: 0, sequenceId: 'S', repeats: 1 }]);
    useTransportStore.getState().play();
    let ended = false;
    for (let i = 0; i <= 120; i++) ended ||= core.tick(i * 0.05).songEnded;
    expect(ended).toBe(false);
    expect(core.isPlaying).toBe(true);
    dispose?.();
  });
});
