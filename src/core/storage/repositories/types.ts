/**
 * Repository row and pagination types (spec §9.2, §9.3).
 *
 * Row interfaces mirror the binding §9.3 DDL column-for-column (snake_case —
 * these are raw table rows; the camelCase domain mapping happens in the Phase 2
 * store hydration layer).
 */

export interface PageParams {
  readonly limit?: number;
  readonly offset?: number;
}

/** Pagination envelope shared by every paginated repository read (spec §9.2). */
export interface Page<T> {
  readonly rows: readonly T[];
  readonly limit: number;
  readonly offset: number;
  /** True when another page may exist (a full page was returned). */
  readonly hasMore: boolean;
}

// --- Row shapes (spec §9.3) ------------------------------------------------------

export type BitDepth = '16' | '24' | '32f';

export interface ProjectRow {
  readonly id: string;
  readonly name: string;
  readonly created_at: number;
  readonly modified_at: number;
  readonly sample_rate: number;
  readonly bit_depth: BitDepth;
  readonly bpm_default: number;
  readonly insert_limit: number;
  readonly payload: string;
}

export interface SequenceRow {
  readonly id: string;
  readonly project_id: string;
  readonly position: number;
  readonly name: string;
  readonly length_bars: number;
  readonly time_sig_numerator: number;
  readonly time_sig_denominator: number;
  readonly tempo: number | null;
  readonly swing_amount: number;
  readonly swing_division: number;
}

export interface ProgramRow {
  readonly id: string;
  readonly project_id: string;
  readonly name: string;
  readonly type: 'drum' | 'keygroup';
  readonly payload: string;
}

export interface TrackRow {
  readonly id: string;
  readonly sequence_id: string;
  readonly program_id: string | null;
  readonly position: number;
  readonly name: string;
  readonly type: 'drum' | 'keygroup' | 'audio';
  readonly mixer: string;
}

export interface MidiEventRow {
  readonly id: string;
  readonly track_id: string;
  readonly tick_start: number;
  readonly duration_ticks: number;
  readonly note: number;
  readonly velocity: number;
  readonly extra: string | null;
}

export interface AutomationPointRow {
  readonly id: string;
  readonly scope: 'sequence' | 'track';
  readonly owner_id: string;
  readonly target_path: string;
  readonly tick: number;
  readonly value: number;
  readonly curve: 'step' | 'linear' | 'exp';
}

export interface SampleRow {
  readonly id: string;
  readonly project_id: string | null;
  readonly name: string;
  readonly opfs_path: string;
  readonly frames: number;
  readonly sample_rate: number;
  readonly channels: 1 | 2;
  readonly root_note: number;
  readonly created_at: number;
}

export interface SongEntryRow {
  readonly id: string;
  readonly project_id: string;
  readonly position: number;
  readonly sequence_id: string;
  readonly repeats: number;
}
