/**
 * Shared repository plumbing (spec §9.2, §11.3).
 *
 * Repositories are the only RPC clients (spec §9.2); they depend only on the
 * injected {@link IDatabaseDriver} — never the worker — keeping them
 * unit-testable against the in-memory driver. React code never contains SQL
 * (spec §3.1): all SQL lives in this directory. Adapted from the proven Gubbins
 * base repository (spec §13.6).
 */
import type { IDatabaseDriver, SqlValue } from '../driver';
import type { Page, PageParams } from './types';

/** Browser-facing queries page at 200 rows — unpaginated unbounded reads are forbidden (spec §9.2). */
export const MAX_PAGE_SIZE = 200;
export const DEFAULT_PAGE_SIZE = 200;

export abstract class BaseRepository {
  protected readonly driver: IDatabaseDriver;

  constructor(driver: IDatabaseDriver) {
    this.driver = driver;
  }

  /** Clamp caller pagination to the strict ceiling (spec §9.2). */
  protected resolvePage(params: PageParams = {}): { limit: number; offset: number } {
    const requested = params.limit ?? DEFAULT_PAGE_SIZE;
    const limit = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(requested)));
    const offset = Math.max(0, Math.floor(params.offset ?? 0));
    return { limit, offset };
  }

  /** Wrap a fetched chunk in a Page envelope (hasMore = a full page came back). */
  protected toPage<T>(rows: readonly T[], limit: number, offset: number): Page<T> {
    return { rows, limit, offset, hasMore: rows.length === limit };
  }

  /**
   * Build a parameterised SET clause from a partial patch, restricted to an
   * explicit column whitelist (values are always bound — never interpolated;
   * column names come only from the fixed whitelist).
   */
  protected buildSet<T extends object>(
    patch: T,
    allowed: readonly Extract<keyof T, string>[],
  ): { clause: string; params: SqlValue[] } {
    const assignments: string[] = [];
    const params: SqlValue[] = [];
    for (const column of allowed) {
      const value = patch[column] as SqlValue | undefined;
      if (value === undefined) continue;
      assignments.push(`${column} = ?`);
      params.push(value);
    }
    return { clause: assignments.join(', '), params };
  }
}
