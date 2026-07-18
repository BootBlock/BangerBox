/**
 * WAV-encode worker (spec §9.4 step 4) — encodes standardised planar Float32 channels to
 * canonical WAV bytes off the main thread, so importing/looping/bouncing a long sample never
 * janks the UI. A thin shell over the pure, golden-tested {@link encodeWav} (§11.1).
 */
import type { BitDepth } from '@/core/project/schemas';
import { encodeWav } from './wav';

export interface WavEncodeRequest {
  id: number;
  channels: Float32Array[];
  sampleRate: number;
  bitDepth: BitDepth;
}
export type WavEncodeResponse =
  { id: number; ok: true; bytes: Uint8Array } | { id: number; ok: false; error: string };

self.onmessage = (event: MessageEvent<WavEncodeRequest>) => {
  const { id, channels, sampleRate, bitDepth } = event.data;
  try {
    const bytes = encodeWav(channels, sampleRate, bitDepth);
    const response: WavEncodeResponse = { id, ok: true, bytes };
    (self as unknown as Worker).postMessage(response, [bytes.buffer]);
  } catch (error) {
    const response: WavEncodeResponse = {
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    (self as unknown as Worker).postMessage(response);
  }
};
