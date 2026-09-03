/**
 * `.mpcweb` zip pack/unpack (spec §9.6) — the fflate layer that turns a snapshot + sample bytes
 * into the exact archive layout (`manifest.json`, `project.json`, `samples/<sampleId>.wav`) and
 * back. Runs in `pack.worker.ts` off the main thread (spec §9.6); the logic is a pure function
 * pair so the round-trip is unit-testable in memory (§11.1). fflate is the §1.3 #12 archiver.
 *
 * Unpacking is STREAMED rather than `unzipSync`, for two reasons that both come down to an
 * archive being untrusted input a user was handed by someone else:
 *
 * - **Bounded decompression (spec §9.7, issue #26).** `unzipSync` materialises everything and
 *   only then hands it back, so there is no moment at which a limit could be applied. The
 *   streaming `Unzip` reports each entry as it is discovered and each chunk as it inflates, so
 *   the entry count, the per-entry size and the running total are all checked BEFORE the bytes
 *   are held. An entry the layout does not describe is never started, so it costs nothing.
 * - **A damaged archive fails loudly (spec §9.6, issue #99).** The sample entries are
 *   reconciled against the sample rows `project.json` declares. An archive missing half its
 *   audio used to import cleanly and be discovered by pressing play.
 */
import { strFromU8, strToU8, Unzip, UnzipInflate, zipSync } from 'fflate';
import { MPCWEB_MAX_ENTRIES, MPCWEB_MAX_ENTRY_BYTES, MPCWEB_MAX_TOTAL_BYTES } from '@/core/constants';
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
const SAMPLE_SUFFIX = '.wav';

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

/**
 * What one archive may inflate to (spec §9.6, §9.7). Defaults come from the §2.6 registry;
 * the parameter exists so the limits can be proven at a size a unit test can build, rather
 * than by generating a real gigabyte (issue #26).
 */
export interface UnpackBudget {
  readonly maxEntries: number;
  readonly maxEntryBytes: number;
  readonly maxTotalBytes: number;
}

const DEFAULT_BUDGET: UnpackBudget = {
  maxEntries: MPCWEB_MAX_ENTRIES,
  maxEntryBytes: MPCWEB_MAX_ENTRY_BYTES,
  maxTotalBytes: MPCWEB_MAX_TOTAL_BYTES,
};

/** Pack a project into `.mpcweb` bytes (spec §9.6). */
export function packMpcweb({ snapshot, appVersion, samples, exportedAt }: PackInput): Uint8Array {
  const entries: Record<string, Uint8Array> = {
    [MANIFEST_ENTRY]: strToU8(JSON.stringify(buildManifest(snapshot.project, appVersion, exportedAt))),
    [PROJECT_ENTRY]: strToU8(serialiseSnapshot(snapshot)),
  };
  for (const sample of samples) {
    entries[`${SAMPLE_PREFIX}${sample.sampleId}${SAMPLE_SUFFIX}`] = sample.bytes;
  }
  // A pinned `exportedAt` also pins the entry mtimes (spec §9.8 byte-determinism); without
  // it fflate stamps each entry from the clock, as a user export should.
  return zipSync(entries, exportedAt === undefined ? { level: 6 } : { level: 6, mtime: exportedAt });
}

/** The three entry names the §9.6 layout defines. Anything else is never inflated. */
function isLayoutEntry(name: string): boolean {
  if (name === MANIFEST_ENTRY || name === PROJECT_ENTRY) return true;
  return name.startsWith(SAMPLE_PREFIX) && name.endsWith(SAMPLE_SUFFIX);
}

/** Thrown for a budget breach, so it survives the friendly wrapper around fflate's errors. */
class BudgetBreach extends Error {}

function humanBytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

