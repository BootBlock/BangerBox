/**
 * Project lifecycle service (spec §4.2, §4.4) — the concrete implementation the store
 * delegates to (spec §4.2). Owns the repositories, the active project's autosave queue,
 * and the create/load/save flows. Registered once at boot via {@link installProjectService};
 * `.mpcweb` export/import run in the pack worker (spec §9.6) and are driven from here.
 */
import { getDatabaseDriver } from '@/core/storage/client';
import { createRepositories, type Repositories } from '@/core/storage/repositories';
import { deleteFile, readFile, samplePath, writeFileAtomic } from '@/core/storage/opfs';
import { assertWriteHeadroom } from '@/core/storage/safeguards';
import { MPCWEB_MAX_ENTRY_BYTES, MPCWEB_MAX_TOTAL_BYTES } from '@/core/constants';
import { useProjectStore, useUIStore } from '@/store';
import { AutosaveQueue, type SaveOutcome } from './autosave';
import { describeDirtyKeys, registerAutosave, unregisterAutosave } from './dirty';
import { hydrateStores } from './hydrate';
import { remapSnapshot, type ProjectSnapshot } from './mpcweb';
import { packMpcwebInWorker, unpackMpcwebInWorker } from './packClient';
import type { PackedSample, UnpackedProject } from './mpcwebZip';
import { flushDirtyKeys } from './persist';
import { planSharedSamples } from './sampleSharing';
import { registerProjectService, type ProjectService } from './service';
import { dumpSnapshot, restoreSnapshot } from './snapshotService';
import { createDefaultChannelStrip, createDefaultDrumProgram, createDefaultSequence } from './schemas';

let repositories: Repositories | null = null;
let queue: AutosaveQueue | null = null;

function getRepositories(): Repositories {
  repositories ??= createRepositories(getDatabaseDriver());
  return repositories;
}

/** Tear down the previous project's autosave queue before switching (spec §4.4). */
function teardownAutosave(): void {
  if (queue !== null) {
    queue.dispose();
    unregisterAutosave();
    queue = null;
  }
}

/**
 * Thrown when a project switch is refused because the outgoing project's autosave could not
 * be written (spec §4.4, issue #103). Carries the finished sentence the UI shows, because
 * only this layer knows both that the switch was refused and what it was refused over.
 */
class UnsavedWorkError extends Error {
  constructor(
    readonly unsavedKeys: readonly string[],
    cause?: unknown,
  ) {
    super(
      `Your work could not be saved (${describeDirtyKeys(unsavedKeys)}), so BangerBox has stayed on this project rather than leaving it behind. Export the project to keep the changes, then try again.`,
      cause !== undefined ? { cause } : undefined,
    );
    this.name = 'UnsavedWorkError';
  }
}

/**
 * Flush the outgoing project's queue, then tear it down (spec §4.4: flush "before project
 * switch/export"). Ordered before {@link hydrateStores} because the flush writes from the
 * store state, which still holds the outgoing project until hydration replaces it.
 *
 * `dispose()` alone drops the dirty set without writing it, so anything edited inside the
 * debounce window is lost — and silently, because a dropped set never reaches `onIdle` while
 * hydration goes on to call `setModified(false)`, clearing the one dot that represents it.
 *
 * **A failed flush REFUSES the transition** (spec §4.4, issue #103). `flushNow()` never
 * rejects, by design, so the failure is reported only through its return value — and
 * discarding that value converted the silent loss #19 fixed into a narrated one: the toast
 * named the cause while hydration removed the project the user would have exported from. The
 * queue is left standing when it refuses, so the work is still queued, the unsaved dot stays
 * up, and a later save (or a retry of the switch) can still write it.
 *
 * `force` is for teardown paths only — Safe Mode and shutdown (see {@link closeActiveProject}).
 * §8.1's Safe Mode exists to get the user OUT of a failing shell, so refusing there would
 * trap them in the very state they are escaping.
 */
async function flushAndTeardownAutosave(options: { force?: boolean } = {}): Promise<void> {
  if (!options.force) await assertOutgoingWorkIsSaved();
  teardownAutosave();
}

