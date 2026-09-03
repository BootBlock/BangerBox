/**
 * FilePickerButton — a file picker that looks and behaves like a {@link Button} (spec §3.6).
 *
 * Opening the system file picker requires a real `<input type="file">`, and the only way to
 * style one is to wrap it in a `<label>` — which is why every import control in the app was
 * hand-rolled from the button classes rather than using the chassis. Two consequences the
 * chassis would have prevented, both reported in issue #54:
 *
 * - **A `<label>` has no `disabled`.** Every sibling button was gated on `busy` and the
 *   import labels were not, so a user who picked a large `.mpcweb`, saw nothing happen and
 *   tapped again imported the project twice. The input carries the `disabled`, because a
 *   disabled input opens no picker however its label is clicked.
 * - **Neither said it was working.** `busy` gated other controls and changed nothing the
 *   user could see on the control they had just used, which is what made the tap look missed.
 *   `busyLabel` is what the control reads while the operation runs.
 *
 * The input is reset to `''` before the change is handed on, so picking the same file twice
 * in a row still fires — a `change` event needs the value to differ from last time.
 */
import type { ChangeEvent } from 'react';
import { buttonChassis, type ButtonSize, type ButtonVariant } from './Button';

export interface FilePickerButtonProps {
  /** Visible text, and the accessible name of the picker. */
  label: string;
  /** What the control reads while `busy` — the visible progress §8.5 owes a long operation. */
  busyLabel: string;
  /** `accept` for the underlying input (spec §9.4 accepts `.wav/.mp3/.flac/.ogg`). */
  accept: string;
  /** True while the picked file is still being processed: the picker refuses a second pick. */
  busy?: boolean;
  /** Additionally unavailable for a reason of the call site's own (no open project, say). */
  disabled?: boolean;
  variant?: ButtonVariant;
  size?: ButtonSize;
  title?: string;
  /** The picked file, or nothing when the user cancelled. */
  onPick: (file: File) => void;
  'data-testid'?: string;
}

export function FilePickerButton({
  label,
  busyLabel,
  accept,
  busy = false,
  disabled = false,
  variant = 'default',
  size = 'md',
  title,
  onPick,
  'data-testid': testId,
}: FilePickerButtonProps) {
  const blocked = busy || disabled;

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Cleared before the handler runs, so re-picking the same file still raises `change`.
    event.target.value = '';
    if (file) onPick(file);
  };

  return (
    <label
      // A label is not a button, so assistive tech is told what state it is in explicitly;
      // the input below is what actually refuses the click.
      aria-disabled={blocked || undefined}
      title={title}
      className={`${buttonChassis({ variant, size, disabled: blocked })} ${blocked ? '' : 'cursor-pointer'}`}
    >
      {busy ? busyLabel : label}
      <input
        type="file"
        accept={accept}
        disabled={blocked}
        className="sr-only"
        data-testid={testId}
        onChange={handleChange}
      />
    </label>
  );
}
