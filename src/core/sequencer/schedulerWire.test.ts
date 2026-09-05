/**
 * Wire round-trip guard (spec §7.1.3, §1.3 #11). Every `SchedulerClient` sender posts a
 * message the worker's own Zod guard must accept AND the worker's own dispatch must act on
 * — the two halves of the protocol are one contract, and a sender whose kind has no schema
 * member is silently dropped at the worker boundary with nothing to see (issue #71: that is
 * how the whole §7.5 groove path died).
 *
 * Driving every sender through `parseSchedulerRequest` and then `applySchedulerRequest`
 * catches that class permanently, which per-feature tests calling `SchedulerCore` directly
 * never could. The table below is checked against the client's real method list, so a
 * sender added without a case here fails rather than going untested (issue #96).
 */
import { describe, expect, it, vi } from 'vitest';
import type { WorkerLike } from '@/core/storage/rpc';
import { createPlayheadSab } from './playheadSab';
import { SchedulerClient } from './schedulerClient';
import { parseSchedulerRequest, SCHEDULER_PROTOCOL_VERSION, type SchedulerRequest } from './messages';
import { applySchedulerRequest, type SchedulerRequestSink } from './schedulerDispatch';
import type { SchedulerCore } from './schedulerCore';
import type { GrooveTemplate } from './groove';

const TEMPLATE: GrooveTemplate = {
  ppqn: 960,
  lengthTicks: 1920,
  division: 16,
  points: [{ gridTick: 0, offsetTicks: 12, velocityScale: 1.1 }],
};

type Spy = ReturnType<typeof vi.fn>;

/**
 * A core stub that grows its own spies on first access — the established shape for a wide
 * interface (see `sequencerSync.test.ts`). A hand-listed set of mocks omits whatever is
 * added later, which is the same drift one layer up.
 */
function spyCore(): { core: SchedulerCore; calls: (method: string) => unknown[][] } {
  const spies = new Map<string, Spy>();
  const spyFor = (name: string): Spy => {
    const existing = spies.get(name);
    if (existing) return existing;
    const spy = vi.fn();
    spies.set(name, spy);
    return spy;
  };
  const core = new Proxy({} as Record<string, Spy>, {
    get: (_target, property: string | symbol) =>
      typeof property === 'string' ? spyFor(property) : undefined,
  }) as unknown as SchedulerCore;
  return { core, calls: (method) => spyFor(method).mock.calls };
}

interface Wire {
  readonly posted: SchedulerRequest[];
  readonly calls: (method: string) => unknown[][];
  readonly onInit: Spy;
  readonly onClockSync: Spy;
}

/**
 * Run one sender end to end: post → Zod guard → dispatch → core. Every posted message must
 * survive the guard, so a sender that posts anything unparseable fails here.
 */
function drive(send: (client: SchedulerClient) => void): Wire {
  const posted: SchedulerRequest[] = [];
  const worker: WorkerLike = {
    postMessage: (message) => posted.push(message as SchedulerRequest),
    addEventListener: () => {},
    removeEventListener: () => {},
    terminate: vi.fn(),
  };
  const client = new SchedulerClient({
    playheadSab: createPlayheadSab(),
    getClockPair: () => ({ contextTime: 1, performanceTime: 1000 }),
    worker,
    dispatch: vi.fn(),
    onRecorded: vi.fn(),
    onErased: vi.fn(),
  });
  send(client);
  client.dispose();

  const { core, calls } = spyCore();
  const onInit = vi.fn();
  const onClockSync = vi.fn();
  const sink: SchedulerRequestSink = {
    core,
    toContextTime: (timestamp) => timestamp,
    onInit,
    onClockSync,
  };
  expect(posted.length).toBeGreaterThan(0);
  for (const request of posted) {
    const parsed = parseSchedulerRequest(request);
    expect(parsed, `${request.kind} was dropped by the guard`).not.toBeNull();
    applySchedulerRequest(sink, parsed!);
  }
  return { posted, calls, onInit, onClockSync };
}

