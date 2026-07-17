/**
 * Transport sync subscriber (spec §4.3). Narrow selectors (spec §3.3) forward
 * transport changes; Phase 4 routes these to the scheduler worker (spec §7.1.3).
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
