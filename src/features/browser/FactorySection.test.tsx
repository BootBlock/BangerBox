/**
 * Browser-mode Factory section (spec §8.5 item 7, §9.8) — the listing, the install actions,
 * and the two failure modes §8.5 item 7 calls out by name: a not-yet-cached pack must say
 * so, and a fetch failure must be retryable rather than an empty list.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchFactoryCatalogue = vi.fn();
const installFactoryPack = vi.fn();
const isPackCached = vi.fn();
const reportInstallFailure = vi.fn();

vi.mock('@/core/project', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/project')>();
  return {
    ...actual,
    fetchFactoryCatalogue: () => fetchFactoryCatalogue(),
    installFactoryPack: (pack: unknown, projectId: unknown) => installFactoryPack(pack, projectId),
    isPackCached: (pack: unknown) => isPackCached(pack),
    reportInstallFailure: (error: unknown) => reportInstallFailure(error),
  };
});

vi.mock('../sample-edit/sampleContext', () => ({ refreshSamples: () => Promise.resolve() }));

const { FactorySection } = await import('./FactorySection');
const { useProjectStore } = await import('@/store');

const KIT = {
  id: 'kit-808',
  title: '808 Kit',
  kind: 'kit' as const,
  file: 'kit-808.mpcweb',
  bytes: 556 * 1024,
  description: 'Deep sub kicks.',
};
const DEMO = {
  id: 'demo-house',
  title: 'House Demo',
  kind: 'demo' as const,
  file: 'demo-house.mpcweb',
  bytes: 508 * 1024,
  description: 'A 124 BPM groove.',
};

beforeEach(() => {
  vi.clearAllMocks();
  fetchFactoryCatalogue.mockResolvedValue([KIT, DEMO]);
  isPackCached.mockResolvedValue(false);
  installFactoryPack.mockResolvedValue({ kind: 'kit', projectId: 'active' });
  useProjectStore.setState({ projectId: 'active' });
});

describe('FactorySection listing (spec §8.5 item 7)', () => {
  it('lists each pack with its title, kind and size', async () => {
    render(<FactorySection />);
    const list = await screen.findByRole('list', { name: 'Factory packs' });
    const rows = within(list).getAllByRole('listitem');

    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('808 Kit')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('kit')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('0.5 MB')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('demo')).toBeInTheDocument();
  });

  it('states when a pack is not yet cached, and when it is', async () => {
    isPackCached.mockImplementation((pack: { id: string }) => Promise.resolve(pack.id === 'kit-808'));
    render(<FactorySection />);

    const list = await screen.findByRole('list', { name: 'Factory packs' });
    await waitFor(() => expect(within(list).getByText('Cached')).toBeInTheDocument());
    expect(within(list).getByText('Not cached')).toBeInTheDocument();
  });

  it('labels the action by install mode — a kit merges, a demo opens', async () => {
    render(<FactorySection />);
    expect(await screen.findByRole('button', { name: 'Merge 808 Kit into this project' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open House Demo as a new project' })).toBeInTheDocument();
  });
});

describe('FactorySection failure handling (spec §8.5 item 7)', () => {
  it('surfaces a fetch failure as a retryable error, not an empty list', async () => {
    fetchFactoryCatalogue.mockRejectedValueOnce(new Error('Could not load the factory catalogue (HTTP 503).'));
    render(<FactorySection />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('HTTP 503');
    // An empty list would read as "no factory content exists" — a different, wrong message.
    expect(screen.queryByRole('list', { name: 'Factory packs' })).not.toBeInTheDocument();
    expect(screen.queryByText(/no factory packs are available/i)).not.toBeInTheDocument();
  });

  it('reloads the catalogue when Retry is pressed', async () => {
    const user = userEvent.setup();
    fetchFactoryCatalogue.mockRejectedValueOnce(new Error('offline'));
    render(<FactorySection />);

    await user.click(await screen.findByTestId('factory-retry'));

    expect(await screen.findByRole('list', { name: 'Factory packs' })).toBeInTheDocument();
    expect(fetchFactoryCatalogue).toHaveBeenCalledTimes(2);
  });

  it('distinguishes a genuinely empty catalogue from a failure', async () => {
    fetchFactoryCatalogue.mockResolvedValue([]);
    render(<FactorySection />);
    expect(await screen.findByText(/no factory packs are available/i)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('FactorySection install (spec §9.8)', () => {
  it('installs the tapped pack against the active project', async () => {
    const user = userEvent.setup();
    render(<FactorySection />);

    await user.click(await screen.findByTestId('factory-install-kit-808'));

    await waitFor(() => expect(installFactoryPack).toHaveBeenCalledTimes(1));
    expect(installFactoryPack).toHaveBeenCalledWith(expect.objectContaining({ id: 'kit-808' }), 'active');
  });

  it('marks a pack cached once installed', async () => {
    const user = userEvent.setup();
    render(<FactorySection />);
    const list = await screen.findByRole('list', { name: 'Factory packs' });

    await user.click(screen.getByTestId('factory-install-kit-808'));

    await waitFor(() => expect(within(list).getByText('Cached')).toBeInTheDocument());
  });

  it('reports an install failure without breaking the list', async () => {
    const user = userEvent.setup();
    installFactoryPack.mockRejectedValueOnce(new Error('Not enough storage space.'));
    render(<FactorySection />);

    await user.click(await screen.findByTestId('factory-install-kit-808'));

    await waitFor(() => expect(reportInstallFailure).toHaveBeenCalledTimes(1));
    // The section stays usable so the user can purge and try again (spec §9.8).
    expect(screen.getByRole('list', { name: 'Factory packs' })).toBeInTheDocument();
    expect(screen.getByTestId('factory-install-kit-808')).toBeEnabled();
  });
});
