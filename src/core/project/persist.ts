/**
 * Autosave persistence (spec §4.4). Turns a batch of dirty keys (spec §4.4 dirtyKey
 * builders) into repository writes from the current store state. Structural entities
 * upsert-or-delete (the store is the source of runtime truth, spec §1.3 #16); event,
 * automation and song lanes use the repositories' atomic replace so a flush is
 * idempotent and safe to retry (spec §4.4). Keys are ordered by foreign-key dependency
 * so a new sequence lands before its track.
 *
 * Resolving is this module's assertion that the batch reached storage — the autosave queue
 * clears the unsaved dot on it. So a key no path here can write rejects with
 * `UnflushableKeyError` rather than falling through to a silent success.
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
import { UnflushableKeyError } from './autosave';
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

/**
 * Write every dirty key, then report any the flush layer could not handle.
 *
 * Unwritable keys do not abort the batch: the keys around them are real work that can and
 * should land. They are collected and rethrown as one {@link UnflushableKeyError} at the
 * end so the queue withholds `onIdle` — resolving here would tell the user their work is
 * saved when part of it was never attempted (spec §4.4).
 */
export async function flushDirtyKeys(repositories: Repositories, keys: readonly string[]): Promise<void> {
  const ordered = [...keys].sort(
    (a, b) => (KIND_RANK[a.split(':')[0]!] ?? 99) - (KIND_RANK[b.split(':')[0]!] ?? 99),
  );
  const unflushable: string[] = [];
  for (const key of ordered) {
    try {
      await flushOne(repositories, key);
    } catch (error) {
      if (!(error instanceof UnflushableKeyError)) throw error; // transient: the queue retries the batch
      unflushable.push(key);
    }
  }
  if (unflushable.length > 0) {
    throw new UnflushableKeyError(unflushable, 'No autosave path could write these entities');
  }
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
      throw new UnflushableKeyError([key], `Unknown dirty-key kind '${kind}'`);
  }
}

// --- Project (settings + master/return payload) ----------------------------------
async function flushProject(repositories: Repositories, id: string): Promise<void> {
  const project = useProjectStore.getState();
  // The store has moved on to another project, so it no longer holds this one's state to
  // write. Nothing can recover the edit here — say so rather than reporting it saved.
  if (project.projectId !== id) {
    throw new UnflushableKeyError([`project:${id}`], 'Project is no longer the active project');
  }
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
  if (!settingsKey.startsWith('qlink:')) {
    // Q-Link bindings are the only settings any store marks dirty today. A different
    // `settings:` key means a new writer shipped without a flush path to match it, and
    // silently resolving would hide that behind a cleared unsaved dot.
    throw new UnflushableKeyError([`settings:${settingsKey}`], 'No flush path for this settings key');
  }
  await repositories.settings.set(settingsKey, JSON.stringify(useHardwareStore.getState().qLinkBindings));
}
