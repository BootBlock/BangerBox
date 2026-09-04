import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { fakeStorageApi } from '@/test/fakes/storagePanelApi';
import { useUIStore } from '@/store';
import { StoragePanel } from './StoragePanel';

describe('StoragePanel (spec §11.4 storage self-test)', () => {
  it('boots through the seam and shows diagnostics', async () => {
    render(<StoragePanel apiOverride={fakeStorageApi()} />);
    expect(screen.getByTestId('storage-panel-status')).toHaveAttribute('data-status', 'booting');

    expect(await screen.findByText('Ready')).toBeInTheDocument();
    expect(screen.getByTestId('storage-panel-detail')).toHaveTextContent(
      'SQLite 3.50.0 on the OPFS VFS · schema v1',
    );
    expect(screen.getByTestId('storage-persisted')).toHaveTextContent('Yes');
    // 1024 B of 1 MiB.
    expect(screen.getByText('0 MiB of 1 MiB')).toBeInTheDocument();
  });

  it('reports a failed boot without a white screen (spec §8.1)', async () => {
    render(
      <StoragePanel
        apiOverride={fakeStorageApi({
          boot: async () => {
            throw new Error('OPFS unavailable');
          },
        })}
      />,
    );
    expect(await screen.findByTestId('storage-panel-status')).toHaveAttribute('data-status', 'failed');
    expect(screen.getByTestId('storage-panel-detail')).toHaveTextContent('OPFS unavailable');
    // The self-test can never run against a dead layer.
    expect(screen.getByTestId('storage-self-test-run')).toBeDisabled();
  });

  it('publishes a refused persistence grant rather than warning here (spec §9.7, issue #51)', async () => {
    render(<StoragePanel apiOverride={fakeStorageApi({ requestPersist: async () => false })} />);

    expect(await screen.findByTestId('storage-persisted')).toHaveTextContent('Not granted');
    // The warning itself belongs to the shell, which is mounted in all 12 modes; this
    // panel is mounted in one. What it owns is the READING, and the store field the
    // always-mounted surface renders from.
    expect(useUIStore.getState().storagePersisted).toBe(false);
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    expect(screen.queryByText(/may evict project data/i)).not.toBeInTheDocument();
  });

  it('carries no live region of its own (spec §8.2, issue #34)', async () => {
    const { container } = render(
      <StoragePanel
        apiOverride={fakeStorageApi({
          boot: async () => {
            throw new Error('OPFS unavailable');
          },
        })}
      />,
    );
    await screen.findByTestId('storage-boot-failure');
    expect(container.querySelectorAll('[aria-live], [role="status"], [role="alert"]')).toHaveLength(0);
  });

  it('runs the self-test through the seam and reports pass and fail', async () => {
    const user = userEvent.setup();
    render(
      <StoragePanel apiOverride={fakeStorageApi({ runSelfTest: async () => 'All layers round-tripped.' })} />,
    );

    const run = await screen.findByTestId('storage-self-test-run');
    await user.click(run);
    expect(await screen.findByTestId('storage-self-test-status')).toHaveAttribute('data-status', 'passed');
    expect(screen.getByTestId('storage-self-test-detail')).toHaveTextContent('All layers round-tripped.');
  });

  it('surfaces self-test failures', async () => {
    const user = userEvent.setup();
    render(
      <StoragePanel
        apiOverride={fakeStorageApi({
          runSelfTest: async () => {
            throw new Error('quota hard-stop');
          },
        })}
      />,
    );
    await user.click(await screen.findByTestId('storage-self-test-run'));
    expect(await screen.findByTestId('storage-self-test-status')).toHaveAttribute('data-status', 'failed');
    expect(screen.getByTestId('storage-self-test-detail')).toHaveTextContent('quota hard-stop');
  });
});
