/**
 * Looper take folding (spec §8.5.8) — the bar-locked length and overdub layering rules,
 * exercised without an AudioContext (§7.1.5) — plus the §3.2 teardown obligation, against
 * the fake graph (§11.3).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeAudioContext } from '@/test/mocks/audioContext';
import { foldCaptureIntoTake, Looper } from './looper';

const chunk = (...values: number[]) => Float32Array.from(values);

describe('foldCaptureIntoTake (spec §8.5.8)', () => {
  it('concatenates the drained chunks when the capture is open-ended', () => {
    const take = foldCaptureIntoTake([chunk(1, 2), chunk(3)], null, 0);
    expect(Array.from(take!)).toEqual([1, 2, 3]);
  });

  it('pads a short bar-locked capture to the target length so overdubs stay aligned', () => {
    const take = foldCaptureIntoTake([chunk(1, 2)], null, 4);
    expect(Array.from(take!)).toEqual([1, 2, 0, 0]);
  });

  it('truncates a capture that overran the bar line', () => {
    const take = foldCaptureIntoTake([chunk(1, 2), chunk(3, 4)], null, 3);
    expect(Array.from(take!)).toEqual([1, 2, 3]);
  });

  it('sums onto the base when overdubbing, keeping the take one bar long', () => {
    const base = chunk(1, 1, 1, 1);
    const take = foldCaptureIntoTake([chunk(0.5, 0.5)], base, 4);
    expect(Array.from(take!)).toEqual([1.5, 1.5, 1, 1]);
    // The base is not mutated in place — layers are additive, not destructive.
    expect(Array.from(base)).toEqual([1, 1, 1, 1]);
  });

  it('leaves the held take alone when nothing was captured', () => {
    const base = chunk(1, 2);
    expect(foldCaptureIntoTake([], base, 4)).toBe(base);
    expect(foldCaptureIntoTake([], null, 4)).toBeNull();
  });

  it('replaces rather than sums when there is no base to overdub onto', () => {
    const take = foldCaptureIntoTake([chunk(0.25, 0.25)], null, 2);
    expect(Array.from(take!)).toEqual([0.25, 0.25]);
  });
});

/** Stands in for the recorder node: happy-dom ships no Web Audio (§11.3). */
class FakeWorkletNode {
  readonly messages: unknown[] = [];
  readonly port = { postMessage: (message: unknown) => void this.messages.push(message) };
  disconnectCount = 0;
  connect(destination: unknown): unknown {
    return destination;
  }
  disconnect(): void {
    this.disconnectCount++;
  }
}

describe('Looper.destroy (spec §3.2)', () => {
  let created: FakeWorkletNode[] = [];

  beforeEach(() => {
    created = [];
    vi.stubGlobal(
      'AudioWorkletNode',
      class {
        constructor() {
          const node = new FakeWorkletNode();
          created.push(node);
          return node as unknown as AudioWorkletNode;
        }
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const attached = () => {
    const { context } = createFakeAudioContext(8_000);
    const masterTap = context.createGain();
    const looper = new Looper(context, masterTap, 8_000);
    looper.attach();
    return { looper, masterTap, node: created[0]! };
  };

  it('severs the master tap edge into the node, which node.disconnect() cannot reach', () => {
    const { looper, masterTap, node } = attached();
    const tapDisconnect = vi.spyOn(masterTap, 'disconnect');

    looper.destroy();

    // Outgoing-only `disconnect()` would leave the tap holding the node scheduled forever.
    expect(tapDisconnect).toHaveBeenCalledWith(node);
    expect(node.disconnectCount).toBe(1);
  });

  it('tells the processor to stop recording and dispose when destroyed mid-take', () => {
    const { looper, node } = attached();
    looper.startRecording();
    expect(looper.isRecording).toBe(true);

    looper.destroy();

    expect(looper.isRecording).toBe(false);
    expect(node.messages).toEqual([
      { kind: 'record', on: true },
      { kind: 'record', on: false },
      { kind: 'dispose' },
    ]);
  });
});
