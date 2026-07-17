import { render, screen, waitForElementToBeRemoved } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from './App';
import { evaluateCapabilities } from './core/platform/capabilities';
import { CapabilityGate } from './ui/CapabilityGate';
import { fakeStorageApi } from './test/fakes/storagePanelApi';
import type { PwaUpdateApi, PwaUpdateHandlers } from './ui/usePwaUpdate';

const fullCapabilities = evaluateCapabilities(
  {
    crossOriginIsolated: true,
    sharedArrayBuffer: true,
    audioWorklet: true,
    opfs: true,
    webAssembly: true,
    atomics: true,
  },
  { bluetooth: true, microphone: false, persistentStorage: true, wakeLock: false },
);

/** Fake PWA seam: captures handlers so a test can signal a waiting worker on demand. */
function fakePwaApi() {
  const updates: boolean[] = [];
  let handlers: PwaUpdateHandlers | null = null;
  const api: PwaUpdateApi = {
    register(h) {
      handlers = h;
      return async (reloadPage = true) => {
        updates.push(reloadPage);
      };
    },
    async checkForUpdate() {},
  };
  return { api, updates, signalNeedRefresh: () => handlers?.onNeedRefresh() };
}

describe('App shell (Phase 1)', () => {
  it('renders the wordmark, version, soft capability summary, and storage panel', async () => {
    const { api } = fakePwaApi();
    render(
      <App capabilities={fullCapabilities} pwaApiOverride={api} storageApiOverride={fakeStorageApi()} />,
    );
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('BangerBox');
    expect(screen.getByText(`v0.1.0`)).toBeInTheDocument();
    expect(screen.getByText('Web Bluetooth (BLE-MIDI hardware)')).toBeInTheDocument();
    // Missing soft capabilities show as unavailable but never block the app (§2.1).
    expect(screen.getAllByText('Unavailable')).toHaveLength(2);
    expect(screen.getByTestId('audio-start')).toBeEnabled();
    // The storage panel boots through its seam and reports ready.
    expect(await screen.findByTestId('storage-panel-status')).toHaveAttribute('data-status', 'ready');
  });

  it('surfaces the reload prompt when a new service worker is waiting and applies it on accept', async () => {
    const user = userEvent.setup();
    const { api, updates, signalNeedRefresh } = fakePwaApi();
    render(
      <App capabilities={fullCapabilities} pwaApiOverride={api} storageApiOverride={fakeStorageApi()} />,
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    signalNeedRefresh();
    const toast = await screen.findByRole('status');
    expect(toast).toHaveTextContent('A new version of BangerBox is ready.');

    await user.click(screen.getByRole('button', { name: 'Reload to update' }));
    expect(updates).toEqual([true]);
  });

  it('"Not now" snoozes the reload prompt', async () => {
    const user = userEvent.setup();
    const { api, signalNeedRefresh } = fakePwaApi();
    render(
      <App capabilities={fullCapabilities} pwaApiOverride={api} storageApiOverride={fakeStorageApi()} />,
    );
    signalNeedRefresh();
    await screen.findByRole('status');
    await user.click(screen.getByRole('button', { name: 'Not now' }));
    // AnimatePresence keeps the toast mounted until its exit animation completes.
    await waitForElementToBeRemoved(() => screen.queryByRole('status'));
  });
});

describe('CapabilityGate blocking screen (spec §2.1)', () => {
  it('lists exactly what is missing and which browser to use', () => {
    render(<CapabilityGate missing={['SharedArrayBuffer shared memory', 'WebAssembly']} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('SharedArrayBuffer shared memory');
    expect(alert).toHaveTextContent('WebAssembly');
    expect(alert).toHaveTextContent('Microsoft Edge');
    expect(alert).toHaveTextContent('Google Chrome');
  });
});
