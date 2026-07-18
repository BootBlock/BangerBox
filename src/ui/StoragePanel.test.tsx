import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { fakeStorageApi } from '@/test/fakes/storagePanelApi';
import { StoragePanel } from './StoragePanel';

describe('StoragePanel (Phase 1 shell)', () => {
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

  it('shows a dismissible eviction warning when persistence is refused (spec §9.7)', async () => {
    const user = userEvent.setup();
    render(<StoragePanel apiOverride={fakeStorageApi({ requestPersist: async () => false })} />);

    expect(await screen.findByTestId('storage-persisted')).toHaveTextContent('Not granted');
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent('may evict project data');

    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
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