function joinChunks(chunks: readonly Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Inflate the layout entries, refusing the archive the moment it exceeds its budget
 * (spec §9.6, §9.7 — issue #26).
 *
 * The check is inside `ondata`, not after the unzip: fflate's decoders are synchronous, so
 * throwing there unwinds straight out of `push` and the remaining bytes are never inflated.
 * That is what makes this a bound on memory rather than a report of how much was used.
 */
function inflateWithinBudget(bytes: Uint8Array, budget: UnpackBudget): Record<string, Uint8Array> {
  const entries: Record<string, Uint8Array> = {};
  let entryCount = 0;
  let totalBytes = 0;

  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  unzip.onfile = (file) => {
    entryCount += 1;
    if (entryCount > budget.maxEntries) {
      throw new BudgetBreach(
        `This project file contains too many items to open safely (more than ${budget.maxEntries}).`,
      );
    }
    // Never started, so never inflated — an unknown entry cannot cost anything.
    if (!isLayoutEntry(file.name)) return;

    const chunks: Uint8Array[] = [];
    let entryBytes = 0;
    file.ondata = (error, chunk, final) => {
      if (error) throw error;
      entryBytes += chunk.length;
      totalBytes += chunk.length;
      if (entryBytes > budget.maxEntryBytes) {
        throw new BudgetBreach(
          `This project file could not be opened: “${file.name}” is too large (over ${humanBytes(budget.maxEntryBytes)}).`,
        );
      }
      if (totalBytes > budget.maxTotalBytes) {
        throw new BudgetBreach(
          `This project file could not be opened: it unpacks to too large a project (over ${humanBytes(budget.maxTotalBytes)}).`,
        );
      }
      if (chunk.length > 0) chunks.push(chunk);
      if (final) entries[file.name] = joinChunks(chunks, entryBytes);
    };
    file.start();
  };

  try {
    unzip.push(bytes, true);
  } catch (error) {
    if (error instanceof BudgetBreach) throw new Error(error.message);
    const detail = error instanceof Error && error.message ? error.message : String(error);
    throw new Error(`This project file could not be read — it is not a valid .mpcweb archive. (${detail})`);
  }
  return entries;
}

/**
 * Reconcile the audio the archive carries against the sample rows it declares
 * (spec §9.6 — issue #99).
 *
 * A row with no bytes behind it is not a recoverable partial import: the row inserts fine,
 * the program payload still points at it, and the pad is simply silent — which the user
 * discovers by pressing play, with nothing having reported a problem. Refusing here is what
 * makes "a failure mid-way leaves no partial project" mean something for a damaged file, and
 * it happens before a single row or byte is written.
 *
 * The reverse case — audio no row references — is left alone. It wastes space inside the
 * archive and nothing else; the install only ever reads bytes for ids it has rows for.
 */
function assertSamplesComplete(snapshot: ProjectSnapshot, samples: ReadonlyMap<string, Uint8Array>): void {
  const missing = snapshot.samples.filter((row) => !samples.has(row.id));
  if (missing.length === 0) return;

  const names = missing.slice(0, 5).map((row) => row.name);
  const andMore = missing.length > names.length ? `, and ${missing.length - names.length} more` : '';
  throw new Error(
    `This project file is damaged: ${missing.length} of its ${snapshot.samples.length} samples are missing from it (${names.join(', ')}${andMore}). Opening it would give you a project with no sound, so it has not been imported — ask for a fresh export.`,
  );
}

/** Unpack `.mpcweb` bytes, validating the manifest, the snapshot and the audio (spec §9.6). */
export function unpackMpcweb(bytes: Uint8Array, budget: UnpackBudget = DEFAULT_BUDGET): UnpackedProject {
  const entries = inflateWithinBudget(bytes, budget);
  const manifestBytes = entries[MANIFEST_ENTRY];
  const projectBytes = entries[PROJECT_ENTRY];
  // Friendly, per §9.6: a file with no manifest is almost always not a `.mpcweb` at all, or
  // one truncated below the point where the entry survived, so name that rather than the entry.
  if (!manifestBytes) {
    throw new Error(
      'This project file could not be read — it is not a valid .mpcweb archive (no manifest.json).',
    );
  }
  if (!projectBytes) {
    throw new Error('This project file could not be read — it is missing its project data (project.json).');
  }

  const manifest = parseManifest(strFromU8(manifestBytes));
  const snapshot = parseSnapshot(strFromU8(projectBytes));

  const samples = new Map<string, Uint8Array>();
  for (const [name, data] of Object.entries(entries)) {
    if (name === MANIFEST_ENTRY || name === PROJECT_ENTRY) continue;
    samples.set(name.slice(SAMPLE_PREFIX.length, -SAMPLE_SUFFIX.length), data);
  }
  assertSamplesComplete(snapshot, samples);

  return { manifest, snapshot, samples };
}
