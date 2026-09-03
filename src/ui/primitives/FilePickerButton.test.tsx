/**
 * FilePickerButton (spec §3.6, issue #54).
 *
 * A `<label>` has no `disabled`, so every import control in the app was hand-rolled from the
 * button classes and none of them was gated on `busy` while every sibling button was. The
 * realistic consequence #54 records: the user picks a large `.mpcweb`, sees nothing happen,
 * assumes the tap missed, picks it again, and imports two duplicate projects.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FilePickerButton } from './FilePickerButton';

const file = () => new File([new Uint8Array([1, 2, 3])], 'kit.mpcweb');

function renderPicker(props: Partial<React.ComponentProps<typeof FilePickerButton>> = {}) {
  const onPick = vi.fn();
  render(
    <FilePickerButton
      label="Import .mpcweb…"
      busyLabel="Importing…"
      accept=".mpcweb"
      onPick={onPick}
      data-testid="picker"
      {...props}
    />,
  );
  return { onPick, input: screen.getByTestId('picker') as HTMLInputElement };
}

describe('FilePickerButton', () => {
  it('hands the picked file to the caller', async () => {
    const user = userEvent.setup();
    const { onPick, input } = renderPicker();
    const picked = file();
    await user.upload(input, picked);
    expect(onPick).toHaveBeenCalledWith(picked);
  });

  it('refuses a second pick while the first is still being processed', async () => {
    const user = userEvent.setup();
    const { onPick, input } = renderPicker({ busy: true });
    expect(input).toBeDisabled();
    await user.upload(input, file());
    expect(onPick).not.toHaveBeenCalled();
  });

  it('says it is working, so the tap does not look missed', () => {
    renderPicker({ busy: true });
    expect(screen.getByText('Importing…')).toBeInTheDocument();
    expect(screen.queryByText('Import .mpcweb…')).not.toBeInTheDocument();
  });

  it('tells assistive tech it is unavailable, which a label cannot say by itself', () => {
    renderPicker({ busy: true });
    expect(screen.getByText('Importing…').closest('label')).toHaveAttribute('aria-disabled', 'true');
  });

  it('honours a disabled reason of the call site’s own, not only busy', () => {
    const { input } = renderPicker({ disabled: true });
    expect(input).toBeDisabled();
  });

  it('fires again for the same file picked twice', async () => {
    // A `change` event needs the value to differ from last time, so the input is cleared
    // before the handler runs — otherwise re-picking the file you just imported does nothing.
    const user = userEvent.setup();
    const { onPick, input } = renderPicker();
    await user.upload(input, file());
    await user.upload(input, file());
    expect(onPick).toHaveBeenCalledTimes(2);
  });
});
