/**
 * Pad — the trigger primitive (spec §1.3.1: 128 pads, 8 banks × 16). Immediate press
 * feedback plus a velocity-driven glow (spec §8.3): the glow intensity is written as a
 * CSS custom property by a direct ref write and decays via a CSS transition, so a hit
 * costs zero React re-renders (spec §3.3 — velocity glow is explicitly named there).
 *
 * Velocity comes from the vertical position of the hit within the pad, the MPC-style
 * touch convention: strike low = soft, high = hard. Keyboard triggers (Space/Enter,
 * spec §8.2) use a fixed nominal velocity since a key press carries no position.
 */
import { useCallback, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { clampInt } from '@/core/math';

/** Velocity for keyboard-triggered hits — a firm-but-not-maximum default (spec §8.2). */
const KEYBOARD_VELOCITY = 100;
const MIN_VELOCITY = 1;
const MAX_VELOCITY = 127;

export interface PadProps {
  label: string;
  /** Pad index within the program, 0..127 (spec §1.3.1 — bank = index >> 4). */
  padIndex: number;
  /** Assigned pads render filled; empty pads stay outlined (spec §3.4 no dead controls). */
  assigned?: boolean;
  /** Latched visual state — used by Mute mode and Pad Perform (spec §8.5.3). */
  active?: boolean;
  selected?: boolean;
  disabled?: boolean;
  /**
   * Fill the grid cell instead of holding a square — for pad grids that scale to the
   * space left in a fit-to-viewport mode (spec §8.4). Velocity still reads off the
   * strike position, which is measured from the rendered box either way.
   */
  fill?: boolean;
  onTrigger: (padIndex: number, velocity: number) => void;
  onRelease?: (padIndex: number) => void;
  /** Secondary action — Program Edit selects the pad without sounding it. */
  onSelect?: (padIndex: number) => void;
  'data-testid'?: string;
}

export function Pad({
  label,
  padIndex,
  assigned = false,
  active = false,
  selected = false,
  disabled = false,
  fill = false,
  onTrigger,
  onRelease,
  onSelect,
  'data-testid': testId,
}: PadProps) {
  const rootRef = useRef<HTMLButtonElement | null>(null);

  /** Paint the velocity glow directly (spec §8.3) — never through React state. */
  const glow = useCallback((velocity: number) => {
    rootRef.current?.style.setProperty('--bb-pad-glow', String(velocity / MAX_VELOCITY));
  }, []);

  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      if (disabled) return;
      const rect = event.currentTarget.getBoundingClientRect();
      // Strike position: bottom of the pad = softest, top = hardest (MPC convention).
      const fromBottom = rect.height > 0 ? (rect.bottom - event.clientY) / rect.height : 1;
      const velocity = clampInt(fromBottom * MAX_VELOCITY, MIN_VELOCITY, MAX_VELOCITY);
      glow(velocity);
      onSelect?.(padIndex);
      onTrigger(padIndex, velocity);
    },
    [disabled, glow, onSelect, onTrigger, padIndex],
  );

  const handlePointerUp = useCallback(() => {
    if (disabled) return;
    glow(0);
    onRelease?.(padIndex);
  }, [disabled, glow, onRelease, padIndex]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      if (disabled || event.repeat) return;
      if (event.key !== ' ' && event.key !== 'Enter') return;
      event.preventDefault();
      glow(KEYBOARD_VELOCITY);
      onSelect?.(padIndex);
      onTrigger(padIndex, KEYBOARD_VELOCITY);
    },
    [disabled, glow, onSelect, onTrigger, padIndex],
  );

  const handleKeyUp = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      if (disabled) return;
      if (event.key !== ' ' && event.key !== 'Enter') return;
      glow(0);
      onRelease?.(padIndex);
    },
    [disabled, glow, onRelease, padIndex],
  );

  return (
    <button
      ref={rootRef}
      type="button"
      aria-label={label}
      aria-pressed={active}
      aria-disabled={disabled || undefined}
      data-testid={testId}
      data-assigned={assigned || undefined}
      data-selected={selected || undefined}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onPointerLeave={handlePointerUp}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      className={[
        'relative touch-none select-none rounded-bb-md border text-[0.625rem] font-semibold',
        fill ? 'h-full min-h-0 w-full' : 'aspect-square',
        // Press feedback is a GPU-composited transform only (spec §8.3 60 fps budget).
        'active:scale-95',
        assigned ? 'bg-bb-raised text-bb-text' : 'bg-bb-surface text-bb-muted',
        active ? 'border-bb-accent' : 'border-bb-line',
        selected ? 'ring-2 ring-bb-accent' : '',
        disabled ? 'opacity-40' : 'hover:border-bb-accent-strong',
      ].join(' ')}
      style={{
        // Velocity glow + press transition, both from design tokens (spec §3.6/§8.3).
        boxShadow: 'var(--shadow-bb-pad-glow)',
        transition: 'var(--transition-bb-pad)',
      }}
    >
      <span className="pointer-events-none absolute inset-0 flex items-center justify-center p-1">
        <span className="line-clamp-2 break-words">{label}</span>
      </span>
    </button>
  );
}
