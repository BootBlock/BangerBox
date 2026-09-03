/**
 * `.mpcweb` zip pack/unpack (spec §9.6) — the fflate layer that turns a snapshot + sample bytes
 * into the exact archive layout (`manifest.json`, `project.json`, `samples/<sampleId>.wav`) and
 * back. Runs in `pack.worker.ts` off the main thread (spec §9.6); the logic is pure, so the
 * round-trip is unit-testable in memory (§11.1). fflate is the §1.3 #12 archiver.
 *
 * **Both directions stream**, and for the same underlying reason: an archive is the size of a
 * project's audio, and holding all of it at once is the one way a large project can fail to
 * open or to export at all on the tablet §11.5 targets.
 *
 * Unpacking has a second reason too — an archive is untrusted input a user was handed by
 * someone else:
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
import { strFromU8, strToU8, Unzip, UnzipInflate, Zip, ZipDeflate } from 'fflate';
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

/**
 * A `.mpcweb` archive built one sample at a time (spec §9.6 "worker zips (streamed)").
 *
 * The `zipSync` packer this replaces took every sample's bytes as one argument and held the
 * whole finished archive besides, so exporting a project peaked at roughly twice its audio
 * in memory — on
 * the device §11.5 targets, a tablet, that is the one place a large project could fail to
 * export at all (issue #99). This builds the same archive incrementally: the caller reads one
 * sample from OPFS, hands it over, and drops its reference before reading the next, while the
 * compressed output leaves through {@link PackerOptions.onChunk} rather than accumulating.
 *
 * It is the ONLY packer: the §9.8 factory generator drives it too, with a pinned
 * `exportedAt`. A second synchronous `zipSync` implementation beside it would be two pieces
 * of code writing one format, which is the drift the §9.6 layout constants exist to prevent.
 *
 * **`project.json` and `manifest.json` are written LAST, by {@link finish}.** A caller that
 * reads its samples one at a time only learns which ones it could not read as it goes, and
 * the §9.6 completeness check on the import side compares the sample rows against the audio
 * — so the snapshot cannot be serialised until the last sample is in. Zip entry order is not
 * part of the §9.6 layout, and {@link unpackMpcweb} reads entries by name.
 *
 * Only ONE entry is open at a time: fflate's `Zip` buffers a later entry's output until the
 * earlier one completes, which would put the archive back in memory and defeat the point.
 */
export interface PackerOptions {
  readonly appVersion: string;
  /** Called with each compressed chunk as it is produced, and a final empty-or-last chunk. */
  readonly onChunk: (chunk: Uint8Array, final: boolean) => void;
  /**
   * Fixed export timestamp. A user export omits it and gets "now" (spec §9.6). The §9.8
   * factory generator pins it, because §9.8 requires byte-reproducible packs and BOTH the
   * manifest's `exportedAt` AND the zip's per-entry mtimes are otherwise read from the
   * clock — two archives of identical content would then differ on every rebuild.
   */
  readonly exportedAt?: string;
}

export interface MpcwebPacker {
  /** Add one sample's WAV bytes. The bytes are not retained after this returns. */
  addSample: (sample: PackedSample) => void;
  /**
   * Write `manifest.json` and `project.json` for the samples actually added, then close the
   * archive. The snapshot's own sample rows are filtered down to what was added, so the file
   * stays internally consistent and re-imports past the §9.6 completeness check.
   */
  finish: (snapshot: ProjectSnapshot) => void;
}

export function createMpcwebPacker({ appVersion, onChunk, exportedAt }: PackerOptions): MpcwebPacker {
  let failure: Error | null = null;
  const added = new Set<string>();

  const zip = new Zip((error, chunk, final) => {
    // fflate reports a stream error through the same callback as data; holding it lets the
    // failure surface from the call the user is waiting on rather than from a stray throw
    // inside a callback the caller never sees.
    if (error) {
      failure ??= error;
      return;
    }
    onChunk(chunk, final);
  });

  /** Push one whole entry, start to finish, so no two entries are ever open at once. */
  const addEntry = (name: string, bytes: Uint8Array): void => {
    if (failure) throw failure;
    const entry = new ZipDeflate(name, { level: 6 });
    // Without a pinned mtime fflate stamps each entry from the clock, as a user export
    // should — and as a §9.8 factory pack must not (byte-determinism across rebuilds).
    if (exportedAt !== undefined) entry.mtime = exportedAt;
    zip.add(entry);
    entry.push(bytes, true);
    if (failure) throw failure;
  };

  return {
    addSample: ({ sampleId, bytes }) => {
      addEntry(`${SAMPLE_PREFIX}${sampleId}${SAMPLE_SUFFIX}`, bytes);
      added.add(sampleId);
    },

    finish: (snapshot) => {
      const packed =
        snapshot.samples.length === added.size
          ? snapshot
          : { ...snapshot, samples: snapshot.samples.filter((row) => added.has(row.id)) };
      addEntry(
        MANIFEST_ENTRY,
        strToU8(JSON.stringify(buildManifest(packed.project, appVersion, exportedAt))),
      );
      addEntry(PROJECT_ENTRY, strToU8(serialiseSnapshot(packed)));
      zip.end();
      if (failure) throw failure;
    },
  };
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
