import { describe, expect, it } from 'vitest';
import { RingBuffer } from './ringBuffer';

describe('RingBuffer — SPSC lock-free Float32 ring (spec §5.5)', () => {
  it('round-trips a block of samples through push then pull', () => {
    const ring = RingBuffer.create(16);
    const written = ring.push(Float32Array.from([1, 2, 3, 4]));
    expect(written).toBe(4);
    expect(ring.availableToRead()).toBe(4);
    const out = new Float32Array(4);
    expect(ring.pull(out)).toBe(4);
    expect(Array.from(out)).toEqual([1, 2, 3, 4]);
    expect(ring.availableToRead()).toBe(0);
  });

  it('reports capacity as one fewer than the slot count (reserved slot)', () => {
    const ring = RingBuffer.create(8);
    expect(ring.availableToWrite()).toBe(7);
    ring.push(Float32Array.from([1, 2, 3, 4, 5, 6, 7]));
    expect(ring.availableToWrite()).toBe(0);
    expect(ring.availableToRead()).toBe(7);
  });

  it('never overwrites unread data — push returns the count actually written', () => {
    const ring = RingBuffer.create(8); // usable capacity 7
    const written = ring.push(Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
    expect(written).toBe(7);
    const out = new Float32Array(10);
    expect(ring.pull(out)).toBe(7);
    expect(Array.from(out.slice(0, 7))).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('wraps around the physical buffer across many push/pull cycles', () => {
    const ring = RingBuffer.create(8);
    let next = 0;
    let expected = 0;
    for (let cycle = 0; cycle < 100; cycle++) {
      const block = Float32Array.from({ length: 5 }, () => next++);
      const written = ring.push(block);
      const out = new Float32Array(written);
      ring.pull(out);
      for (let i = 0; i < written; i++) expect(out[i]).toBe(expected++);
    }
  });

  it('pulls only what is available, leaving the rest for the next read', () => {
    const ring = RingBuffer.create(16);
    ring.push(Float32Array.from([10, 20, 30]));
    const out = new Float32Array(8);
    expect(ring.pull(out)).toBe(3);
    expect(Array.from(out.slice(0, 3))).toEqual([10, 20, 30]);
    expect(ring.pull(out)).toBe(0);
  });

  it('shares state across two instances attached to the same SharedArrayBuffer', () => {
    const producer = RingBuffer.create(16);
    const consumer = new RingBuffer(producer.sab);
    producer.push(Float32Array.from([7, 8, 9]));
    const out = new Float32Array(3);
    expect(consumer.pull(out)).toBe(3);
    expect(Array.from(out)).toEqual([7, 8, 9]);
    // The producer sees the consumer's advance too.
    expect(producer.availableToRead()).toBe(0);
  });

  it('interleaves partial producer/consumer progress without loss or duplication', () => {
    const ring = RingBuffer.create(8); // capacity 7
    let produced = 0;
    let consumed = 0;
    const seen: number[] = [];
    for (let step = 0; step < 200; step++) {
      // Producer offers 3, whatever fits.
      const block = Float32Array.from({ length: 3 }, (_, i) => produced + i);
      produced += ring.push(block);
      // Consumer takes up to 2.
      const out = new Float32Array(2);
      const got = ring.pull(out);
      for (let i = 0; i < got; i++) seen.push(out[i]!);
      consumed += got;
    }
    // Drain the remainder.
    const tail = new Float32Array(ring.availableToRead());
    const drained = ring.pull(tail);
    for (let i = 0; i < drained; i++) seen.push(tail[i]!);
    consumed += drained;
    expect(consumed).toBe(produced);
    for (let i = 0; i < seen.length; i++) expect(seen[i]).toBe(i);
  });
});
