/**
 * Transport sync subscriber (spec §4.3). Narrow selectors (spec §3.3) forward
 * transport changes to the bridge. The audio graph has nothing to do with them — the
 * scheduler worker owns transport (spec §7.1.3) and is driven by the engine directly.
 */
import { useTransportStore } from '../useTransportStore';
import { combineUnsubscribers, type SyncBridge, type Unsubscribe } from './bridge';

export function subscribeTransportSync(bridge: SyncBridge): Unsubscribe {
  // Wrap so only the current value reaches the bridge — the subscriber also passes the
  // previous value, which the graph does not need.
  return combineUnsubscribers([
    useTransportStore.subscribe(
      (state) => state.isPlaying,
      (value) => bridge.setTransportPlaying(value),
    ),
    useTransportStore.subscribe(
      (state) => state.isRecording,
      (value) => bridge.setTransportRecording(value),
    ),
    useTransportStore.subscribe(
      (state) => state.bpm,
      (value) => bridge.setBpm(value),
    ),
  ]);
}
