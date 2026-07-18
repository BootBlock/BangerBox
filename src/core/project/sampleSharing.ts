/**
 * Content-addressed sample sharing for factory installs (spec §9.1, §9.8 de-duplication).
 *
 * A factory demo embeds the audio of the kit it plays, so it opens standalone. That makes the
 * same sound arrive twice for a user who installs both, and storing it twice charges the §9.7
 * quota — metered by the §9.8 gauge — for one sound. The factory build renders a demo's kit
 * samples under the KIT's seed (see `scripts/factory/snapshot.mjs`), so the two arrive as
 * IDENTICAL BYTES; this module is what turns that identity into a single stored copy.
 *
 * The bytes are hashed and stored at `/global_library/{hash}.wav` with `project_id = NULL`
 * (§9.3's "global" encoding). A second pack shipping the same audio finds the existing row by
 * path and adopts its id rather than writing anything. Addressing by CONTENT rather than by
 * row id is what makes that lookup possible without a schema change: the hash is already in
 * the path, and the path is already a queryable column.
 *
 * SCOPE — factory content only. A user importing a `.mpcweb` gets project-scoped samples as
 * before (§9.6): their project must stay self-contained, and silently promoting their audio
 * into a shared library would make one project's purge reach into another's. Sharing is a
 * property of content the app ships and can re-fetch, not of content the user brought.
 */
import type { Repositories } from '@/core/storage/repositories';
import { globalContentPath } from '@/core/storage/opfs';
import { parseSnapshot, serialiseSnapshot, type ProjectSnapshot } from './mpcweb';

/**
 * A global-library row a plan wants inserted, alongside the bytes backing it. The row fields
 * are taken from the snapshot's own sample type, so the Zod-validated shape (§9.6) carries
 * through to the repository insert without being re-declared — and re-widened — here.
 */
export type SharedSampleWrite = Pick<
  ProjectSnapshot['samples'][number],
  'id' | 'name' | 'opfs_path' | 'frames' | 'sample_rate' | 'channels' | 'root_note'
> & { readonly bytes: Uint8Array };

export interface SharedSamplePlan {
  /**
   * The snapshot with every shared sample id rewritten to the id actually stored, and
   * `samples` emptied — those rows are global now, so they are inserted from `writes`
   * rather than as part of the project.
   */
  readonly snapshot: ProjectSnapshot;
  /** Samples whose bytes are not yet in the global library and must be written. */
  readonly writes: readonly SharedSampleWrite[];
  /** How many samples resolved to audio already installed — nothing written for these. */
  readonly reusedCount: number;
}

/** Lowercase hex SHA-256 of `bytes` — the global library's content address. */
export async function contentHash(bytes: Uint8Array): Promise<string> {
  // Copy into a fresh ArrayBuffer-backed view: `digest` rejects SharedArrayBuffer-backed ones,
  // and packed samples can arrive on a shared buffer under COOP/COEP isolation (spec §1.3).
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Decide where each of a pack's samples lives, collapsing bytes already in the global library.
 *
 * Runs on an ALREADY-REMAPPED snapshot (§9.6), so the ids being rewritten here are this
 * install's fresh ones and cannot collide with another project's. Rewriting is done by
 * replacing ids across the serialised snapshot — the same mechanism `remapSnapshot` uses, and
 * for the same reason: a sample id is referenced from program payloads and pad layers as well
 * as from its own row, and a targeted patch would miss one of them.
 */
export async function planSharedSamples(
  snapshot: ProjectSnapshot,
  bytesById: ReadonlyMap<string, Uint8Array>,
  repos: Repositories,
): Promise<SharedSamplePlan> {
  const writes: SharedSampleWrite[] = [];
  const idRewrites = new Map<string, string>();
  /** Hash → id chosen for it in THIS plan, so a pack shipping one sound twice writes it once. */
  const chosenByHash = new Map<string, string>();
  let reusedCount = 0;

  for (const sample of snapshot.samples) {
    const bytes = bytesById.get(sample.id);
    if (!bytes) throw new Error(`Pack is missing audio for sample “${sample.name}”.`);

    const hash = await contentHash(bytes);
    const path = globalContentPath(hash);

    const alreadyPlanned = chosenByHash.get(hash);
    if (alreadyPlanned !== undefined) {
      idRewrites.set(sample.id, alreadyPlanned);
      reusedCount++;
      continue;
    }

    const installed = await repos.samples.getGlobalByPath(path);
    if (installed) {
      idRewrites.set(sample.id, installed.id);
      chosenByHash.set(hash, installed.id);
      reusedCount++;
      continue;
    }

    chosenByHash.set(hash, sample.id);
    writes.push({
      id: sample.id,
      name: sample.name,
      opfs_path: path,
      frames: sample.frames,
      sample_rate: sample.sample_rate,
      channels: sample.channels,
      root_note: sample.root_note,
      bytes,
    });
  }

  let json = serialiseSnapshot({ ...snapshot, samples: [] });
  for (const [oldId, newId] of idRewrites) json = json.split(oldId).join(newId);

  return { snapshot: parseSnapshot(json), writes, reusedCount };
}
