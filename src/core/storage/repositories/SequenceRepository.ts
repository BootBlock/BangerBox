/**
 * Sequence persistence (spec §9.2, §9.3 `sequences`).
 */
import { DbError } from '../errors';
import { BaseRepository } from './base';
import type { Page, PageParams, SequenceRow } from './types';

export interface SequenceCreate {
  readonly id?: string;
  readonly project_id: string;
  readonly position: number;
  readonly name: string;
  readonly length_bars?: number;
  readonly time_sig_numerator?: number;
  readonly time_sig_denominator?: number;
  readonly tempo?: number | null;
  readonly swing_amount?: number;
  readonly swing_division?: number;
}

export interface SequencePatch {
  readonly position?: number;
  readonly name?: string;
  readonly length_bars?: number;
  readonly time_sig_numerator?: number;
  readonly time_sig_denominator?: number;
  readonly tempo?: number | null;
  readonly swing_amount?: number;
  readonly swing_division?: number;
}

const PATCH_COLUMNS = [
  'position',
  'name',
  'length_bars',
  'time_sig_numerator',
  'time_sig_denominator',
  'tempo',
  'swing_amount',
  'swing_division',
] as const;

export class SequenceRepository extends BaseRepository {
  async create(input: SequenceCreate): Promise<SequenceRow> {
    const id = input.id ?? crypto.randomUUID();
    await this.driver.execute(
      `INSERT INTO sequences (id, project_id, position, name, length_bars, time_sig_numerator, time_sig_denominator, tempo, swing_amount, swing_division)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        id,
        input.project_id,
        input.position,
        input.name,
        input.length_bars ?? 2,
        input.time_sig_numerator ?? 4,
        input.time_sig_denominator ?? 4,
        input.tempo ?? null,
        input.swing_amount ?? 50,
        input.swing_division ?? 16,
      ],
    );
    return this.require(id);
  }

  getById(id: string): Promise<SequenceRow | undefined> {
    return this.driver.queryOne<SequenceRow>('SELECT * FROM sequences WHERE id = ?;', [id]);
  }

  /** All sequences of a project in arrangement order (uses idx_sequences_project). */
  async listByProject(projectId: string, page: PageParams = {}): Promise<Page<SequenceRow>> {
    const { limit, offset } = this.resolvePage(page);
    const rows = await this.driver.query<SequenceRow>(
      'SELECT * FROM sequences WHERE project_id = ? ORDER BY position LIMIT ? OFFSET ?;',
      [projectId, limit, offset],
    );
    return this.toPage(rows, limit, offset);
  }

  async update(id: string, patch: SequencePatch): Promise<SequenceRow> {
    // `tempo: null` is a meaningful write (follow the project default — spec §7.2),
    // so nulls pass through buildSet's undefined filter unchanged.
    const { clause, params } = this.buildSet(patch, PATCH_COLUMNS);
    if (clause.length === 0) return this.require(id);
    await this.driver.execute(`UPDATE sequences SET ${clause} WHERE id = ?;`, [...params, id]);
    return this.require(id);
  }

  async remove(id: string): Promise<void> {
    await this.driver.execute('DELETE FROM sequences WHERE id = ?;', [id]);
  }

  private async require(id: string): Promise<SequenceRow> {
    const row = await this.getById(id);
    if (!row) throw new DbError('SQLITE_ERROR', `Sequence ${id} not found.`);
    return row;
  }
}
