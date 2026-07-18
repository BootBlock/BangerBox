/**
 * `useQLinkFocus` — the Screen-mode Q-Link focus registry (spec §10.3): "encoders map to
 * the currently focused UI panel — components register their parameters via a
 * `useQLinkFocus(params[])` hook into `useUIStore`'s focus registry; e.g. opening a Delay
 * insert maps knobs to Time/Feedback/Mix/Tone".
 *
 * A panel declares the parameters it offers while it is mounted; unmounting withdraws
 * them, so the encoders never keep addressing a panel that is no longer on screen (spec
 * §3.5 lens 5). The list is written to the store, not React state, because the Q-Link
 * runtime reads it outside React (spec §3.3).
 */
import { useEffect } from 'react';
import { useUIStore, type QLinkFocusParam } from '@/store';

/**
 * Publish this panel's Q-Link parameters while it is mounted. Pass a stable array (or one
 * built with `useMemo`) — the registry is rewritten whenever the identity changes.
 */
export function useQLinkFocus(params: readonly QLinkFocusParam[]): void {
  useEffect(() => {
    useUIStore.getState().setFocusedControlParams([...params]);
    return () => {
      // Withdraw only if this panel's list is still the one in force: a panel mounting as
      // this one unmounts must not have its registration cleared by the outgoing panel.
      const current = useUIStore.getState().focusedControlParams;
      const stillOurs =
        current.length === params.length &&
        current.every((entry, index) => entry.targetParameterPath === params[index]?.targetParameterPath);
      if (stillOurs) useUIStore.getState().setFocusedControlParams([]);
    };
  }, [params]);
}
