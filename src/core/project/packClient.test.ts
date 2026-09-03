import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectSnapshot } from './mpcweb';

/** A scriptable stand-in for the real `Worker` the client constructs internally. */
class FakeWorker {
  static instances: FakeWorker[] = [];
  readonly sent: unknown[] = [];
  readonly transfers: Transferable[][] = [];
  terminated = false;
  #listeners = new Map<string, Set<(event: Event) => void>>();

  constructor() {
    FakeWorker.instances.push(this);
  }

  postMessage(message: unknown, transfer: Transferable[] = []): void {
    this.sent.push(message);
    this.transfers.push(transfer);
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    if (!this.#listeners.has(type)) this.#listeners.set(type, new Set());
    this.#listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.#listeners.get(type)?.delete(listener);
  }

  terminate(): void {
    this.terminated = true;
  }

  dispatch(event: Event): void {
    for (const listener of this.#listeners.get(event.type) ?? []) listener(event);
  }

  /** Acknowledge the request at `index`, as the real worker does for every pack step. */
  ack(index: number): void {
    const { id } = this.sent[index] as { id: number };
    this.dispatch(new MessageEvent('message', { data: { id, ok: true, kind: 'ack' } }));
  }

  /** The session id the client stamped on the request at `index`. */
  sessionOf(index: number): number {
    return (this.sent[index] as { session: number }).session;
  }
}

async function loadClient(): Promise<typeof import('./packClient')> {
  vi.resetModules();
  return import('./packClient');
}

const snapshot = { samples: [] } as unknown as ProjectSnapshot;

beforeEach(() => {
  FakeWorker.instances = [];
  vi.stubGlobal('Worker', FakeWorker);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('pack client worker failure handling', () => {
  it('rejects every in-flight call when the worker errors', async () => {
    const { beginMpcwebPack, unpackMpcwebInWorker } = await loadClient();
    const opening = beginMpcwebPack('1.2.3');
    const unpacking = unpackMpcwebInWorker(new Uint8Array(2));

    FakeWorker.instances[0]!.dispatch(new ErrorEvent('error', { message: 'worker exploded' }));

    await expect(opening).rejects.toThrow(/Pack worker error: worker exploded/);
    await expect(unpacking).rejects.toThrow(/Pack worker error: worker exploded/);
    expect(FakeWorker.instances[0]!.terminated).toBe(true);
  });

  it('rejects in-flight calls on messageerror too', async () => {
    const { unpackMpcwebInWorker } = await loadClient();
    const pending = unpackMpcwebInWorker(new Uint8Array(2));

    FakeWorker.instances[0]!.dispatch(new Event('messageerror'));

    await expect(pending).rejects.toThrow(/unknown worker failure/);
  });

  it('builds a fresh worker for the next call after a failure', async () => {
    const { unpackMpcwebInWorker } = await loadClient();
    const failed = unpackMpcwebInWorker(new Uint8Array(1));
    FakeWorker.instances[0]!.dispatch(new ErrorEvent('error', { message: 'boom' }));
    await expect(failed).rejects.toThrow();

    const retry = unpackMpcwebInWorker(new Uint8Array(1));
    expect(FakeWorker.instances).toHaveLength(2);

    const replacement = FakeWorker.instances[1]!;
    const { id } = replacement.sent[0] as { id: number };
    const result = { manifest: {}, snapshot: {}, samples: new Map() };
    replacement.dispatch(new MessageEvent('message', { data: { id, ok: true, kind: 'unpack', result } }));
    await expect(retry).resolves.toBe(result);
  });

  it('ignores a late failure from a worker that has already been replaced', async () => {
    const { unpackMpcwebInWorker } = await loadClient();
    const failed = unpackMpcwebInWorker(new Uint8Array(1));
    const dead = FakeWorker.instances[0]!;
    dead.dispatch(new ErrorEvent('error', { message: 'boom' }));
    await expect(failed).rejects.toThrow();

    const live = unpackMpcwebInWorker(new Uint8Array(1));
    dead.dispatch(new ErrorEvent('error', { message: 'again' }));

    const replacement = FakeWorker.instances[1]!;
    expect(replacement.terminated).toBe(false);
    const { id } = replacement.sent[0] as { id: number };
    const result = { manifest: {}, snapshot: {}, samples: new Map() };
    replacement.dispatch(new MessageEvent('message', { data: { id, ok: true, kind: 'unpack', result } }));
    await expect(live).resolves.toBe(result);
  });
});

/**
 * Issue #99: the export used to hand the worker every sample's bytes in one message and get
 * the whole archive back in one reply, so the project's audio was resident twice over. These
 * pin the streaming contract that replaced it.
 */
describe('streaming pack session (spec §9.6)', () => {
  it('transfers each sample rather than copying it', async () => {
    const { beginMpcwebPack } = await loadClient();
    const opening = beginMpcwebPack('1.2.3');
    const fake = FakeWorker.instances[0]!;
    fake.ack(0);
    const session = await opening;

    const bytes = new Uint8Array([1, 2, 3, 4]);
    const added = session.addSample({ sampleId: 'sample-a', bytes });
    // The transfer list is the whole point: without it the structured clone COPIES the
    // audio, and the peak is the same as it was before the streaming path existed.
    expect(fake.transfers[1]).toEqual([bytes.buffer]);
    fake.ack(1);
    await added;
  });

  it('assembles the archive from the chunks the worker streams back', async () => {
    const { beginMpcwebPack } = await loadClient();
    const opening = beginMpcwebPack('1.2.3');
    const fake = FakeWorker.instances[0]!;
    fake.ack(0);
    const session = await opening;
    const session_ = fake.sessionOf(0);

    const chunk = (data: number[], final: boolean) =>
      fake.dispatch(
        new MessageEvent('message', {
          data: { session: session_, ok: true, kind: 'packChunk', chunk: new Uint8Array(data), final },
        }),
      );

    chunk([0x50, 0x4b], false);
    const finishing = session.finish(snapshot);
    chunk([0x03, 0x04], true);
    fake.ack(1);

    const blob = await finishing;
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    expect(blob.type).toBe('application/zip');
  });

  it('drops a session the caller aborts, so its chunks reach no later archive', async () => {
    const { beginMpcwebPack } = await loadClient();
    const opening = beginMpcwebPack('1.2.3');
    const fake = FakeWorker.instances[0]!;
    fake.ack(0);
    const session = await opening;
    const abandoned = fake.sessionOf(0);

    const aborting = session.abort();
    fake.ack(1);
    await aborting;

    // A chunk that arrives after the abort — the worker had already queued it — must land
    // nowhere rather than in the next export's parts.
    fake.dispatch(
      new MessageEvent('message', {
        data: { session: abandoned, ok: true, kind: 'packChunk', chunk: new Uint8Array([9]), final: true },
      }),
    );

    const second = beginMpcwebPack('1.2.3');
    fake.ack(2);
    const next = await second;
    const finishing = next.finish(snapshot);
    fake.ack(3);
    expect((await finishing).size).toBe(0);
  });
});
