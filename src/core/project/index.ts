/**
 * Project layer barrel (spec §2.5 `core/project` — autosave, load/hydrate, `.mpcweb`
 * pack/unpack).
 */
export { AutosaveQueue } from './autosave';
export { registerAutosave, unregisterAutosave, markDirty, dirtyKey } from './dirty';
export { hydrateStores } from './hydrate';
export { flushDirtyKeys } from './persist';
export {
  projectService,
  installProjectService,
  loadOrCreateActiveProject,
  closeActiveProject,
  getActiveRepositories,
} from './projectService';
export { getProjectService, registerProjectService, type ProjectService } from './service';
export {
  fetchFactoryCatalogue,
  installFactoryPack,
  isPackCached,
  describeInstall,
  reportInstallFailure,
  FactoryStorageError,
} from './factoryService';
export {
  parseFactoryCatalogue,
  type FactoryCatalogue,
  type FactoryPack,
  type FactoryPackKind,
} from './factoryCatalogue';
export {
  startProjectSession,
  stopProjectSession,
  startAudioEngine,
  getAudioEngine,
  ProjectSessionBootError,
} from './session';
