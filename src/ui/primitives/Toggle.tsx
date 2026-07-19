/**
 * Toggle — a two-state control rendered as a real `<button>` with `aria-pressed`
 * (spec §8.2). Tones carry meaning consistently across the app (accent = engaged,
 * danger = record/destructive, warn = caution), so call sites never re-style a toggle
 * themselves (spec §3.6).
 *
 * Shares Button's `whileTap` press spring (spec §8.3) so a toggle and a button next to each
 * other in a transport bar answer a finger the same way. `SegmentControl` deliberately does
 * not: its options sit shoulder to shoulder inside an `overflow-hidden` group, where
 * shrinking one would open a seam against its neighbours.
 */
import type { ReactNode } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { PRESS_SCALE, SPRING_BB_PRESS } from '@/ui/motionTokens';

export type ToggleTone = 'accent' | 'danger' | 'warn' | 'neutral';

/**
 * `lg` is the *performance* size: a toggle thrown mid-take, where the target has to be
 * found without looking (spec §8.5.3 — large touch hitboxes for live mute/solo). It draws
 * large rather than relying on `bb-touch-target`, because an invisible hit area still
 * leaves the eye aiming at a small button.
 */
export type ToggleSize = 'sm' | 'md' | 'lg';

export interface ToggleProps {
  label: string;
  pressed: boolean;
  onChange: (pressed: boolean) => void;
  tone?: ToggleTone;
  disabled?: boolean;
  /** Optional leading icon; label text still carries the accessible name (spec §8.2). */
  icon?: ReactNode;
  /** Hide the text label visually while keeping it as the accessible name. */
  iconOnly?: boolean;
  size?: ToggleSize;
  /** Stretch to the width of the container rather than hugging the label, as Button does. */
  block?: boolean;
  title?: string;
  'data-testid'?: string;
}

const PRESSED_TONE: Record<ToggleTone, string> = {
  accent: 'bg-bb-accent text-bb-bg border-bb-accent',
  danger: 'bg-bb-danger text-bb-bg border-bb-danger',
  warn: 'bg-bb-warn text-bb-bg border-bb-warn',
  neutral: 'bg-bb-line text-bb-text border-bb-line',
};

const SIZE: Record<ToggleSize, string> = {
  sm: 'px-2 py-1 text-bb-micro gap-1',
  md: 'min-h-11 px-3 py-2 text-xs gap-1.5',
  lg: 'min-h-14 px-3 py-3 text-xs gap-1.5',
};

export function Toggle({
  label,
  pressed,
  onChange,
  tone = 'accent',
  disabled = false,
  icon,
  iconOnly = false,
  size = 'md',
  block = false,
  title,
  'data-testid': testId,
}: ToggleProps) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.button
      type="button"
      whileTap={reduceMotion || disabled ? undefined : { scale: PRESS_SCALE }}
      transition={SPRING_BB_PRESS}
      aria-pressed={pressed}
      aria-label={iconOnly ? label : undefined}
      disabled={disabled}
      title={title ?? (iconOnly ? label : undefined)}
      data-testid={testId}
      onClick={() => onChange(!pressed)}
      className={[
        'inline-flex items-center justify-center rounded-bb-sm border font-semibold',
        // ~44 px hit area whatever the drawn size (spec §8.1) — a mixer strip's solo is
        // 24 px because the strip is 128 px wide, not because 24 px is tappable.
        'bb-touch-target',
        'transition-colors duration-150 ease-bb-snap',
        SIZE[size],
        block ? 'w-full' : '',
        pressed ? PRESSED_TONE[tone] : 'border-bb-line bg-bb-raised text-bb-text',
        disabled ? 'cursor-not-allowed opacity-40' : 'hover:border-bb-accent-strong',
      ].join(' ')}
    >
      {icon}
      {!iconOnly && <span>{label}</span>}
    </motion.button>
  );
}
