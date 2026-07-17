/**
 * Metering SAB + slot registry — spec §5.8. One global `SharedArrayBuffer` holds a
 * `[peak, rms]` pair per channel for every metered point (pad-selected, per-track,
 * per-return, master L/R). Each `meterTap.worklet.ts` instance writes its assigned slot
 * lock-free (single writer per slot); UI canvases read the buffer in one shared rAF loop
 * — never `postMessage` streams (spec §5.5). An `Int32Array` header carries a generation
 * counter bumped via `Atomics` so readers can tell the writers are live (spec §5.8).
 *
 * This module is import-safe inside the AudioWorkletGlobalScope (constants + offset maths
 * only; no DOM). The registry itself runs on the main thread.
 */

/** Maximum simultaneously metered points (spec §5.8 — generous headroom). */
export const METER_SLOTS = 64;
/** Stereo: L then R (mono taps write L and leave R silent). */
export const CHANNELS_PER_SLOT = 2;
/** Per channel: `[peak, rms]`. */
export const VALUES_PER_CHANNEL = 2;
export const VALUES_PER_SLOT = CHANNELS_PER_SLOT * VALUES_PER_CHANNEL;
/** Int32 header words: [0] = generation counter. */
export const HEADER_INTS = 1;
const HEADER_BYTES = HEADER_INTS * 4;

/** Allocate the single global meter SAB (spec §5.8). */
export function createMeterSab(): SharedArrayBuffer {
  return new SharedArrayBuffer(HEADER_BYTES + METER_SLOTS * VALUES_PER_SLOT * 4);
}

/** The Float32 data view over a meter SAB (skips the Int32 header). */
export function meterData(sab: SharedArrayBuffer): Float32Array {
  return new Float32Array(sab, HEADER_BYTES, METER_SLOTS * VALUES_PER_SLOT);
}

/** The Int32 header view over a meter SAB. */
export function meterHeader(sab: SharedArrayBuffer): Int32Array {
  return new Int32Array(sab, 0, HEADER_INTS);
}

/** First Float32 index of a slot's four values within {@link meterData}. */
export function slotFloatBase(slot: number): number {
  return slot * VALUES_PER_SLOT;
}

export interface MeterReading {
  peakL: number;
  rmsL: number;
  peakR: number;
  rmsR: number;
}

/**
 * Assigns SAB slots to metered points and reads them back for the UI (spec §5.8). Slot
 * ids are the mixer channel ids (`master`, `track:<id>`, …). Allocation is idempotent per
 * id; releasing returns the slot to the free pool for reuse.
 */
export class MeterRegistry {
  readonly sab: SharedArrayBuffer;
  private readonly data: Float32Array;
  private readonly header: Int32Array;
  private readonly assigned = new Map<string, number>();
  private readonly freeSlots: number[];

  constructor(sab: SharedArrayBuffer = createMeterSab()) {
    this.sab = sab;
    this.data = meterData(sab);
    this.header = meterHeader(sab);
    // Free stack, highest index first so allocation hands out 0, 1, 2, …
    this.freeSlots = Array.from({ length: METER_SLOTS }, (_, i) => METER_SLOTS - 1 - i);
  }

  /** Slot index for `meterId`, allocating (and zeroing) one on first request. */
  allocate(meterId: string): number {
    const existing = this.assigned.get(meterId);
    if (existing !== undefined) return existing;
    const slot = this.freeSlots.pop();
    if (slot === undefined) throw new Error('Meter SAB exhausted — no free slot (spec §5.8)');
    const base = slotFloatBase(slot);
    for (let i = 0; i < VALUES_PER_SLOT; i++) this.data[base + i] = 0;
    this.assigned.set(meterId, slot);
    return slot;
  }

  /** Return a meter's slot to the free pool (metered point removed). */
  release(meterId: string): void {
    const slot = this.assigned.get(meterId);
    if (slot === undefined) return;
    this.assigned.delete(meterId);
    this.freeSlots.push(slot);
  }

  slotOf(meterId: string): number | undefined {
    return this.assigned.get(meterId);
  }

  /** Read a slot's `[peak, rms]` per channel (reuses `out` to avoid per-frame allocation). */
  read(slot: number, out: MeterReading = { peakL: 0, rmsL: 0, peakR: 0, rmsR: 0 }): MeterReading {
    const base = slotFloatBase(slot);
    out.peakL = this.data[base] ?? 0;
    out.rmsL = this.data[base + 1] ?? 0;
    out.peakR = this.data[base + 2] ?? 0;
    out.rmsR = this.data[base + 3] ?? 0;
    return out;
  }

  /** Current generation counter (liveness signal) — spec §5.8. */
  generation(): number {
    return Atomics.load(this.header, 0);
  }
}
