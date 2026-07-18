import { describe, expect, it } from 'vitest';
import { DbError } from './errors';
import {
  WorkerDatabaseDriver,
  parseRequestEnvelope,
  parseResponseEnvelope,
  type RpcRequestEnvelope,
  type RpcResponseEnvelope,
  type WorkerLike,
} from './rpc';

/** A scriptable fake worker implementing the WorkerLike seam. */
class FakeWorker implements WorkerLike {
  readonly sent: RpcRequestEnvelope[] = [];
  terminated = false;
  #listeners = new Map<string, Set<(event: MessageEvent) => void>>();

  postMessage(message: unknown): void {
    this.sent.push(message as RpcRequestEnvelope);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    if (!this.#listeners.has(type)) this.#listeners.set(type, new Set());
    this.#listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: (event: MessageEvent) => void): void {
    this.#listeners.get(type)?.delete(listener);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Deliver a message event to the driver as though the worker replied. */
  reply(envelope: RpcResponseEnvelope | unknown): void {
    for (const listener of this.#listeners.get('message') ?? []) {
      listener(new MessageEvent('message', { data: envelope }));
    }
  }

  /** Simulate the worker dying — an `error` or `messageerror` event. */
  fail(type: 'error' | 'messageerror', event: Event = new Event(type)): void {
    for (const listener of this.#listeners.get(type) ?? []) {
      listener(event as MessageEvent);
    }
  }
}

/** Resolve to 'HUNG' if `promise` has not settled by the next macrotask tick. */
function settledOrHung(promise: Promise<unknown>): Promise<unknown> {
  const hung = new Promise((resolve) => setTimeout(() => resolve('HUNG'), 0));
  return Promise.race([promise.then(() => 'RESOLVED').catch((err: unknown) => err), hung]);
}

describe('envelope guards', () => {
  it('accepts a well-formed request envelope', () => {
    const envelope = parseRequestEnvelope({
      id: 'abc',
      request: { kind: 'query', sql: 'SELECT 1', params: [1, 'two', null] },
    });
    expect(envelope?.request.kind).toBe('query');
  });

  it('rejects malformed request envelopes', () => {
    expect(parseRequestEnvelope(null)).toBeNull();
    expect(parseRequestEnvelope({ id: 'x', request: { kind: 'nope' } })).toBeNull();
    expect(parseRequestEnvelope({ id: '', request: { kind: 'init' } })).toBeNull();
    expect(parseRequestEnvelope({ id: 'x', request: { kind: 'query', sql: '' } })).toBeNull();
  });

  it('accepts success and failure response envelopes and rejects junk', () => {
    expect(parseResponseEnvelope({ id: 'a', ok: true, result: [{ n: 1 }] })).not.toBeNull();
    expect(
      parseResponseEnvelope({
        id: 'a',
        ok: false,
        error: { name: 'DbError', code: 'SQLITE_BUSY', message: 'locked' },
      }),
    ).not.toBeNull();
    expect(parseResponseEnvelope({ id: 'a', ok: false, error: { code: 'X' } })).toBeNull();
    expect(parseResponseEnvelope('noise')).toBeNull();
  });
});

describe('WorkerDatabaseDriver', () => {
  it('correlates replies to calls by envelope id', async () => {
    const worker = new FakeWorker();
    const driver = new WorkerDatabaseDriver(worker);

    const first = driver.query('SELECT 1');
    const second = driver.query('SELECT 2');
    expect(worker.sent).toHaveLength(2);

    // Answer out of order — correlation must still hold.
    worker.reply({ id: worker.sent[1]!.id, ok: true, result: [{ n: 2 }] });
    worker.reply({ id: worker.sent[0]!.id, ok: true, result: [{ n: 1 }] });

    await expect(first).resolves.toEqual([{ n: 1 }]);
    await expect(second).resolves.toEqual([{ n: 2 }]);
    driver.dispose();
  });

  it('rebuilds typed DbErrors from failure envelopes', async () => {
    const worker = new FakeWorker();
    const driver = new WorkerDatabaseDriver(worker);

    const call = driver.execute('INSERT …');
    worker.reply({
      id: worker.sent[0]!.id,
      ok: false,
      error: { name: 'DbError', code: 'SQLITE_CONSTRAINT', message: 'no', resultCode: 19 },
    });

    await expect(call).rejects.toMatchObject({ name: 'DbError', code: 'SQLITE_CONSTRAINT' });
    driver.dispose();
  });

  it('ignores unparseable and unknown-id messages', async () => {
    const worker = new FakeWorker();
    const driver = new WorkerDatabaseDriver(worker);

    const call = driver.queryOne('SELECT 1');
    worker.reply('garbage');
    worker.reply({ id: 'not-ours', ok: true, result: [] });
    worker.reply({ id: worker.sent[0]!.id, ok: true, result: [{ n: 7 }] });

    await expect(call).resolves.toEqual({ n: 7 });
    driver.dispose();
  });

  it('rejects all in-flight calls on dispose and refuses further use', async () => {
    const worker = new FakeWorker();
    const driver = new WorkerDatabaseDriver(worker);

    const inFlight = driver.query('SELECT 1');
    driver.dispose();

    await expect(inFlight).rejects.toBeInstanceOf(DbError);
    expect(worker.terminated).toBe(true);
    await expect(driver.query('SELECT 2')).rejects.toMatchObject({ name: 'DbError' });
  });

  it('rejects in-flight calls when the worker errors', async () => {
    const worker = new FakeWorker();
    const driver = new WorkerDatabaseDriver(worker);

    const inFlight = driver.query('SELECT 1');
    worker.fail('error', new ErrorEvent('error', { message: 'boom' }));

    await expect(inFlight).rejects.toMatchObject({
      name: 'DbError',
      code: 'INIT_FAILED',
      message: 'Database worker error: boom',
    });
    expect(worker.terminated).toBe(true);
  });

  it('refuses later calls after a worker error instead of hanging', async () => {
    const worker = new FakeWorker();
    const driver = new WorkerDatabaseDriver(worker);

    worker.fail('error', new ErrorEvent('error', { message: 'boom' }));

    // The regression: this call used to be posted to a dead worker and never settle.
    const outcome = await settledOrHung(driver.query('SELECT 2'));
    expect(outcome).toMatchObject({ name: 'DbError', code: 'INIT_FAILED' });
    expect(worker.sent).toHaveLength(0);
  });

  it('treats messageerror as a worker failure too', async () => {
    const worker = new FakeWorker();
    const driver = new WorkerDatabaseDriver(worker);

    worker.fail('messageerror');

    const outcome = await settledOrHung(driver.execute('INSERT …'));
    expect(outcome).toMatchObject({
      name: 'DbError',
      code: 'INIT_FAILED',
      message: 'Database worker error: unknown worker failure',
    });
  });

  it('close() after a worker failure tears down without awaiting a reply', async () => {
    const worker = new FakeWorker();
    const driver = new WorkerDatabaseDriver(worker);

    worker.fail('error', new ErrorEvent('error', { message: 'boom' }));

    expect(await settledOrHung(driver.close())).toBe('RESOLVED');
    expect(worker.sent).toHaveLength(0);
    expect(worker.terminated).toBe(true);
  });

  it('close() sends the close request then tears down', async () => {
    const worker = new FakeWorker();
    const driver = new WorkerDatabaseDriver(worker);

    const closing = driver.close();
    expect(worker.sent[0]!.request.kind).toBe('close');
    worker.reply({ id: worker.sent[0]!.id, ok: true, result: null });

    await closing;
    expect(worker.terminated).toBe(true);
  });
});
