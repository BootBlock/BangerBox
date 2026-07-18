/**
 * Browser folder tree (spec §8.5.7 "folder tree (projects/global)", §9.1).
 *
 * Two roots, matching the §9.1 layout: the active project's samples under a `Projects`
 * group, and the `/global_library` samples that belong to no project (§9.3). Selecting a
 * node writes `useBrowserStore.currentPath`, which is what the sample query and the import
 * destination both read — see {@link libraryLocation}.
 */
import { useState } from 'react';
import { GLOBAL_LIBRARY_ROOT, projectSamplesRoot } from '@/core/storage/opfs';
import { useBrowserStore, useProjectStore } from '@/store';

/** One selectable node. `role="treeitem"` carries the interaction — no nested button. */
function TreeItem({
  label,
  path,
  selected,
  indented = false,
  onSelect,
  testId,
}: {
  label: string;
  path: string;
  selected: boolean;
  indented?: boolean;
  onSelect: (path: string) => void;
  testId: string;
}) {
  return (
    <li
      role="treeitem"
      aria-selected={selected}
      tabIndex={0}
      data-testid={testId}
      onClick={() => onSelect(path)}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onSelect(path);
      }}
      className={`cursor-pointer truncate rounded-bb-sm px-2 py-1 text-xs ${
        indented ? 'pl-6' : ''
      } ${selected ? 'bg-bb-raised font-semibold text-bb-text' : 'text-bb-muted hover:text-bb-text'}`}
    >
      {label}
    </li>
  );
}

export function FolderTree() {
  const currentPath = useBrowserStore((state) => state.currentPath);
  const setCurrentPath = useBrowserStore((state) => state.setCurrentPath);
  const projectId = useProjectStore((state) => state.projectId);
  const projectName = useProjectStore((state) => state.projectName);
  const [projectsExpanded, setProjectsExpanded] = useState(true);

  const projectPath = projectId ? projectSamplesRoot(projectId) : '';

  return (
    <ul
      role="tree"
      aria-label="Library folders"
      data-testid="browser-folder-tree"
      className="w-44 shrink-0 overflow-auto rounded-bb-sm border border-bb-line p-1"
    >
      <li role="treeitem" aria-expanded={projectsExpanded} aria-selected={false}>
        <button
          type="button"
          aria-label={`${projectsExpanded ? 'Collapse' : 'Expand'} projects`}
          data-testid="browser-tree-projects"
          onClick={() => setProjectsExpanded((expanded) => !expanded)}
          className="w-full truncate rounded-bb-sm px-2 py-1 text-left text-[0.625rem] font-semibold text-bb-muted uppercase"
        >
          {projectsExpanded ? '▾' : '▸'} Projects
        </button>
        {projectsExpanded && (
          <ul role="group">
            {projectId ? (
              <TreeItem
                label={projectName || 'Untitled project'}
                path={projectPath}
                selected={currentPath === projectPath}
                indented
                onSelect={setCurrentPath}
                testId="browser-tree-project"
              />
            ) : (
              <li className="px-2 py-1 pl-6 text-xs text-bb-muted">No project open.</li>
            )}
          </ul>
        )}
      </li>

      <TreeItem
        label="Global library"
        path={GLOBAL_LIBRARY_ROOT}
        selected={currentPath === GLOBAL_LIBRARY_ROOT}
        onSelect={setCurrentPath}
        testId="browser-tree-global"
      />
    </ul>
  );
}
