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

  it('stops forwarding after dispose', () => {
    seed();
    const scheduler = fakeScheduler();
    subscribeSequencerSync(scheduler)();
    scheduler.setTempo.mockClear();
    useTransportStore.getState().setBpm(90);
    expect(scheduler.setTempo).not.toHaveBeenCalled();
  });
});