/**
 * Flush the open project's queue and REFUSE if it could not be written — without tearing the
 * queue down (spec §4.4, issue #103).
 *
 * The split matters. `newProject` and {@link installUnpackedAsNewProject} have to refuse
 * before they write anything, so a refusal leaves neither an empty project nor a half-installed
 * archive behind. But tearing the queue down at that point would mean any later failure — a
 * rejected `create`, a §9.7 headroom refusal, a rolled-back restore — left the STILL-OPEN
 * project with `markDirty` a no-op: the unsaved dot would never light again and every
 * subsequent edit would be lost on reload. That is a worse loss than the one being prevented,
 * so the teardown stays where the project actually changes, in {@link loadProject}.
 *
 * Calling it twice is free: the second flush finds an empty queue and reports `'idle'`.
 */
async function assertOutgoingWorkIsSaved(): Promise<void> {
  const active = queue;
  if (active && (await active.flushNow()) === 'failed') {
    throw new UnsavedWorkError(active.unsavedKeys);
  }
}

async function newProject(name = 'New Project'): Promise<string> {
  // Refuse before creating anything (spec §4.4, issue #103): `loadProject` at the end would
  // refuse anyway, and doing it here means a refused switch leaves no empty project behind.
  // The queue is deliberately left standing — see `assertOutgoingWorkIsSaved`.
  await assertOutgoingWorkIsSaved();
  const repos = getRepositories();
  const project = await repos.projects.create({ name });

  // Seed the minimal playable skeleton: one drum program, one sequence, one track.
  const program = createDefaultDrumProgram('Program 1');
  await repos.programs.create({
    id: program.id,
    project_id: project.id,
    name: program.name,
    type: 'drum',
    payload: JSON.stringify(program),
  });

  const sequence = createDefaultSequence(project.id, 0, 'Sequence 1');
  await repos.sequences.create({
    id: sequence.id,
    project_id: project.id,
    position: sequence.position,
    name: sequence.name,
    length_bars: sequence.lengthBars,
    time_sig_numerator: sequence.timeSig.numerator,
    time_sig_denominator: sequence.timeSig.denominator,
    tempo: sequence.tempo,
    swing_amount: sequence.swingAmount,
    swing_division: sequence.swingDivision,
  });

  const trackId = crypto.randomUUID();
  await repos.tracks.create({
    id: trackId,
    sequence_id: sequence.id,
    program_id: program.id,
    position: 0,
    name: 'Track 1',
    type: 'drum',
    mixer: JSON.stringify(createDefaultChannelStrip(`track:${trackId}`)),
  });

  await loadProject(project.id);
  return project.id;
}

async function loadProject(id: string): Promise<void> {
  await flushAndTeardownAutosave();
  const repos = getRepositories();
  await hydrateStores(repos, id);

  queue = new AutosaveQueue({
    flush: (keys) => flushDirtyKeys(repos, keys),
    // Autosave failing means edits are only in memory — an error, not a warning, and one the
    // user can act on: export now, before a reload takes the unsaved work with it. The cause
    // is named because "quota full" and "worker died" call for different responses.
    onError: (error) =>
      useUIStore
        .getState()
        .pushToast(
          `Autosave failed — your recent changes are not saved. Export the project now. (${
            error instanceof Error && error.message ? error.message : 'unknown cause'
          })`,
          'error',
        ),
    onIdle: () => useProjectStore.getState().setModified(false),
  });
  registerAutosave(queue, { onDirty: () => useProjectStore.getState().setModified(true) });
}

async function saveNow(): Promise<SaveOutcome> {
  // No queue means no open project — nothing to save, which is not a save.
  return (await queue?.flushNow()) ?? 'idle';
}

/**
 * Warn when an export exceeds what the §9.6 import will accept (issue #26, issue #99).
 *
 * Import enforces the §2.6 decompression budget and export enforces nothing, so BangerBox can
 * write an archive it will later refuse to open — and one of those refusals tells the user to
 * ask for a fresh export, which is the thing that produced the file.
 *
 * It warns rather than refusing, for the reason export is per-sample recoverable at all: this
 * file may be the only copy of the user's work, so producing it and saying what is wrong beats
 * producing nothing. The message names the sample, because a project over the total is fixed by
 * removing audio and the user has to know which.
 */
