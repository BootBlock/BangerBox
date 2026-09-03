/**
 * Transient-channel sync subscriber (spec §4.3, §4.1 — issue #27).
 *
 * The §4.1 transient channel carries a continuous gesture's values, and §3.3 forbids them
 * from passing through React state or a Zustand-driven re-render. They used to reach the
 * graph as a side effect of a store write, which is what made every consumer of `channels`
 * and `programs` re-render sixty times a second while a knob turned. They now arrive here
 * instead, and this is the only subscriber.
 *
 * **One `applyParam` per value, whatever the address.** `audioBridge.applyAutomation` — which
 * `applyParam` is the "apply it now" form of — already resolves every §7.8 address kind:
 * channel level, pan, sends, insert parameters, and the per-voice program leaves. That is
 * also why this is an improvement to what a gesture COSTS the graph rather than only to what
 * it costs React: `mixerSync`'s diff sees a new `inserts` array whenever an insert parameter
 * moves and rebuilds the whole serial insert chain, so dragging one delay's feedback used to
 * tear down and recreate every effect on the strip per pointer sample. `setInsertParam`
 * ramps the one `AudioParam` instead.
 *
 * The commit that ends a gesture still writes the store, so `mixerSync` and
 * `programParams` apply the committed value again. Applying the same value twice is free —
 * both paths ramp to it — and that second write is what keeps undo, hydration and every
 * non-gesture edit flowing through the §4.3 diff exactly as before.
 */
import { subscribeTransientChannel } from '../transientChannel';
import type { SyncBridge, Unsubscribe } from './bridge';

export function subscribeTransientSync(bridge: SyncBridge): Unsubscribe {
  return subscribeTransientChannel((path, value) => bridge.applyParam(path, value));
}