/** One case per typed sender on `SchedulerClient`. Keyed by the method name it drives. */
const CASES: Record<string, (wire: Wire) => void> = {
  start: (wire) => {
    // `start` opens the handshake and pushes the first clock pair (spec §7.1.2).
    expect(wire.posted.map((r) => r.kind)).toEqual(['init', 'clockSync']);
    expect(wire.onInit).toHaveBeenCalledTimes(1);
    expect(wire.onClockSync).toHaveBeenCalledWith(1, 1000);
    const init = wire.posted[0] as Extract<SchedulerRequest, { kind: 'init' }>;
    expect(init.protocolVersion).toBe(SCHEDULER_PROTOCOL_VERSION);
  },
  sendClockSync: (wire) => expect(wire.onClockSync).toHaveBeenCalledWith(1, 1000),
  setTransport: (wire) => expect(wire.calls('setTransport')).toEqual([[true, false, 1920]]),
  setTempo: (wire) => expect(wire.calls('setTempo')).toEqual([[128]]),
  setSwing: (wire) => expect(wire.calls('setSwing')).toEqual([[58, 16]]),
  setGroove: (wire) => expect(wire.calls('setGroove')).toEqual([['t1', TEMPLATE]]),
  setLoop: (wire) =>
    expect(wire.calls('setLoop')).toEqual([[{ enabled: true, startTick: 0, endTick: 3840 }]]),
  sendEventsDiff: (wire) => expect(wire.calls('applyEventsDiff')).toEqual([['t1', 's1', [], ['gone']]]),
  sendAutomationDiff: (wire) =>
    expect(wire.calls('applyAutomationDiff')).toEqual([['track', 't1', 'insert:track:t1:slot2.mix', []]]),
  setSongSequence: (wire) =>
    expect(wire.calls('setSongSequence')).toEqual([
      [
        [
          { sequenceId: 'a', repeats: 1 },
          { sequenceId: 'b', repeats: 1 },
        ],
      ],
    ]),
  setSongLoop: (wire) => expect(wire.calls('setSongLoop')).toEqual([[true]]),
  setSequenceMeta: (wire) =>
    expect(wire.calls('setSequenceMeta')).toEqual([
      [{ a: { lengthBars: 2, timeSigNumerator: 4, timeSigDenominator: 4, tempo: null } }, 120, 'a', 'song'],
    ]),
  sendLiveNote: (wire) => {
    // The client moves the §10.1 `performance.now()` reading into the absolute-epoch domain
    // the worker's clock model uses; dispatch then maps it to context time.
    expect(wire.calls('pushLiveNote')).toEqual([[36, 100, true, performance.timeOrigin + 12, 't1']]);
  },
  setNoteRepeat: (wire) =>
    expect(wire.calls('setNoteRepeat')).toEqual([[true, { value: 16, triplet: false }]]),
  setArpeggiator: (wire) =>
    expect(wire.calls('setArpeggiator')).toEqual([
      [true, { mode: 'up', octaves: 2, gate: 0.5, division: { value: 8, triplet: true } }],
    ]),
  setMetronome: (wire) => expect(wire.calls('setMetronome')).toEqual([[true, 2]]),
  setLiveErase: (wire) => expect(wire.calls('setLiveErase')).toEqual([['t1', 36, true]]),
  removeTrack: (wire) => expect(wire.calls('removeTrack')).toEqual([['t1']]),
};

