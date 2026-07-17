/**
 * Hardware sync subscriber (spec §4.3). Q-Link mode changes remap encoders to the
 * active context (spec §10.3); Phase 8 acts on this, the skeleton forwards it.
 */
import { useHardwareStore } from '../useHardwareStore';
import type { SyncBridge, Unsubscribe } from './bridge';

export function subscribeHardwareSync(bridge: SyncBridge): Unsubscribe {
  return useHardwareStore.subscribe(
    (state) => state.qLinkMode,
    (value) => bridge.onQLinkModeChanged(value),
  );
}
