import { describe, expect, it, vi } from 'vitest';
import type { WorkerLike } from '@/core/storage/rpc';
import { createPlayheadSab } from './playheadSab';
import { SchedulerClient } from './schedulerClient';
import type { SchedulerRequest, SchedulerResponse } from './messages';

/** A fake worker capturing posts and letting the test push inbound responses. */
function fakeWorker() {
  let listener: ((event: MessageEvent) => void) | null = null;
  const posted: SchedulerRequest[] = [];
  const worker: WorkerLike = {
    postMessage: (message) => posted.push(message as SchedulerRequest),
    addEventListener: (_type, l) => {
      listener = l;
    },
    removeEventListener: () => {
      listener = null;
    },
    terminate: vi.fn(),
  };
  const emit = (response: SchedulerResponse) => listener?.({ data: response } as MessageEvent);
  return { worker, posted, emit };
}

function makeClient(callbacks = {}) {
  const { worker, posted, emit } = fakeWorker();
  const dispatch = vi.fn();
  const onRecorded = vi.fn();
  const onErased = vi.fn();
  const onLoopWrapped = vi.fn();
  const onSongAdvanced = vi.fn();
  const client = new SchedulerClient({
    playheadSab: createPlayheadSab(),
    getClockPair: () => ({ contextTime: 2, performanceTime: 1000 }),
    worker,
    dispatch,
    onRecorded,
    onErased,
    onLoopWrapped,
    onSongAdvanced,
    ...callbacks,
  });
  return { client, posted, emit, dispatch, onRecorded, onErased, onLoopWrapped, onSongAdvanced };
}

describe('SchedulerClient outbound (spec §7.1.2/3)', () => {
  it('sends init and a first clock sync on start', () => {
    const { client, posted } = makeClient();
    client.start();
    expect(posted[0]?.kind).toBe('init');
    expect(posted[1]).toEqual({ kind: 'clockSync', contextTime: 2, performanceTime: 1000 });
    client.dispose();
  });

  it('forwards typed transport and diff messages', () => {
    const { client, posted } = makeClient();
    client.setTransport(true, false, 0);
    client.setTempo(140);
    client.setLoop(true, 0, 3840);
    client.sendEventsDiff('t1', 's1', [], ['x']);
    client.setSequenceMeta({}, 120, 's1', 'sequence');
    expect(posted).toContainEqual({ kind: 'transport', isPlaying: true, isRecording: false, startTick: 0 });
    expect(posted).toContainEqual({ kind: 'tempo', bpm: 140 });
    expect(posted).toContainEqual({ kind: 'loop', enabled: true, startTick: 0, endTick: 3840 });
    expect(posted).toContainEqual({
      kind: 'eventsDiff',
      trackId: 't1',
      sequenceId: 's1',
      upserts: [],
      deletes: ['x'],
    });
    client.dispose();
  });

  it('ignores sends after dispose and terminates the worker', () => {
    const { client, posted } = makeClient();
    client.dispose();
    client.setTempo(99);
    expect(posted).toHaveLength(0);
  });
});

describe('SchedulerClient inbound routing (spec §7.1.3)', () => {
  it('dispatches every scheduled event in a batch', () => {
    const { client, emit, dispatch } = makeClient();
    emit({
      kind: 'scheduleBatch',
      events: [
        { kind: 'noteOn', when: 1, tick: 0, trackId: 't1', note: 36, velocity: 100 },
        { kind: 'click', when: 1, tick: 0, accented: true },
      ],
    });
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[0]![0]).toMatchObject({ kind: 'noteOn', note: 36 });
    client.dispose();
  });

  it('routes recorded / erased / loopWrapped / songAdvanced to callbacks', () => {
    const { client, emit, onRecorded, onErased, onLoopWrapped, onSongAdvanced } = makeClient();
    emit({ kind: 'recorded', trackId: 't1', events: [] });
    emit({ kind: 'erased', trackId: 't1', eventIds: ['a'] });
    emit({ kind: 'loopWrapped', tick: 3840 });
    emit({ kind: 'songAdvanced', entryIndex: 1 });
    expect(onRecorded).toHaveBeenCalledWith('t1', []);
    expect(onErased).toHaveBeenCalledWith('t1', ['a']);
    expect(onLoopWrapped).toHaveBeenCalledWith(3840);
    expect(onSongAdvanced).toHaveBeenCalledWith(1);
    client.dispose();
  });

  it('drops malformed inbound messages', () => {
    const { client, emit, dispatch } = makeClient();
    emit({ kind: 'nonsense' } as unknown as SchedulerResponse);
    expect(dispatch).not.toHaveBeenCalled();
    client.dispose();
  });
});
