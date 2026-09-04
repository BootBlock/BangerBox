/**
 * Shell platform-notice tests (spec §2.1 soft requirements, §9.7 storage safeguards;
 * issue #51). §9.7 asks for "a persistent dismissible warning that the browser may evict
 * data"; the assertions below are what "persistent", "dismissible" and "visible in all 12
 * modes" mean in the DOM — readable text and a real button, rather than a `title`
 * attribute a keyboard never reaches and a touch device cannot open at all.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { evaluateCapabilities } from '@/core/platform/capabilities';
import type { SoftCapabilities } from '@/core/platform/capabilities';
import { useUIStore } from '@/store';
import { LiveRegion } from '@/ui/primitives';
import { PlatformNotices } from './PlatformNotices';

const ALL_HARD = {
  crossOriginIsolated: true,
  sharedArrayBuffer: true,
  audioWorklet: true,
  opfs: true,
  webAssembly: true,
  atomics: true,
};
const ALL_SOFT: SoftCapabilities = {
  bluetooth: true,
  microphone: true,
  persistentStorage: true,
  wakeLock: true,
};

function setCapabilities(soft: Partial<SoftCapabilities>): void {
  useUIStore.getState().setCapabilities(evaluateCapabilities(ALL_HARD, { ...ALL_SOFT, ...soft }));
}

describe('PlatformNotices (spec §2.1, §9.7, issue #51)', () => {
  beforeEach(() => {
    setCapabilities({});
    useUIStore.setState({ storagePersisted: null });
  });

  it('says nothing at all when the device can do everything', () => {
    useUIStore.getState().setStoragePersisted(true);
    render(<PlatformNotices />);
    expect(screen.queryByTestId('platform-notices')).not.toBeInTheDocument();
  });

  it('says nothing before the persistence request has answered', () => {
    // `null` is "not yet asked", which is not a refusal — warning then would put a scare
    // on screen for the first moments of every single session.
    render(<PlatformNotices />);
    expect(screen.queryByTestId('platform-notice-persistentStorage')).not.toBeInTheDocument();
  });

  it('warns about eviction as readable, dismissible text when the grant is refused (§9.7)', async () => {
    const user = userEvent.setup();
    useUIStore.getState().setStoragePersisted(false);
    render(<PlatformNotices />);

    const notice = screen.getByTestId('platform-notice-persistentStorage');
    expect(notice).toHaveTextContent(/may clear your projects/i);
    // What the fix actually is, not merely that something is wrong.
    expect(notice).toHaveTextContent(/Install BangerBox as an app/i);

    // Dismissible by a real button, which a keyboard reaches and a touch device can press —
    // the `title` attribute this replaced could be reached by neither.
    await user.click(screen.getByRole('button', { name: /^Dismiss/ }));
    expect(screen.queryByTestId('platform-notice-persistentStorage')).not.toBeInTheDocument();
  });

  it('warns when the browser cannot even ask to persist, for the same consequence', () => {
    setCapabilities({ persistentStorage: false });
    render(<PlatformNotices />);
    expect(screen.getByTestId('platform-notice-persistentStorage')).toBeInTheDocument();
  });

  it('gives the wake lock the §2.1 explanation it had nowhere else', () => {
    setCapabilities({ wakeLock: false });
    useUIStore.getState().setStoragePersisted(true);
    render(<PlatformNotices />);
    const notice = screen.getByTestId('platform-notice-wakeLock');
    expect(notice).toHaveTextContent(/screen may dim/i);
    // It says the audio is unaffected: a dimmed screen is a nuisance, not a data risk, and
    // a warning that does not say so reads as though something is broken.
    expect(notice).toHaveTextContent(/audio keeps playing/i);
  });

  it('distinguishes two Dismiss buttons by what each dismisses (spec §8.2)', () => {
    setCapabilities({ wakeLock: false });
    useUIStore.getState().setStoragePersisted(false);
    render(<PlatformNotices />);
    const names = screen.getAllByRole('button').map((button) => button.getAttribute('aria-label'));
    expect(new Set(names).size).toBe(2);
    expect(names.every((name) => name?.startsWith('Dismiss'))).toBe(true);
  });

  it('says nothing about Bluetooth or the microphone, which their own controls handle', () => {
    setCapabilities({ bluetooth: false, microphone: false });
    useUIStore.getState().setStoragePersisted(true);
    render(<PlatformNotices />);
    // §2.1 prefers a disabled control with its reason beside it, and Q-Link Edit and the
    // Looper each already do exactly that. A shell strip would repeat it in eleven modes
    // where nothing can be done about it.
    expect(screen.queryByTestId('platform-notices')).not.toBeInTheDocument();
  });

  it('does not re-announce a surviving notice when its neighbour is dismissed', async () => {
    const user = userEvent.setup();
    setCapabilities({ wakeLock: false });
    useUIStore.getState().setStoragePersisted(false);
    render(
      <>
        <LiveRegion />
        <PlatformNotices />
      </>,
    );

    const announced = () => screen.getByTestId('live-region').textContent ?? '';
    const first = announced();
    // Both conditions are named once, when the DEVICE raises them.
    expect(first).toMatch(/deleted to reclaim space/i);
    expect(first).toMatch(/screen may dim/i);

    await user.click(screen.getByRole('button', { name: /^Dismiss Your work/ }));
    // Dismissing is a UI act; the device has not changed, so nothing is said again.
    expect(announced()).toBe(first);
  });

  it('carries no live region of its own (spec §8.2, issue #34)', () => {
    useUIStore.getState().setStoragePersisted(false);
    const { container } = render(<PlatformNotices />);
    expect(container.querySelectorAll('[aria-live], [role="status"], [role="alert"]')).toHaveLength(0);
  });
});
