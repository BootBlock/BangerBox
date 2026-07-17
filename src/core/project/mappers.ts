/**
 * Row ↔ domain mapping (spec §4.4 hydration). The repositories return raw snake_case
 * rows (spec §9.3); the stores hold the camelCase domain model (spec §4.2). JSON blobs
 * (program payloads, project payload, track mixer strips) are Zod-validated here — the
 * load/import boundary where §6 mandates validation. A malformed blob throws, and the
 * loader falls back to Safe Mode rather than a white screen (spec §4.4, §8.1).
 */
import {
  channelStripSchema,
  createDefaultChannelStrip,
  programSchema,
  projectPayloadSchema,
  type AutomationPoint,
  type ChannelStrip,
  type MidiEvent,
  type Program,
  type ProjectPayload,
  type Sequence,
  type SongEntry,
  type Track,
} from './schemas';
import type { ProjectSettings } from '@/store/useProjectStore';
import type {
  AutomationPointRow,
  MidiEventRow,
  ProgramRow,
  ProjectRow,
  SequenceRow,
  SongEntryRow,
  TrackRow,
} from '@/core/storage/repositories';

type TimeSigDenominator = Sequence['timeSig']['denominator'];
type SwingDivision = Sequence['swingDivision'];

export function rowToProjectSettings(row: ProjectRow): ProjectSettings {
  return {
    projectId: row.id,
    projectName: row.name,
    sampleRate: row.sample_rate,
    bitDepth: row.bit_depth,
    globalInsertLimit: row.insert_limit,
  };
}

export function parseProjectPayload(json: string): ProjectPayload {
  return projectPayloadSchema.parse(JSON.parse(json));
}

export function rowToSequence(row: SequenceRow): Sequence {
  return {
    id: row.id,
    projectId: row.project_id,
    position: row.position,
    name: row.name,
    lengthBars: row.length_bars,
    timeSig: {
      numerator: row.time_sig_numerator,
      denominator: row.time_sig_denominator as TimeSigDenominator,
    },
    tempo: row.tempo,
    swingAmount: row.swing_amount,
    swingDivision: row.swing_division as SwingDivision,
  };
}

export function rowToTrack(row: TrackRow): Track {
  return {
    id: row.id,
    sequenceId: row.sequence_id,
    programId: row.program_id,
    position: row.position,
    name: row.name,
    type: row.type,
  };
}

/**
 * A track's persisted mixer strip (spec §9.3 tracks.mixer). Fresh tracks store `'{}'`
 * (spec §9.3 default) — those hydrate to a neutral strip. The stored id is normalised
 * to the channel address so it can never drift from the track it belongs to.
 */
export function parseTrackMixer(json: string, channelId: string): ChannelStrip {
  const parsed = channelStripSchema.safeParse(JSON.parse(json));
  if (!parsed.success) return createDefaultChannelStrip(channelId);
  return { ...parsed.data, id: channelId };
}

export function rowToProgram(row: ProgramRow): Program {
  return programSchema.parse(JSON.parse(row.payload));
}

export function rowToMidiEvent(row: MidiEventRow): MidiEvent {
  return {
    id: row.id,
    tickStart: row.tick_start,
    durationTicks: row.duration_ticks,
    note: row.note,
    velocity: row.velocity,
    extra: row.extra === null ? null : (JSON.parse(row.extra) as Record<string, unknown>),
  };
}

export function rowToAutomationPoint(row: AutomationPointRow): AutomationPoint {
  return {
    id: row.id,
    scope: row.scope,
    ownerId: row.owner_id,
    targetPath: row.target_path,
    tick: row.tick,
    value: row.value,
    curve: row.curve,
  };
}

export function rowToSongEntry(row: SongEntryRow): SongEntry {
  return {
    id: row.id,
    position: row.position,
    sequenceId: row.sequence_id,
    repeats: row.repeats,
  };
}
