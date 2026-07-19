/**
 * BLE-MIDI packet parser tests — spec §10.1, §11.1 ("BLE-MIDI parser: framing, running
 * status, timestamp unwrap, malformed input"). The parser is pure, so every case here is
 * a plain byte array in and a message list out.
 */
import { describe, expect, it } from 'vitest';
import { BLE_MIDI_TIMESTAMP_WRAP_MS, createMidiParser, type MidiMessage } from './parser';

/** Header byte for a packet whose timestamp high bits are `high` (spec §10.1). */
const header = (high: number): number => 0x80 | (high & 0x3f);
/** Timestamp byte carrying the low 7 bits (spec §10.1). */
const stamp = (low: number): number => 0x80 | (low & 0x7f);

/** Build a single-message packet at 13-bit timestamp `ts`. */
function packet(ts: number, ...midi: number[]): Uint8Array {
  return new Uint8Array([header(ts >> 7), stamp(ts & 0x7f), ...midi]);
}

describe('BLE-MIDI framing (spec §10.1)', () => {
  it('parses a note on with channel, note and velocity', () => {
    const parser = createMidiParser();
    const messages = parser.parse(packet(100, 0x92, 60, 111), 1000);
    expect(messages).toEqual<MidiMessage[]>([
      { kind: 'noteOn', channel: 2, note: 60, velocity: 111, timestampMs: expect.any(Number) },
    ]);
  });

  it('parses a note off', () => {
    const parser = createMidiParser();
    const [message] = parser.parse(packet(10, 0x81, 64, 40), 500);
    expect(message).toMatchObject({ kind: 'noteOff', channel: 1, note: 64, velocity: 40 });
  });

  it('treats note on with velocity 0 as note off (spec §10.1)', () => {
    const parser = createMidiParser();
    const [message] = parser.parse(packet(10, 0x90, 60, 0), 500);
    expect(message).toMatchObject({ kind: 'noteOff', channel: 0, note: 60, velocity: 0 });
  });

  it('parses control change', () => {
    const parser = createMidiParser();
    const [message] = parser.parse(packet(10, 0xb0, 74, 96), 500);
    expect(message).toMatchObject({ kind: 'controlChange', channel: 0, controller: 74, value: 96 });
  });

  it('parses pitch bend into raw 14-bit and normalised −1..1', () => {
    const parser = createMidiParser();
    const centre = parser.parse(packet(10, 0xe0, 0x00, 0x40), 500)[0];
    expect(centre).toMatchObject({ kind: 'pitchBend', raw: 8192 });
    expect((centre as { value: number }).value).toBeCloseTo(0, 6);

    const max = parser.parse(packet(11, 0xe0, 0x7f, 0x7f), 500)[0];
    expect(max).toMatchObject({ raw: 16383 });
    expect((max as { value: number }).value).toBeCloseTo(1, 3);

    const min = parser.parse(packet(12, 0xe0, 0x00, 0x00), 500)[0];
    expect((min as { value: number }).value).toBeCloseTo(-1, 6);
  });

  it('parses multiple messages in one packet, each with its own timestamp byte', () => {
    const parser = createMidiParser();
    const data = new Uint8Array([
      header(0),
      stamp(10),
      0x90,
      60,
      100,
      stamp(20),
      0x90,
      64,
      100,
      stamp(30),
      0x80,
      60,
      0,
    ]);
    const messages = parser.parse(data, 1000);
    expect(messages.map((m) => m.kind)).toEqual(['noteOn', 'noteOn', 'noteOff']);
    expect(messages[1]!.timestampMs).toBeGreaterThan(messages[0]!.timestampMs);
    expect(messages[2]!.timestampMs).toBeGreaterThan(messages[1]!.timestampMs);
  });
});

