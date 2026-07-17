/**
 * Track persistence (spec §9.2, §9.3 `tracks`).
 */
import { DbError } from '../errors';
import { BaseRepository } from './base';
import type { Page, PageParams, TrackRow } from './types';

export interface TrackCreate {
  readonly id?: string;
  readonly sequence_id: string;
  readonly program_id?: string | null;
  readonly position: number;
  readonly name: string;
  readonly type: TrackRow['type'];
  readonly mixer?: string;
}

export interface TrackPatch {
  readonly program_id?: string | null;
  readonly position?: number;
  readonly name?: string;
  readonly mixer?: string;
}

const PATCH_COLUMNS = ['program_id', 'position', 'name', 'mixer'] as const;

export class TrackRepository extends BaseRepository {
  async create(input: TrackCreate): Promise<TrackRow> {
    const id = input.id ?? crypto.randomUUID();
    await this.driver.execute(
      `INSERT INTO tracks (id, sequence_id, program_id, position, name, type, mixer)
       VALUES (?, ?, ?, ?, ?, ?, ?);`,
      [
        id,
        input.sequence_id,
        input.program_id ?? null,
        input.position,
        input.name,
        input.type,
        input.mixer ?? '{}',
      ],
    );
    return this.require(id);
  }

  getById(id: string): Promise<TrackRow | undefined> {
    return this.driver.queryOne<TrackRow>('SELECT * FROM tracks WHERE id = ?;', [id]);
  }

  /** All lanes of a sequence in display order (uses idx_tracks_sequence). */
  async listBySequence(sequenceId: string, page: PageParams = {}): Promise<Page<TrackRow>> {
    const { limit, offset } = this.resolvePage(page);
    const rows = await this.driver.query<TrackRow>(
      'SELECT * FROM tracks WHERE sequence_id = ? ORDER BY position LIMIT ? OFFSET ?;',
      [sequenceId, limit, offset],
    );
    return this.toPage(rows, limit, offset);
  }

  async update(id: string, patch: TrackPatch): Promise<TrackRow> {
    const { clause, params } = this.buildSet(patch, PATCH_COLUMNS);
    if (clause.length === 0) return this.require(id);
    await this.driver.execute(`UPDATE tracks SET ${clause} WHERE id = ?;`, [...params, id]);
    return this.require(id);
  }

  async remove(id: string): Promise<void> {
    await this.driver.execute('DELETE FROM tracks WHERE id = ?;', [id]);
  }

  private async require(id: string): Promise<TrackRow> {
    const row = await this.getById(id);
    if (!row) throw new DbError('SQLITE_ERROR', `Track ${id} not found.`);
    return row;
  }
}
