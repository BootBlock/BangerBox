/**
 * Autosave persistence (spec §4.4). Turns a batch of dirty keys (spec §4.4 dirtyKey
 * builders) into repository writes from the current store state. Structural entities
 * upsert-or-delete (the store is the source of runtime truth, spec §1.3 #16); event,
 * automation and song lanes use the repositories' atomic replace so a flush is
 * idempotent and safe to retry (spec §4.4). Keys are ordered by foreign-key dependency
 * so a new sequence lands before its track.
 */
import type {
  ProgramCreate,
  Repositories,
  SequenceCreate,
  SequencePatch,
  TrackCreate,
  TrackPatch,
} from '@/core/storage/repositories';
import { useHardwareStore, useMixerStore, useProgramStore, useProjectStore, useSequenceStore } from '@/store';
import { projectPayloadSchema, type ChannelStrip, type MidiEvent, type Sequence } from './schemas';

/** Foreign-key-safe ordering: parents before children (spec §9.3 cascades). */
const KIND_RANK: Record<string, number> = {
  project: 0,
  program: 1,
  sequence: 2,
  track: 3,
  events: 4,
  automation: 5,
  song: 6,
  settings: 7,
};

export async function flushDirtyKeys(repositories: Repositories, keys: readonly string[]): Promise<void> {
  const ordered = [...keys].sort(
    (a, b) => (KIND_RANK[a.split(':')[0]!] ?? 99) - (KIND_RANK[b.split(':')[0]!] ?? 99),
  );
  for (const key of ordered) await flushOne(repositories, key);
}

async function flushOne(repositories: Repositories, key: string): Promise<void> {
  const colon = key.indexOf(':');
  const kind = key.slice(0, colon);
  const rest = key.slice(colon + 1);
  switch (kind) {
    case 'project':
      return flushProject(repositories, rest);
    case 'program':
      return flushProgram(repositories, rest);
    case 'sequence':
      return flushSequence(repositories, rest);
    case 'track':
      return flushTrack(repositories, rest);
    case 'events':
      return flushEvents(repositories, rest);
    case 'automation':
      return flushAutomation(repositories, rest);
    case 'song':
      return flushSong(repositories, rest);
    case 'settings':
      return flushSettings(repositories, rest);
    default:
      return;
  }
}

// --- Project (settings + master/return payload) ----------------------------------
async function flushProject(repositories: Repositories, id: string): Promise<void> {
  const project = useProjectStore.getState();
  if (project.projectId !== id) return;
  const channels = useMixerStore.getState().channels;
  const returns: ChannelStrip[] = [0, 1, 2, 3]
    .map((index) => channels[`return:${index}`])
    .filter((strip): strip is ChannelStrip => strip !== undefined);
  const payload = projectPayloadSchema.parse({ master: channels.master, returns });
  await repositories.projects.update(id, {
    name: project.projectName,
    sample_rate: project.sampleRate,
    bit_depth: project.bitDepth,
    insert_limit: project.globalInsertLimit,
    payload: JSON.stringify(payload),
  });
}

// --- Programs --------------------------------------------------------------------
async function flushProgram(repositories: Repositories, id: string): Promise<void> {
  const program = useProgramStore.getState().programs[id];
  if (program === undefined) {
    await repositories.programs.remove(id);
    return;
  }
  const payload = JSON.stringify(program);
  const existing = await repositories.programs.getById(id);
  if (existing === undefined) {
    const create: ProgramCreate = {
      id,
      project_id: useProjectStore.getState().projectId,
      name: program.name,
      type: program.type,
      payload,
    };
    await repositories.programs.create(create);
  } else {
    await repositories.programs.update(id, { name: program.name, payload });
  }
}

// --- Sequences -------------------------------------------------------------------
function sequenceToCreate(sequence: Sequence): SequenceCreate {
  return {
    id: sequence.id,
    project_id: sequence.projectId,
    position: sequence.position,
    name: sequence.name,
    length_bars: sequence.lengthBars,
    time_sig_numerator: sequence.timeSig.numerator,
    time_sig_denominator: sequence.timeSig.denominator,
    tempo: sequence.tempo,
    swing_amount: sequence.swingAmount,
    swing_division: sequence.swingDivision,
  };
}

