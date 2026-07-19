/**
 * Sample metadata persistence (spec §9.2, §9.3 `samples` + `sample_tags`).
 *
 * Audio bytes live in OPFS (spec §9.1); only metadata rows live here. Browser-mode
 * queries page at 200 rows (spec §9.2).
 */
import { DbError } from '../errors';
import { BaseRepository } from './base';
import type { SqlStatement } from '../driver';
import type { Page, PageParams, SampleRow } from './types';

export interface SampleCreate {
  readonly id?: string;
  /** null = global library (spec §9.3). */
  readonly project_id?: string | null;
  readonly name: string;
  readonly opfs_path: string;
  readonly frames: number;
  readonly sample_rate: number;
  readonly channels: 1 | 2;
  readonly root_note?: number;
}

const INSERT_SQL = `INSERT INTO samples (id, project_id, name, opfs_path, frames, sample_rate, channels, root_note, created_at)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`;

export class SampleRepository extends BaseRepository {
  /** The insert as an unexecuted statement, for cross-table batches (see ProjectRepository). */
  insertStatement(input: SampleCreate & { readonly id: string }): SqlStatement {
    return {
      sql: INSERT_SQL,
      params: [
        input.id,
        input.project_id ?? null,
        input.name,
        input.opfs_path,
        input.frames,
        input.sample_rate,
        input.channels,
        input.root_note ?? 60,
        Date.now(),
      ],
    };
  }

  async create(input: SampleCreate): Promise<SampleRow> {
    const id = input.id ?? crypto.randomUUID();
    const { sql, params } = this.insertStatement({ ...input, id });
    await this.driver.execute(sql, params);
    return this.require(id);
  }

  getById(id: string): Promise<SampleRow | undefined> {
    return this.driver.queryOne<SampleRow>('SELECT * FROM samples WHERE id = ?;', [id]);
  }

  /** A project's samples, newest first (Browser mode pages at 200 — spec §9.2). */
  async listByProject(projectId: string, page: PageParams = {}): Promise<Page<SampleRow>> {
    const { limit, offset } = this.resolvePage(page);
    const rows = await this.driver.query<SampleRow>(
      'SELECT * FROM samples WHERE project_id = ? ORDER BY created_at DESC, id LIMIT ? OFFSET ?;',
      [projectId, limit, offset],
    );
    return this.toPage(rows, limit, offset);
  }

  /** Global-library samples (project_id IS NULL), newest first. */
  async listGlobal(page: PageParams = {}): Promise<Page<SampleRow>> {
    const { limit, offset } = this.resolvePage(page);
    const rows = await this.driver.query<SampleRow>(
      'SELECT * FROM samples WHERE project_id IS NULL ORDER BY created_at DESC, id LIMIT ? OFFSET ?;',
      [limit, offset],
    );
    return this.toPage(rows, limit, offset);
  }

  /**
   * The global-library sample stored at `opfsPath`, if one is (spec §9.8 de-duplication).
   *
   * Global paths are content-addressed (`globalContentPath`), so this answers "are these exact
   * bytes already installed?" — the check that lets a second pack shipping the same audio reuse
   * the existing row instead of writing a duplicate. Scoped to `project_id IS NULL` so a
   * project-scoped row can never be mistaken for shared content.
   */
  getGlobalByPath(opfsPath: string): Promise<SampleRow | undefined> {
    return this.driver.queryOne<SampleRow>(
      'SELECT * FROM samples WHERE project_id IS NULL AND opfs_path = ?;',
      [opfsPath],
    );
  }

  /** Samples carrying a tag (Browser tag chips — uses idx_sample_tags_tag). */
  async listByTag(tag: string, page: PageParams = {}): Promise<Page<SampleRow>> {
    const { limit, offset } = this.resolvePage(page);
    const rows = await this.driver.query<SampleRow>(
      `SELECT s.* FROM samples s
       JOIN sample_tags st ON st.sample_id = s.id
       WHERE st.tag = ? ORDER BY s.created_at DESC, s.id LIMIT ? OFFSET ?;`,
      [tag, limit, offset],
    );
    return this.toPage(rows, limit, offset);
  }

  /** Atomically replace a sample's tag set. */
  async setTags(sampleId: string, tags: readonly string[]): Promise<void> {
    await this.driver.transaction([
      { sql: 'DELETE FROM sample_tags WHERE sample_id = ?;', params: [sampleId] },
      ...tags.map((tag) => ({
        sql: 'INSERT INTO sample_tags (sample_id, tag) VALUES (?, ?);',
        params: [sampleId, tag],
      })),
    ]);
  }

  async tagsFor(sampleId: string): Promise<string[]> {
    const rows = await this.driver.query<{ tag: string }>(
      'SELECT tag FROM sample_tags WHERE sample_id = ? ORDER BY tag;',
      [sampleId],
    );
    return rows.map((row) => row.tag);
  }

  /** Delete the metadata row (cascades tags); OPFS file removal is the caller's step. */
  async remove(id: string): Promise<void> {
    await this.driver.execute('DELETE FROM samples WHERE id = ?;', [id]);
  }

  private async require(id: string): Promise<SampleRow> {
    const row = await this.getById(id);
    if (!row) throw new DbError('SQLITE_ERROR', `Sample ${id} not found.`);
    return row;
  }
}
