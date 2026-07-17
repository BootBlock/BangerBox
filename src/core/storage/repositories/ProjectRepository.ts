/**
 * Project persistence (spec §9.2, §9.3 `projects`).
 */
import { DbError } from '../errors';
import { BaseRepository } from './base';
import type { BitDepth, Page, PageParams, ProjectRow } from './types';

export interface ProjectCreate {
  readonly id?: string;
  readonly name: string;
  readonly sample_rate?: number;
  readonly bit_depth?: BitDepth;
  readonly bpm_default?: number;
  readonly insert_limit?: number;
  readonly payload?: string;
}

export interface ProjectSettingsPatch {
  readonly name?: string;
  readonly sample_rate?: number;
  readonly bit_depth?: BitDepth;
  readonly bpm_default?: number;
  readonly insert_limit?: number;
  readonly payload?: string;
}

const SETTINGS_COLUMNS = [
  'name',
  'sample_rate',
  'bit_depth',
  'bpm_default',
  'insert_limit',
  'payload',
] as const;

export class ProjectRepository extends BaseRepository {
  /** Insert a new project (defaults per the §9.3 DDL) and return its row. */
  async create(input: ProjectCreate): Promise<ProjectRow> {
    const id = input.id ?? crypto.randomUUID();
    const now = Date.now();
    await this.driver.execute(
      `INSERT INTO projects (id, name, created_at, modified_at, sample_rate, bit_depth, bpm_default, insert_limit, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        id,
        input.name,
        now,
        now,
        input.sample_rate ?? 48000, // spec §1.3 #18
        input.bit_depth ?? '24',
        input.bpm_default ?? 120,
        input.insert_limit ?? 4,
        input.payload ?? '{}',
      ],
    );
    return this.require(id);
  }

  getById(id: string): Promise<ProjectRow | undefined> {
    return this.driver.queryOne<ProjectRow>('SELECT * FROM projects WHERE id = ?;', [id]);
  }

  /** Most recently modified first — the Main-mode recent-projects list (spec §8.5.1). */
  async listRecent(page: PageParams = {}): Promise<Page<ProjectRow>> {
    const { limit, offset } = this.resolvePage(page);
    const rows = await this.driver.query<ProjectRow>(
      'SELECT * FROM projects ORDER BY modified_at DESC LIMIT ? OFFSET ?;',
      [limit, offset],
    );
    return this.toPage(rows, limit, offset);
  }

  /** Patch name/audio settings/payload, stamping modified_at. */
  async update(id: string, patch: ProjectSettingsPatch): Promise<ProjectRow> {
    const { clause, params } = this.buildSet(patch, SETTINGS_COLUMNS);
    if (clause.length === 0) return this.require(id);
    await this.driver.execute(`UPDATE projects SET ${clause}, modified_at = ? WHERE id = ?;`, [
      ...params,
      Date.now(),
      id,
    ]);
    return this.require(id);
  }

  /** Stamp modified_at (autosave marks the project dirty via its entities). */
  async touch(id: string, at = Date.now()): Promise<void> {
    await this.driver.execute('UPDATE projects SET modified_at = ? WHERE id = ?;', [at, id]);
  }

  /** Delete the project; §9.3 cascades remove all dependent rows. */
  async remove(id: string): Promise<void> {
    await this.driver.execute('DELETE FROM projects WHERE id = ?;', [id]);
  }

  private async require(id: string): Promise<ProjectRow> {
    const row = await this.getById(id);
    if (!row) throw new DbError('SQLITE_ERROR', `Project ${id} not found.`);
    return row;
  }
}
