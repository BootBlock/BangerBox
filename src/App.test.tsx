/**
 * Application shell tests (spec §8.1) — the persistent transport bar, the 12-mode rail,
 * and mode switching through `useUIStore.activeMode` (spec §1.3 #9, no router). These
 * assert the shell's accessibility contract (spec §8.2/§3.5 lens 1) rather than its
 * pixels: roles, names, keyboard operation, and that every mode actually mounts.
 */
import { render, screen, waitForElementToBeRemoved, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { AppShell } from './ui/shell/AppShell';
import { evaluateCapabilities } from './core/platform/capabilities';
import { CapabilityGate } from './ui/CapabilityGate';
import { MODE_DEFINITIONS } from './features/modes';
import { useUIStore } from './store';
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

function renderApp() {
  const { api, updates, signalNeedRefresh } = fakePwaApi();
  render(<App capabilities={fullCapabilities} pwaApiOverride={api} />);
  return { updates, signalNeedRefresh };
}

/**
 * The shell sits behind the §5.1 start gate, which needs a real AudioContext to pass.
 * Shell behaviour is therefore exercised by mounting it directly; the gate has its own
 * tests below.
 */
function renderShell() {
  render(<AppShell />);
}

describe('AppShell (spec §8.1)', () => {
  beforeEach(() => {
    useUIStore.getState().setActiveMode('main');
  });

  it('renders the persistent transport bar and mode rail', () => {
    renderShell();
    expect(screen.getByRole('toolbar', { name: 'Transport' })).toBeInTheDocument();
    expect(screen.getByRole('tablist', { name: 'Modes' })).toBeInTheDocument();
  });

  it('offers exactly the 12 modes the spec requires (§8.5)', () => {
    renderShell();
    const tabs = within(screen.getByRole('tablist', { name: 'Modes' })).getAllByRole('tab');
    expect(tabs).toHaveLength(12);
    expect(MODE_DEFINITIONS).toHaveLength(12);
  });

  it('starts on Main with its tab selected and its panel shown', () => {
    renderShell();
    expect(screen.getByTestId('mode-tab-main')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel', { name: 'Main' })).toBeInTheDocument();
  });

  it('switches modes on tap without a router (spec §1.3 #9)', async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(screen.getByTestId('mode-tab-song'));
    expect(useUIStore.getState().activeMode).toBe('song');
    expect(screen.getByTestId('mode-tab-song')).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByRole('tabpanel', { name: 'Song' })).toBeInTheDocument();
  });

  it('moves between modes with the arrow keys (spec §8.2 roving tabindex)', async () => {
    const user = userEvent.setup();
    renderShell();
    const mainTab = screen.getByTestId('mode-tab-main');
    expect(mainTab).toHaveAttribute('tabindex', '0');
    mainTab.focus();
    await user.keyboard('{ArrowDown}');
    // Grid follows Main in the §8.5 order.
    expect(useUIStore.getState().activeMode).toBe('grid');
  });

  it('mounts every mode without crashing (spec §3.4 no dead modes)', async () => {
    const user = userEvent.setup();
    renderShell();
    for (const mode of MODE_DEFINITIONS) {
      await user.click(screen.getByTestId(`mode-tab-${mode.id}`));
      expect(await screen.findByRole('tabpanel', { name: mode.title })).toBeInTheDocument();
    }
  });

  it('exposes the transport controls with accessible names (spec §8.2)', () => {
    renderShell();
    const toolbar = screen.getByRole('toolbar', { name: 'Transport' });
    expect(within(toolbar).getByRole('button', { name: 'Play' })).toBeInTheDocument();
    expect(within(toolbar).getByRole('button', { name: 'Arm recording' })).toBeInTheDocument();
    expect(within(toolbar).getByRole('slider', { name: 'Tempo' })).toBeInTheDocument();
    expect(within(toolbar).getByRole('button', { name: 'Save project now' })).toBeInTheDocument();
  });

  it('disables undo and redo until there is history (spec §4.5)', () => {
    renderShell();
    expect(screen.getByTestId('transport-undo')).toBeDisabled();
    expect(screen.getByTestId('transport-redo')).toBeDisabled();
  });

  it('mounts the single polite live region (spec §8.2)', () => {
    renderShell();
    expect(screen.getByTestId('live-region')).toHaveAttribute('aria-live', 'polite');
  });
});

describe('PWA update prompt (spec §2.4)', () => {
  beforeEach(() => {
    // The stores are module singletons, so a toast pushed by an earlier test's mode would
    // otherwise still be mounted and compete with the prompt for `role="status"`.
    const { toasts, dismissToast } = useUIStore.getState();
    for (const toast of toasts) dismissToast(toast.id);
  });

  it('surfaces the reload prompt when a new worker is waiting and applies it on accept', async () => {
    const user = userEvent.setup();
    const { updates, signalNeedRefresh } = renderApp();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    signalNeedRefresh();
    const toast = await screen.findByRole('status');
    expect(toast).toHaveTextContent('A new version of BangerBox is ready.');

    await user.click(screen.getByRole('button', { name: 'Reload to update' }));
    expect(updates).toEqual([true]);
  });

  it('"Not now" snoozes the reload prompt', async () => {
    const user = userEvent.setup();
    const { signalNeedRefresh } = renderApp();
    signalNeedRefresh();
    await screen.findByRole('status');
    await user.click(screen.getByRole('button', { name: 'Not now' }));
    // AnimatePresence keeps the toast mounted until its exit animation completes.
    await waitForElementToBeRemoved(() => screen.queryByRole('status'));
  });
});

describe('StartGate (spec §5.1 autoplay gate)', () => {
  it('presents an explicit start control before any audio code runs', () => {
    renderApp();
    expect(screen.getByTestId('audio-start')).toBeInTheDocument();
    expect(screen.getByTestId('audio-engine-status')).toHaveAttribute('data-status', 'idle');
    // The shell must not mount behind the gate — nothing may touch the graph yet.
    expect(screen.queryByRole('tablist', { name: 'Modes' })).not.toBeInTheDocument();
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
