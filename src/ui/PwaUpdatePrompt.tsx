import { useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useProjectStore } from '@/store';
import { Button } from './primitives';
import { usePwaUpdate, type PwaUpdateApi } from './usePwaUpdate';

/**
 * Reload onto the new build, but only once autosave has drained — this is the one reload
 * path the app controls, so it can await the flush that `beforeunload` cannot (issue #42).
 * A failed flush is already surfaced as a toast by the autosave queue and must not strand
 * the user on the old build, so the reload proceeds either way.
 */
async function flushThenUpdate(update: () => Promise<void>): Promise<void> {
  try {
    await useProjectStore.getState().saveNow();
  } catch {
    // Reported by the autosave error toast; reloading is still the user's request.
  }
  await update();
}

/**
 * "Reload to update" toast — spec §2.4. A new build waits until the user accepts;
 * the page is never reloaded out from under an unsaved project. "Not now" snoozes the
 * prompt until a genuinely newer worker appears (visibility is derived: a snooze
 * records the sequence number it silenced, and a fresh worker increments past it).
 */
export function PwaUpdatePrompt({ apiOverride }: { apiOverride?: PwaUpdateApi }) {
  const { needRefresh, updateAvailableSeq, update } = usePwaUpdate(apiOverride);
  const [snoozedSeq, setSnoozedSeq] = useState(0);
  const reduceMotion = useReducedMotion();

  const visible = needRefresh && updateAvailableSeq > snoozedSeq;

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          role="status"
          aria-live="polite"
          initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 16 }}
          animate={reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 16 }}
          transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
          className="fixed right-4 bottom-4 z-50 flex items-center gap-3 rounded-bb-md border border-bb-line bg-bb-raised px-4 py-3 shadow-bb-raised"
        >
          <p className="text-sm">A new version of BangerBox is ready.</p>
          <Button label="Reload to update" variant="accent" onClick={() => void flushThenUpdate(update)} />
          <Button label="Not now" variant="quiet" onClick={() => setSnoozedSeq(updateAvailableSeq)} />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
