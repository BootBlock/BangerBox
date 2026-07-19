/**
 * MIDI event persistence (spec §9.2, §9.3 `midi_events`).
 *
 * Events are written in bulk (a recording pass, a quantise edit) inside a single
 * transaction, and read back in tick order for hydration and scheduling.
 */
import { BaseRepository } from './base';
import type { SqlStatement } from '../driver';
import type { MidiEventRow, Page, PageParams } from './types';

export interface MidiEventCreate {
  readonly id?: string;
  readonly track_id: string;
  readonly tick_start: number;
  readonly duration_ticks: number;
  readonly note: number;
  readonly velocity: number;
  readonly extra?: string | null;
}

const INSERT_SQL = `INSERT INTO midi_events (id, track_id, tick_start, duration_ticks, note, velocity, extra)
 VALUES (?, ?, ?, ?, ?, ?, ?);`;

function insertStatement(event: MidiEventCreate): SqlStatement {
  return {
    sql: INSERT_SQL,
    params: [
      event.id ?? crypto.randomUUID(),
      event.track_id,
      event.tick_start,
      event.duration_ticks,
      event.note,
      event.velocity,
      event.extra ?? null,
    ],
  };
}

export class MidiEventRepository extends BaseRepository {
  /** The inserts as unexecuted statements, for cross-table batches (see ProjectRepository). */
  insertStatements(events: readonly MidiEventCreate[]): SqlStatement[] {
    return events.map(insertStatement);
  }

  /** Insert a batch atomically (one recording pass = one batch = one undo entry). */
  async insertMany(events: readonly MidiEventCreate[]): Promise<void> {
    if (events.length === 0) return;
    await this.driver.transaction(events.map(insertStatement));
  }

  /** Events of a track in tick order (uses idx_midi_events_lookup). */
  async listByTrack(trackId: string, page: PageParams = {}): Promise<Page<MidiEventRow>> {
    const { limit, offset } = this.resolvePage(page);
    const rows = await this.driver.query<MidiEventRow>(
      'SELECT * FROM midi_events WHERE track_id = ? ORDER BY tick_start, id LIMIT ? OFFSET ?;',
      [trackId, limit, offset],
    );
    return this.toPage(rows, limit, offset);
  }

  /** Atomically replace a track's events (destructive edits: quantise, replace-record). */
  async replaceTrack(trackId: string, events: readonly MidiEventCreate[]): Promise<void> {
    await this.driver.transaction([
      { sql: 'DELETE FROM midi_events WHERE track_id = ?;', params: [trackId] },
      ...events.map(insertStatement),
    ]);
  }

  async deleteMany(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.driver.transaction(
      ids.map((id) => ({ sql: 'DELETE FROM midi_events WHERE id = ?;', params: [id] })),
    );
  }

  async clearTrack(trackId: string): Promise<void> {
    await this.driver.execute('DELETE FROM midi_events WHERE track_id = ?;', [trackId]);
  }
}
