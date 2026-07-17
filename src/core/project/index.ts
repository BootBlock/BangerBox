/**
 * Project layer barrel (spec §2.5 `core/project` — autosave, load/hydrate; `.mpcweb`
 * pack/unpack arrives in Phase 6).
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
} from './projectService';
export { getProjectService, registerProjectService, type ProjectService } from './service';
