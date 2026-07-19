/**
 * TextField — the single-line text input chassis (spec §3.6, §1.3 #10: bespoke, no
 * component library). Added with the project/sequence/track naming surface (issue #40),
 * which is the first place the app asks the user to type anything: until then the only
 * `<input>`s were a range slider and a file picker, so there was no chassis to reuse and
 * three call sites would have hand-rolled three.
 *
 * The border/background/radius match the `<select>` chassis the mode headers already use,
 * so a name field and a picker sitting in the same row read as one control set.
 *
 * `onSubmit` fires on Enter and `onCancel` on Escape, because every current call site is
 * an inline rename where those are the expected keys. Escape is stopped from propagating:
 * inside a Modal it would otherwise dismiss the whole dialog rather than the edit.
 */
import { useEffect, useId, useRef, type ChangeEvent, type KeyboardEvent } from 'react';
import { FieldLabel } from './FieldLabel';

export interface TextFieldProps {
  /** Accessible name. Visible only if `showLabel` is set; otherwise it names the input. */
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Enter. Omit for a field that has no single confirming action. */
  onSubmit?: () => void;
  /** Escape — abandon the edit. */
  onCancel?: () => void;
  placeholder?: string;
  disabled?: boolean;
  /** Render the label above the input rather than only exposing it to assistive tech. */
  showLabel?: boolean;
  /**
   * Take focus on mount — for a field the user summoned by pressing Rename, where
   * landing anywhere else would make them Tab back to the control they just used.
   *
   * Applied with a ref rather than the `autoFocus` attribute, which `jsx-a11y` forbids
   * for good reason: the attribute fires on mount unconditionally, including on page
   * load, where it moves a screen reader's cursor with no user action behind it. This
   * field only ever mounts *in response to* the press that asked for it.
   */
  focusOnMount?: boolean;
  maxLength?: number;
  block?: boolean;
  'data-testid'?: string;
}

const INPUT =
  'min-w-0 rounded-bb-sm border border-bb-line bg-bb-raised px-2 py-1 text-xs text-bb-text ' +
  'transition-colors duration-150 ease-bb-snap placeholder:text-bb-muted ' +
  'hover:border-bb-accent-strong focus:border-bb-accent focus:outline-none ' +
  'disabled:cursor-not-allowed disabled:opacity-40';

export function TextField({
  label,
  value,
  onChange,
  onSubmit,
  onCancel,
  placeholder,
  disabled = false,
  showLabel = false,
  focusOnMount = false,
  maxLength = 120,
  block = false,
  'data-testid': testId,
}: TextFieldProps) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!focusOnMount) return;
    const input = inputRef.current;
    input?.focus();
    // Select the existing name: a rename usually replaces it, and the caret parked at
    // character zero would make the user clear it by hand first.
    input?.select();
  }, [focusOnMount]);

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && onSubmit) {
      event.preventDefault();
      onSubmit();
      return;
    }
    if (event.key === 'Escape' && onCancel) {
      event.preventDefault();
      // Keep an enclosing Modal open — this key cancels the edit, not the dialog.
      event.stopPropagation();
      onCancel();
    }
  };

  const input = (
    <input
      id={id}
      type="text"
      value={value}
      disabled={disabled}
      placeholder={placeholder}
      maxLength={maxLength}
      ref={inputRef}
      aria-label={showLabel ? undefined : label}
      onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
      onKeyDown={handleKeyDown}
      data-testid={testId}
      className={`${INPUT} ${block ? 'w-full' : ''}`}
    />
  );

  if (!showLabel) return input;
  // FieldLabel owns the caption chassis (spec §3.6); it associates by id rather than
  // wrapping, so the input keeps its own width and does not inherit the caption's flow.
  return (
    <div className={`flex flex-col gap-1.5 ${block ? 'w-full' : ''}`}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {input}
    </div>
  );
}
