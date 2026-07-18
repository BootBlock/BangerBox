/**
 * Toggle — a two-state control rendered as a real `<button>` with `aria-pressed`
 * (spec §8.2). Tones carry meaning consistently across the app (accent = engaged,
 * danger = record/destructive, warn = caution), so call sites never re-style a toggle
 * themselves (spec §3.6).
 */
import type { ReactNode } from 'react';

export type ToggleTone = 'accent' | 'danger' | 'warn' | 'neutral';

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
  size?: 'sm' | 'md';
  title?: string;
  'data-testid'?: string;
}

const PRESSED_TONE: Record<ToggleTone, string> = {
  accent: 'bg-bb-accent text-bb-bg border-bb-accent',
  danger: 'bg-bb-danger text-bb-bg border-bb-danger',
  warn: 'bg-bb-warn text-bb-bg border-bb-warn',
  neutral: 'bg-bb-line text-bb-text border-bb-line',
};

const SIZE: Record<'sm' | 'md', string> = {
  sm: 'px-2 py-1 text-[0.625rem] gap-1',
  md: 'px-3 py-2 text-xs gap-1.5',
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
  title,
  'data-testid': testId,
}: ToggleProps) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={iconOnly ? label : undefined}
      disabled={disabled}
      title={title ?? (iconOnly ? label : undefined)}
      data-testid={testId}
      onClick={() => onChange(!pressed)}
      className={[
        'inline-flex items-center justify-center rounded-bb-sm border font-semibold',
        'transition-colors duration-150 ease-bb-snap',
        SIZE[size],
        pressed ? PRESSED_TONE[tone] : 'border-bb-line bg-bb-raised text-bb-text',
        disabled ? 'cursor-not-allowed opacity-40' : 'hover:border-bb-accent-strong',
      ].join(' ')}
    >
      {icon}
      {!iconOnly && <span>{label}</span>}
    </button>
  );
}
