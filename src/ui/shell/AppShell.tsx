/**
 * AppShell — the persistent application frame (spec §8.1): transport bar across the top,
 * the 12-mode rail down the side, and the active mode in the content area. Sized in fluid
 * units (`dvh`, `rem`, grid `gap`) with no absolute-pixel guesswork (spec §3.5 lens 2).
 *
 * Mode switching is a `useUIStore.activeMode` read (spec §1.3 #9 — no router). Only the
 * active mode is mounted, so an inactive mode's rAF loops and subscriptions do not exist
 * rather than merely idling (spec §3.5 lens 5).
 */
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useUIStore } from '@/store';
import { modeDefinition } from '@/features/modes';
import { LiveRegion } from '@/ui/primitives';
import { ModeRail } from './ModeRail';
import { TransportBar } from './TransportBar';
import { PerfHud } from './PerfHud';
import { useWakeLock } from './useWakeLock';

export function AppShell() {
  const activeMode = useUIStore((s) => s.activeMode);
  const mode = modeDefinition(activeMode);
  const reduceMotion = useReducedMotion();
  const Mode = mode.Component;

  // Hold a screen wake lock while the transport runs (spec §2.4).
  useWakeLock();

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <TransportBar />
      <div className="flex min-h-0 flex-1">
        <ModeRail />
        <main
          id={`mode-panel-${mode.id}`}
          role="tabpanel"
          // Named by the mode's full title rather than `aria-labelledby` the tab: the rail
          // label is abbreviated to fit the touch target ("Perform", "Q-Link"), and the
          // panel deserves the unambiguous name.
          aria-label={mode.title}
          tabIndex={-1}
          // A mode fits its viewport rather than scrolling as a page (spec §8.4) — the give
          // comes from the panels built to absorb it. Below `lg` the modes stack into one
          // column where fitting is not possible, so the scroll stays there.
          className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3 lg:overflow-hidden"
        >
          <AnimatePresence mode="wait">
            <motion.div
              key={mode.id}
              // Mode changes cross-fade; a mode is content, not a spatial move, so no
              // slide (and nothing at all under prefers-reduced-motion — spec §8.2/§8.3).
              initial={reduceMotion ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={reduceMotion ? { opacity: 1 } : { opacity: 0 }}
              transition={{ duration: 0.12 }}
              className="flex min-h-0 flex-1 flex-col gap-3"
            >
              <Mode />
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
      <PerfHud />
      <LiveRegion />
    </div>
  );
}
