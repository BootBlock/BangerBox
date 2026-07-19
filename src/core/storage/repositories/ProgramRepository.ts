/**
 * Program persistence (spec §9.2, §9.3 `programs`).
 *
 * Payloads are opaque JSON here; the §6 DrumProgram/KeygroupProgram Zod schemas
 * validate them at hydration (spec §4.4).
 */
import { DbError } from '../errors';
import { BaseRepository } from './base';
import type { SqlStatement } from '../driver';
import type { Page, PageParams, ProgramRow } from './types';

export interface ProgramCreate {
  readonly id?: string;
  readonly project_id: string;
  readonly name: string;
  readonly type: ProgramRow['type'];
  readonly payload: string;
}

export interface ProgramPatch {
  readonly name?: string;
  readonly payload?: string;
}

const PATCH_COLUMNS = ['name', 'payload'] as const;

const INSERT_SQL = 'INSERT INTO programs (id, project_id, name, type, payload) VALUES (?, ?, ?, ?, ?);';

export class ProgramRepository extends BaseRepository {
  /** The insert as an unexecuted statement, for cross-table batches (see ProjectRepository). */
  insertStatement(input: ProgramCreate & { readonly id: string }): SqlStatement {
    return {
      sql: INSERT_SQL,
      params: [input.id, input.project_id, input.name, input.type, input.payload],
    };
  }

  async create(input: ProgramCreate): Promise<ProgramRow> {
    const id = input.id ?? crypto.randomUUID();
    const { sql, params } = this.insertStatement({ ...input, id });
    await this.driver.execute(sql, params);
    return this.require(id);
  }

  getById(id: string): Promise<ProgramRow | undefined> {
    return this.driver.queryOne<ProgramRow>('SELECT * FROM programs WHERE id = ?;', [id]);
  }

  /**
   * Every program payload in the database, across all projects — the reference set "Purge
   * unused samples" tests a global-library sample against (spec §8.5.7, §9.8).
   *
   * Deliberately UNPAGED, unlike every other list here. Purge deletes what this does not
   * mention, so a payload missed because it fell past a page boundary is a sample deleted out
   * from under a project that still uses it. Only the payload text is selected, since that is
   * all the reference test reads.
   */
  async allPayloads(): Promise<string[]> {
    const rows = await this.driver.query<{ payload: string }>('SELECT payload FROM programs;');
    return rows.map((row) => row.payload);
  }

  async listByProject(projectId: string, page: PageParams = {}): Promise<Page<ProgramRow>> {
    const { limit, offset } = this.resolvePage(page);
    const rows = await this.driver.query<ProgramRow>(
      'SELECT * FROM programs WHERE project_id = ? ORDER BY name, id LIMIT ? OFFSET ?;',
      [projectId, limit, offset],
    );
    return this.toPage(rows, limit, offset);
  }

  async update(id: string, patch: ProgramPatch): Promise<ProgramRow> {
    const { clause, params } = this.buildSet(patch, PATCH_COLUMNS);
    if (clause.length === 0) return this.require(id);
    await this.driver.execute(`UPDATE programs SET ${clause} WHERE id = ?;`, [...params, id]);
    return this.require(id);
  }

  /** Delete the program; §9.3 sets referencing tracks' program_id to NULL. */
  async remove(id: string): Promise<void> {
    await this.driver.execute('DELETE FROM programs WHERE id = ?;', [id]);
  }

  private async require(id: string): Promise<ProgramRow> {
    const row = await this.getById(id);
    if (!row) throw new DbError('SQLITE_ERROR', `Program ${id} not found.`);
    return row;
  }
}
