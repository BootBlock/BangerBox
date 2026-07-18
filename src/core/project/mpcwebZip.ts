/**
 * `.mpcweb` zip pack/unpack (spec §9.6) — the fflate layer that turns a snapshot + sample bytes
 * into the exact archive layout (`manifest.json`, `project.json`, `samples/<sampleId>.wav`) and
 * back. Runs in `pack.worker.ts` off the main thread (spec §9.6); the logic is a pure function
 * pair so the round-trip is unit-testable in memory (§11.1). fflate is the §1.3 #12 archiver
 * (`zipSync`/`unzipSync`).
 */
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import {
  buildManifest,
  parseManifest,
  parseSnapshot,
  serialiseSnapshot,
  type MpcwebManifest,
  type ProjectSnapshot,
} from './mpcweb';

const MANIFEST_ENTRY = 'manifest.json';
const PROJECT_ENTRY = 'project.json';
const SAMPLE_PREFIX = 'samples/';

export interface PackedSample {
  readonly sampleId: string;
  /** Canonical WAV bytes (spec §9.4). */
  readonly bytes: Uint8Array;
}

export interface PackInput {
  readonly snapshot: ProjectSnapshot;
  readonly appVersion: string;
  readonly samples: readonly PackedSample[];
  /**
   * Fixed export timestamp. A user export omits it and gets "now" (spec §9.6). The factory
   * generator pins it, because §9.8 requires byte-reproducible packs and BOTH the manifest's
   * `exportedAt` AND the zip's per-entry mtimes are otherwise read from the clock — two
   * archives of identical content would then differ on every rebuild.
   */
  readonly exportedAt?: string;
}

export interface UnpackedProject {
  readonly manifest: MpcwebManifest;
  readonly snapshot: ProjectSnapshot;
  readonly samples: Map<string, Uint8Array>;
}

/** Pack a project into `.mpcweb` bytes (spec §9.6). */
export function packMpcweb({ snapshot, appVersion, samples, exportedAt }: PackInput): Uint8Array {
  const entries: Record<string, Uint8Array> = {
    [MANIFEST_ENTRY]: strToU8(JSON.stringify(buildManifest(snapshot.project, appVersion, exportedAt))),
    [PROJECT_ENTRY]: strToU8(serialiseSnapshot(snapshot)),
  };
  for (const sample of samples) {
    // WAV is already compressed audio data; store it (level 0) rather than re-deflating.
    entries[`${SAMPLE_PREFIX}${sample.sampleId}.wav`] = sample.bytes;
  }
  // project.json compresses well; samples are stored — a per-entry level keeps both cheap.
  // A pinned `exportedAt` also pins the entry mtimes (spec §9.8 byte-determinism); without
  // it fflate stamps each entry from the clock, as a user export should.
  return zipSync(entries, exportedAt === undefined ? { level: 6 } : { level: 6, mtime: exportedAt });
}

/** Unpack `.mpcweb` bytes, validating the manifest and snapshot (spec §9.6). */
export function unpackMpcweb(bytes: Uint8Array): UnpackedProject {
  const entries = unzipSync(bytes);
  const manifestBytes = entries[MANIFEST_ENTRY];
  const projectBytes = entries[PROJECT_ENTRY];
  if (!manifestBytes) throw new Error('.mpcweb archive is missing manifest.json');
  if (!projectBytes) throw new Error('.mpcweb archive is missing project.json');

  const manifest = parseManifest(strFromU8(manifestBytes));
  const snapshot = parseSnapshot(strFromU8(projectBytes));

  const samples = new Map<string, Uint8Array>();
  for (const [name, data] of Object.entries(entries)) {
    if (name.startsWith(SAMPLE_PREFIX) && name.endsWith('.wav')) {
      samples.set(name.slice(SAMPLE_PREFIX.length, -'.wav'.length), data);
    }
  }
  return { manifest, snapshot, samples };
}
