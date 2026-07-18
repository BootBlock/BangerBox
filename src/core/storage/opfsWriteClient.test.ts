import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

async function loadClient(): Promise<typeof import('./opfsWriteClient')> {
  vi.resetModules();
  return import('./opfsWriteClient');
}

const bytes = (): Uint8Array<ArrayBuffer> => new Uint8Array(new ArrayBuffer(4));

beforeEach(() => {
  FakeWorker.instances = [];
  vi.stubGlobal('Worker', FakeWorker);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('writeFileInWorker worker failure handling', () => {
  it('rejects every in-flight write when the worker errors', async () => {
    const { writeFileInWorker } = await loadClient();
    const first = writeFileInWorker('/a.bin', bytes());
    const second = writeFileInWorker('/b.bin', bytes());
    const worker = FakeWorker.instances[0]!;

    worker.dispatch(new ErrorEvent('error', { message: 'worker exploded' }));

    await expect(first).rejects.toThrow(/OPFS write worker error: worker exploded/);
    await expect(second).rejects.toThrow(/OPFS write worker error: worker exploded/);
    expect(worker.terminated).toBe(true);
  });

  it('rejects in-flight writes on messageerror too', async () => {
    const { writeFileInWorker } = await loadClient();
    const pending = writeFileInWorker('/a.bin', bytes());

    FakeWorker.instances[0]!.dispatch(new Event('messageerror'));

    await expect(pending).rejects.toThrow(/unknown worker failure/);
  });

  it('builds a fresh worker for the next write after a failure', async () => {
    const { writeFileInWorker } = await loadClient();
    const failed = writeFileInWorker('/a.bin', bytes());
    FakeWorker.instances[0]!.dispatch(new ErrorEvent('error', { message: 'boom' }));
    await expect(failed).rejects.toThrow();

    const retry = writeFileInWorker('/a.bin', bytes());
    expect(FakeWorker.instances).toHaveLength(2);

    const replacement = FakeWorker.instances[1]!;
    const id = (replacement.sent[0] as { id: number }).id;
    replacement.dispatch(new MessageEvent('message', { data: { id, ok: true } }));
    await expect(retry).resolves.toBeUndefined();
  });

  it('ignores a late failure from a worker that has already been replaced', async () => {
    const { writeFileInWorker } = await loadClient();
    const failed = writeFileInWorker('/a.bin', bytes());
    const dead = FakeWorker.instances[0]!;
    dead.dispatch(new ErrorEvent('error', { message: 'boom' }));
    await expect(failed).rejects.toThrow();

    const live = writeFileInWorker('/b.bin', bytes());
    dead.dispatch(new ErrorEvent('error', { message: 'again' }));

    const replacement = FakeWorker.instances[1]!;
    expect(replacement.terminated).toBe(false);
    const id = (replacement.sent[0] as { id: number }).id;
    replacement.dispatch(new MessageEvent('message', { data: { id, ok: true } }));
    await expect(live).resolves.toBeUndefined();
  });
});
