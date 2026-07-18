/**
 * Canonical WAV codec (spec §9.4 step 4) — a pure, dependency-free encoder/decoder for the
 * project's own audio interchange bytes: 16/24-bit PCM (format 1) and 32-bit IEEE float
 * (format 3). The encoder is the unit-tested function §11.1 mandates (golden bytes) and runs
 * in the sample/looper/bounce workers (spec §9.4, §8.5.8, §9.5). The decoder round-trips our
 * files for the in-memory `.mpcweb` snapshot test and any non-Web-Audio path; live decode of
 * imported mp3/flac/ogg/wav still goes through `decodeAudioData` (spec §9.4 step 2).
 *
 * All multi-byte fields are little-endian per the RIFF spec. Kept free of DOM/audio types so
 * it is trivially testable (spec §2.5).
 */
import type { BitDepth } from '@/core/project/schemas';

/** Bytes per sample for each supported storage depth. */
const BYTES_PER_SAMPLE: Record<BitDepth, number> = { '16': 2, '24': 3, '32f': 4 };

/** WAVE `audioFormat` tag: PCM integer (1) or IEEE float (3). */
function audioFormatFor(bitDepth: BitDepth): 1 | 3 {
  return bitDepth === '32f' ? 3 : 1;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

/** Clamp a Float32 sample into [-1, 1] so encoding never wraps around (spec §9.4). */
function clampSample(value: number): number {
  if (value > 1) return 1;
  if (value < -1) return -1;
  return value;
}

/**
 * Encode planar Float32 channels to a canonical WAV byte stream at `bitDepth` (spec §9.4).
 * Channels are interleaved (L0 R0 L1 R1 …); mono is a single channel. Returns a fresh
 * `Uint8Array<ArrayBuffer>` so the bytes can be transferred/written without aliasing input.
 */
export function encodeWav(
  channels: readonly Float32Array[],
  sampleRate: number,
  bitDepth: BitDepth,
): Uint8Array<ArrayBuffer> {
  const numChannels = channels.length;
  if (numChannels === 0) throw new Error('encodeWav: at least one channel is required');
  const frames = channels[0]!.length;
  const bytesPerSample = BYTES_PER_SAMPLE[bitDepth];
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = frames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // PCM/float fmt chunk size
  view.setUint16(20, audioFormatFor(bitDepth), true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bytesPerSample * 8, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < numChannels; channel++) {
      const sample = clampSample(channels[channel]![frame] ?? 0);
      if (bitDepth === '32f') {
        view.setFloat32(offset, sample, true);
      } else if (bitDepth === '16') {
        view.setInt16(offset, Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff), true);
      } else {
        // 24-bit: three little-endian bytes of the signed sample.
        const int = Math.round(sample < 0 ? sample * 0x800000 : sample * 0x7fffff);
        view.setUint8(offset, int & 0xff);
        view.setUint8(offset + 1, (int >> 8) & 0xff);
        view.setUint8(offset + 2, (int >> 16) & 0xff);
      }
      offset += bytesPerSample;
    }
  }
  return new Uint8Array(buffer);
}

export interface DecodedWav {
  readonly channels: Float32Array[];
  readonly sampleRate: number;
  readonly bitDepth: BitDepth;
}

/**
 * Decode a canonical PCM (16/24-bit) or IEEE-float (32-bit) WAV back to planar Float32
 * channels (spec §11.1 round-trip). Walks the RIFF chunk list so a leading `fmt ` and a
 * later `data` chunk are both found even if other chunks (e.g. `fact`) sit between them.
 */
export function decodeWav(bytes: Uint8Array): DecodedWav {
  if (bytes.byteLength < 44) throw new Error('decodeWav: byte stream too short for a WAV header');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number): string =>
    String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3),
    );
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('decodeWav: not a RIFF/WAVE stream');

  let audioFormat = 1;
  let numChannels = 1;
  let sampleRate = 48_000;
  let bitsPerSample = 16;
  let sawFmt = false;
  let dataOffset = -1;
  let dataSize = 0;

  let cursor = 12;
  while (cursor + 8 <= bytes.byteLength) {
    const chunkId = tag(cursor);
    const chunkSize = view.getUint32(cursor + 4, true);
    const body = cursor + 8;
    if (chunkId === 'fmt ') {
      // A `fmt ` chunk truncated at end-of-buffer would otherwise raise a bare RangeError.
      if (body + 16 > bytes.byteLength) throw new Error('decodeWav: truncated fmt chunk');
      audioFormat = view.getUint16(body, true);
      numChannels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
      sawFmt = true;
    } else if (chunkId === 'data') {
      dataOffset = body;
      dataSize = Math.min(chunkSize, bytes.byteLength - body);
    }
    // Chunks are word-aligned: an odd size is followed by a pad byte.
    cursor = body + chunkSize + (chunkSize & 1);
  }
  if (!sawFmt) throw new Error('decodeWav: no fmt chunk found');
  if (dataOffset < 0) throw new Error('decodeWav: no data chunk found');

  // Validate before allocating: a zero channel count or bit depth makes `blockAlign` zero, and
  // `dataSize / 0` is Infinity — an unbounded loop that wedges the thread rather than throwing.
  // §9.3 constrains stored samples to 1 or 2 channels, so anything else is not ours to decode.
  if (numChannels !== 1 && numChannels !== 2) {
    throw new Error(`decodeWav: unsupported channel count ${numChannels}`);
  }
  if (![8, 16, 24, 32].includes(bitsPerSample)) {
    throw new Error(`decodeWav: unsupported bit depth ${bitsPerSample}`);
  }
  // IEEE float is only defined at 32 bits; any other width would read past each frame's stride.
  if (audioFormat === 3 && bitsPerSample !== 32) {
    throw new Error(`decodeWav: IEEE float requires 32 bits, got ${bitsPerSample}`);
  }
  if (sampleRate <= 0) throw new Error(`decodeWav: invalid sample rate ${sampleRate}`);

  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const frames = Math.floor(dataSize / blockAlign);
  const channels: Float32Array[] = Array.from({ length: numChannels }, () => new Float32Array(frames));

  let offset = dataOffset;
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < numChannels; channel++) {
      let sample: number;
      if (audioFormat === 3) {
        sample = view.getFloat32(offset, true);
      } else if (bitsPerSample === 16) {
        sample = view.getInt16(offset, true) / 0x8000;
      } else if (bitsPerSample === 24) {
        const b0 = view.getUint8(offset);
        const b1 = view.getUint8(offset + 1);
        const b2 = view.getUint8(offset + 2);
        let int = b0 | (b1 << 8) | (b2 << 16);
        if (int & 0x800000) int -= 0x1000000; // sign-extend 24-bit
        sample = int / 0x800000;
      } else if (bitsPerSample === 32) {
        sample = view.getInt32(offset, true) / 0x80000000;
      } else if (bitsPerSample === 8) {
        sample = (view.getUint8(offset) - 128) / 128;
      } else {
        throw new Error(`decodeWav: unsupported bit depth ${bitsPerSample}`);
      }
      channels[channel]![frame] = sample;
      offset += bytesPerSample;
    }
  }

  const bitDepth: BitDepth = audioFormat === 3 ? '32f' : bitsPerSample === 24 ? '24' : '16';
  return { channels, sampleRate, bitDepth };
}
