/**
 * Program sync subscriber (spec §4.3). On active-program change the graph rebuilds the
 * pad voice chains (spec §5.3) in Phase 3; here the skeleton forwards the selection.
 */
import { useProgramStore } from '../useProgramStore';
import type { SyncBridge, Unsubscribe } from './bridge';

export function subscribeProgramSync(bridge: SyncBridge): Unsubscribe {
  return useProgramStore.subscribe(
    (state) => state.activeProgramId,
    (value) => bridge.onActiveProgramChanged(value),
  );
}
