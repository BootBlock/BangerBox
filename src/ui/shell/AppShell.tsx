/**
 * AppShell — the persistent application frame (spec §8.1): transport bar across the top,
 * the 12-mode rail down the side, and the active mode in the content area. Sized in fluid
 * units (`dvh`, `rem`, grid `gap`) with no absolute-pixel guesswork (spec §3.5 lens 2).
 *
 * Mode switching is a `useUIStore.activeMode` read (spec §1.3 #9 — no router). Only the
 * active mode is mounted, so an inactive mode's rAF loops and subscriptions do not exist
 * rather than merely idling (spec §3.5 lens 5).
 *
 * The shell takes focus when it first appears (spec §8.2, issue #46). It mounts exactly
 * once per session, at the moment the §5.1 start gate unmounts the button that held focus —
 * so without this the caret falls back to `<body>` and a keyboard user starts again from
 * the top of the document, with no indication the application has arrived.
 */
import { useEffect, useRef } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useUIStore } from '@/store';
import { modeDefinition } from '@/features/modes';
import { ModeRail } from './ModeRail';
import { PlatformNotices } from './PlatformNotices';
import { TransportBar } from './TransportBar';
import { PerfHud } from './PerfHud';
import { useWakeLock } from './useWakeLock';

export function AppShell() {
  const activeMode = useUIStore((s) => s.activeMode);
  const mode = modeDefinition(activeMode);
  const reduceMotion = useReducedMotion();
  const Mode = mode.Component;
  const contentRef = useRef<HTMLElement | null>(null);

  // Hold a screen wake lock while the transport runs (spec §2.4).
  useWakeLock();

  // Land focus in the mode content once, when the shell first appears (spec §8.2).
  useEffect(() => {
    contentRef.current?.focus();
  }, []);

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      {/* The document's one `h1`. Visually hidden because the frame already says what the
          app is; heading-list navigation needs the top-level anchor regardless (§8.2). */}
      <h1 className="sr-only">BangerBox</h1>
      {/*
       * Skip link (spec §8.2, issue #46). The transport bar is roughly eleven tab stops and
       * precedes the content in every one of the 12 modes, so without this a keyboard user
       * crosses the whole bar on every mode switch.
       *
       * A button rather than an `href="#…"` anchor: §1.3 #9 rules out a router, and a hash
       * link would rewrite the URL away from the §2.4 `start_url` for the rest of the
       * session. Focusing the panel does everything the anchor would — the panel is already
       * `tabIndex={-1}`, and Tab continues from it.
       */}
      <button
        type="button"
        data-testid="skip-to-content"
        onClick={() => contentRef.current?.focus()}
        className="sr-only rounded-bb-sm bg-bb-accent px-4 py-2 text-sm font-bold text-bb-bg focus-visible:not-sr-only focus-visible:absolute focus-visible:top-2 focus-visible:left-2 focus-visible:z-50"
      >
        Skip to mode content
      </button>
      <TransportBar />
      <PlatformNotices />
      <div className="flex min-h-0 flex-1">
        <ModeRail />
        <main
          ref={contentRef}
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
          className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain p-3 lg:overflow-hidden"
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
              {/* Every mode gets its `h2` from here rather than from its own markup, so
                  the hierarchy under the `h1` is identical across all 12 (§3.5 lens 1)
                  and `Panel` can render `h3` beneath it unconditionally. */}
              <h2 className="sr-only">{mode.title}</h2>
              <Mode />
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
      <PerfHud />
    </div>
  );
}
