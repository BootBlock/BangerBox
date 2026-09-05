import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SchedulerClient } from '@/core/sequencer';
import { createDefaultSequence, createDefaultTrack, type MidiEvent } from '@/core/project/schemas';
import { useSequenceStore } from '../useSequenceStore';
import { useTransportStore } from '../useTransportStore';
import { subscribeSequencerSync } from './sequencerSync';

/**
 * A scheduler stub that grows its own spies on first access. A hand-listed set of mocks
 * silently omits any sender added later, so the subscriber under test would throw (or worse,
 * a new forward would go unasserted) — the same drift that hid the §7.5 groove wire break
 * (issue #71).
 */
function fakeScheduler() {
  const spies = new Map<string, ReturnType<typeof vi.fn>>();
  return new Proxy({} as Record<string, ReturnType<typeof vi.fn>>, {
    get: (_target, property: string | symbol) => {
      if (typeof property !== 'string') return undefined;
      const existing = spies.get(property);
      if (existing) return existing;
      const spy = vi.fn();
      spies.set(property, spy);
      return spy;
    },
  }) as unknown as SchedulerClient & Record<string, ReturnType<typeof vi.fn>>;
}

const SEQ = createDefaultSequence('proj', 0, 'Seq', 'S');
const TRACK = createDefaultTrack('S', 'prog', 0, 'Track', 'drum', 't1');

