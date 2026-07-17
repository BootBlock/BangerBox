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

export { AutomationRepository } from './AutomationRepository';
export { MidiEventRepository } from './MidiEventRepository';
export { ProgramRepository } from './ProgramRepository';
export { ProjectRepository } from './ProjectRepository';
export { SampleRepository } from './SampleRepository';
export { SequenceRepository } from './SequenceRepository';
export { SettingsRepository } from './SettingsRepository';
export { SongRepository } from './SongRepository';
export { TrackRepository } from './TrackRepository';
export type * from './types';
