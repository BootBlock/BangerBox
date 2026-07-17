/**
 * Song-mode playlist persistence (spec §9.2, §9.3 `song_entries`, §7.9).
 */
import { BaseRepository } from './base';
import type { SongEntryRow } from './types';

export interface SongEntryCreate {
  readonly id?: string;
  readonly sequence_id: string;
  readonly repeats?: number;
}

export class SongRepository extends BaseRepository {
  /** A project's playlist in position order (bounded by the project's arrangement). */
  listByProject(projectId: string): Promise<SongEntryRow[]> {
    return this.driver.query<SongEntryRow>(
      'SELECT * FROM song_entries WHERE project_id = ? ORDER BY position;',
      [projectId],
    );
  }

  /**
   * Atomically replace the whole playlist (add/remove/reorder all reduce to this —
   * positions are re-stamped from array order).
   */
  async replaceForProject(projectId: string, entries: readonly SongEntryCreate[]): Promise<void> {
    await this.driver.transaction([
      { sql: 'DELETE FROM song_entries WHERE project_id = ?;', params: [projectId] },
      ...entries.map((entry, position) => ({
        sql: 'INSERT INTO song_entries (id, project_id, position, sequence_id, repeats) VALUES (?, ?, ?, ?, ?);',
        params: [
          entry.id ?? crypto.randomUUID(),
          projectId,
          position,
          entry.sequence_id,
          entry.repeats ?? 1,
        ],
      })),
    ]);
  }
}