describe('running status (spec §10.1)', () => {
  it('continues the running status when a timestamp byte is followed by data bytes', () => {
    const parser = createMidiParser();
    const data = new Uint8Array([header(0), stamp(10), 0x90, 60, 100, stamp(20), 64, 90]);
    const messages = parser.parse(data, 1000);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ kind: 'noteOn', channel: 0, note: 64, velocity: 90 });
  });

  it('continues the running status for data bytes with no timestamp byte at all', () => {
    const parser = createMidiParser();
    const data = new Uint8Array([header(0), stamp(10), 0x90, 60, 100, 62, 80, 65, 70]);
    const messages = parser.parse(data, 1000);
    expect(messages.map((m) => (m as { note: number }).note)).toEqual([60, 62, 65]);
    // Bytes sharing a timestamp byte share its time.
    expect(messages[1]!.timestampMs).toBe(messages[0]!.timestampMs);
  });

  it('carries the running status across packets', () => {
    const parser = createMidiParser();
    parser.parse(packet(10, 0x90, 60, 100), 1000);
    const messages = parser.parse(packet(20, 64, 90), 1000);
    expect(messages[0]).toMatchObject({ kind: 'noteOn', note: 64, velocity: 90 });
  });

  it('does not apply running status across a system-common status (spec §10.1)', () => {
    const parser = createMidiParser();
    parser.parse(packet(10, 0x90, 60, 100), 1000);
    // 0xF1 (MIDI time code) cancels running status; the trailing data must not become a note.
    const messages = parser.parse(new Uint8Array([header(0), stamp(20), 0xf1, 0x20, 64, 90]), 1000);
    expect(messages).toEqual([]);
  });
});

describe('timestamp reconstruction (spec §10.1)', () => {
  it('reconstructs a performance.now()-domain timestamp near the arrival time', () => {
    const parser = createMidiParser();
    const arrival = 20_000;
    const ts = arrival % BLE_MIDI_TIMESTAMP_WRAP_MS;
    const [message] = parser.parse(packet(ts, 0x90, 60, 100), arrival);
    expect(message!.timestampMs).toBeCloseTo(arrival, 3);
  });

  it('unwraps a timestamp that belongs to the previous 8192 ms window', () => {
    const parser = createMidiParser();
    // Arrival just after a wrap; the device stamped just before it.
    const arrival = BLE_MIDI_TIMESTAMP_WRAP_MS * 3 + 5;
    const stamped = BLE_MIDI_TIMESTAMP_WRAP_MS - 10; // 10 ms before the wrap
    const [message] = parser.parse(packet(stamped, 0x90, 60, 100), arrival);
    expect(message!.timestampMs).toBeCloseTo(BLE_MIDI_TIMESTAMP_WRAP_MS * 3 - 10, 3);
    expect(message!.timestampMs).toBeLessThan(arrival);
  });

  it('never reconstructs a timestamp far in the future', () => {
    const parser = createMidiParser();
    const arrival = BLE_MIDI_TIMESTAMP_WRAP_MS * 2 + 20;
    const [message] = parser.parse(packet(BLE_MIDI_TIMESTAMP_WRAP_MS - 1, 0x90, 60, 100), arrival);
    expect(message!.timestampMs).toBeLessThanOrEqual(arrival + 1);
  });

  it('handles the low-7-bit timestamp wrapping inside a single packet', () => {
    const parser = createMidiParser();
    // Two messages whose low bytes wrap (126 → 2) share one header high value.
    const data = new Uint8Array([header(0), stamp(126), 0x90, 60, 100, stamp(2), 0x90, 64, 100]);
    const messages = parser.parse(data, 1000);
    expect(messages[1]!.timestampMs).toBeGreaterThan(messages[0]!.timestampMs);
    expect(messages[1]!.timestampMs - messages[0]!.timestampMs).toBeCloseTo(4, 6);
  });

  it('carries every low-7-bit wrap in a packet, not just the first (issue #77)', () => {
    const parser = createMidiParser();
    // Low bytes 100 → 10 → 120 → 30 wrap twice, spanning more than 256 ms. Carrying only the
    // latest wrap gave the fourth message 158 ms — 90 ms *behind* the third, i.e. in the past.
    const data = new Uint8Array([
      header(0),
      stamp(100),
      0x90,
      60,
      100,
      stamp(10),
      0x90,
      61,
      100,
      stamp(120),
      0x90,
      62,
      100,
      stamp(30),
      0x90,
      63,
      100,
    ]);
    const stamps = parser.parse(data, 5000).map((message) => message.timestampMs);
    expect(stamps).toHaveLength(4);
    const deltas = stamps.slice(1).map((value, index) => value - stamps[index]!);
    expect(deltas).toEqual([38, 110, 38]);
  });
});

