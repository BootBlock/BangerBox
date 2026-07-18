/**
 * BLE-MIDI packet parser — spec §10.1. Pure and dependency-free (spec §2.5) so the
 * framing, running status, timestamp unwrap, and malformed-input behaviour are all
 * exhaustively unit-testable (spec §11.1).
 *
 * Framing (spec §10.1): a packet opens with a header byte (bit 7 set, bits 0–5 = the
 * timestamp's high bits). Every status byte is preceded by a timestamp byte (bit 7 set,
 * bits 0–6 = the timestamp's low bits), so at the top of the parse loop a byte with bit 7
 * set is always a *timestamp* byte and the byte after it, if bit 7 is set, is a *status*
 * byte. Data bytes (bit 7 clear) either complete the current message or start another one
 * under running status. The two halves form a 13-bit millisecond clock that wraps every
 * {@link BLE_MIDI_TIMESTAMP_WRAP_MS}; it is unwrapped against the packet's arrival time so
 * every message carries a `performance.now()`-domain timestamp (spec §10.1) — which is what
 * lets recording schedule from the reconstructed stamp rather than "on receipt" (§10.4).
 *
 * v1 emits Note On (velocity 0 ⇒ Note Off), Note Off, Control Change and Pitch Bend
 * (spec §10.1). Other channel messages are parsed for framing but not emitted; SysEx is
 * skipped safely, including across packets; malformed input is dropped, never thrown.
 */

/** The BLE-MIDI timestamp is 13 bits of milliseconds — it wraps every 8192 ms (spec §10.1). */
export const BLE_MIDI_TIMESTAMP_WRAP_MS = 8192;

/**
 * How far ahead of the packet's arrival a reconstructed timestamp may sit before it is
 * treated as belonging to the previous wrap window. A device stamps a message strictly
 * before it transmits, so any meaningful lead is a wrap, not a genuinely future event; the
 * 1 ms of slack absorbs the two clocks' rounding.
 */
const FUTURE_TOLERANCE_MS = 1;

export interface MidiNoteMessage {
  readonly kind: 'noteOn' | 'noteOff';
  readonly channel: number;
  readonly note: number;
  readonly velocity: number;
  readonly timestampMs: number;
}

export interface MidiControlChangeMessage {
  readonly kind: 'controlChange';
  readonly channel: number;
  readonly controller: number;
  readonly value: number;
  readonly timestampMs: number;
}

export interface MidiPitchBendMessage {
  readonly kind: 'pitchBend';
  readonly channel: number;
  /** Raw 14-bit value, 0..16383 (8192 = centre). */
  readonly raw: number;
  /** Normalised to −1..1 with an exact 0 at centre. */
  readonly value: number;
  readonly timestampMs: number;
}

export type MidiMessage = MidiNoteMessage | MidiControlChangeMessage | MidiPitchBendMessage;

export interface MidiParser {
  /** Parse one BLE characteristic value. `arrivalMs` is `performance.now()` at receipt. */
  parse(data: Uint8Array | DataView, arrivalMs: number): MidiMessage[];
  /** Drop running status and any partial SysEx — used on (re)connect (spec §10.4). */
  reset(): void;
}

/** Data bytes a channel-voice status expects (0 for anything we do not frame). */
function dataLengthFor(status: number): number {
  switch (status & 0xf0) {
    case 0x80: // note off
    case 0x90: // note on
    case 0xa0: // polyphonic aftertouch
    case 0xb0: // control change
    case 0xe0: // pitch bend
      return 2;
    case 0xc0: // program change
    case 0xd0: // channel pressure
      return 1;
    default:
      return 0;
  }
}

