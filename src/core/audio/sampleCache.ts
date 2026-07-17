/**
 * Sample buffer cache — spec §9.4 (decode) / §5.2 (source). Reads a sample's WAV bytes
 * from OPFS and decodes them to an `AudioBuffer` once per path, memoising the promise so
 * repeated pad triggers share a single decode (spec §3.2: temporary decode buffers are
 * not re-created per hit). Decoding uses `audioContext.decodeAudioData`, which is
 * internally off-thread (spec §9.4). The read/decode seam is injectable so the cache's
 * memoisation is unit-testable without real OPFS or Web Audio (spec §11.3).
 */
import { readFile } from '@/core/storage/opfs';

export interface SampleSource {
  /** Read the raw encoded bytes at an OPFS path. */
  read: (path: string) => Promise<ArrayBuffer>;
  /** Decode encoded bytes to an AudioBuffer (spec §9.4 step 2). */
  decode: (bytes: ArrayBuffer) => Promise<AudioBuffer>;
}

function defaultSource(context: AudioContext): SampleSource {
  return {
    read: async (path) => {
      const file = await readFile(path);
      return file.arrayBuffer();
    },
    // decodeAudioData detaches the buffer; slice() hands it a private copy so a cached
    // byte source (if any) is never neutered underneath the caller.
    decode: (bytes) => context.decodeAudioData(bytes.slice(0)),
  };
}

export class SampleCache {
  private readonly cache = new Map<string, Promise<AudioBuffer>>();
  private readonly source: SampleSource;

  constructor(context: AudioContext, source?: SampleSource) {
    this.source = source ?? defaultSource(context);
  }

  /** The decoded buffer for an OPFS path, decoding at most once (spec §9.4). */
  get(path: string): Promise<AudioBuffer> {
    const cached = this.cache.get(path);
    if (cached) return cached;
    const decoded = (async () => {
      const bytes = await this.source.read(path);
      return this.source.decode(bytes);
    })();
    this.cache.set(path, decoded);
    decoded.catch(() => this.cache.delete(path)); // let a transient failure be retried
    return decoded;
  }

  /** Drop one path's cached buffer (destructive edit replaced the file — spec §8.5.4). */
  invalidate(path: string): void {
    this.cache.delete(path);
  }

  /** Drop every cached buffer (project close). */
  clear(): void {
    this.cache.clear();
  }
}
