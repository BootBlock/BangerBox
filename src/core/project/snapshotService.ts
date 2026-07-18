/**
 * Project snapshot dump/restore (spec §9.6) — turns the repository rows of one project into a
 * {@link ProjectSnapshot} for export, and writes a snapshot's rows back for import. All reads
 * page at the repository limit and drain fully (spec §9.2). Restore inserts in foreign-key order
 * (project → programs → sequences → tracks → events → automation → samples → song). Import
 * always feeds a UUID-remapped snapshot ({@link remapSnapshot}) so copies never collide (§9.6).
 */
import type { Repositories } from '@/core/storage/repositories';
import type { AutomationPointRow, Page } from '@/core/storage/repositories';
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
    automation.push(...(await drain((offset) => repos.automation.listByOwner('sequence', sequence.id, { offset }))));
  }
  for (const track of tracks) {
    automation.push(...(await drain((offset) => repos.automation.listByOwner('track', track.id, { offset }))));
  }

  return { version: 1, project, sequences, tracks, midiEvents, automation, programs, samples, songEntries };
}

/** Insert a snapshot's rows into the database in foreign-key order (spec §9.6 import). */
export async function restoreSnapshot(repos: Repositories, snapshot: ProjectSnapshot): Promise<void> {
  const p = snapshot.project;
  await repos.projects.create({
    id: p.id,
    name: p.name,
    sample_rate: p.sample_rate,
    bit_depth: p.bit_depth,
    bpm_default: p.bpm_default,
    insert_limit: p.insert_limit,
    payload: p.payload,
  });

  for (const program of snapshot.programs) {
    await repos.programs.create({
      id: program.id,
      project_id: program.project_id,
      name: program.name,
      type: program.type,
      payload: program.payload,
    });
  }

  for (const sequence of snapshot.sequences) {
    await repos.sequences.create({
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
    });
  }

  for (const track of snapshot.tracks) {
    await repos.tracks.create({
      id: track.id,
      sequence_id: track.sequence_id,
      program_id: track.program_id,
      position: track.position,
      name: track.name,
      type: track.type,
      mixer: track.mixer,
    });
  }

  await repos.midiEvents.insertMany(
    snapshot.midiEvents.map((e) => ({
      id: e.id,
      track_id: e.track_id,
      tick_start: e.tick_start,
      duration_ticks: e.duration_ticks,
      note: e.note,
      velocity: e.velocity,
      extra: e.extra,
    })),
  );

  await repos.automation.insertMany(
    snapshot.automation.map((a) => ({
      id: a.id,
      scope: a.scope,
      owner_id: a.owner_id,
      target_path: a.target_path,
      tick: a.tick,
      value: a.value,
      curve: a.curve,
    })),
  );

  for (const sample of snapshot.samples) {
    await repos.samples.create({
      id: sample.id,
      project_id: sample.project_id,
      name: sample.name,
      opfs_path: sample.opfs_path,
      frames: sample.frames,
      sample_rate: sample.sample_rate,
      channels: sample.channels,
      root_note: sample.root_note,
    });
  }

  await repos.songs.replaceForProject(
    p.id,
    snapshot.songEntries.map((entry) => ({ id: entry.id, sequence_id: entry.sequence_id, repeats: entry.repeats })),
  );
}
