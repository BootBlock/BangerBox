/**
 * Bundled demo sample — a ~0.2 s 440 Hz pluck (16-bit mono WAV) embedded as base64 so it
 * is precached with the app JS and available offline (the SW precache glob does not
 * include `.wav`, spec §2.3.5). It seeds the real OPFS → decode → voice path for the
 * Phase 3 audible proof (spec §12; smoke §11.4) before the sample-import pipeline exists
 * (Phase 6). Not a shipped feature — only the test UI and browser smoke use it.
 */
import { fileExists, samplePath, writeFileAtomic } from '@/core/storage/opfs';

/** Deterministic sample id for the seeded demo pluck. */
export const DEMO_SAMPLE_ID = 'demo-pluck';

const DEMO_WAV_BASE64 =
  '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';

/** Decode the embedded WAV to bytes (a fresh `Uint8Array<ArrayBuffer>` each call). */
export function demoSampleBytes(): Uint8Array<ArrayBuffer> {
  const binary = atob(DEMO_WAV_BASE64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** In-flight/completed write per project id, so concurrent triggers share one write. */
const ensurePending = new Map<string, Promise<string>>();

/**
 * Ensure the demo pluck exists at its canonical OPFS sample path for `projectId`
 * (spec §9.1) and return that path. Idempotent AND concurrency-safe: rapid pad hits
 * would otherwise race two atomic writes onto the same locked destination, so the write
 * promise is memoised per project (mirrors the sample-cache dedupe, spec §9.4).
 */
export function ensureDemoSampleInOpfs(projectId: string): Promise<string> {
  const cached = ensurePending.get(projectId);
  if (cached) return cached;
  const path = samplePath(projectId, DEMO_SAMPLE_ID);
  const pending = (async () => {
    if (!(await fileExists(path))) await writeFileAtomic(path, demoSampleBytes());
    return path;
  })();
  ensurePending.set(projectId, pending);
  pending.catch(() => ensurePending.delete(projectId)); // allow a retry after failure
  return pending;
}
