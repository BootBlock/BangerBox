/**
 * Hardware sync subscriber (spec §4.3). A Q-Link mode change remaps the encoders to the
 * new context (spec §10.3): the bindings saved for that mode are loaded from
 * `app_settings`, and a mode with none stored falls back to its defaults. The bridge is
 * notified too, so the graph side can react.
 */
import { loadBindingsForMode } from '@/core/midi/qlinkBindings';
import { getActiveRepositories } from '@/core/project/projectService';
import type { QLinkMode } from '@/core/project/schemas';
import { useHardwareStore } from '../useHardwareStore';
import type { SyncBridge, Unsubscribe } from './bridge';

export function subscribeHardwareSync(bridge: SyncBridge): Unsubscribe {
  return useHardwareStore.subscribe(
    (state) => state.qLinkMode,
    (value: QLinkMode) => {
      bridge.onQLinkModeChanged(value);
      // Before a project is open there is no database to read; the mode's defaults stand.
      void (async () => {
        try {
          await loadBindingsForMode(value, getActiveRepositories().settings);
        } catch {
          // Storage unavailable — leave the bindings empty so defaults apply (spec §10.3).
        }
      })();
    },
  );
}
