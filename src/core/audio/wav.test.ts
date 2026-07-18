import { describe, expect, it } from 'vitest';
import { decodeWav, encodeWav } from './wav';

/** Read a little-endian uint32 from a byte view at an offset. */
function u32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>>
    0
  );
}
function u16(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}
function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}

describe('encodeWav — canonical RIFF/WAVE header (spec §9.4 step 4, §11.1 golden bytes)', () => {
  it('writes a 16-bit PCM header with the exact expected bytes', () => {
    const bytes = encodeWav([Float32Array.from([0, 1])], 48_000, '16');
    // 44-byte canonical header + 2 frames × 1 channel × 2 bytes = 48 bytes.
    expect(bytes.length).toBe(48);
    expect(ascii(bytes, 0, 4)).toBe('RIFF');
    expect(u32(bytes, 4)).toBe(36 + 4); // chunkSize = 36 + dataSize
    expect(ascii(bytes, 8, 4)).toBe('WAVE');
    expect(ascii(bytes, 12, 4)).toBe('fmt ');
    expect(u32(bytes, 16)).toBe(16); // PCM fmt chunk size
    expect(u16(bytes, 20)).toBe(1); // audioFormat = PCM
    expect(u16(bytes, 22)).toBe(1); // channels
    expect(u32(bytes, 24)).toBe(48_000); // sample rate
    expect(u32(bytes, 28)).toBe(48_000 * 1 * 2); // byte rate
    expect(u16(bytes, 32)).toBe(2); // block align
    expect(u16(bytes, 34)).toBe(16); // bits per sample
    expect(ascii(bytes, 36, 4)).toBe('data');
    expect(u32(bytes, 40)).toBe(4); // data size
    // sample 0 = 0 → 0x0000; sample 1 = +1 clamps to 32767 = 0x7FFF LE.
    expect([bytes[44], bytes[45], bytes[46], bytes[47]]).toEqual([0x00, 0x00, 0xff, 0x7f]);
  });

  it('interleaves stereo frames (L0 R0 L1 R1 …)', () => {
    const left = Float32Array.from([1, 0]);
    const right = Float32Array.from([0, -1]);
    const bytes = encodeWav([left, right], 44_100, '16');
    expect(u16(bytes, 22)).toBe(2); // channels
    // frame 0: L=+1 (0x7FFF), R=0 (0x0000); frame 1: L=0, R=-1 (0x8000)
    expect([bytes[44], bytes[45], bytes[46], bytes[47]]).toEqual([0xff, 0x7f, 0x00, 0x00]);
    expect([bytes[48], bytes[49], bytes[50], bytes[51]]).toEqual([0x00, 0x00, 0x00, 0x80]);
  });

  it('writes IEEE float (format 3) for 32f bit depth', () => {
    const bytes = encodeWav([Float32Array.from([0.5])], 48_000, '32f');
    expect(u16(bytes, 20)).toBe(3); // audioFormat = IEEE float
    expect(u16(bytes, 34)).toBe(32); // bits per sample
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getFloat32(44, true)).toBeCloseTo(0.5, 6);
  });

  it('writes 24-bit PCM as three little-endian bytes per sample', () => {
    const bytes = encodeWav([Float32Array.from([1])], 48_000, '24');
    expect(u16(bytes, 34)).toBe(24);
    // +1 clamps to 0x7FFFFF → LE bytes FF FF 7F
    expect([bytes[44], bytes[45], bytes[46]]).toEqual([0xff, 0xff, 0x7f]);
  });
});

describe('decodeWav — round-trips the encoder (spec §11.1)', () => {
  it('recovers channels, sample rate and bit depth for 16-bit', () => {
    const channels = [Float32Array.from([0, 0.5, -0.5, 1, -1])];
    const decoded = decodeWav(encodeWav(channels, 48_000, '16'));
    expect(decoded.sampleRate).toBe(48_000);
    expect(decoded.bitDepth).toBe('16');
    expect(decoded.channels.length).toBe(1);
    for (let i = 0; i < channels[0]!.length; i++) {
      expect(decoded.channels[0]![i]).toBeCloseTo(channels[0]![i]!, 2);
    }
  });

  it('round-trips 24-bit stereo with tighter tolerance', () => {
    const left = Float32Array.from([0, 0.25, -0.75, 0.999]);
    const right = Float32Array.from([-0.1, 0.1, -0.5, 0.5]);
    const decoded = decodeWav(encodeWav([left, right], 44_100, '24'));
    expect(decoded.sampleRate).toBe(44_100);
    expect(decoded.channels.length).toBe(2);
    for (let i = 0; i < left.length; i++) {
      expect(decoded.channels[0]![i]).toBeCloseTo(left[i]!, 4);
      expect(decoded.channels[1]![i]).toBeCloseTo(right[i]!, 4);
    }
  });

  it('round-trips 32-bit float exactly', () => {
    const channels = [Float32Array.from([0, 0.333333, -0.777, 1, -1])];
    const decoded = decodeWav(encodeWav(channels, 96_000, '32f'));
    expect(decoded.bitDepth).toBe('32f');
    for (let i = 0; i < channels[0]!.length; i++) {
      expect(decoded.channels[0]![i]).toBeCloseTo(channels[0]![i]!, 6);
    }
  });

  it('clamps out-of-range input on encode (no wrap-around)', () => {
    const decoded = decodeWav(encodeWav([Float32Array.from([2, -2])], 48_000, '16'));
    expect(decoded.channels[0]![0]).toBeCloseTo(1, 3);
    expect(decoded.channels[0]![1]).toBeCloseTo(-1, 3);
  });

  it('rejects bytes that are not a RIFF/WAVE stream', () => {
    expect(() => decodeWav(new Uint8Array([1, 2, 3, 4]))).toThrow(/RIFF|WAVE|too short/i);
  });
});
