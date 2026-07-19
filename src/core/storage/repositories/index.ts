/**
 * Repository registry (spec §9.2 — repositories are the only RPC clients).
 *
 * `createRepositories(driver)` binds the full set to one driver: production
 * passes the worker bridge; unit tests pass the in-memory driver (spec §11.3).
 */
import type { IDatabaseDriver } from '../driver';
import { AutomationRepository } from './AutomationRepository';
import { MidiEventRepository } from './MidiEventRepository';
import { ProgramRepository } from './ProgramRepository';
import { ProjectRepository } from './ProjectRepository';
import { SampleRepository } from './SampleRepository';
import { SequenceRepository } from './SequenceRepository';
import { SettingsRepository } from './SettingsRepository';
import { SongRepository } from './SongRepository';
import { TrackRepository } from './TrackRepository';

export interface Repositories {
  /**
   * The driver the set is bound to, exposed ONLY so a caller can run statements built by
   * several repositories inside one transaction — `.mpcweb` import, whose restore spans
   * every table and must leave no partial project (spec §9.6).
   *
   * Not a general escape hatch: SQL still lives exclusively in this directory (spec §3.1),
   * so callers assemble `insertStatement`/`replaceStatements` results and never write their
   * own. Anything that fits inside one repository belongs on that repository instead.
   */
  readonly driver: IDatabaseDriver;
  readonly projects: ProjectRepository;
  readonly sequences: SequenceRepository;
  readonly tracks: TrackRepository;
  readonly midiEvents: MidiEventRepository;
  readonly automation: AutomationRepository;
  readonly programs: ProgramRepository;
  readonly samples: SampleRepository;
  readonly songs: SongRepository;
  readonly settings: SettingsRepository;
}

export function createRepositories(driver: IDatabaseDriver): Repositories {
  return {
    driver,
    projects: new ProjectRepository(driver),
    sequences: new SequenceRepository(driver),
    tracks: new TrackRepository(driver),
    midiEvents: new MidiEventRepository(driver),
    automation: new AutomationRepository(driver),
    programs: new ProgramRepository(driver),
    samples: new SampleRepository(driver),
    songs: new SongRepository(driver),
    settings: new SettingsRepository(driver),
  };
}

export { AutomationRepository, type AutomationPointCreate } from './AutomationRepository';
export { MidiEventRepository, type MidiEventCreate } from './MidiEventRepository';
export { ProgramRepository, type ProgramCreate, type ProgramPatch } from './ProgramRepository';
export { ProjectRepository, type ProjectCreate, type ProjectSettingsPatch } from './ProjectRepository';
export { SampleRepository, type SampleCreate } from './SampleRepository';
export { SequenceRepository, type SequenceCreate, type SequencePatch } from './SequenceRepository';
export { SettingsRepository } from './SettingsRepository';
export { SongRepository, type SongEntryCreate } from './SongRepository';
export { TrackRepository, type TrackCreate, type TrackPatch } from './TrackRepository';
export type * from './types';
