/**
 * Project lifecycle service registry (spec §4.2, §4.4). The lifecycle actions the
 * spec lists on `useProjectStore` (newProject/loadProject/saveNow/export/import) need
 * repositories, hydration and packing — which must not be imported by the store
 * (plain data only, spec §4.2). The store delegates to the implementation registered
 * here by the project-load layer at boot; the indirection keeps the store cycle-free.
 */
export interface ProjectService {
  /** Create a fresh project with defaults, persist it, hydrate the stores. Returns its id. */
  newProject(name?: string): Promise<string>;
  /** Load a project by id and hydrate all stores from the database (spec §4.4). */
  loadProject(id: string): Promise<void>;
  /** Flush autosave synchronously (spec §4.4 explicit save). */
  saveNow(): Promise<void>;
  /** Pack the open project to a `.mpcweb` blob (spec §9.6). */
  exportMpcweb(): Promise<Blob>;
  /** Import a `.mpcweb` file and open it (spec §9.6). Returns the new project id. */
  importMpcweb(file: File): Promise<string>;
}

let service: ProjectService | null = null;

export function registerProjectService(implementation: ProjectService): void {
  service = implementation;
}

export function getProjectService(): ProjectService {
  if (service === null) {
    throw new Error('BangerBox: project service not registered — boot the project layer first.');
  }
  return service;
}
