/**
 * Peak-pyramid worker (spec §8.5.4) — decodes a sample's canonical WAV bytes and reduces them to
 * a min/max pyramid off the main thread, which §3.3 requires and the 60 fps budget (§11.5)
 * depends on: a five-minute stereo sample is tens of millions of frames, and reducing that on the
 * main thread would drop frames every time a waveform appeared.
 *
 * A thin shell over the pure {@link buildPeakPyramid} and the golden-tested {@link decodeWav}.
 */
import { decodeWav } from './wav';
import { buildPeakPyramid, monoDownmix, type PeakPyramid } from './peakPyramid';

export interface PeakPyramidRequest {
  id: number;
  /** Canonical WAV bytes read from OPFS. */
  bytes: Uint8Array;
}
export type PeakPyramidResponse =
  { id: number; ok: true; pyramid: PeakPyramid } | { id: number; ok: false; error: string };

self.onmessage = (event: MessageEvent<PeakPyramidRequest>) => {
  const { id, bytes } = event.data;
  try {
    const decoded = decodeWav(bytes);
    const pyramid = buildPeakPyramid(monoDownmix(decoded.channels));
    const response: PeakPyramidResponse = { id, ok: true, pyramid };
    // Transfer every level's backing store; the worker keeps nothing.
    (self as unknown as Worker).postMessage(
      response,
      pyramid.levels.flatMap((level) => [level.min.buffer, level.max.buffer]),
    );
  } catch (error) {
    const response: PeakPyramidResponse = {
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    (self as unknown as Worker).postMessage(response);
  }
};
