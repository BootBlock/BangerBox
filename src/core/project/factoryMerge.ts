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
import type { ProjectSnapshot } from './mpcweb';

/** The rows a kit merge contributes to the active project (spec §9.8). */
export interface KitMerge {
  /** Program rows re-parented onto the active project. */
  readonly programs: ProjectSnapshot['programs'];
}

/**
 * Re-parent a remapped pack snapshot's PROGRAMS onto `projectId` (spec §9.8).
 *
 * Only programs: a kit's samples are installed into the content-addressed global library
 * rather than under the active project (spec §9.1, §9.8 de-duplication — see
 * `sampleSharing.ts`), so nothing here rewrites a sample's `opfs_path`. The pads reference
 * their samples by id, and `planSharedSamples` has already pointed those ids at whichever
 * copy is stored, so the programs need no sample-side fixing up.
 */
export function buildKitMerge(snapshot: ProjectSnapshot, projectId: string): KitMerge {
  return {
    programs: snapshot.programs.map((program) => ({ ...program, project_id: projectId })),
  };
}
