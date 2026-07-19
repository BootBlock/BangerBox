/**
 * The §8.5.1 recent-projects list. `ProjectRepository.listRecent` has long carried a
 * comment naming "the Main-mode recent-projects list (spec §8.5.1)" while nothing called
 * it (issue #40); this is the read side of that list.
 *
 * Repository reads are RPC to the storage worker (spec §3.1), so the list is fetched
 * rather than derived from a store. It refreshes on the project id — creating, opening
 * or importing a project all change it — and exposes `refresh` for the cases that do not.
 *
 * It deliberately does NOT re-read on a rename. The new name reaches storage only when
 * autosave next flushes (spec §4.4), so re-reading on the keystroke would fetch the name
 * the user just replaced and show it back to them. The open project's row is labelled
 * from the store instead, which is the live truth (spec §1.3 #16).
 */
import { useCallback, useEffect, useState } from 'react';
import { getActiveRepositories } from '@/core/project/projectService';
import type { ProjectRow } from '@/core/storage/repositories';
import { useProjectStore } from '@/store';

/** How many recent projects Main shows — a dashboard panel, not a file browser. */
const RECENT_LIMIT = 12;

export interface RecentProjects {
  readonly rows: readonly ProjectRow[];
  readonly loading: boolean;
  readonly refresh: () => void;
}

export function useRecentProjects(): RecentProjects {
  const projectId = useProjectStore((state) => state.projectId);
  const [rows, setRows] = useState<readonly ProjectRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Inside the async body, not before it: a synchronous setState in an effect body
      // triggers a cascading render (react-hooks/set-state-in-effect), and the flag is
      // only meaningful once the read is actually outstanding.
      if (!cancelled) setLoading(true);
      try {
        const page = await getActiveRepositories().projects.listRecent({ limit: RECENT_LIMIT });
        if (!cancelled) setRows(page.rows);
      } catch {
        // The list is a convenience, not the way the open project loads (that is
        // `loadOrCreateActiveProject` at boot). A failed read shows an empty panel
        // rather than taking the dashboard down with it.
        if (!cancelled) setRows([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, nonce]);

  return { rows, loading, refresh };
}
