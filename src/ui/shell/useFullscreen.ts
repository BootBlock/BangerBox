/**
 * useFullscreen — tracks and toggles the Fullscreen API for the whole document.
 *
 * Fullscreen is a *soft* capability (spec §2.1): where it is unavailable the button is
 * hidden rather than shown broken, and a request the browser refuses leaves the app
 * exactly as it was. Losing fullscreen costs screen real estate, never audio state.
 *
 * The hook follows `fullscreenchange` rather than assuming its own request succeeded:
 * the user can leave fullscreen with Esc or the browser's own affordance, and the button
 * must reflect that without a click.
 */
import { useCallback, useEffect, useState } from 'react';

function isFullscreen(): boolean {
  // Loose null check on purpose: environments without the API leave this `undefined`
  // rather than `null`, and both mean "windowed".
  return typeof document !== 'undefined' && document.fullscreenElement != null;
}

export interface FullscreenControl {
  /** True while the document is displayed fullscreen. */
  readonly active: boolean;
  /** False when the browser or a permissions policy forbids fullscreen (spec §2.1). */
  readonly available: boolean;
  /** Enter if windowed, leave if fullscreen. Rejected requests are a no-op. */
  toggle: () => void;
}

export function useFullscreen(): FullscreenControl {
  const [active, setActive] = useState(isFullscreen);

  useEffect(() => {
    const onChange = () => setActive(isFullscreen());
    document.addEventListener('fullscreenchange', onChange);
    // The state can already have moved between the initial render and this effect.
    onChange();
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggle = useCallback(() => {
    // `fullscreenchange` drives the state either way, so nothing is set optimistically
    // here — a refused request must not leave the button lit.
    if (isFullscreen()) {
      void document.exitFullscreen().catch(() => {
        // Already exited, or the browser reclaimed it — nothing left to do.
      });
      return;
    }
    void document.documentElement.requestFullscreen().catch(() => {
      // Denied (no user gesture, or a permissions policy) — stay windowed silently.
    });
  }, []);

  const available =
    typeof document !== 'undefined' &&
    document.fullscreenEnabled === true &&
    typeof document.documentElement.requestFullscreen === 'function';

  return { active, available, toggle };
}
