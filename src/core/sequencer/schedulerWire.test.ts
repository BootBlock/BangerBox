/**
 * Wire round-trip guard (spec §7.1.3, §1.3 #11). Every `SchedulerClient` sender posts a
 * message the worker's own Zod guard must accept — the two halves of the protocol are one
 * contract, and a sender whose kind has no schema member is silently dropped at the worker
 * boundary with nothing to see (issue #71: that is how the whole §7.5 groove path died).
 *
 * Driving every sender through `parseSchedulerRequest` catches that class permanently,
 * which per-feature tests calling `SchedulerCore` directly never could.
 */
import { describe, expect, it, vi } from 'vitest';
import type { WorkerLike } from '@/core/storage/rpc';
import { createPlayheadSab } from './playheadSab';
import { SchedulerClient } from './schedulerClient';
import { parseSchedulerRequest, type SchedulerRequest } from './messages';
import type { GrooveTemplate } from './groove';

const TEMPLATE: GrooveTemplate = {
  ppqn: 960,
  lengthTicks: 1920,
  division: 16,
  points: [{ gridTick: 0, offsetTicks: 12, velocityScale: 1.1 }],
};

function capturingClient() {
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
  return { client, posted };
}

describe('SchedulerClient → worker guard round-trip (spec §7.1.3)', () => {
  it('posts only messages the worker guard accepts', () => {
    const { client, posted } = capturingClient();

    // One call per typed sender on the client (spec §7.1.3). A sender added without a
    // schema member fails here rather than at runtime in a browser.
    client.start();
    client.setTransport(true, false, 0);
    client.setTempo(128);
    client.setSwing(58, 16);
    client.setLoop(true, 0, 3840);
    client.setGroove('t1', TEMPLATE);
    client.setGroove('t1', null);
    client.sendEventsDiff('t1', 's1', [], ['gone']);
    client.sendAutomationDiff('track', 't1', 'mixer.track:t1.level', []);
    client.setSongSequence(['a', 'b']);
    client.setSongLoop(true);
    client.setSequenceMeta(
      { a: { lengthBars: 2, timeSigNumerator: 4, timeSigDenominator: 4, tempo: null } },
      120,
      'a',
      'song',
    );
    client.sendLiveNote(36, 100, true, 12, 't1');
    client.setNoteRepeat(true, { value: 16, triplet: false });
    client.setArpeggiator(true, { mode: 'up', octaves: 2, gate: 0.5, division: { value: 8, triplet: true } });
    client.setMetronome(true, 2);
    client.setLiveErase('t1', 36, true);
    client.dispose();

    expect(posted.length).toBeGreaterThan(0);
    for (const request of posted) {
      expect(parseSchedulerRequest(request), `${request.kind} was dropped by the guard`).not.toBeNull();
    }
  });
});
