/**
 * Project snapshot dump/restore (spec §9.6) — turns the repository rows of one project into a
 * {@link ProjectSnapshot} for export, and writes a snapshot's rows back for import. All reads
 * page at the repository limit and drain fully (spec §9.2). Restore inserts in foreign-key order
 * (project → programs → sequences → tracks → events → automation → samples → song). Import
 * always feeds a UUID-remapped snapshot ({@link remapSnapshot}) so copies never collide (§9.6).
 */
import type { Repositories } from '@/core/storage/repositories';
import type { AutomationPointRow, Page } from '@/core/storage/repositories';
import type { SqlStatement } from '@/core/storage/driver';
import type { ProjectSnapshot } from './mpcweb';

/** Drain every page of a paginated repository read into one array (spec §9.2). */
async function drain<T>(read: (offset: number) => Promise<Page<T>>): Promise<T[]> {
  const rows: T[] = [];
  let offset = 0;
  for (;;) {
    const page = await read(offset);
    rows.push(...page.rows);
    if (!page.hasMore) return rows;
    offset += page.rows.length;
  }
}

/** Dump a project's full row set into an interchange snapshot (spec §9.6). */
export async function dumpSnapshot(repos: Repositories, projectId: string): Promise<ProjectSnapshot> {
  const project = await repos.projects.getById(projectId);
  if (!project) throw new Error(`Project ${projectId} not found`);

  const sequences = await drain((offset) => repos.sequences.listByProject(projectId, { offset }));
  const programs = await drain((offset) => repos.programs.listByProject(projectId, { offset }));
  const samples = await drain((offset) => repos.samples.listByProject(projectId, { offset }));
  const songEntries = await repos.songs.listByProject(projectId);

  const tracks = [];
  for (const sequence of sequences) {
    tracks.push(...(await drain((offset) => repos.tracks.listBySequence(sequence.id, { offset }))));
  }

  const midiEvents = [];
  for (const track of tracks) {
    midiEvents.push(...(await drain((offset) => repos.midiEvents.listByTrack(track.id, { offset }))));
  }

  const automation: AutomationPointRow[] = [];
  for (const sequence of sequences) {
    automation.push(
      ...(await drain((offset) => repos.automation.listByOwner('sequence', sequence.id, { offset }))),
    );
  }
  for (const track of tracks) {
    automation.push(
      ...(await drain((offset) => repos.automation.listByOwner('track', track.id, { offset }))),
    );
  }

  return { version: 1, project, sequences, tracks, midiEvents, automation, programs, samples, songEntries };
}

/**
 * Insert a snapshot's rows into the database in foreign-key order (spec §9.6 import).
 *
 * ONE transaction, not a statement per row: §9.6 requires import to be transactional, and a
 * failure part-way through a sequence of separately-awaited writes would leave the project row,
 * its programs, sequences, tracks and events committed — listed in Main mode's recent projects
 * and openable in a state the archive never described. Declining to OPEN the new project does
 * not undo rows already written, so the atomicity has to come from the driver.
 *
 * Every statement is built by the repository that owns its table (spec §3.1: no SQL outside
 * `storage/repositories`); this function only orders them and hands the batch to the driver.
 *
 * `alsoInsert` carries rows an install needs committed with the snapshot but which the snapshot
 * itself cannot describe — the global-library sample rows a shared install adds (spec §9.8),
 * whose `project_id` is NULL and so belongs to no project's row set. They run first, before the
 * project row, because nothing in the snapshot references them by foreign key.
 */
export async function restoreSnapshot(
  repos: Repositories,
  snapshot: ProjectSnapshot,
  alsoInsert: readonly SqlStatement[] = [],
): Promise<void> {
  const p = snapshot.project;
  await repos.driver.transaction([
    ...alsoInsert,

    repos.projects.insertStatement({
      id: p.id,
      name: p.name,
      sample_rate: p.sample_rate,
      bit_depth: p.bit_depth,
      bpm_default: p.bpm_default,
      insert_limit: p.insert_limit,
      payload: p.payload,
    }),

    ...snapshot.programs.map((program) =>
      repos.programs.insertStatement({
        id: program.id,
        project_id: program.project_id,
        name: program.name,
        type: program.type,
        payload: program.payload,
      }),
    ),

    ...snapshot.sequences.map((sequence) =>
      repos.sequences.insertStatement({
        id: sequence.id,
        project_id: sequence.project_id,
        position: sequence.position,
        name: sequence.name,
        length_bars: sequence.length_bars,
        time_sig_numerator: sequence.time_sig_numerator,
        time_sig_denominator: sequence.time_sig_denominator,
        tempo: sequence.tempo,
        swing_amount: sequence.swing_amount,
        swing_division: sequence.swing_division,
      }),
    ),

    ...snapshot.tracks.map((track) =>
      repos.tracks.insertStatement({
        id: track.id,
        sequence_id: track.sequence_id,
        program_id: track.program_id,
        position: track.position,
        name: track.name,
        type: track.type,
        mixer: track.mixer,
      }),
    ),

    ...repos.midiEvents.insertStatements(
      snapshot.midiEvents.map((e) => ({
        id: e.id,
        track_id: e.track_id,
        tick_start: e.tick_start,
        duration_ticks: e.duration_ticks,
        note: e.note,
        velocity: e.velocity,
        extra: e.extra,
      })),
    ),

    ...repos.automation.insertStatements(
      snapshot.automation.map((a) => ({
        id: a.id,
        scope: a.scope,
        owner_id: a.owner_id,
        target_path: a.target_path,
        tick: a.tick,
        value: a.value,
        curve: a.curve,
      })),
    ),

    ...snapshot.samples.map((sample) =>
      repos.samples.insertStatement({
        id: sample.id,
        project_id: sample.project_id,
        name: sample.name,
        opfs_path: sample.opfs_path,
        frames: sample.frames,
        sample_rate: sample.sample_rate,
        channels: sample.channels,
        root_note: sample.root_note,
      }),
    ),

    ...repos.songs.replaceStatements(
      p.id,
      snapshot.songEntries.map((entry) => ({
        id: entry.id,
        sequence_id: entry.sequence_id,
        repeats: entry.repeats,
      })),
    ),
  ]);
}
