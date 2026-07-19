/**
 * Automation point persistence (spec §9.2, §9.3 `automation_points`, §7.8).
 */
import { BaseRepository } from './base';
import type { SqlStatement } from '../driver';
import type { AutomationPointRow, Page, PageParams } from './types';

export interface AutomationPointCreate {
  readonly id?: string;
  readonly scope: AutomationPointRow['scope'];
  readonly owner_id: string;
  readonly target_path: string;
  readonly tick: number;
  readonly value: number;
  readonly curve?: AutomationPointRow['curve'];
}

const INSERT_SQL = `INSERT INTO automation_points (id, scope, owner_id, target_path, tick, value, curve)
 VALUES (?, ?, ?, ?, ?, ?, ?);`;

function insertStatement(point: AutomationPointCreate): SqlStatement {
  return {
    sql: INSERT_SQL,
    params: [
      point.id ?? crypto.randomUUID(),
      point.scope,
      point.owner_id,
      point.target_path,
      point.tick,
      point.value,
      point.curve ?? 'linear',
    ],
  };
}

export class AutomationRepository extends BaseRepository {
  /** The inserts as unexecuted statements, for cross-table batches (see ProjectRepository). */
  insertStatements(points: readonly AutomationPointCreate[]): SqlStatement[] {
    return points.map(insertStatement);
  }

  /** Insert a batch atomically (one recorded gesture = one batch). */
  async insertMany(points: readonly AutomationPointCreate[]): Promise<void> {
    if (points.length === 0) return;
    await this.driver.transaction(points.map(insertStatement));
  }

  /** All points of one owner (sequence or track) in tick order (uses idx_automation_lookup). */
  async listByOwner(
    scope: AutomationPointRow['scope'],
    ownerId: string,
    page: PageParams = {},
  ): Promise<Page<AutomationPointRow>> {
    const { limit, offset } = this.resolvePage(page);
    const rows = await this.driver.query<AutomationPointRow>(
      'SELECT * FROM automation_points WHERE owner_id = ? AND scope = ? ORDER BY target_path, tick LIMIT ? OFFSET ?;',
      [ownerId, scope, limit, offset],
    );
    return this.toPage(rows, limit, offset);
  }

  /** Atomically replace one automation lane (owner + target path). */
  async replaceTarget(
    scope: AutomationPointRow['scope'],
    ownerId: string,
    targetPath: string,
    points: readonly AutomationPointCreate[],
  ): Promise<void> {
    await this.driver.transaction([
      {
        sql: 'DELETE FROM automation_points WHERE owner_id = ? AND scope = ? AND target_path = ?;',
        params: [ownerId, scope, targetPath],
      },
      ...points.map(insertStatement),
    ]);
  }

  async deleteMany(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.driver.transaction(
      ids.map((id) => ({ sql: 'DELETE FROM automation_points WHERE id = ?;', params: [id] })),
    );
  }

  /** Remove every point owned by a deleted sequence/track (no FK ties owner_id). */
  async clearOwner(scope: AutomationPointRow['scope'], ownerId: string): Promise<void> {
    await this.driver.execute('DELETE FROM automation_points WHERE owner_id = ? AND scope = ?;', [
      ownerId,
      scope,
    ]);
  }
}
