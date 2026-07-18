/**
 * Kit-merge snapshot transform (spec §9.8 "Install modes") — the pure half of installing a
 * `kit` pack into the *active* project.
 *
 * A `demo` pack installs as a new project and reuses the §9.6 import path unchanged. A `kit`
 * instead MERGES: its programs and samples are inserted into the open project, and its
 * sequences, tracks, MIDI events, automation and song entries are discarded — a kit is a
 * sound source, not an arrangement, and adopting its patterns would silently rewrite the
 * user's work.
 *
 * This module is pure so the discard/re-parent rules are unit-testable without a database
 * (spec §2.5, §11.1). It always runs on an already-UUID-remapped snapshot (§9.6), so the ids
 * it re-parents are guaranteed collision-free against the active project.
 */
import { samplePath } from '@/core/storage/opfs';
import type { ProjectSnapshot } from './mpcweb';

/** The rows a kit merge contributes to the active project (spec §9.8). */
export interface KitMerge {
  /** Program rows re-parented onto the active project. */
  readonly programs: ProjectSnapshot['programs'];
  /** Sample rows re-parented, with OPFS paths rewritten under the active project (§9.1). */
  readonly samples: ProjectSnapshot['samples'];
}

/**
 * Re-parent a remapped pack snapshot onto `projectId`, keeping only programs and samples.
 *
 * `remapSnapshot` rewrote every id — including the pack's own project id, which appears
 * inside each sample's `opfs_path`. That path must instead point under the ACTIVE project
 * (spec §9.1), so it is rebuilt from `samplePath` rather than patched, and never
 * hand-formatted at a call site.
 */
export function buildKitMerge(snapshot: ProjectSnapshot, projectId: string): KitMerge {
  return {
    programs: snapshot.programs.map((program) => ({ ...program, project_id: projectId })),
    samples: snapshot.samples.map((sample) => ({
      ...sample,
      project_id: projectId,
      opfs_path: samplePath(projectId, sample.id),
    })),
  };
}

/**
 * Total uncompressed bytes a pack's samples will occupy in OPFS (spec §9.8 "Storage").
 *
 * The §9.7 hard stop is checked against THIS, not against the catalogue's `bytes` (the
 * compressed archive size) — a pack that deflates well would otherwise slip past a gate
 * meant to protect the quota it actually consumes once written.
 */
export function uncompressedSampleBytes(samples: ReadonlyMap<string, Uint8Array>): number {
  let total = 0;
  for (const bytes of samples.values()) total += bytes.byteLength;
  return total;
}