function warnIfImportWouldRefuse(samples: readonly PackedSample[], names: ReadonlyMap<string, string>): void {
  const oversized = samples.filter((sample) => sample.bytes.byteLength > MPCWEB_MAX_ENTRY_BYTES);
  const total = samples.reduce((sum, sample) => sum + sample.bytes.byteLength, 0);
  if (oversized.length === 0 && total <= MPCWEB_MAX_TOTAL_BYTES) return;

  // Named from the snapshot rows being packed, not from the Browser's cached list: this is a
  // statement about THIS archive, and the two can disagree.
  const nameOf = (sampleId: string) => names.get(sampleId) ?? sampleId;
  const detail =
    oversized.length > 0
      ? `${oversized.length} sample${oversized.length === 1 ? ' is' : 's are'} too large (${oversized
          .slice(0, 3)
          .map((sample) => nameOf(sample.sampleId))
          .join(', ')})`
      : 'the project is too large in total';
  useUIStore
    .getState()
    .pushToast(
      `This export was written, but BangerBox cannot open it again: ${detail}. Split the project or shorten the audio before relying on this file.`,
      'warning',
    );
}

/**
 * Export the active project as a `.mpcweb` archive (spec §9.6): flush autosave, dump the row
 * snapshot, read every referenced sample's WAV bytes from OPFS, then zip in the pack worker.
 *
 * **Export is per-sample recoverable, not all-or-nothing** (issue #99). A single `Promise.all`
 * over the reads meant one missing OPFS file made the project impossible to export at all —
 * and export is precisely what a user reaches for when a project is already misbehaving, so
 * that is the worst possible moment to be strict.
 *
 * A sample that cannot be read is dropped from the archive **and from the snapshot's sample
 * rows**, so the archive stays internally consistent and re-imports cleanly rather than
 * tripping the §9.6 completeness check the import now applies. The user is told how much was
 * left out, because the alternative — a quietly smaller export — is the silent loss this
 * whole issue is about. The pads that played those samples import with a dangling reference
 * and no sound, which is the honest outcome: the audio genuinely is not there any more.
 */
async function exportMpcweb(): Promise<Blob> {
  await saveNow();
  const projectId = useProjectStore.getState().projectId;
  if (!projectId) throw new Error('No active project to export.');
  const repos = getRepositories();
  const snapshot = await dumpSnapshot(repos, projectId);

  const samples: PackedSample[] = [];
  const unreadable: string[] = [];
  for (const sample of snapshot.samples) {
    try {
      samples.push({
        sampleId: sample.id,
        bytes: new Uint8Array(await (await readFile(sample.opfs_path)).arrayBuffer()),
      });
    } catch {
      unreadable.push(sample.name);
    }
  }

  warnIfImportWouldRefuse(samples, new Map(snapshot.samples.map((row) => [row.id, row.name])));

  const exported = new Set(samples.map((sample) => sample.sampleId));
  const packed =
    unreadable.length === 0
      ? snapshot
      : { ...snapshot, samples: snapshot.samples.filter((row) => exported.has(row.id)) };

  if (unreadable.length > 0) {
    useUIStore
      .getState()
      .pushToast(
        `Exported without ${unreadable.length} sample${unreadable.length === 1 ? '' : 's'} whose audio could not be read (${unreadable.slice(0, 3).join(', ')}). Everything else is in the file.`,
        'warning',
      );
  }

  const bytes = await packMpcwebInWorker({ snapshot: packed, appVersion: __APP_VERSION__, samples });
  return new Blob([bytes as BlobPart], { type: 'application/zip' });
}

/**
 * Import a `.mpcweb` archive as a new project (spec §9.6): unpack + validate in the worker, remap
 * every UUID so it never collides, write the samples to OPFS under the new ids, insert every row
 * in one transaction, and open the imported project. A mid-way failure leaves no partial project
 * and no orphaned audio — see {@link installUnpackedAsNewProject}.
 */
async function importMpcweb(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return installUnpackedAsNewProject(await unpackMpcwebInWorker(bytes));
}