describe('SysEx and malformed input (spec §10.1 — never crashes)', () => {
  it('skips a complete SysEx message without emitting anything', () => {
    const parser = createMidiParser();
    const data = new Uint8Array([header(0), stamp(10), 0xf0, 0x7d, 0x01, 0x02, stamp(20), 0xf7]);
    expect(parser.parse(data, 1000)).toEqual([]);
  });

  it('skips a SysEx that spans packets, then resumes parsing normally', () => {
    const parser = createMidiParser();
    expect(parser.parse(new Uint8Array([header(0), stamp(10), 0xf0, 0x7d, 0x01]), 1000)).toEqual([]);
    expect(parser.parse(new Uint8Array([header(0), 0x02, 0x03]), 1000)).toEqual([]);
    const tail = parser.parse(new Uint8Array([header(0), stamp(20), 0xf7, stamp(21), 0x90, 60, 100]), 1000);
    expect(tail).toHaveLength(1);
    expect(tail[0]).toMatchObject({ kind: 'noteOn', note: 60 });
  });

  it('ignores an empty packet', () => {
    const parser = createMidiParser();
    expect(parser.parse(new Uint8Array([]), 1000)).toEqual([]);
  });

  it('ignores a header-only packet', () => {
    const parser = createMidiParser();
    expect(parser.parse(new Uint8Array([header(0)]), 1000)).toEqual([]);
  });

  it('ignores a packet whose first byte is not a header', () => {
    const parser = createMidiParser();
    expect(parser.parse(new Uint8Array([0x00, 0x90, 60, 100]), 1000)).toEqual([]);
  });

  it('drops a truncated message at the end of a packet', () => {
    const parser = createMidiParser();
    const messages = parser.parse(new Uint8Array([header(0), stamp(10), 0x90, 60]), 1000);
    expect(messages).toEqual([]);
  });

  it('ignores data bytes arriving with no running status established', () => {
    const parser = createMidiParser();
    expect(parser.parse(new Uint8Array([header(0), stamp(10), 60, 100]), 1000)).toEqual([]);
  });

  it('skips single-byte real-time messages without disturbing running status', () => {
    const parser = createMidiParser();
    parser.parse(packet(10, 0x90, 60, 100), 1000);
    const messages = parser.parse(new Uint8Array([header(0), stamp(20), 0xf8, stamp(21), 64, 90]), 1000);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ kind: 'noteOn', note: 64 });
  });

  it('survives a long burst of arbitrary bytes', () => {
    const parser = createMidiParser();
    const noise = new Uint8Array(512);
    for (let index = 0; index < noise.length; index++) noise[index] = (index * 37) % 256;
    expect(() => parser.parse(noise, 1000)).not.toThrow();
  });

  it('resets running status and SysEx state on reset()', () => {
    const parser = createMidiParser();
    parser.parse(packet(10, 0x90, 60, 100), 1000);
    parser.reset();
    expect(parser.parse(packet(20, 64, 90), 1000)).toEqual([]);
  });

  it('accepts a DataView as well as a Uint8Array', () => {
    const parser = createMidiParser();
    const bytes = packet(10, 0x90, 60, 100);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(parser.parse(view, 1000)).toHaveLength(1);
  });
});
