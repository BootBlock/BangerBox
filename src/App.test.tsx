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
import { detectBrowser, evaluateCapabilities } from './core/platform/capabilities';
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
    // The rail is two columns filled row-major, so left/right step one mode along the §8.5
    // order and up/down step a whole row.
    await user.keyboard('{ArrowRight}');
    // Grid follows Main in the §8.5 order.
    expect(useUIStore.getState().activeMode).toBe('grid');
    await user.keyboard('{ArrowDown}');
    expect(useUIStore.getState().activeMode).toBe(MODE_DEFINITIONS[3]?.id);
    await user.keyboard('{ArrowUp}');
    expect(useUIStore.getState().activeMode).toBe('grid');
  });

  it('wraps the rail arrow keys around both axes so no mode is unreachable', async () => {
    const user = userEvent.setup();
    renderShell();
    screen.getByTestId('mode-tab-main').focus();
    // Main is index 0: stepping backwards must wrap to the end rather than stalling, which
    // a naive `index - columns` would do by going negative.
    await user.keyboard('{ArrowUp}');
    expect(useUIStore.getState().activeMode).toBe(
      MODE_DEFINITIONS[MODE_DEFINITIONS.length - 2]?.id,
    );
  });

  it('mounts every mode without crashing (spec §3.4 no dead modes)', async () => {
    const user = userEvent.setup();
    renderShell();
    for (const mode of MODE_DEFINITIONS) {
      await user.click(screen.getByTestId(`mode-tab-${mode.id}`));
      expect(await screen.findByRole('tabpanel', { name: mode.title })).toBeInTheDocument();
    }
  });

  it('anchors heading navigation with exactly one h1 (spec §8.2)', () => {
    renderShell();
    const h1s = screen.getAllByRole('heading', { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent('BangerBox');
  });

  it('gives every mode the same heading hierarchy (spec §3.5 lens 1)', async () => {
    const user = userEvent.setup();
    renderShell();
    for (const mode of MODE_DEFINITIONS) {
      await user.click(screen.getByTestId(`mode-tab-${mode.id}`));
      // The cross-fade unmounts the outgoing mode before mounting the incoming one, so
      // wait for the new mode's own heading rather than the panel's `aria-label`.
      await screen.findByRole('heading', { level: 2, name: mode.title });

      // One h2 per mode — no mode may skip it or add a second of its own.
      expect(screen.getAllByRole('heading', { level: 2 }), mode.id).toHaveLength(1);

      // And nothing below it skips a level: an h4 only exists under an h3.
      if (screen.queryAllByRole('heading', { level: 4 }).length > 0) {
        expect(screen.queryAllByRole('heading', { level: 3 }).length, mode.id).toBeGreaterThan(0);
      }
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
  const allHard = {
    crossOriginIsolated: true,
    sharedArrayBuffer: true,
    audioWorklet: true,
    opfs: true,
    webAssembly: true,
    atomics: true,
  };
  const allSoft = { bluetooth: true, microphone: true, persistentStorage: true, wakeLock: true };
  const firefox = { engine: 'firefox' as const, name: 'Firefox', supported: false };

  it('explains each missing requirement individually, not as one blanket statement', () => {
    const report = evaluateCapabilities({ ...allHard, webAssembly: false, opfs: false }, allSoft);
    render(<CapabilityGate report={report} />);
    const alert = screen.getByRole('alert');

    // The plain-English name, what it costs the user, and the specific thing to try —
    // for BOTH items, not just a shared summary.
    expect(alert).toHaveTextContent('WebAssembly');
    expect(alert).toHaveTextContent('native speed');
    expect(alert).toHaveTextContent('enterprise/group policy');
    expect(alert).toHaveTextContent('Private file storage');
    expect(alert).toHaveTextContent('Private/incognito windows block this storage');
    expect(alert).toHaveTextContent('navigator.storage.getDirectory');
  });

  it('leads with a reload when only isolation is missing — the browser is fine', () => {
    const report = evaluateCapabilities(
      { ...allHard, crossOriginIsolated: false, sharedArrayBuffer: false },
      allSoft,
    );
    render(<CapabilityGate report={report} />);
    expect(screen.getByRole('alert')).toHaveTextContent('BangerBox needs one more reload');
    expect(screen.getByTestId('capability-gate-reload')).toBeInTheDocument();
  });

  it('does not offer the reload shortcut when a genuine capability is absent', () => {
    const report = evaluateCapabilities({ ...allHard, audioWorklet: false }, allSoft);
    render(<CapabilityGate report={report} />);
    expect(screen.getByRole('alert')).toHaveTextContent('can’t start in this browser');
    expect(screen.queryByTestId('capability-gate-reload')).not.toBeInTheDocument();
  });

  it('links to the repo, the wiki, and a troubleshooting guide that exists', () => {
    const report = evaluateCapabilities({ ...allHard, webAssembly: false }, allSoft);
    render(<CapabilityGate report={report} />);
    // In-repo, NOT the wiki: a GitHub wiki answers 200 with its Home page for any page
    // that does not exist, so an unwritten wiki deep link misdirects silently. See
    // core/platform/links.ts.
    expect(screen.getByRole('link', { name: /troubleshooting guide/i })).toHaveAttribute(
      'href',
      'https://github.com/BootBlock/BangerBox/blob/main/docs/TROUBLESHOOTING.md',
    );
    expect(screen.getByRole('link', { name: /documentation wiki/i })).toHaveAttribute(
      'href',
      'https://github.com/BootBlock/BangerBox/wiki',
    );
    expect(screen.getByRole('link', { name: /bangerbox on github/i })).toHaveAttribute(
      'href',
      'https://github.com/BootBlock/BangerBox',
    );
  });

  it('names an untested browser without blaming it for the fault', () => {
    const report = evaluateCapabilities({ ...allHard, webAssembly: false }, allSoft, firefox);
    render(<CapabilityGate report={report} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('You’re using Firefox');
    expect(alert).toHaveTextContent('Other browsers may still work');
  });

  it('says nothing about the browser when it is the supported one', () => {
    const report = evaluateCapabilities({ ...allHard, webAssembly: false }, allSoft);
    render(<CapabilityGate report={report} />);
    expect(screen.getByRole('alert')).not.toHaveTextContent('isn’t supported');
  });
});

describe('detectBrowser (spec §1.3 #15)', () => {
  // Edge and Chrome both carry "Safari" in their UA, so ordering is the whole test.
  it.each([
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
      'chromium',
      true,
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      'chromium',
      true,
    ],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0', 'firefox', false],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
      'safari',
      false,
    ],
  ])('identifies %s', (ua, engine, supported) => {
    const info = detectBrowser(ua);
    expect(info.engine).toBe(engine);
    expect(info.supported).toBe(supported);
  });
});