/** How each sender is driven. Same key set as {@link CASES}. */
const SENDS: Record<string, (client: SchedulerClient) => void> = {
  start: (c) => c.start(),
  sendClockSync: (c) => c.sendClockSync(),
  setTransport: (c) => c.setTransport(true, false, 1920),
  setTempo: (c) => c.setTempo(128),
  setSwing: (c) => c.setSwing(58, 16),
  setGroove: (c) => c.setGroove('t1', TEMPLATE),
  setLoop: (c) => c.setLoop(true, 0, 3840),
  sendEventsDiff: (c) => c.sendEventsDiff('t1', 's1', [], ['gone']),
  // A §7.8 address full of colons, which is the shape the lane-key split has to survive.
  sendAutomationDiff: (c) => c.sendAutomationDiff('track', 't1', 'insert:track:t1:slot2.mix', []),
  setSongSequence: (c) =>
    c.setSongSequence([
      { sequenceId: 'a', repeats: 1 },
      { sequenceId: 'b', repeats: 1 },
    ]),
  setSongLoop: (c) => c.setSongLoop(true),
  setSequenceMeta: (c) =>
    c.setSequenceMeta(
      { a: { lengthBars: 2, timeSigNumerator: 4, timeSigDenominator: 4, tempo: null } },
      120,
      'a',
      'song',
    ),
  sendLiveNote: (c) => c.sendLiveNote(36, 100, true, 12, 't1'),
  setNoteRepeat: (c) => c.setNoteRepeat(true, { value: 16, triplet: false }),
  setArpeggiator: (c) =>
    c.setArpeggiator(true, { mode: 'up', octaves: 2, gate: 0.5, division: { value: 8, triplet: true } }),
  setMetronome: (c) => c.setMetronome(true, 2),
  setLiveErase: (c) => c.setLiveErase('t1', 36, true),
  // spec §7.1.3, issue #137: a track that has left the project is withdrawn by name.
  removeTrack: (c) => c.removeTrack('t1'),
};

describe('SchedulerClient → worker guard → dispatch round-trip (spec §7.1.3)', () => {
  it('covers every sender the client declares', () => {
    // Read off the prototype rather than hand-listed, so a sender added later has nowhere
    // to hide. `dispose` is the only public method that posts nothing.
    const senders = Object.getOwnPropertyNames(SchedulerClient.prototype).filter(
      (name) => name !== 'constructor' && name !== 'dispose',
    );
    expect(senders.sort()).toEqual(Object.keys(SENDS).sort());
    expect(Object.keys(CASES).sort()).toEqual(Object.keys(SENDS).sort());
  });

  for (const [name, send] of Object.entries(SENDS)) {
    it(`${name} survives the guard and reaches the core`, () => {
      CASES[name]!(drive(send));
    });
  }
});

describe('the init handshake compares protocol versions (spec §7.1.3, issue #96)', () => {
  function dispatchInit(protocolVersion: number): void {
    const { core } = spyCore();
    const request = parseSchedulerRequest({
      kind: 'init',
      playheadSab: createPlayheadSab(),
      protocolVersion,
    });
    expect(request).not.toBeNull();
    applySchedulerRequest({ core, toContextTime: (t) => t, onInit: vi.fn(), onClockSync: vi.fn() }, request!);
  }

  it('says nothing when the two halves agree', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    dispatchInit(SCHEDULER_PROTOCOL_VERSION);
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('names a handshake that carries no version at all, and still initialises', () => {
    // A build predating the handshake version is the case the check exists for, so the
    // guard must let it through to be reported rather than dropping it (issue #96).
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onInit = vi.fn();
    const { core } = spyCore();
    const request = parseSchedulerRequest({ kind: 'init', playheadSab: createPlayheadSab() });
    expect(request).not.toBeNull();
    applySchedulerRequest({ core, toContextTime: (t) => t, onInit, onClockSync: vi.fn() }, request!);
    expect(String(error.mock.calls[0]![0])).toContain('sent no version');
    expect(onInit).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it('names a skew rather than dropping messages in silence, and still initialises', () => {
    // Reporting, not refusing: the Zod guard already drops what this build cannot read, and
    // a worker that would not start is a dead transport. The §11.4 smoke fails on a console
    // error, so a real skew fails the gate instead of presenting as a silent sequencer.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onInit = vi.fn();
    const { core } = spyCore();
    const request = parseSchedulerRequest({
      kind: 'init',
      playheadSab: createPlayheadSab(),
      protocolVersion: SCHEDULER_PROTOCOL_VERSION + 1,
    });
    applySchedulerRequest({ core, toContextTime: (t) => t, onInit, onClockSync: vi.fn() }, request!);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]![0])).toContain('protocol version mismatch');
    expect(onInit).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});
