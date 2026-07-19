/**
 * SegmentControl — an exclusive choice among a small option set, presented as an ARIA
 * radio group (spec §8.2: correct role, keyboard operable). Arrow keys move the selection
 * within the group and Tab moves past it, which is the WAI-ARIA radio-group pattern —
 * implemented here rather than pulled from a component library (spec §1.3 #10).
 */
import { useRef, type KeyboardEvent } from 'react';

export interface SegmentOption<T extends string | number> {
  readonly value: T;
  readonly label: string;
  /**
   * Disable this option alone — for a choice the build offers but this environment cannot do,
   * such as a §2.1 soft capability the browser lacks. Pair it with {@link SegmentOption.title}:
   * an option that is dead with no stated reason reads as a bug.
   */
  readonly disabled?: boolean;
  /** Native tooltip, and the place to say why a disabled option is disabled (spec §2.1). */
  readonly title?: string;
}

export interface SegmentControlProps<T extends string | number> {
  label: string;
  value: T;
  options: readonly SegmentOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  size?: 'sm' | 'md';
  'data-testid'?: string;
}

/**
 * Both sizes clear the ~44 px touch minimum in height (spec §8.1) — `sm` differs from `md`
 * in type and horizontal padding, not in how tappable it is. Unlike Button and Toggle this
 * cannot lean on `bb-touch-target`: the group clips to `overflow-hidden` so its options
 * inherit the rounded ends, and that clips a pseudo-element hit area with them. The height
 * is therefore real, which is also the honest answer for options sitting shoulder to
 * shoulder with no gap to expand into.
 */
const SIZE: Record<'sm' | 'md', string> = {
  sm: 'min-h-11 px-3 text-bb-micro',
  md: 'min-h-11 px-4 text-xs',
};

export function SegmentControl<T extends string | number>({
  label,
  value,
  options,
  onChange,
  disabled = false,
  size = 'md',
  'data-testid': testId,
}: SegmentControlProps<T>) {
  const groupRef = useRef<HTMLDivElement | null>(null);

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
    const backward = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
    if (!forward && !backward) return;
    event.preventDefault();
    const index = options.findIndex((option) => option.value === value);
    if (index < 0) return;
    // Wrap around the group, per the WAI-ARIA radio-group pattern, stepping over any disabled
    // option rather than landing on it — the arrow keys select as they move, so a stop on a
    // disabled option would have to select it.
    const step = forward ? 1 : -1;
    let nextIndex = index;
    for (let hop = 1; hop < options.length; hop += 1) {
      const candidate = (((index + step * hop) % options.length) + options.length) % options.length;
      if (!options[candidate]?.disabled) {
        nextIndex = candidate;
        break;
      }
    }
    const next = options[nextIndex];
    if (!next || nextIndex === index) return;
    onChange(next.value);
    // Roving tabindex: focus follows selection so the keyboard stays inside the group.
    const buttons = groupRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    buttons?.[nextIndex]?.focus();
  };

  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      data-testid={testId}
      className="inline-flex overflow-hidden rounded-bb-sm border border-bb-line bg-bb-raised"
    >
      {options.map((option) => {
        const selected = option.value === value;
        const optionDisabled = disabled || option.disabled === true;
        return (
          <button
            key={String(option.value)}
            type="button"
            role="radio"
            aria-checked={selected}
            title={option.title}
            // Roving tabindex — only the selected option is in the tab order (spec §8.2).
            tabIndex={selected ? 0 : -1}
            disabled={optionDisabled}
            // Arrow handling lives on the options, not the group: the group is a container
            // and giving it a key handler would demand it be focusable too (jsx-a11y).
            onKeyDown={handleKeyDown}
            onClick={() => onChange(option.value)}
            className={[
              // Explicit centring: `min-h` alone leaves a button's anonymous content box to
              // the UA's default alignment, which is not consistent across engines.
              'inline-flex items-center justify-center font-semibold transition-colors duration-150 ease-bb-snap',
              SIZE[size],
              selected ? 'bg-bb-accent text-bb-bg' : 'text-bb-muted hover:text-bb-text',
              optionDisabled ? 'cursor-not-allowed opacity-40' : '',
            ].join(' ')}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
