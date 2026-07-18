import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UnsupportedBrowserNotice } from './UnsupportedBrowserNotice';

const firefox = { engine: 'firefox' as const, name: 'Firefox', supported: false };
const chromium = { engine: 'chromium' as const, name: 'your browser', supported: true };

describe('UnsupportedBrowserNotice (spec §1.3 #15)', () => {
  // The test environment provides no usable Storage at all, so stub a real in-memory one
  // — otherwise the dismissal test would pass for the wrong reason (the component's
  // storage-blocked fallback, not the persistence it is meant to prove).
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('warns on an untested engine, and points at help', () => {
    render(<UnsupportedBrowserNotice browser={firefox} />);
    expect(screen.getByTestId('unsupported-browser-notice')).toHaveTextContent('Firefox isn’t supported yet');
    expect(screen.getByRole('link', { name: /troubleshooting guide/i })).toHaveAttribute(
      'href',
      'https://github.com/BootBlock/BangerBox/blob/main/docs/TROUBLESHOOTING.md',
    );
  });

  it('stays out of the way on the supported browser', () => {
    render(<UnsupportedBrowserNotice browser={chromium} />);
    expect(screen.queryByTestId('unsupported-browser-notice')).not.toBeInTheDocument();
  });

  it('is dismissible, and stays dismissed on the next load', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<UnsupportedBrowserNotice browser={firefox} />);
    await user.click(screen.getByTestId('unsupported-browser-dismiss'));
    expect(screen.queryByTestId('unsupported-browser-notice')).not.toBeInTheDocument();

    unmount();
    render(<UnsupportedBrowserNotice browser={firefox} />);
    expect(screen.queryByTestId('unsupported-browser-notice')).not.toBeInTheDocument();
  });

  it('never blocks the app — it is a status, not an alert', () => {
    render(<UnsupportedBrowserNotice browser={firefox} />);
    expect(screen.getByTestId('unsupported-browser-notice')).toHaveAttribute('role', 'status');
  });
});
