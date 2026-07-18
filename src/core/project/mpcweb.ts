/**
 * `.mpcweb` interchange snapshot (spec §9.6) — the pure, Zod-validated project snapshot that
 * `pack.worker.ts` zips and `importMpcweb` restores. `project.json` is a versioned dump of the
 * project row plus its sequences, tracks, MIDI events, automation, programs, song entries and
 * sample metadata (spec §9.6). Import remaps every UUID so an imported copy never collides with
 * an existing project (spec §9.6). Dependency-free beyond Zod (spec §2.5) so the round-trip is
 * unit-testable in memory (§11.1).
 */
import { z } from 'zod';
import { bitDepthSchema } from './schemas/primitives';

/** Current interchange format version (spec §9.6 manifest.formatVersion). */
export const MPCWEB_FORMAT_VERSION = 1;

// --- manifest.json (spec §9.6) ---------------------------------------------------
export const mpcwebManifestSchema = z.object({
  format: z.literal('mpcweb'),
  formatVersion: z.number().int(),
  appVersion: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  exportedAt: z.string(),
});
export type MpcwebManifest = z.infer<typeof mpcwebManifestSchema>;

// --- project.json row schemas (mirror the §9.3 DDL rows) -------------------------
const projectRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  created_at: z.number(),
  modified_at: z.number(),
  sample_rate: z.number(),
  bit_depth: bitDepthSchema,
  bpm_default: z.number(),
  insert_limit: z.number(),
  payload: z.string(),
});
const sequenceRowSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  position: z.number(),
  name: z.string(),
  length_bars: z.number(),
  time_sig_numerator: z.number(),
  time_sig_denominator: z.number(),
  tempo: z.number().nullable(),
  swing_amount: z.number(),
  swing_division: z.number(),
});
const trackRowSchema = z.object({
  id: z.string(),
  sequence_id: z.string(),
  program_id: z.string().nullable(),
  position: z.number(),
  name: z.string(),
  type: z.enum(['drum', 'keygroup', 'audio']),
  mixer: z.string(),
});
const midiEventRowSchema = z.object({
  id: z.string(),
  track_id: z.string(),
  tick_start: z.number(),
  duration_ticks: z.number(),
  note: z.number(),
  velocity: z.number(),
  extra: z.string().nullable(),
});
const automationRowSchema = z.object({
  id: z.string(),
  scope: z.enum(['sequence', 'track']),
  owner_id: z.string(),
  target_path: z.string(),
  tick: z.number(),
  value: z.number(),
  curve: z.enum(['step', 'linear', 'exp']),
});
const programRowSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  name: z.string(),
  type: z.enum(['drum', 'keygroup']),
  payload: z.string(),
});
const sampleRowSchema = z.object({
  id: z.string(),
  project_id: z.string().nullable(),
  name: z.string(),
  opfs_path: z.string(),
  frames: z.number(),
  sample_rate: z.number(),
  channels: z.union([z.literal(1), z.literal(2)]),
  root_note: z.number(),
  created_at: z.number(),
});
const songEntryRowSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  position: z.number(),
  sequence_id: z.string(),
  repeats: z.number(),
});

export const projectSnapshotSchema = z.object({
  version: z.number().int(),
  project: projectRowSchema,
  sequences: z.array(sequenceRowSchema),
  tracks: z.array(trackRowSchema),
  midiEvents: z.array(midiEventRowSchema),
  automation: z.array(automationRowSchema),
  programs: z.array(programRowSchema),
  samples: z.array(sampleRowSchema),
  songEntries: z.array(songEntryRowSchema),
});
export type ProjectSnapshot = z.infer<typeof projectSnapshotSchema>;

/** Serialise a snapshot to the `project.json` string (spec §9.6). The real SQLite worker may
 * hand back INTEGER columns as BigInt (rpc value union), which `JSON.stringify` cannot encode —
 * a replacer coerces any BigInt to Number so the dump never throws on a live project. */
export function serialiseSnapshot(snapshot: ProjectSnapshot): string {
  return JSON.stringify(snapshot, (_key, value) => (typeof value === 'bigint' ? Number(value) : value));
}

/** Parse and validate a `project.json` string (spec §9.6; rejects malformed snapshots). */
export function parseSnapshot(json: string): ProjectSnapshot {
  return projectSnapshotSchema.parse(JSON.parse(json));
}

/** Build the export manifest for a project (spec §9.6). */
export function buildManifest(
  project: { id: string; name: string },
  appVersion: string,
  exportedAt: string = new Date().toISOString(),
): MpcwebManifest {
  return {
    format: 'mpcweb',
    formatVersion: MPCWEB_FORMAT_VERSION,
    appVersion,
    projectId: project.id,
    projectName: project.name,
    exportedAt,
  };
}

/** Parse a manifest, rejecting an unknown format version with a friendly error (spec §9.6). */
export function parseManifest(json: string): MpcwebManifest {
  const manifest = mpcwebManifestSchema.parse(JSON.parse(json));
  if (manifest.formatVersion !== MPCWEB_FORMAT_VERSION) {
    throw new Error(
      `This project was exported by a newer version of BangerBox (format v${manifest.formatVersion}). Please update to open it.`,
    );
  }
  return manifest;
}

/** Every entity UUID in a snapshot (project, sequences, tracks, programs, events, …). */
function collectIds(snapshot: ProjectSnapshot): string[] {
  return [
    snapshot.project.id,
    ...snapshot.sequences.map((r) => r.id),
    ...snapshot.tracks.map((r) => r.id),
    ...snapshot.programs.map((r) => r.id),
    ...snapshot.samples.map((r) => r.id),
    ...snapshot.midiEvents.map((r) => r.id),
    ...snapshot.automation.map((r) => r.id),
    ...snapshot.songEntries.map((r) => r.id),
  ];
}

export interface RemapResult {
  readonly snapshot: ProjectSnapshot;
  readonly projectId: string;
  /** Old → new sample id, so the packed sample bytes can be relocated (spec §9.6). */
  readonly sampleIdMap: Map<string, string>;
}

/**
 * Remap every UUID in a snapshot to a fresh one (spec §9.6 "remap all UUIDs on collision"). Ids
 * are globally-unique 36-char strings, so replacing each old id with its new id across the whole
 * serialised snapshot rewrites every reference at once — foreign keys, mixer JSON channel ids,
 * program-payload sample ids, automation target-path ids, and sample OPFS paths — consistently.
 */
export function remapSnapshot(snapshot: ProjectSnapshot): RemapResult {
  const ids = collectIds(snapshot);
  // Two rows sharing an id would map onto one new id and collide on the primary key part-way
  // through `restoreSnapshot`, leaving rows already written. Reject the archive up front so the
  // import fails before it touches the database (spec §9.6).
  const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  if (duplicates.length > 0) {
    throw new Error(
      `This project file is corrupt: it reuses the same id for more than one item (${duplicates.join(', ')}).`,
    );
  }

  const idMap = new Map<string, string>();
  for (const id of ids) idMap.set(id, crypto.randomUUID());

  let json = serialiseSnapshot(snapshot);
  for (const [oldId, newId] of idMap) json = json.split(oldId).join(newId);
  const remapped = parseSnapshot(json);

  const sampleIdMap = new Map<string, string>();
  for (const sample of snapshot.samples) sampleIdMap.set(sample.id, idMap.get(sample.id)!);

  return { snapshot: remapped, projectId: idMap.get(snapshot.project.id)!, sampleIdMap };
}