export interface InstallOptions {
  /**
   * Install samples into the content-addressed global library instead of under the new
   * project (spec §9.1, §9.8). Set by factory `demo` installs, whose audio is shipped content
   * the app can re-fetch and legitimately share with the kit pack that also carries it.
   *
   * A USER import must leave this unset: their project has to stay self-contained, and
   * promoting imported audio into a shared library would let one project's purge reach into
   * another's (spec §9.6).
   */
  readonly shareSamples?: boolean;
  /**
   * Gate the §9.7 hard stop against the bytes this install will actually add, once sharing
   * has removed what is already stored. Injected rather than imported so the factory layer
   * keeps ownership of its own refusal type without this module depending on it.
   */
  readonly assertHeadroom?: (requiredBytes: number) => Promise<void>;
}

/**
 * Re-derive every sample row's storage location from the ids this install just generated,
 * discarding whatever the archive claimed (spec §9.1, §9.6).
 *
 * An archive is untrusted input: `opfs_path` and `project_id` arrive from a file the user was
 * given, and both are consumed as authority later — `opfs_path` by the Browser's purge
 * (`deleteFile`) and by every read, `project_id` by the project/global split. A crafted file
 * naming `/bangerbox.sqlite3` would aim a purge at the whole database, and `project_id: null`
 * would smuggle the user's imported audio into the shared global library.
 *
 * Nothing is lost by ignoring them: the bytes are written to `samplePath(projectId, newId)`
 * regardless, so the imported path was only ever right by coincidence. Deriving it here makes
 * the row agree with the file by construction, which is why this is not a validation step —
 * there is no longer anything to validate.
 */
function withDerivedSamplePaths(snapshot: ProjectSnapshot, projectId: string): ProjectSnapshot {
  return {
    ...snapshot,
    samples: snapshot.samples.map((sample) => ({
      ...sample,
      project_id: projectId,
      opfs_path: samplePath(projectId, sample.id),
    })),
  };
}

/**
 * Delete the OPFS files an aborted install had already written (spec §9.6 transactionality).
 *
 * The rows are the driver's problem — one transaction, rolled back — but the audio is not:
 * each `writeFileAtomic` is atomic on its own and there is no transaction spanning the set, so
 * a failure part-way through leaves WAVs that no row references. Nothing can reclaim those
 * later: "Purge unused samples" works from program payloads, and the programs were never
 * inserted, so the bytes would sit in the user's quota permanently and invisibly.
 *
 * Best-effort per file, as the §9.8 kit-merge unwind is and for the same reason: one failed
 * delete must not abort the rest and degrade "no orphaned files" into "none up to the first
 * error". The install's original failure is what the caller sees.
 */
async function deleteWrittenSamples(paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    try {
      await deleteFile(path);
    } catch {
      // Already absent, or OPFS is the thing that failed — nothing more to do here.
    }
  }
}

/**
 * Install an already-unpacked `.mpcweb` payload as a NEW project and open it (spec §9.6).
 *
 * Shared by the user import above and the factory `demo` install (spec §9.8), which is why
 * it takes an unpacked payload rather than a File: §9.8 installs factory content "through
 * the same unpack → Zod-validate → UUID-remap → OPFS-write → row-insert path as a user
 * import", so there is one path here, not two. `options` varies that one path where factory
 * content legitimately differs from a user's, rather than forking it.
 *
 * Transactional in both halves (spec §9.6 "a failure mid-way leaves no partial project"):
 * every row goes in through a single {@link restoreSnapshot} transaction, and the OPFS writes —
 * which no transaction covers — are recorded and deleted on failure by
 * {@link deleteWrittenSamples}. The audio is written first so that, when the rows do commit,
 * every path they name already exists.
 */