function toBytes(data: Uint8Array | DataView): Uint8Array {
  return data instanceof Uint8Array
    ? data
    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/**
 * Reconstruct an absolute `performance.now()`-domain millisecond time from the 13-bit
 * BLE-MIDI timestamp and the packet's arrival time (spec §10.1 "unwrap against arrival
 * time").
 */
export function unwrapTimestamp(timestamp13: number, arrivalMs: number): number {
  const windowStart = Math.floor(arrivalMs / BLE_MIDI_TIMESTAMP_WRAP_MS) * BLE_MIDI_TIMESTAMP_WRAP_MS;
  const candidate = windowStart + timestamp13;
  return candidate > arrivalMs + FUTURE_TOLERANCE_MS
    ? candidate - BLE_MIDI_TIMESTAMP_WRAP_MS
    : candidate;
}

export function createMidiParser(): MidiParser {
  /** Running status carried across messages and packets (spec §10.1). */
  let runningStatus: number | null = null;
  /** Data bytes accumulated for the running status, flushed when the message completes. */
  let pending: number[] = [];
  /** True between 0xF0 and 0xF7 — payload bytes are skipped, spanning packets if needed. */
  let inSysEx = false;
  /** Timestamp of the message currently being assembled. */
  let timestampMs = 0;

  const emit = (out: MidiMessage[], status: number, data: readonly number[]): void => {
    const channel = status & 0x0f;
    switch (status & 0xf0) {
      case 0x90: {
        const [note, velocity] = data as [number, number];
        // Note On with velocity 0 is a Note Off (spec §10.1).
        out.push({
          kind: velocity === 0 ? 'noteOff' : 'noteOn',
          channel,
          note,
          velocity,
          timestampMs,
        });
        return;
      }
      case 0x80: {
        const [note, velocity] = data as [number, number];
        out.push({ kind: 'noteOff', channel, note, velocity, timestampMs });
        return;
      }
      case 0xb0: {
        const [controller, value] = data as [number, number];
        out.push({ kind: 'controlChange', channel, controller, value, timestampMs });
        return;
      }
      case 0xe0: {
        const [lsb, msb] = data as [number, number];
        const raw = (msb << 7) | lsb;
        // Centre (8192) is exactly 0; the halves are scaled independently so both
        // extremes reach ±1 despite the asymmetric 14-bit range (spec §10.2 bend depth).
        const value = raw === 8192 ? 0 : raw > 8192 ? (raw - 8192) / 8191 : (raw - 8192) / 8192;
        out.push({ kind: 'pitchBend', channel, raw, value, timestampMs });
        return;
      }
      default:
        // Framed for correctness, not emitted in v1 (spec §10.1).
        return;
    }
  };

  return {
    parse(data, arrivalMs) {
      const bytes = toBytes(data);
      const out: MidiMessage[] = [];
      // A packet must open with a header byte; anything else is malformed (spec §10.1).
      if (bytes.length < 2 || (bytes[0]! & 0x80) === 0) return out;

      const timestampHigh = bytes[0]! & 0x3f;
      /** Previous 13-bit stamp *within this packet*, to detect the low 7 bits wrapping. */
      let previous13: number | null = null;
      timestampMs = arrivalMs;

      let index = 1;
      while (index < bytes.length) {
        const byte = bytes[index]!;

        if (byte & 0x80) {
          index++;
          // Timestamp byte: rebuild the 13-bit stamp, carrying a low-byte wrap into the high
          // bits (the header's high value is fixed for the whole packet).
          let timestamp13 = (timestampHigh << 7) | (byte & 0x7f);
          if (previous13 !== null && timestamp13 < previous13) timestamp13 += 128;
          previous13 = timestamp13;
          timestampMs = unwrapTimestamp(timestamp13, arrivalMs);

          // A status byte, if present, immediately follows its timestamp byte.
          if (index < bytes.length && bytes[index]! & 0x80) {
            const status = bytes[index]!;
            index++;
            if (status === 0xf0) {
              inSysEx = true;
              runningStatus = null;
              pending = [];
            } else if (status === 0xf7) {
              inSysEx = false;
            } else if (status >= 0xf8) {
              // System real-time: single byte, and it never disturbs running status.
            } else if (status >= 0xf0) {
              // System common cancels running status (spec §10.1); its data is skipped.
              inSysEx = false;
              runningStatus = null;
              pending = [];
            } else {
              inSysEx = false;
              runningStatus = status;
              pending = [];
            }
          }
          continue;
        }

        // Data byte — SysEx payload, or the next byte of the running-status message.
        index++;
        if (inSysEx || runningStatus === null) continue;
        pending.push(byte);
        if (pending.length === dataLengthFor(runningStatus)) {
          emit(out, runningStatus, pending);
          pending = [];
        }
      }

      return out;
    },

    reset() {
      runningStatus = null;
      pending = [];
      inSysEx = false;
    },
  };
}