function seed() {
  useSequenceStore.getState().hydrate({
    sequences: { S: SEQ },
    tracks: { t1: TRACK },
    events: {},
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
afterEach(() => {
  dispose?.();
  dispose = null;
});

const event = (id: string, tickStart: number): MidiEvent => ({
  id,
  tickStart,
  durationTicks: 120,
  note: 36,
  velocity: 100,
  extra: null,
});

describe('subscribeSequencerSync — initial resync (spec §7.1.3)', () => {
  it('pushes the full current state to the scheduler on registration', () => {
    seed();
    const scheduler = fakeScheduler();
    dispose = subscribeSequencerSync(scheduler);

    expect(scheduler.setSequenceMeta).toHaveBeenCalledWith(
      { S: { lengthBars: 2, timeSigNumerator: 4, timeSigDenominator: 4, tempo: null } },
      120,
      'S',
      'sequence',
    );
    expect(scheduler.setTempo).toHaveBeenCalledWith(120);
    // Loop disabled → implicit sequence-length loop (2 bars of 4/4 = 7680 ticks).
    expect(scheduler.setLoop).toHaveBeenCalledWith(true, 0, 7680);
    expect(scheduler.setMetronome).toHaveBeenCalledWith(false, 0);
    expect(scheduler.setTransport).toHaveBeenCalledWith(false, false, 0);
  });
});

describe('subscribeSequencerSync — incremental forwarding (spec §4.3)', () => {
  it('forwards tempo, transport, and metronome changes', () => {
    seed();
    const scheduler = fakeScheduler();
    dispose = subscribeSequencerSync(scheduler);
    scheduler.setTempo.mockClear();

    useTransportStore.getState().setBpm(140);
    expect(scheduler.setTempo).toHaveBeenCalledWith(140);

    useTransportStore.getState().setMetronomeEnabled(true);
    expect(scheduler.setMetronome).toHaveBeenLastCalledWith(true, 0);

    useTransportStore.getState().play();
    expect(scheduler.setTransport).toHaveBeenLastCalledWith(true, false, 0);
  });

  it('forwards an events diff when a track gains notes', () => {
    seed();
    const scheduler = fakeScheduler();
    dispose = subscribeSequencerSync(scheduler);
    scheduler.sendEventsDiff.mockClear();

    useSequenceStore.getState().addEvents('t1', [event('n1', 0)]);
    expect(scheduler.sendEventsDiff).toHaveBeenCalledWith('t1', 'S', [event('n1', 0)], []);
  });

  /**
   * spec §7.9, issue #130: the playlist crosses the wire in `position` order with `repeats`
   * intact, because `songAdvanced { entryIndex }` indexes the ENTRY list. Expanding repeats
   * here made an entry played twice two entries by the time the worker numbered them.
   */
  it('forwards the position-sorted playlist with repeats unexpanded', () => {
    seed();
    const scheduler = fakeScheduler();
    dispose = subscribeSequencerSync(scheduler);
    scheduler.setSongSequence.mockClear();

    // Written out of order on purpose: `position` is what §7.9 orders by, not array order.
    useSequenceStore.getState().setSongEntries([
      { id: 'e2', position: 1, sequenceId: 'S', repeats: 1 },
      { id: 'e1', position: 0, sequenceId: 'S', repeats: 3 },
    ]);

    expect(scheduler.setSongSequence).toHaveBeenLastCalledWith([
      { sequenceId: 'S', repeats: 3 },
      { sequenceId: 'S', repeats: 1 },
    ]);
  });

  /**
   * spec §7.1.3, §7.9, issue #132: the sender ships the WHOLE project and the worker's
   * schedule path selects the sequence it is playing. Narrowing here instead would empty song
   * mode, which selects a different sequence per segment, and would turn every switch of
   * active sequence into the full re-send §7.1.3 forbids during playback. This is the guard
   * against fixing #132 on the wrong side of the wire.
   */
  it('forwards an events diff for a track outside the active sequence', () => {
    const other = createDefaultSequence('proj', 1, 'Other', 'O');
    const otherTrack = createDefaultTrack('O', 'prog', 0, 'Other track', 'drum', 't2');
    useSequenceStore.getState().hydrate({
      sequences: { S: SEQ, O: other },
      tracks: { t1: TRACK, t2: otherTrack },
      events: {},
      automation: {},
      songEntries: [],
    });
    useTransportStore.setState({ activeSequenceId: 'S', playbackMode: 'sequence' });
    const scheduler = fakeScheduler();
    dispose = subscribeSequencerSync(scheduler);
    scheduler.sendEventsDiff.mockClear();

    useSequenceStore.getState().addEvents('t2', [event('n1', 0)]);
    expect(scheduler.sendEventsDiff).toHaveBeenCalledWith('t2', 'O', [event('n1', 0)], []);
  });

  /**
   * spec §7.1.4: with no user brace the loop IS the active sequence's own length, so anything
   * that changes which sequence is active — or that sequence's length — changes the loop too.
   * Found reviewing issue #132: while every sequence played at once the wrong loop length was
   * one symptom among many, and with one sequence playing it is the whole of what is heard.
   */
  it('re-derives the implicit loop when the active sequence changes', () => {
    const long = { ...createDefaultSequence('proj', 1, 'Long', 'L'), lengthBars: 4 };
    useSequenceStore.getState().hydrate({
      sequences: { S: SEQ, L: long },
      tracks: { t1: TRACK },
      events: {},
      automation: {},
      songEntries: [],
    });
    useTransportStore.setState({ activeSequenceId: 'S', playbackMode: 'sequence', loopEnabled: false });
    const scheduler = fakeScheduler();
    dispose = subscribeSequencerSync(scheduler);
    expect(scheduler.setLoop).toHaveBeenLastCalledWith(true, 0, 7680); // 2 bars of 4/4

    useTransportStore.getState().setActiveSequenceId('L');
    expect(scheduler.setLoop).toHaveBeenLastCalledWith(true, 0, 15360); // 4 bars of 4/4
  });

  it('re-derives the implicit loop when the active sequence is made longer', () => {
    seed();
    const scheduler = fakeScheduler();
    dispose = subscribeSequencerSync(scheduler);
    scheduler.setLoop.mockClear();

    useSequenceStore.getState().updateSequence('S', { lengthBars: 4 });
    expect(scheduler.setLoop).toHaveBeenLastCalledWith(true, 0, 15360);
  });

  it('stops forwarding after dispose', () => {
    seed();
    const scheduler = fakeScheduler();
    subscribeSequencerSync(scheduler)();
    scheduler.setTempo.mockClear();
    useTransportStore.getState().setBpm(90);
    expect(scheduler.setTempo).not.toHaveBeenCalled();
  });
});

/**
 * spec §7.1.3, issue #137: a track that has LEFT the project is withdrawn from the worker.
 *
 * `removeTrack` deleted the store's track and its events, and the events subscriber only
 * ever iterated the keys it was handed — so the worker kept the track and kept scheduling
 * its notes until the project was reloaded, where the automation subscriber beside it had
 * handled a removed key all along.
 *
 * This does not narrow what §14 (aq) says must be sent. The sender still forwards a diff
 * for every track in the project; what it now also says is which tracks the project no
 * longer has.
 */
describe('subscribeSequencerSync — withdrawing a deleted track (spec §7.1.3)', () => {
  it('withdraws a track that leaves the store', () => {
    seed();
    useSequenceStore.getState().addEvents('t1', [event('n1', 0)]);
    const scheduler = fakeScheduler();
    dispose = subscribeSequencerSync(scheduler);

    useSequenceStore.getState().removeTrack('t1');
    expect(scheduler.removeTrack).toHaveBeenCalledWith('t1');
  });

  it('withdraws a track that never carried a note', () => {
    // The events map never held the id, so a removed-key loop over `events` would see
    // nothing to withdraw — while the worker may still hold the track's §7.5 groove.
    seed();
    const scheduler = fakeScheduler();
    dispose = subscribeSequencerSync(scheduler);

    expect(useSequenceStore.getState().events['t1']).toBeUndefined();
    useSequenceStore.getState().removeTrack('t1');
    expect(scheduler.removeTrack).toHaveBeenCalledWith('t1');
  });

  it('withdraws every track of the outgoing project on a load', () => {
    // `subscribeSequencerSync` is registered once at the §5.1 start gate and survives a
    // project switch, so the tracks of the project being left are the worker's to forget.
    seed();
    const scheduler = fakeScheduler();
    dispose = subscribeSequencerSync(scheduler);

    const other = createDefaultSequence('proj-2', 0, 'Other', 'O');
    useSequenceStore.getState().hydrate({
      sequences: { O: other },
      tracks: { t9: createDefaultTrack('O', 'prog', 0, 'New', 'drum', 't9') },
      events: {},
      automation: {},
      songEntries: [],
    });
    expect(scheduler.removeTrack).toHaveBeenCalledWith('t1');
    expect(scheduler.removeTrack).not.toHaveBeenCalledWith('t9');
  });

  it('withdraws nothing when a track merely loses its notes', () => {
    seed();
    useSequenceStore.getState().addEvents('t1', [event('n1', 0)]);
    const scheduler = fakeScheduler();
    dispose = subscribeSequencerSync(scheduler);

    useSequenceStore.getState().removeEvents('t1', ['n1']);
    expect(scheduler.removeTrack).not.toHaveBeenCalled();
    expect(scheduler.sendEventsDiff).toHaveBeenLastCalledWith('t1', 'S', [], ['n1']);
  });

  /**
   * spec §7.8: a track-scope lane's owner is the track, and the §9.3 `automation_points`
   * table declares no foreign key — so nothing else takes the lane with it. It reaches the
   * worker on the `automationDiff` path an emptied lane already takes.
   */
  it('clears the deleted track’s automation lane on the automation path', () => {
    seed();
    useSequenceStore.getState().setAutomationLane('track', 't1', 'mixer.track:t1.level', [
      {
        id: 'p1',
        scope: 'track',
        ownerId: 't1',
        targetPath: 'mixer.track:t1.level',
        tick: 0,
        value: 0.5,
        curve: 'linear',
      },
    ]);
    const scheduler = fakeScheduler();
    dispose = subscribeSequencerSync(scheduler);
    scheduler.sendAutomationDiff.mockClear();

    useSequenceStore.getState().removeTrack('t1');
    expect(scheduler.sendAutomationDiff).toHaveBeenCalledWith('track', 't1', 'mixer.track:t1.level', []);
  });

  /** spec §7.5: the assignment leaves with the track, on the `groove` path it already has. */
  it('clears the deleted track’s groove assignment on the groove path', () => {
    seed();
    useSequenceStore.getState().setGrooveTemplate('Shuffle', {
      ppqn: 960,
      lengthTicks: 1920,
      division: 16,
      points: [{ gridTick: 0, offsetTicks: 24, velocityScale: 1 }],
    });
    useSequenceStore.getState().assignTrackGroove('t1', 'Shuffle');
    const scheduler = fakeScheduler();
    dispose = subscribeSequencerSync(scheduler);
    scheduler.setGroove.mockClear();

    useSequenceStore.getState().removeTrack('t1');
    expect(scheduler.setGroove).toHaveBeenCalledWith('t1', null);
  });
});
