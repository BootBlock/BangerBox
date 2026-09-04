/**
 * Toast announcement routing (spec §8.2, issue #34).
 *
 * Each toast used to take `role="status"` or `role="alert"` from its own severity, minting
 * a live region per notice — so a burst put several competing regions on the page at once.
 * The queue now announces through the one §8.2 announcer, on the channel severity chooses,
 * and each notice is announced exactly once however many times the queue re-renders.
 */
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { LiveRegion } from '@/ui/primitives';
import { useUIStore } from '@/store';
import { ToastViewport } from './ToastViewport';

function renderQueue() {
  return render(
    <>
      <LiveRegion />
      <ToastViewport />
    </>,
  );
}

const polite = () => screen.getByTestId('live-region').textContent ?? '';
const assertive = () => screen.getByTestId('live-region-assertive').textContent ?? '';

beforeEach(() => {
  const { toasts, dismissToast } = useUIStore.getState();
  for (const toast of toasts) dismissToast(toast.id);
});

describe('ToastViewport announcement routing (spec §8.2, issue #34)', () => {
  it('mints no live region of its own, however many notices are queued', async () => {
    const { container } = renderQueue();
    useUIStore.getState().pushToast('One', 'error');
    useUIStore.getState().pushToast('Two', 'warning');
    useUIStore.getState().pushToast('Three', 'info');
    await screen.findByText('Three');

    // Three toasts on screen, and the only live regions in the tree are the announcer's two.
    expect(screen.getAllByTestId('toast')).toHaveLength(3);
    expect(container.querySelectorAll('[aria-live]')).toHaveLength(2);
    expect(container.querySelectorAll('[role="status"], [role="alert"]')).toHaveLength(0);
  });

  it('interrupts for a warning or an error and waits its turn for the rest', async () => {
    renderQueue();
    useUIStore.getState().pushToast('Autosave failed', 'error');
    await screen.findByText('Autosave failed');
    expect(assertive()).toContain('Autosave failed');
    expect(polite()).not.toContain('Autosave failed');

    useUIStore.getState().pushToast('Project saved', 'success');
    await screen.findByText('Project saved');
    expect(polite()).toContain('Project saved');
    expect(assertive()).not.toContain('Project saved');
  });

  it('announces a repeating failure once, not once per retry', async () => {
    renderQueue();
    // `pushToast` refreshes a notice already on screen rather than queueing a second copy,
    // so an autosave failing every debounce tick keeps one id — which is what lets this be
    // announced once. A live region per toast could not have made that distinction.
    useUIStore.getState().pushToast('Autosave failed — will retry.', 'error');
    await screen.findByText('Autosave failed — will retry.');
    const first = assertive();

    useUIStore.getState().pushToast('Autosave failed — will retry.', 'error');
    useUIStore.getState().pushToast('Autosave failed — will retry.', 'error');
    expect(screen.getAllByTestId('toast')).toHaveLength(1);
    // Unchanged: a re-announcement would append a zero-width space to force a re-read.
    expect(assertive()).toBe(first);
  });

  it('names the notification region only while there is something in it', async () => {
    renderQueue();
    expect(screen.queryByRole('region', { name: 'Notifications' })).not.toBeInTheDocument();
    useUIStore.getState().pushToast('Project saved', 'success');
    await screen.findByText('Project saved');
    expect(screen.getByRole('region', { name: 'Notifications' })).toBeInTheDocument();
  });
});
