/**
 * Browser folder tree (spec §8.5.7 "folder tree (projects/global)"). The tree is the only
 * writer of `useBrowserStore.currentPath`, which is what makes the global library reachable
 * at all — these cover both roots and the selection it publishes.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { GLOBAL_LIBRARY_ROOT, projectSamplesRoot } from '@/core/storage/opfs';
import { useBrowserStore, useProjectStore } from '@/store';
import { FolderTree } from './FolderTree';

beforeEach(() => {
  useProjectStore.setState({ projectId: 'p1', projectName: 'Demo Song' });
  useBrowserStore.setState({ currentPath: projectSamplesRoot('p1') });
});

describe('FolderTree (spec §8.5.7)', () => {
  it('shows a project root and a global-library root', () => {
    render(<FolderTree />);
    const tree = screen.getByRole('tree', { name: 'Library folders' });
    expect(tree).toBeInTheDocument();
    expect(screen.getByText('Demo Song')).toBeInTheDocument();
    expect(screen.getByText('Global library')).toBeInTheDocument();
  });

  it('marks the browsed node as selected', () => {
    render(<FolderTree />);
    expect(screen.getByTestId('browser-tree-project')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('browser-tree-global')).toHaveAttribute('aria-selected', 'false');
  });

  it('selecting the global library publishes its path to the browser store', async () => {
    render(<FolderTree />);
    await userEvent.click(screen.getByTestId('browser-tree-global'));
    expect(useBrowserStore.getState().currentPath).toBe(GLOBAL_LIBRARY_ROOT);
  });

  it('selecting the project node publishes the project samples path', async () => {
    useBrowserStore.setState({ currentPath: GLOBAL_LIBRARY_ROOT });
    render(<FolderTree />);
    await userEvent.click(screen.getByTestId('browser-tree-project'));
    expect(useBrowserStore.getState().currentPath).toBe(projectSamplesRoot('p1'));
  });

  it('collapses and expands the projects group', async () => {
    render(<FolderTree />);
    await userEvent.click(screen.getByTestId('browser-tree-projects'));
    expect(screen.queryByTestId('browser-tree-project')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('browser-tree-projects'));
    expect(screen.getByTestId('browser-tree-project')).toBeInTheDocument();
  });

  it('says so when no project is open, leaving the global library reachable', () => {
    useProjectStore.setState({ projectId: '', projectName: '' });
    render(<FolderTree />);
    expect(screen.getByText('No project open.')).toBeInTheDocument();
    expect(screen.getByTestId('browser-tree-global')).toBeInTheDocument();
  });
});