async function flushSequence(repositories: Repositories, id: string): Promise<void> {
  const sequence = useSequenceStore.getState().sequences[id];
  if (sequence === undefined) {
    await repositories.sequences.remove(id);
    return;
  }
  const existing = await repositories.sequences.getById(id);
  if (existing === undefined) {
    await repositories.sequences.create(sequenceToCreate(sequence));
  } else {
    const patch: SequencePatch = {
      position: sequence.position,
      name: sequence.name,
      length_bars: sequence.lengthBars,
      time_sig_numerator: sequence.timeSig.numerator,
      time_sig_denominator: sequence.timeSig.denominator,
      tempo: sequence.tempo,
      swing_amount: sequence.swingAmount,
      swing_division: sequence.swingDivision,
    };
    await repositories.sequences.update(id, patch);
  }
}

// --- Tracks (structure + mixer strip) --------------------------------------------
async function flushTrack(repositories: Repositories, id: string): Promise<void> {
  const track = useSequenceStore.getState().tracks[id];
  if (track === undefined) {
    await repositories.tracks.remove(id);
    return;
  }
  const strip = useMixerStore.getState().channels[`track:${id}`];
  const mixer = strip ? JSON.stringify(strip) : '{}';
  const existing = await repositories.tracks.getById(id);
  if (existing === undefined) {
    const create: TrackCreate = {
      id,
      sequence_id: track.sequenceId,
      program_id: track.programId,
      position: track.position,
      name: track.name,
      type: track.type,
      mixer,
    };
    await repositories.tracks.create(create);
  } else {
    const patch: TrackPatch = {
      program_id: track.programId,
      position: track.position,
      name: track.name,
      mixer,
    };
    await repositories.tracks.update(id, patch);
  }
}

// --- Events (atomic per-track replace — spec §4.4) -------------------------------
async function flushEvents(repositories: Repositories, trackId: string): Promise<void> {
  const events: readonly MidiEvent[] = useSequenceStore.getState().events[trackId] ?? [];
  await repositories.midiEvents.replaceTrack(
    trackId,
    events.map((event) => ({
      id: event.id,
      track_id: trackId,
      tick_start: event.tickStart,
      duration_ticks: event.durationTicks,
      note: event.note,
      velocity: event.velocity,
      extra: event.extra === null ? null : JSON.stringify(event.extra),
    })),
  );
}

// --- Automation (atomic per-lane replace) ----------------------------------------
async function flushAutomation(repositories: Repositories, rest: string): Promise<void> {
  const firstColon = rest.indexOf(':');
  const scope = rest.slice(0, firstColon) as 'sequence' | 'track';
  const afterScope = rest.slice(firstColon + 1);
  const secondColon = afterScope.indexOf(':');
  const ownerId = afterScope.slice(0, secondColon);
  const targetPath = afterScope.slice(secondColon + 1);
  const laneKey = `${scope}:${ownerId}:${targetPath}`;
  const points = useSequenceStore.getState().automation[laneKey] ?? [];
  await repositories.automation.replaceTarget(
    scope,
    ownerId,
    targetPath,
    points.map((point) => ({
      id: point.id,
      scope: point.scope,
      owner_id: point.ownerId,
      target_path: point.targetPath,
      tick: point.tick,
      value: point.value,
      curve: point.curve,
    })),
  );
}

// --- Song playlist (atomic replace) ----------------------------------------------
async function flushSong(repositories: Repositories, projectId: string): Promise<void> {
  const entries = useSequenceStore.getState().songEntries;
  await repositories.songs.replaceForProject(
    projectId,
    entries.map((entry) => ({ id: entry.id, sequence_id: entry.sequenceId, repeats: entry.repeats })),
  );
}

// --- Settings (e.g. per-mode Q-Link bindings — spec §10.3) -----------------------
async function flushSettings(repositories: Repositories, settingsKey: string): Promise<void> {
  if (settingsKey.startsWith('qlink:')) {
    await repositories.settings.set(settingsKey, JSON.stringify(useHardwareStore.getState().qLinkBindings));
  }
}
