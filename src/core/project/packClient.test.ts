import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PackInput } from './mpcwebZip';

/** A scriptable stand-in for the real `Worker` the client constructs internally. */
class FakeWorker {
  static instances: FakeWorker[] = [];
  readonly sent: unknown[] = [];
  terminated = false;
  #listeners = new Map<string, Set<(event: Event) => void>>();

  constructor() {
    FakeWorker.instances.push(this);
  }

  postMessage(message: unknown): void {
    this.sent.push(message);
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
}

async function loadClient(): Promise<typeof import('./packClient')> {
  vi.resetModules();
  return import('./packClient');
}

const input = {} as PackInput;

beforeEach(() => {
  FakeWorker.instances = [];
  vi.stubGlobal('Worker', FakeWorker);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('pack client worker failure handling', () => {
  it('rejects every in-flight call when the worker errors', async () => {
    const { packMpcwebInWorker, unpackMpcwebInWorker } = await loadClient();
    const packing = packMpcwebInWorker(input);
    const unpacking = unpackMpcwebInWorker(new Uint8Array(2));

    FakeWorker.instances[0]!.dispatch(new ErrorEvent('error', { message: 'worker exploded' }));

    await expect(packing).rejects.toThrow(/Pack worker error: worker exploded/);
    await expect(unpacking).rejects.toThrow(/Pack worker error: worker exploded/);
    expect(FakeWorker.instances[0]!.terminated).toBe(true);
  });

  it('rejects in-flight calls on messageerror too', async () => {
    const { packMpcwebInWorker } = await loadClient();
    const pending = packMpcwebInWorker(input);

    FakeWorker.instances[0]!.dispatch(new Event('messageerror'));

    await expect(pending).rejects.toThrow(/unknown worker failure/);
  });

  it('builds a fresh worker for the next call after a failure', async () => {
    const { packMpcwebInWorker } = await loadClient();
    const failed = packMpcwebInWorker(input);
    FakeWorker.instances[0]!.dispatch(new ErrorEvent('error', { message: 'boom' }));
    await expect(failed).rejects.toThrow();

    const retry = packMpcwebInWorker(input);
    expect(FakeWorker.instances).toHaveLength(2);

    const replacement = FakeWorker.instances[1]!;
    const id = (replacement.sent[0] as { id: number }).id;
    const packed = new Uint8Array([1, 2, 3]);
    replacement.dispatch(
      new MessageEvent('message', { data: { id, ok: true, kind: 'pack', bytes: packed } }),
    );
    await expect(retry).resolves.toBe(packed);
  });

  it('ignores a late failure from a worker that has already been replaced', async () => {
    const { packMpcwebInWorker } = await loadClient();
    const failed = packMpcwebInWorker(input);
    const dead = FakeWorker.instances[0]!;
    dead.dispatch(new ErrorEvent('error', { message: 'boom' }));
    await expect(failed).rejects.toThrow();

    const live = packMpcwebInWorker(input);
    dead.dispatch(new ErrorEvent('error', { message: 'again' }));

    const replacement = FakeWorker.instances[1]!;
    expect(replacement.terminated).toBe(false);
    const id = (replacement.sent[0] as { id: number }).id;
    const packed = new Uint8Array([9]);
    replacement.dispatch(
      new MessageEvent('message', { data: { id, ok: true, kind: 'pack', bytes: packed } }),
    );
    await expect(live).resolves.toBe(packed);
  });
});
