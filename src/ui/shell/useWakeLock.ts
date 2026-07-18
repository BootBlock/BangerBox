/**
 * useWakeLock — holds a Screen Wake Lock while the transport is playing or recording
 * (spec §2.4), releasing it on stop and on unmount. The controller owns the API detail;
 * this hook only follows transport state.
 *
 * It subscribes to the store directly rather than selecting into React state: the lock is
 * a side effect, not something the shell renders, so waking React for it would be pure
 * overhead (spec §3.3).
 */
import { useEffect } from 'react';
import { browserWakeLockApi, createWakeLockController } from '@/core/platform/wakeLock';
import { useTransportStore } from '@/store';

export function useWakeLock(): void {
  useEffect(() => {
    const controller = createWakeLockController(browserWakeLockApi());
    const unsubscribe = useTransportStore.subscribe(
      (state) => state.isPlaying || state.isRecording,
      (active) => {
        void controller.setActive(active);
      },
      { fireImmediately: true },
    );
    return () => {
      unsubscribe();
      void controller.dispose();
    };
  }, []);
}
