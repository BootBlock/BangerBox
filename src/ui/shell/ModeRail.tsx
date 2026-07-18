/**
 * ModeRail — the persistent 12-mode switcher (spec §8.1, §8.5). Modes are switched through
 * `useUIStore.activeMode`, never a router (spec §1.3 #9).
 *
 * Presented as an ARIA tab list: arrow keys move between modes with a roving tabindex, and
 * the active indicator is a `motion` shared `layoutId` so it slides between entries rather
 * than cutting (spec §8.3 — shared layout IDs for the mode rail), collapsing to no motion
 * under `prefers-reduced-motion` (spec §8.2).
 */
import { useRef, type KeyboardEvent } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { useUIStore, type Mode } from '@/store';
import { MODE_DEFINITIONS } from '@/features/modes';

export function ModeRail() {
  const activeMode = useUIStore((s) => s.activeMode);
  const listRef = useRef<HTMLDivElement | null>(null);
  const reduceMotion = useReducedMotion();

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const forward = event.key === 'ArrowDown' || event.key === 'ArrowRight';
    const backward = event.key === 'ArrowUp' || event.key === 'ArrowLeft';
    if (!forward && !backward) return;
    event.preventDefault();
    const index = MODE_DEFINITIONS.findIndex((mode) => mode.id === activeMode);
    if (index < 0) return;
    const nextIndex = (index + (forward ? 1 : -1) + MODE_DEFINITIONS.length) % MODE_DEFINITIONS.length;
    const next = MODE_DEFINITIONS[nextIndex];
    if (!next) return;
    useUIStore.getState().setActiveMode(next.id as Mode);
    listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIndex]?.focus();
  };

  return (
    <nav
      aria-label="Modes"
      className="flex shrink-0 overflow-y-auto border-r border-bb-line bg-bb-surface p-2"
    >
      <div
        ref={listRef}
        role="tablist"
        aria-label="Modes"
        aria-orientation="vertical"
        className="flex flex-col gap-1"
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
              className={`relative flex min-h-16 w-20 flex-col items-center justify-center gap-1 rounded-bb-md px-1 py-2 text-[0.625rem] font-semibold transition-colors duration-150 ease-bb-snap ${
                selected ? 'text-bb-bg' : 'text-bb-muted hover:text-bb-text'
              }`}
            >
              {selected && (
                // Shared layout id — the indicator slides between modes (spec §8.3).
                <motion.span
                  layoutId={reduceMotion ? undefined : 'mode-rail-indicator'}
                  aria-hidden="true"
                  className="absolute inset-0 rounded-bb-md bg-bb-accent"
                  transition={{ type: 'spring', stiffness: 420, damping: 34 }}
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
