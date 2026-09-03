import { describe, expect, it } from 'vitest';
import { createFakeAudioContext } from '@/test/mocks/audioContext';
import { SampleCache, type SampleSource } from './sampleCache';

function countingSource(): SampleSource & { readonly counts: { reads: number; decodes: number } } {
  const counts = { reads: 0, decodes: 0 };
  return {
    counts,
    read: async () => {
      counts.reads++;
      return new ArrayBuffer(8);
    },
    decode: async () => {
      counts.decodes++;
      return { length: 1, duration: 0.1 } as unknown as AudioBuffer;
    },
  };
}

describe('sample cache (spec §9.4)', () => {
  it('decodes a path once and shares the buffer across triggers', async () => {
    const { context } = createFakeAudioContext();
    const source = countingSource();
    const cache = new SampleCache(context, source);
    const [a, b] = await Promise.all([cache.get('/s.wav'), cache.get('/s.wav')]);
    expect(a).toBe(b);
    expect(source.counts.reads).toBe(1);
    expect(source.counts.decodes).toBe(1);
  });

  it('re-decodes after the path is invalidated', async () => {
    const { context } = createFakeAudioContext();
    const source = countingSource();
    const cache = new SampleCache(context, source);
    await cache.get('/s.wav');
    cache.invalidate('/s.wav');
    await cache.get('/s.wav');
    expect(source.counts.decodes).toBe(2);
  });

  it('drops a failed decode so it can be retried', async () => {
    const { context } = createFakeAudioContext();
    let attempt = 0;
    const source: SampleSource = {
      read: async () => new ArrayBuffer(8),
      decode: async () => {
        attempt++;
        if (attempt === 1) throw new Error('bad bytes');
        return { length: 1 } as unknown as AudioBuffer;
      },
    };
    const cache = new SampleCache(context, source);
    await expect(cache.get('/s.wav')).rejects.toThrow('bad bytes');
    await expect(cache.get('/s.wav')).resolves.toBeDefined(); // retry succeeds
  });
});

describe('SampleCache evicts by promise identity (spec §9.4, issue #97)', () => {
  it('a stale decode failure does not delete the entry that replaced it', async () => {
    const { context } = createFakeAudioContext();
    let attempt = 0;
    let failFirst: (error: Error) => void = () => {};
    const source: SampleSource = {
      read: async () => new ArrayBuffer(8),
      decode: () => {
        attempt++;
        if (attempt === 1) return new Promise<AudioBuffer>((_, reject) => (failFirst = reject));
        return Promise.resolve({ length: attempt } as unknown as AudioBuffer);
      },
    };
    const cache = new SampleCache(context, source);
    const first = cache.get('/s.wav');
    first.catch(() => {}); // the rejection below is expected
    cache.invalidate('/s.wav'); // a destructive edit replaced the file mid-decode
    const second = cache.get('/s.wav');
    await expect(second).resolves.toBeDefined();

    failFirst(new Error('stale decode failed'));
    await Promise.resolve();
    await Promise.resolve();

    // The good entry must still be cached: a third get decodes nothing new.
    await cache.get('/s.wav');
    expect(attempt).toBe(2);
  });
});
