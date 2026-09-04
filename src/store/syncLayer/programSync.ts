/**
 * Program sync subscriber (spec §4.3) — the store → graph half of a program change.
 *
 * The §4.2 pad strips a program change publishes are NOT here: publishing them writes
 * `useMixerStore`, which is store → store, and it lives in `derive/padStripMirror` beside the
 * write-back that keeps the §6 payload true (issue #133). §4.3 is the only code allowed to
 * touch audio nodes, and that rule means less every time a store → store write is filed
 * under it.
 */
import { useProgramStore } from '../useProgramStore';
import type { SyncBridge, Unsubscribe } from './bridge';

export function subscribeProgramSync(bridge: SyncBridge): Unsubscribe {
  return useProgramStore.subscribe(
    (state) => state.activeProgramId,
    (value) => {
      bridge.onActiveProgramChanged(value);
    },
  );
}
