/**
 * The §4.1 transient channel, carried entirely outside React (spec §3.3, issue #27).
 *
 * §4.1 gives every store a transient channel for continuous gestures: `setTransient` moves
 * the graph without an undo entry or an autosave write, and `commit` finalises. §3.3 then
 * forbids the values it carries — "XY touch position, knob drag angle mid-gesture" — from
 * ever reaching React state or a Zustand-driven re-render.
 *
 * Both stores used to implement `setTransient` as an ordinary `set()`, which replaces the
 * containing map's identity. Every component selecting `channels` or `programs` therefore
 * re-rendered on every pointer sample and every §10.4 rAF-aligned CC frame — about sixty
 * store writes a second while an encoder turns — and Q-Link Edit rebuilt an option list of
 * thousands of `<option>` elements inside each of them, in the very mode the user is in
 * while turning that encoder. A gesture now publishes here instead: the §4.3 sync layer
 * subscribes and applies the value to the graph, and React sees nothing until the commit.
 *
 * Three rules hold the design together:
 *
 * - **The overlay is the live value, and the store is the committed one.** A relative §10.3
 *   encoder steps from where the parameter is NOW, so something has to hold that between
 *   frames once the store has stopped moving. {@link readTransientValue} is that reading, and
 *   it is why this is a channel with memory rather than a plain event bus.
 * - **A commit publishes before it settles.** The committed value may not be the last one
 *   the gesture published — XYFX's release-return commits where the axes RESTED — so the
 *   graph is told the committed value explicitly rather than left on whatever the gesture
 *   last sent. A store diff cannot cover it: the store never moved, so it sees no change.
 * - **Addresses are canonical §7.8 registry paths.** The sync layer applies them through
 *   `bridge.applyParam`, which parses them with the registry (spec §13.6, one grammar owner),
 *   so a legacy address is canonicalised by the store before it is published.
 */
import type { Unsubscribe } from './syncLayer/bridge';

export type TransientListener = (path: string, value: number) => void;

const listeners = new Set<TransientListener>();
/** The live value at each path with a gesture in flight. Empty between gestures. */
const overlay = new Map<string, number>();

/**
 * Publish a mid-gesture value: record it as live and notify the sync layer.
 *
 * Deliberately synchronous and unbatched. The §4.3 subscribers turn this into an
 * `AudioParam` ramp, and a gesture the graph hears a frame late is a gesture that feels
 * late — which is what §11.5's touch-to-sound budget is about.
 */
export function publishTransient(path: string, value: number): void {
  overlay.set(path, value);
  for (const listener of listeners) listener(path, value);
}

/**
 * Drop a path's live value, because its store now holds the committed one.
 *
 * Called by `commit`, AFTER it has published the committed value: the reading must never
 * fall back to the store while the graph is still on the gesture's last position.
 */
export function settleTransient(path: string): void {
  overlay.delete(path);
}

/** True while any gesture is in flight — the cheap guard on a per-note lookup (issue #27). */
export function anyTransientInFlight(): boolean {
  return overlay.size > 0;
}

/**
 * The value a path is at right now, or `undefined` when no gesture is in flight on it.
 *
 * A caller with `undefined` reads its own store, which holds the committed value. Only a
 * relative encoder and the store actions themselves need this; a component must not, because
 * reading it per frame is the re-render this module exists to remove.
 */
export function readTransientValue(path: string): number | undefined {
  return overlay.get(path);
}

/** Subscribe to every transient publish. The §4.3 sync layer is the only subscriber. */
export function subscribeTransientChannel(listener: TransientListener): Unsubscribe {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Subscribe to one address, for a control that must show a gesture it is not driving.
 *
 * §10.3 ends its execution flow with "UI reacts concurrently": a §10.4 encoder turn has to
 * move the on-screen knob as it happens, not at the 250 ms idle commit. §3.3 says how that
 * is allowed to happen — "direct ref style writes", never a re-render — so a control paints
 * itself from this and React learns nothing until the commit. A control drives its own
 * publish and paints its own gesture, so the value it just sent is filtered out by the
 * caller having nothing to do differently, not by this.
 */
export function subscribeTransientPath(path: string, onValue: (value: number) => void): Unsubscribe {
  return subscribeTransientChannel((published, value) => {
    if (published === path) onValue(value);
  });
}

/**
 * Forget every in-flight gesture — project close and test isolation (spec §3.5 lens 5).
 *
 * A stale overlay entry would make the next gesture on that path step from a value the
 * closed project held, and would answer `readTransientValue` for a parameter that no longer
 * exists. Listeners are left alone: they belong to the sync layer's own lifecycle.
 */
export function resetTransientChannel(): void {
  overlay.clear();
}
