/**
 * Lock-free single-producer / single-consumer ring buffer (spec §5.5) — one shared,
 * tested implementation used by looper capture (worklet → worker) and any worklet→worker
 * float streaming. Data lives in a `Float32Array`; the read/write cursors live in an
 * `Int32Array` header updated with `Atomics`, so the two threads coordinate without a lock
 * and the render quantum never blocks (spec §5.5, §3.2). One slot is reserved so a full
 * ring is distinguishable from an empty one without a separate count.
 *
 * Memory layout of the backing `SharedArrayBuffer`:
 *   [ Int32 writeIndex ][ Int32 readIndex ][ Float32 × slots … ]
 */
const HEADER_INTS = 2; // writeIndex, readIndex
const HEADER_BYTES = HEADER_INTS * 4;
const WRITE = 0;
const READ = 1;

export class RingBuffer {
  readonly sab: SharedArrayBuffer;
  private readonly header: Int32Array;
  private readonly data: Float32Array;
  /** Physical slot count; usable capacity is `slots − 1` (one reserved). */
  private readonly slots: number;

  constructor(sab: SharedArrayBuffer) {
    this.sab = sab;
    this.header = new Int32Array(sab, 0, HEADER_INTS);
    this.slots = (sab.byteLength - HEADER_BYTES) / 4;
    this.data = new Float32Array(sab, HEADER_BYTES, this.slots);
  }

  /** Allocate a ring with `slots` physical float slots (usable capacity `slots − 1`). */
  static create(slots: number): RingBuffer {
    if (slots < 2) throw new Error('RingBuffer.create: need at least 2 slots');
    return new RingBuffer(new SharedArrayBuffer(HEADER_BYTES + slots * 4));
  }

  /** Samples currently readable by the consumer. */
  availableToRead(): number {
    const write = Atomics.load(this.header, WRITE);
    const read = Atomics.load(this.header, READ);
    return (write - read + this.slots) % this.slots;
  }

  /** Free slots the producer may write before it would overwrite unread data. */
  availableToWrite(): number {
    return this.slots - 1 - this.availableToRead();
  }

  /**
   * Producer: copy as much of `input` as fits into the ring, returning the count written.
   * Publishes the new write cursor with a release store so the consumer sees the samples.
   */
  push(input: Float32Array): number {
    const write = Atomics.load(this.header, WRITE);
    const free = this.availableToWrite();
    const count = Math.min(input.length, free);
    for (let i = 0; i < count; i++) this.data[(write + i) % this.slots] = input[i]!;
    Atomics.store(this.header, WRITE, (write + count) % this.slots);
    return count;
  }

  /**
   * Consumer: copy up to `output.length` readable samples out of the ring, returning the
   * count read. Publishes the new read cursor so the producer's free space grows.
   */
  pull(output: Float32Array): number {
    const read = Atomics.load(this.header, READ);
    const available = this.availableToRead();
    const count = Math.min(output.length, available);
    for (let i = 0; i < count; i++) output[i] = this.data[(read + i) % this.slots]!;
    Atomics.store(this.header, READ, (read + count) % this.slots);
    return count;
  }
}
