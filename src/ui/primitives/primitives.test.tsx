/**
 * Primitive contract tests — the Multi-Lens accessibility lens (spec §3.5 #1) expressed
 * as assertions: every continuous control carries `aria-valuemin/max/now` + a human-unit
 * `aria-valuetext`, is fully keyboard-operable, and splits transient movement from a
 * single undoable commit (spec §3.3).
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Fader } from './Fader';
import { Knob } from './Knob';
import { Modal } from './Modal';
import { Pad } from './Pad';
import { SegmentControl } from './SegmentControl';
import { Toggle } from './Toggle';

describe('Knob (spec §8.2 ARIA + keyboard)', () => {
  it('exposes the full slider ARIA contract with human units', () => {
    render(
      <Knob label="Cutoff" value={1200} range={[20, 20_000]} unit="Hz" curve="log" onCommit={vi.fn()} />,
    );
    const knob = screen.getByRole('slider', { name: 'Cutoff' });
    expect(knob).toHaveAttribute('aria-valuemin', '20');
    expect(knob).toHaveAttribute('aria-valuemax', '20000');
    expect(knob).toHaveAttribute('aria-valuenow', '1200');
    expect(knob).toHaveAttribute('aria-valuetext', '1.2 kHz');
  });

  it('is reachable by keyboard and steps with the arrow keys', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<Knob label="Level" value={50} range={[0, 100]} step={1} onCommit={onCommit} />);
    await user.tab();
    expect(screen.getByRole('slider', { name: 'Level' })).toHaveFocus();

    await user.keyboard('{ArrowUp}');
    expect(onCommit).toHaveBeenLastCalledWith(51);
    await user.keyboard('{ArrowDown}');
    expect(onCommit).toHaveBeenLastCalledWith(49);
  });

  it('uses a fine step while Shift is held (spec §8.2)', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<Knob label="Level" value={50} range={[0, 100]} step={1} onCommit={onCommit} />);
    await user.tab();
    await user.keyboard('{Shift>}{ArrowUp}{/Shift}');
    expect(onCommit).toHaveBeenLastCalledWith(50.1);
  });

  it('jumps to the range ends with Home and End', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<Knob label="Level" value={50} range={[0, 100]} step={1} onCommit={onCommit} />);
    await user.tab();
    await user.keyboard('{Home}');
    expect(onCommit).toHaveBeenLastCalledWith(0);
    await user.keyboard('{End}');
    expect(onCommit).toHaveBeenLastCalledWith(100);
  });

  it('each keyboard step is its own commit — never a transient update (spec §4.5)', async () => {
    const user = userEvent.setup();
    const onTransient = vi.fn();
    const onCommit = vi.fn();
    render(
      <Knob
        label="Level"
        value={50}
        range={[0, 100]}
        step={1}
        onTransient={onTransient}
        onCommit={onCommit}
      />,
    );
    await user.tab();
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(onCommit).toHaveBeenCalledTimes(2);
    expect(onTransient).not.toHaveBeenCalled();
  });

  it('a disabled knob is out of the tab order and ignores keys', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<Knob label="Level" value={50} range={[0, 100]} disabled onCommit={onCommit} />);
    const knob = screen.getByRole('slider', { name: 'Level' });
    expect(knob).toHaveAttribute('tabindex', '-1');
    expect(knob).toHaveAttribute('aria-disabled', 'true');
    knob.focus();
    await user.keyboard('{ArrowUp}');
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('double-click resets to the supplied default (hardware-desk convention)', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<Knob label="Pan" value={0.8} range={[-1, 1]} defaultValue={0} onCommit={onCommit} />);
    await user.dblClick(screen.getByRole('slider', { name: 'Pan' }));
    expect(onCommit).toHaveBeenLastCalledWith(0);
  });
});

describe('Fader (spec §8.5.6)', () => {
  it('reports a vertical orientation and formats its value through the caller law', () => {
    render(
      <Fader
        label="Master"
        value={1}
        range={[0, 1.2]}
        formatValue={(v) => (v <= 0 ? '−∞ dB' : `${(v * 6).toFixed(1)} dB`)}
        onCommit={vi.fn()}
      />,
    );
    const fader = screen.getByRole('slider', { name: 'Master' });
    expect(fader).toHaveAttribute('aria-orientation', 'vertical');
    expect(fader).toHaveAttribute('aria-valuetext', '6.0 dB');
  });
});

describe('Pad (spec §8.3 velocity + §8.2 keyboard)', () => {
  it('triggers from the keyboard with a nominal velocity', async () => {
    const user = userEvent.setup();
    const onTrigger = vi.fn();
    render(<Pad label="Kick" padIndex={0} assigned onTrigger={onTrigger} />);
    await user.tab();
    await user.keyboard('{ }');
    expect(onTrigger).toHaveBeenCalledWith(0, 100);
  });

  it('reports latched state through aria-pressed', () => {
    render(<Pad label="Snare" padIndex={1} active onTrigger={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Snare' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('releases on pointer leave so a drag off the pad cannot leave a note hanging', async () => {
    const user = userEvent.setup();
    const onRelease = vi.fn();
    render(<Pad label="Hat" padIndex={2} onTrigger={vi.fn()} onRelease={onRelease} />);
    const pad = screen.getByRole('button', { name: 'Hat' });
    await user.pointer([{ target: pad, keys: '[MouseLeft>]' }, { target: document.body }]);
    expect(onRelease).toHaveBeenCalledWith(2);
  });
});

describe('SegmentControl (spec §8.2 radio-group pattern)', () => {
  const options = [
    { value: 'a', label: 'A' },
    { value: 'b', label: 'B' },
    { value: 'c', label: 'C' },
  ] as const;

  it('is a radiogroup whose selected option is the only tab stop', () => {
    render(<SegmentControl label="Mode" value="b" options={options} onChange={vi.fn()} />);
    expect(screen.getByRole('radiogroup', { name: 'Mode' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'B' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('radio', { name: 'A' })).toHaveAttribute('tabindex', '-1');
  });

  it('moves the selection with the arrow keys and wraps at the ends', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<SegmentControl label="Mode" value="c" options={options} onChange={onChange} />);
    await user.tab();
    await user.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenLastCalledWith('a');
  });
});

describe('Toggle', () => {
  it('reports its state through aria-pressed and toggles on click', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Toggle label="Metronome" pressed={false} onChange={onChange} />);
    const toggle = screen.getByRole('button', { name: 'Metronome' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await user.click(toggle);
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe('Modal (spec §8.2 dialog contract)', () => {
  it('names itself from its heading and closes on Escape', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Modal open title="Quantise" onClose={onClose}>
        <button type="button">Apply</button>
      </Modal>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Quantise' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('moves focus into the dialog on open', () => {
    render(
      <Modal open title="Quantise" onClose={vi.fn()}>
        <button type="button">Apply</button>
      </Modal>,
    );
    expect(screen.getByRole('dialog', { name: 'Quantise' })).toHaveFocus();
  });

  it('confines Tab to the dialog (spec §8.2 focus trap)', async () => {
    const user = userEvent.setup();
    render(
      <Modal open title="Quantise" onClose={vi.fn()} footer={<button type="button">Cancel</button>}>
        <button type="button">Apply</button>
      </Modal>,
    );
    // Panel → Close → Apply → Cancel, then wrap back to Close rather than escaping.
    await user.tab();
    expect(screen.getByRole('button', { name: 'Close dialog' })).toHaveFocus();
    await user.tab();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Close dialog' })).toHaveFocus();
  });
});
