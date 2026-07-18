import { useEffect } from 'react';
import type { CapabilityReport } from '@/core/platform/capabilities';
import { useUIStore } from '@/store';
import { AppShell } from '@/ui/shell/AppShell';
import { StartGate } from '@/ui/shell/StartGate';
import { PwaUpdatePrompt } from '@/ui/PwaUpdatePrompt';
import { ToastViewport } from '@/ui/ToastViewport';
import { UnsupportedBrowserNotice } from '@/ui/UnsupportedBrowserNotice';
import { useUndoKeyboard } from '@/ui/useUndoKeyboard';
import type { PwaUpdateApi } from '@/ui/usePwaUpdate';

interface AppProps {
  capabilities: CapabilityReport;
  /** Test seam for the PWA update flow; production uses the browser seam. */
  pwaApiOverride?: PwaUpdateApi;
}

/**
 * Application root (spec §8.1). The capability gate has already passed by the time this
 * mounts (spec §2.1 — it runs before any store hydration), so this composes the persistent
 * shell: transport bar, mode rail, active mode, plus the global overlays (toasts, the PWA
 * update prompt) and the app-wide undo shortcuts (spec §4.5).
 */
export function App({ capabilities, pwaApiOverride }: AppProps) {
  useUndoKeyboard();

  // Freeze the capability report into the UI store once (spec §2.1); soft capabilities
  // gate individual features (Looper mic source, hardware mode) from there.
  useEffect(() => {
    useUIStore.getState().setCapabilities(capabilities);
  }, [capabilities]);

  return (
    <>
      {/* Nothing behind the gate mounts until the engine is running (spec §5.1). */}
      <StartGate>
        <AppShell />
      </StartGate>
      <PwaUpdatePrompt apiOverride={pwaApiOverride} />
      <ToastViewport />
      {/* Non-blocking: the gate already let this browser through on capability (spec §2.1);
          this only warns that the engine is untested (spec §1.3 #15). */}
      <UnsupportedBrowserNotice browser={capabilities.browser} />
    </>
  );
}
