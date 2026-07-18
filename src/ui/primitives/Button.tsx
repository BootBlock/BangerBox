/**
 * Button — the shared button chassis (spec §3.6: reusable visual behaviour lives in a
 * primitive variant, never re-styled at the call site). Before this existed the chassis
 * was hand-rolled at every call site and had drifted: four disabled opacities, five hover
 * affordances, and a transition that many buttons simply omitted, so visually identical
 * buttons in different modes animated differently.
 *
 * Variants describe intent, not appearance, so a call site picks meaning and the look
 * stays consistent app-wide:
 *   default — the standard raised chassis
 *   accent  — the primary/confirming action in a group
 *   quiet   — a secondary action that recedes until hovered
 *   danger  — a destructive action; recedes until hovered, then reads as danger
 *
 * `iconOnly` keeps the label as the accessible name while hiding it visually (spec §8.2),
 * matching how Toggle handles the same case.
 */
import type { MouseEvent, ReactNode } from 'react';

export type ButtonVariant = 'default' | 'accent' | 'quiet' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps {
  /** Visible text, and the accessible name when `iconOnly` hides it. */
  label: string;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  /** Optional leading icon; the label still carries the accessible name (spec §8.2). */
  icon?: ReactNode;
  /** Hide the text label visually, keeping it as the accessible name. */
  iconOnly?: boolean;
  /**
   * A fuller accessible name for a button whose visible label is only meaningful in
   * context — a row's "Audition" button becomes "Audition Kick.wav", so the name still
   * distinguishes it when a screen reader lists the buttons out of context. Must *begin
   * with* the visible label: WCAG 2.5.3 (Label in Name) requires the accessible name to
   * contain the visible text, so speech-input users can say what they see.
   */
  accessibleName?: string;
  /** Stretch to the width of the container rather than hugging the label. */
  block?: boolean;
  title?: string;
  /** For a button that discloses a panel. Set it with the panel's open state. */
  'aria-expanded'?: boolean;
  'data-testid'?: string;
}

const VARIANT: Record<ButtonVariant, string> = {
  default: 'border-bb-line bg-bb-raised text-bb-text',
  accent: 'border-bb-accent bg-bb-accent text-bb-bg',
  quiet: 'border-bb-line text-bb-muted',
  danger: 'border-bb-line text-bb-muted',
};

/** Hover affordance per variant — applied only when the button is enabled. */
const VARIANT_HOVER: Record<ButtonVariant, string> = {
  default: 'hover:border-bb-accent-strong',
  accent: 'hover:border-bb-accent-strong hover:bg-bb-accent-strong',
  quiet: 'hover:border-bb-accent-strong hover:text-bb-text',
  danger: 'hover:border-bb-danger hover:text-bb-danger',
};

/**
 * `lg` is the page-level call to action on a blocking screen (the capability gate, the
 * storage self-test) — the only place the app steps up to the larger radius, so the
 * radius travels with the size rather than sitting in the shared chassis.
 */
const SIZE: Record<ButtonSize, string> = {
  sm: 'gap-1 rounded-bb-sm px-2 py-1 text-xs',
  md: 'gap-1.5 rounded-bb-sm px-3 py-1.5 text-xs',
  lg: 'gap-2 rounded-bb-md px-4 py-2 text-sm',
};

/** Icon-only buttons drop the horizontal padding so they stay square. */
const ICON_SIZE: Record<ButtonSize, string> = {
  sm: 'rounded-bb-sm p-1 text-xs',
  md: 'rounded-bb-sm p-1.5 text-xs',
  lg: 'rounded-bb-md p-2 text-sm',
};

export function Button({
  label,
  onClick,
  variant = 'default',
  size = 'md',
  disabled = false,
  icon,
  iconOnly = false,
  accessibleName,
  block = false,
  title,
  'aria-expanded': ariaExpanded,
  'data-testid': testId,
}: ButtonProps) {
  return (
    <button
      // Always `button`: a bare <button> in a form defaults to `submit`, and nothing in
      // the app submits a form (spec §8 — every action is a handler, not a form post).
      type="button"
      disabled={disabled}
      aria-label={accessibleName ?? (iconOnly ? label : undefined)}
      aria-expanded={ariaExpanded}
      title={title ?? (iconOnly ? (accessibleName ?? label) : undefined)}
      data-testid={testId}
      onClick={onClick}
      className={[
        // `shrink-0`: a button squeezed below its label's width clips the label, which is
        // never what a flex row wants. Several call sites had already discovered this and
        // pasted `shrink-0` in themselves; it belongs to the chassis.
        // No radius here — every entry in SIZE/ICON_SIZE sets its own, and specifying one
        // in both places would leave the winner to stylesheet emission order.
        'inline-flex shrink-0 items-center justify-center border font-semibold',
        // One transition for every button in the app, using the token easing, so a button
        // never snaps in one mode and eases in another.
        'transition-colors duration-150 ease-bb-snap',
        iconOnly ? ICON_SIZE[size] : SIZE[size],
        block ? 'w-full' : '',
        VARIANT[variant],
        // One disabled treatment app-wide, matching Toggle and SegmentControl.
        disabled ? 'cursor-not-allowed opacity-40' : VARIANT_HOVER[variant],
      ].join(' ')}
    >
      {icon}
      {!iconOnly && <span>{label}</span>}
    </button>
  );
}
