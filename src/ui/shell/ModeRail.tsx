/**
 * ModeRail — the persistent 12-mode switcher (spec §8.1, §8.5). Modes are switched through
 * `useUIStore.activeMode`, never a router (spec §1.3 #9).
 *
 * Presented as an ARIA tab list: arrow keys move between modes with a roving tabindex, and
 * the active indicator is a `motion` shared `layoutId` so it slides between entries rather
 * than cutting (spec §8.3 — shared layout IDs for the mode rail), collapsing to no motion
 * under `prefers-reduced-motion` (spec §8.2).
 *
 * ## The app's three selection idioms, and which is which
 *
 * "This one is the active one" was being expressed three ways across the modes, so a
 * screen-reader user heard the same fact described differently depending on where they
 * were. All three attributes are legitimate; each answers a different question, and the
 * rule is which question the control is actually asking:
 *
 *   `aria-selected` — only inside a role that defines selection: `tab` (this rail),
 *   `treeitem` (the Browser's folder tree), `option`, `row`. Invalid anywhere else, so it
 *   never leaks into a plain group of buttons.
 *
 *   `aria-pressed` — an independently toggleable control that the user can turn back off:
 *   a mute, a favourite, a bypass, a held performance pad. If pressing it again cannot
 *   un-press it, this is the wrong attribute.
 *
 *   `aria-current` — one of a set of plain buttons is the one being acted on, and picking
 *   another moves the mark rather than adding a second: the sequence list, the sample
 *   list, the pad grid in Pad Edit, the note list in Grid.
 *
 * The last group was the drift: those were written as `aria-pressed`, which announces a
 * list of sixteen pads as fifteen unpressed toggles instead of one current item.
 */
import { useRef, type KeyboardEvent } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { useUIStore, type Mode } from '@/store';
import { MODE_DEFINITIONS } from '@/features/modes';
import { SPRING_BB_LAYOUT } from '@/ui/motionTokens';

/**
 * Two columns, because one does not fit. Twelve 64 px entries stacked singly need
 * 12 × 64 + 11 × 4 + 16 = 828 px of rail, against roughly 712 px of content row at the
 * 1280 × 800 target — so the rail always overflowed and the last two modes (Q-Link Edit and
 * Song) were off-screen on first paint, reachable only by dragging an 80 px strip. Six rows
 * of two need 404 px and fit with room to spare, and §8.1's "touch-large" entries keep
 * their full 64 px rather than being shrunk to fit a single column.
 */
const RAIL_COLUMNS = 2;

export function ModeRail() {
  const activeMode = useUIStore((s) => s.activeMode);
  const listRef = useRef<HTMLDivElement | null>(null);
  const reduceMotion = useReducedMotion();

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    // Two columns filled row-major, so left/right step one mode and up/down step a whole
    // row. Both wrap over the flat order, which keeps every mode reachable with either axis.
    const step =
      event.key === 'ArrowRight'
        ? 1
        : event.key === 'ArrowLeft'
          ? -1
          : event.key === 'ArrowDown'
            ? RAIL_COLUMNS
            : event.key === 'ArrowUp'
              ? -RAIL_COLUMNS
              : 0;
    if (step === 0) return;
    event.preventDefault();
    const index = MODE_DEFINITIONS.findIndex((mode) => mode.id === activeMode);
    if (index < 0) return;
    const count = MODE_DEFINITIONS.length;
    const nextIndex = (((index + step) % count) + count) % count;
    const next = MODE_DEFINITIONS[nextIndex];
    if (!next) return;
    useUIStore.getState().setActiveMode(next.id as Mode);
    listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIndex]?.focus();
  };

  return (
    <nav
      aria-label="Modes"
      // `overscroll-contain` for the short-viewport case where the rail does still scroll:
      // its edge must not chain into a history navigation (spec §1.3 #14).
      className="flex shrink-0 overflow-y-auto overscroll-contain border-r border-bb-line bg-bb-surface p-2"
    >
      <div
        ref={listRef}
        role="tablist"
        aria-label="Modes"
        // No `aria-orientation`: the rail is a grid, and neither axis alone describes it.
        // `auto-rows-fr`: the six rows share the rail's height equally, so the space freed
        // by the second column is spent making each entry taller than its `min-h-16` floor
        // rather than left as dead rail. Below the height where that floor binds, the six
        // rows overflow and the nav scrolls — the same fallback as before, but now reached
        // only on a viewport far shorter than the 1280 × 800 target.
        className="grid w-full auto-rows-fr grid-cols-2 gap-1"
      >
        {MODE_DEFINITIONS.map((mode) => {
          const selected = mode.id === activeMode;
          const Icon = mode.icon;
          return (
            <button
              key={mode.id}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`mode-panel-${mode.id}`}
              id={`mode-tab-${mode.id}`}
              // Roving tabindex: the rail is one tab stop, arrows move within it (spec §8.2).
              tabIndex={selected ? 0 : -1}
              data-testid={`mode-tab-${mode.id}`}
              onKeyDown={handleKeyDown}
              onClick={() => useUIStore.getState().setActiveMode(mode.id as Mode)}
              // Touch-large hit target for the tablet form factor (spec §8.1).
              className={`relative flex min-h-16 w-20 flex-col items-center justify-center gap-1 rounded-bb-md px-1 py-2 text-bb-micro font-semibold transition-colors duration-150 ease-bb-snap ${
                selected ? 'text-bb-bg' : 'text-bb-muted hover:text-bb-text'
              }`}
            >
              {selected && (
                // Shared layout id — the indicator slides between modes (spec §8.3).
                <motion.span
                  layoutId={reduceMotion ? undefined : 'mode-rail-indicator'}
                  aria-hidden="true"
                  className="absolute inset-0 rounded-bb-md bg-bb-accent"
                  transition={SPRING_BB_LAYOUT}
                />
              )}
              <Icon size={18} aria-hidden="true" className="relative" />
              <span className="relative text-center leading-tight">{mode.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
