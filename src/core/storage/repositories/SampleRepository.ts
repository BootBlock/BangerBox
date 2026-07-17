/**
 * Sample metadata persistence (spec §9.2, §9.3 `samples` + `sample_tags`).
 *
 * Audio bytes live in OPFS (spec §9.1); only metadata rows live here. Browser-mode
 * queries page at 200 rows (spec §9.2).
 */
import { DbError } from '../errors';
import { BaseRepository } from './base';
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

export class SampleRepository extends BaseRepository {
  async create(input: SampleCreate): Promise<SampleRow> {
    const id = input.id ?? crypto.randomUUID();
    await this.driver.execute(
      `INSERT INTO samples (id, project_id, name, opfs_path, frames, sample_rate, channels, root_note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        id,
        input.project_id ?? null,
        input.name,
        input.opfs_path,
        input.frames,
        input.sample_rate,
        input.channels,
        input.root_note ?? 60,
        Date.now(),
      ],
    );
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
