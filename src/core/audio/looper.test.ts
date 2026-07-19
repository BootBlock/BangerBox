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

/** A `MediaStream` stand-in — happy-dom ships no media capture, and only `getTracks` is used. */
function fakeMicStream() {
  const track = { stop: vi.fn(), kind: 'audio' };
  return { stream: { getTracks: () => [track] } as unknown as MediaStream, track };
}

/** Point `navigator.mediaDevices.getUserMedia` at `impl` for one test. */
function stubGetUserMedia(impl: () => Promise<MediaStream>): void {
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: impl } });
}

describe('Looper source + teardown (spec §3.2, §8.5.8)', () => {
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
    return { context, looper, masterTap, node: created[0]! };
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

  it('repatches the recorder from the master tap to the mic stream', async () => {
    const { context, looper, masterTap, node } = attached();
    const { stream } = fakeMicStream();
    stubGetUserMedia(() => Promise.resolve(stream));
    const tapDisconnect = vi.spyOn(masterTap, 'disconnect');

    await looper.setSource('microphone');

    expect(looper.source).toBe('microphone');
    // The master tap is cut, and a mic node exists to take its place.
    expect(tapDisconnect).toHaveBeenCalledWith(node);
    expect(context.nodes.some((entry) => entry.nodeType === 'mediaStreamSource')).toBe(true);
  });

  it('stops the mic tracks when switching back to the master bus', async () => {
    const { looper, masterTap, node } = attached();
    const { stream, track } = fakeMicStream();
    stubGetUserMedia(() => Promise.resolve(stream));
    await looper.setSource('microphone');
    const tapConnect = vi.spyOn(masterTap, 'connect');

    await looper.setSource('master');

    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(tapConnect).toHaveBeenCalledWith(node);
  });

  it('cuts the mic edge into the recorder and stops its tracks on destroy', async () => {
    const { context, looper, node } = attached();
    const { stream, track } = fakeMicStream();
    stubGetUserMedia(() => Promise.resolve(stream));
    await looper.setSource('microphone');
    const micNode = context.nodes.find((entry) => entry.nodeType === 'mediaStreamSource')!;
    const micDisconnect = vi.spyOn(micNode, 'disconnect');

    looper.destroy();

    // The mic node, not the master tap, is what holds the recorder scheduled on this source.
    expect(micDisconnect).toHaveBeenCalledWith(node);
    expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it('keeps the master source connected when the mic is refused', async () => {
    const { context, looper, masterTap } = attached();
    stubGetUserMedia(() => Promise.reject(new DOMException('denied', 'NotAllowedError')));
    const tapDisconnect = vi.spyOn(masterTap, 'disconnect');

    await expect(looper.setSource('microphone')).rejects.toThrow(/blocked/i);

    // A refusal must not strand the recorder with nothing feeding it.
    expect(looper.source).toBe('master');
    expect(tapDisconnect).not.toHaveBeenCalled();
    expect(context.nodes.some((entry) => entry.nodeType === 'mediaStreamSource')).toBe(false);
  });

  it('refuses to swap the source mid-take, which would splice two sources into one', async () => {
    const { looper } = attached();
    stubGetUserMedia(() => Promise.resolve(fakeMicStream().stream));
    looper.startRecording();

    await expect(looper.setSource('microphone')).rejects.toThrow(/Stop the capture/);
    expect(looper.source).toBe('master');
  });
});
