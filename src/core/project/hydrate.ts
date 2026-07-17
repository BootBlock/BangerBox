/**
 * Project hydration (spec §4.4). Reads every row for a project via the repositories,
 * maps and Zod-validates it (spec §6), and populates the runtime stores in the DB →
 * store order (spec §4.4; the graph and UI hydrate in later phases). Reads page through
 * the 200-row ceiling (spec §9.2). A failure propagates so the caller falls to Safe
 * Mode rather than a white screen (spec §8.1).
 */
import {
  automationLaneKey,
  createDefaultChannelStrip,
  type AutomationPoint,
  type ChannelStrip,
  type MidiEvent,
  type Program,
  type Sequence,
  type Track,
} from './schemas';
import {
  parseProjectPayload,
  rowToAutomationPoint,
  rowToMidiEvent,
  rowToProgram,
  rowToProjectSettings,
  rowToSequence,
  rowToSongEntry,
  rowToTrack,
  parseTrackMixer,
} from './mappers';
import type { Page, Repositories, SampleRow } from '@/core/storage/repositories';
import {
  clearUndoHistory,
  useBrowserStore,
  useMixerStore,
  useProgramStore,
  useProjectStore,
  useSequenceStore,
  useTransportStore,
} from '@/store';

/** Read every page of a bounded list (spec §9.2 pages at 200 rows). */
async function collectPages<T>(fetch: (offset: number) => Promise<Page<T>>): Promise<T[]> {
  const rows: T[] = [];
  let offset = 0;
  for (;;) {
    const page = await fetch(offset);
    rows.push(...page.rows);
    if (!page.hasMore) break;
    offset += page.limit;
  }
  return rows;
}

export async function hydrateStores(repositories: Repositories, projectId: string): Promise<void> {
  const projectRow = await repositories.projects.getById(projectId);
  if (projectRow === undefined) throw new Error(`BangerBox: project ${projectId} not found for hydration.`);

  const payload = parseProjectPayload(projectRow.payload);

  // Programs.
  const programRows = await collectPages((offset) =>
    repositories.programs.listByProject(projectId, { offset }),
  );
  const programs: Record<string, Program> = {};
  for (const row of programRows) programs[row.id] = rowToProgram(row);

  // Sequences.
  const sequenceRows = await collectPages((offset) =>
    repositories.sequences.listByProject(projectId, { offset }),
  );
  const sequences: Record<string, Sequence> = {};
  for (const row of sequenceRows) sequences[row.id] = rowToSequence(row);

  // Mixer: master + 4 returns (project payload) and one strip per track.
  const channels: Record<string, ChannelStrip> = {
    master: payload.master ?? createDefaultChannelStrip('master'),
  };
  for (let index = 0; index < 4; index += 1) {
    channels[`return:${index}`] = payload.returns?.[index] ?? createDefaultChannelStrip(`return:${index}`);
  }

  // Tracks, their events, and both automation scopes.
  const tracks: Record<string, Track> = {};
  const events: Record<string, MidiEvent[]> = {};
  const automation: Record<string, AutomationPoint[]> = {};

  const pushLane = (
    scope: AutomationPoint['scope'],
    ownerId: string,
    targetPath: string,
    point: AutomationPoint,
  ) => {
    (automation[automationLaneKey(scope, ownerId, targetPath)] ??= []).push(point);
  };

  for (const seqRow of sequenceRows) {
    const trackRows = await collectPages((offset) =>
      repositories.tracks.listBySequence(seqRow.id, { offset }),
    );
    for (const trackRow of trackRows) {
      tracks[trackRow.id] = rowToTrack(trackRow);
      const channelId = `track:${trackRow.id}`;
      channels[channelId] = parseTrackMixer(trackRow.mixer, channelId);

      const eventRows = await collectPages((offset) =>
        repositories.midiEvents.listByTrack(trackRow.id, { offset }),
      );
      events[trackRow.id] = eventRows.map(rowToMidiEvent);

      const trackAuto = await collectPages((offset) =>
        repositories.automation.listByOwner('track', trackRow.id, { offset }),
      );
      for (const row of trackAuto) {
        pushLane('track', row.owner_id, row.target_path, rowToAutomationPoint(row));
      }
    }

    const seqAuto = await collectPages((offset) =>
      repositories.automation.listByOwner('sequence', seqRow.id, { offset }),
    );
    for (const row of seqAuto) pushLane('sequence', row.owner_id, row.target_path, rowToAutomationPoint(row));
  }

  const songEntries = (await repositories.songs.listByProject(projectId)).map(rowToSongEntry);
  const sampleRows: SampleRow[] = await collectPages((offset) =>
    repositories.samples.listByProject(projectId, { offset }),
  );

  // Populate stores (DB → store — spec §4.4).
  useProjectStore.getState().applyProject(rowToProjectSettings(projectRow));
  useProgramStore.getState().setPrograms(programs);
  useProgramStore.getState().setActiveProgram(programRows[0]?.id ?? null);
  useSequenceStore.getState().hydrate({ sequences, tracks, events, automation, songEntries });
  useMixerStore.getState().setChannels(channels);
  useBrowserStore.getState().setSamples(sampleRows);

  const activeSeq = sequenceRows[0] ? rowToSequence(sequenceRows[0]) : null;
  const transport = useTransportStore.getState();
  transport.setActiveSequenceId(activeSeq?.id ?? null);
  transport.setBpm(activeSeq?.tempo ?? projectRow.bpm_default);
  if (activeSeq) transport.setSwing(activeSeq.swingAmount, activeSeq.swingDivision);

  // A freshly loaded project starts with an empty undo timeline and a clean dot (spec §4.4).
  clearUndoHistory();
  useProjectStore.getState().setModified(false);
}