export async function installUnpackedAsNewProject(
  unpacked: UnpackedProject,
  options: InstallOptions = {},
): Promise<string> {
  // Refuse before a byte is written (spec §4.4, issue #103): `loadProject` at the end would
  // refuse anyway, and doing it first means a refused install leaves no rows and no audio.
  // The queue is left standing, so an install that fails after this point does not cost the
  // still-open project its autosave — see `assertOutgoingWorkIsSaved`.
  await assertOutgoingWorkIsSaved();

  const remapped = remapSnapshot(unpacked.snapshot);
  const { projectId, sampleIdMap } = remapped;
  const snapshot = withDerivedSamplePaths(remapped.snapshot, projectId);
  const repos = getRepositories();

  // Re-key the packed bytes onto the remapped ids the rows now carry.
  const bytesById = new Map<string, Uint8Array>();
  for (const [oldId, data] of unpacked.samples) {
    const newId = sampleIdMap.get(oldId);
    if (newId) bytesById.set(newId, data);
  }

  // Every file written so far, so a failure anywhere below can take them back with it.
  const writtenPaths: string[] = [];

  try {
    if (options.shareSamples) {
      const plan = await planSharedSamples(snapshot, bytesById, repos);
      const shared = plan.writes.reduce((sum, write) => sum + write.bytes.byteLength, 0);
      await (options.assertHeadroom ?? assertWriteHeadroom)(shared);
      for (const sample of plan.writes) {
        await writeFileAtomic(sample.opfs_path, new Uint8Array(sample.bytes));
        writtenPaths.push(sample.opfs_path);
      }
      // The global sample rows ride along in the restore's transaction rather than going in
      // first: committed separately, a later failure would strand rows pointing at deleted
      // files. `plan.snapshot` carries no sample rows of its own — they are global now, and
      // its programs already point at whichever stored copy won.
      await restoreSnapshot(
        repos,
        plan.snapshot,
        plan.writes.map((sample) =>
          repos.samples.insertStatement({
            id: sample.id,
            // NULL project id IS the global-library encoding (spec §9.3).
            project_id: null,
            name: sample.name,
            opfs_path: sample.opfs_path,
            frames: sample.frames,
            sample_rate: sample.sample_rate,
            channels: sample.channels,
            root_note: sample.root_note,
          }),
        ),
      );
    } else {
      // One check for the whole archive, not one per sample: a partially installed project is
      // worse than a refused one, so the §9.7 gate is sized on everything about to be written.
      let required = 0;
      for (const data of bytesById.values()) required += data.byteLength;
      await (options.assertHeadroom ?? assertWriteHeadroom)(required);

      // Relocate each sample's bytes to its new OPFS path before inserting rows.
      for (const [newId, data] of bytesById) {
        const path = samplePath(projectId, newId);
        // Copy into a fresh ArrayBuffer-backed view (the OPFS stream API rejects shared buffers).
        await writeFileAtomic(path, new Uint8Array(data));
        writtenPaths.push(path);
      }

      await restoreSnapshot(repos, snapshot);
    }
  } catch (error) {
    await deleteWrittenSamples(writtenPaths);
    throw error;
  }

  await loadProject(projectId);
  return projectId;
}

export const projectService: ProjectService = {
  newProject,
  loadProject,
  saveNow,
  exportMpcweb,
  importMpcweb,
};

/** Register the lifecycle service so the store's lifecycle actions resolve (spec §4.2). */
export function installProjectService(): void {
  registerProjectService(projectService);
}

/** The active repository set — the only RPC clients (spec §3.1); used by Browser/Sample modes. */
export function getActiveRepositories(): Repositories {
  return getRepositories();
}

/** Open the most recently modified project, creating a first project if none exists (spec §8.5.1). */
export async function loadOrCreateActiveProject(): Promise<string> {
  const repos = getRepositories();
  const recent = await repos.projects.listRecent({ limit: 1 });
  const existing = recent.rows[0];
  if (existing !== undefined) {
    await loadProject(existing.id);
    return existing.id;
  }
  return newProject('First Project');
}

/**
 * Flush and tear down the active project's autosave (Safe Mode / shutdown).
 *
 * Forced, unlike a project switch (issue #103): §8.1's Safe Mode is the escape hatch from a
 * shell that is already failing, and its own offer is to export the project — so refusing to
 * close would trap the user in the state they are trying to leave. A switch has somewhere
 * safe to stay; a shutdown does not.
 */
export async function closeActiveProject(): Promise<void> {
  await flushAndTeardownAutosave({ force: true });
}
