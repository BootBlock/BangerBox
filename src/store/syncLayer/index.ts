/**
 * Sync-layer registration (spec §4.3). Wires every domain subscriber (mixer, transport,
 * program, hardware) to the graph bridge and returns a single disposer that unsubscribes
 * them all — so mode unmount / project close leave no dangling subscriptions (spec §3.5
 * lens 5, memory & resources). The engine passes the real audio-graph bridge; callers
 * with no graph (tests, headless boot) may omit it and get the no-op bridge.
 */
import { noopBridge, type SyncBridge, type Unsubscribe } from './bridge';
import { combineUnsubscribers } from './bridge';
import { subscribeMixerSync } from './mixerSync';
import { subscribeTransportSync } from './transportSync';
import { subscribeProgramSync } from './programSync';
import { subscribeProgramParamSync } from './programParams';
import { subscribeHardwareSync } from './hardwareSync';
import { subscribeTransientSync } from './transientSync';

export type { SyncBridge, Unsubscribe } from './bridge';
export { noopBridge } from './bridge';

/** Register all store→graph subscribers; call the returned disposer to unwire them. */
export function registerSyncSubscribers(bridge: SyncBridge = noopBridge): Unsubscribe {
  return combineUnsubscribers([
    subscribeMixerSync(bridge),
    subscribeTransportSync(bridge),
    subscribeProgramSync(bridge),
    subscribeProgramParamSync(bridge),
    subscribeHardwareSync(bridge),
    // The §4.1 transient channel (issue #27) — a continuous gesture reaches the graph here
    // rather than through a store write, so it never re-renders a React consumer (§3.3).
    subscribeTransientSync(bridge),
  ]);
}
