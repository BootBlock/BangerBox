import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useFullscreen } from './useFullscreen';

/**
 * Drives jsdom's fullscreen surface, which is inert by default: the element property and
 * the two methods are stubbed so the hook's behaviour — including a *refused* request —
 * can be exercised without a real browser.
 */
function stubFullscreen(options: { enabled?: boolean; requestFails?: boolean } = {}) {
  const { enabled = true, requestFails = false } = options;
  let element: Element | null = null;

  const emitChange = () => document.dispatchEvent(new Event('fullscreenchange'));

  // jsdom implements none of these, so they are defined outright rather than spied on.
  Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, get: () => enabled });
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => element });

  const request = vi.fn(async () => {
    if (requestFails) throw new Error('denied');
    element = document.documentElement;
    emitChange();
  });
  const exit = vi.fn(async () => {
    element = null;
    emitChange();
  });

  document.documentElement.requestFullscreen = request;
  document.exitFullscreen = exit;

  return { request, exit, emitChange, setElement: (next: Element | null) => (element = next) };
}

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, 'fullscreenEnabled');
  Reflect.deleteProperty(document, 'fullscreenElement');
  Reflect.deleteProperty(document.documentElement, 'requestFullscreen');
  Reflect.deleteProperty(document, 'exitFullscreen');
});

describe('useFullscreen', () => {
  it('reports unavailable when the browser forbids fullscreen (spec §2.1 soft capability)', () => {
    stubFullscreen({ enabled: false });
    const { result } = renderHook(() => useFullscreen());
    expect(result.current.available).toBe(false);
  });

  it('enters fullscreen when windowed and leaves it when already fullscreen', async () => {
    const fs = stubFullscreen();
    const { result } = renderHook(() => useFullscreen());

    expect(result.current.available).toBe(true);
    expect(result.current.active).toBe(false);

    await act(async () => result.current.toggle());
    expect(fs.request).toHaveBeenCalledTimes(1);
    expect(result.current.active).toBe(true);

    await act(async () => result.current.toggle());
    expect(fs.exit).toHaveBeenCalledTimes(1);
    expect(result.current.active).toBe(false);
  });

  it('stays windowed when the browser refuses the request', async () => {
    stubFullscreen({ requestFails: true });
    const { result } = renderHook(() => useFullscreen());

    await act(async () => result.current.toggle());
    // A refused request must not leave the control lit.
    expect(result.current.active).toBe(false);
  });

  it('follows fullscreen exits the app did not initiate (Esc, browser chrome)', async () => {
    const fs = stubFullscreen();
    const { result } = renderHook(() => useFullscreen());

    await act(async () => result.current.toggle());
    expect(result.current.active).toBe(true);

    act(() => {
      fs.setElement(null);
      fs.emitChange();
    });
    expect(result.current.active).toBe(false);
  });
});
