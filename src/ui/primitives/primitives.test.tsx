/**
 * Primitive contract tests — the Multi-Lens accessibility lens (spec §3.5 #1) expressed
 * as assertions: every continuous control carries `aria-valuemin/max/now` + a human-unit
 * `aria-valuetext`, is fully keyboard-operable, and splits transient movement from a
 * single undoable commit (spec §3.3).
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './Button';
import { EmptyState } from './EmptyState';
import { Fader } from './Fader';
import { FieldLabel } from './FieldLabel';
import { Knob } from './Knob';
import { Modal } from './Modal';
import { Pad } from './Pad';
import { SegmentControl } from './SegmentControl';
import { Toast } from './Toast';
import { Toggle } from './Toggle';
import { ValueReadout } from './ValueReadout';

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

  it('positions the cap and fill with transforms only (spec §8.3 composite-only budget)', () => {
    render(<Fader label="Level" value={0.25} range={[0, 1]} onCommit={vi.fn()} />);
    const painted = Array.from(
      screen.getByRole('slider', { name: 'Level' }).querySelectorAll<HTMLElement>(':scope > div'),
    );
    expect(painted.map((el) => el.style.transform)).toEqual(['scaleY(0.25)', 'translateY(-25%)']);
    // A layout property here would force reflow on every frame of a drag.
    for (const el of painted) {
      expect(el.style.height).toBe('');
      expect(el.style.bottom).toBe('');
    }
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

  it('stays held when the pointer slides off, and releases wherever it lifts', async () => {
    const user = userEvent.setup();
    const onRelease = vi.fn();
    render(<Pad label="Hat" padIndex={2} onTrigger={vi.fn()} onRelease={onRelease} />);
    const pad = screen.getByRole('button', { name: 'Hat' });

    // Struck, then dragged off with the button still down. A finger that slides off a
    // hardware pad has not let go of it, and `whileTap` keeps the pad visually depressed
    // through this — releasing the voice here would put the sound and the picture at odds.
    await user.pointer([{ target: pad, keys: '[MouseLeft>]' }, { target: document.body }]);
    expect(onRelease).not.toHaveBeenCalled();

    // Lifting anywhere ends it, so the note still cannot hang.
    await user.pointer({ target: document.body, keys: '[/MouseLeft]' });
    expect(onRelease).toHaveBeenCalledWith(2);
  });

  it('releases a held pad when it unmounts mid-hit, so switching bank cannot hang a note', async () => {
    const user = userEvent.setup();
    const onRelease = vi.fn();
    const { unmount } = render(<Pad label="Tom" padIndex={3} onTrigger={vi.fn()} onRelease={onRelease} />);
    await user.pointer({ target: screen.getByRole('button', { name: 'Tom' }), keys: '[MouseLeft>]' });
    expect(onRelease).not.toHaveBeenCalled();
    unmount();
    expect(onRelease).toHaveBeenCalledWith(3);
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

describe('Button (spec §3.6 one chassis, no call-site re-styling)', () => {
  it('names itself from its label and fires onClick', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button label="Load Sample" onClick={onClick} />);
    await user.click(screen.getByRole('button', { name: 'Load Sample' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('keeps the label as the accessible name when it is visually hidden', () => {
    render(<Button label="Delete step" iconOnly variant="danger" icon={<span aria-hidden="true">x</span>} />);
    const button = screen.getByRole('button', { name: 'Delete step' });
    expect(button).toHaveAttribute('title', 'Delete step');
    expect(button).not.toHaveTextContent('Delete step');
  });

  // Row-scoped buttons ("Audition", "Remove") need a name that distinguishes them when a
  // screen reader lists the buttons out of context, without changing what is on screen.
  it('extends the accessible name past the visible label when asked, keeping the label visible', () => {
    render(<Button label="Audition" accessibleName="Audition Kick.wav" variant="quiet" />);
    const button = screen.getByRole('button', { name: 'Audition Kick.wav' });
    // WCAG 2.5.3: the visible text must remain part of the accessible name, so a
    // speech-input user can activate the button by saying what they see.
    expect(button).toHaveTextContent('Audition');
    expect(button.getAttribute('aria-label')).toContain('Audition');
  });

  it('defaults to type="button" so it never submits a surrounding form by accident', () => {
    render(<Button label="Clear" />);
    expect(screen.getByRole('button', { name: 'Clear' })).toHaveAttribute('type', 'button');
  });

  it('does not fire onClick while disabled', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button label="Export" onClick={onClick} disabled />);
    await user.click(screen.getByRole('button', { name: 'Export' }));
    expect(onClick).not.toHaveBeenCalled();
  });

  // The drift this primitive exists to stop: disabled buttons used to fade to four
  // different opacities and identical buttons eased in one mode but snapped in another.
  it('gives every variant the same disabled treatment and the same token transition', () => {
    const variants = ['default', 'accent', 'quiet', 'danger'] as const;
    for (const variant of variants) {
      const { unmount } = render(<Button label={variant} variant={variant} disabled />);
      const className = screen.getByRole('button', { name: variant }).className;
      expect(className).toContain('opacity-40');
      expect(className).toContain('cursor-not-allowed');
      expect(className).toContain('transition-colors duration-150 ease-bb-snap');
      // A disabled button must not advertise a hover affordance it will not honour.
      expect(className).not.toContain('hover:');
      unmount();
    }
  });

  // The radius lives in the size map alone; naming one in the base chassis too would leave
  // the winner to stylesheet emission order rather than to the size that was asked for.
  it('applies exactly one radius per size', () => {
    const radii = { sm: 'rounded-bb-sm', md: 'rounded-bb-sm', lg: 'rounded-bb-md' } as const;
    for (const [size, radius] of Object.entries(radii)) {
      for (const iconOnly of [false, true]) {
        const { unmount } = render(
          <Button label="Go" size={size as 'sm' | 'md' | 'lg'} iconOnly={iconOnly} />,
        );
        const classes = screen.getByRole('button', { name: 'Go' }).className.split(' ');
        expect(classes.filter((c) => c.startsWith('rounded-'))).toEqual([radius]);
        unmount();
      }
    }
  });

  it('gives each variant exactly one hover affordance when enabled', () => {
    const { rerender } = render(<Button label="Act" variant="quiet" />);
    expect(screen.getByRole('button', { name: 'Act' }).className).toContain('hover:text-bb-text');
    rerender(<Button label="Act" variant="danger" />);
    expect(screen.getByRole('button', { name: 'Act' }).className).toContain('hover:text-bb-danger');
  });
});

describe('FieldLabel (spec §3.6 one caption chassis)', () => {
  it('wraps its control so the caption names it without needing an id', () => {
    render(
      <FieldLabel>
        Quantise
        <input type="text" defaultValue="1/16" />
      </FieldLabel>,
    );
    expect(screen.getByLabelText('Quantise')).toHaveValue('1/16');
  });

  it('associates by id when the control is not a child', () => {
    render(
      <>
        <FieldLabel htmlFor="bars">Bars</FieldLabel>
        <input id="bars" type="text" defaultValue="4" />
      </>,
    );
    expect(screen.getByLabelText('Bars')).toHaveValue('4');
  });

  it('renders a span — not a label — when it names something that is not a control', () => {
    render(
      <FieldLabel as="span" data-testid="pads-caption">
        Pads
      </FieldLabel>,
    );
    expect(screen.getByTestId('pads-caption').tagName).toBe('SPAN');
  });

  // The three drifted copies (gap-1.5, gap-2, and ValueReadout's tracked variant) collapse
  // into this one chassis; ValueReadout now renders the same element.
  it('renders one chassis for both element kinds, and ValueReadout reuses it', () => {
    const { unmount } = render(<FieldLabel data-testid="a">A</FieldLabel>);
    const labelClass = screen.getByTestId('a').className;
    unmount();
    render(
      <>
        <FieldLabel as="span" data-testid="b">
          B
        </FieldLabel>
        <ValueReadout label="BPM" value="120" showLabel />
      </>,
    );
    expect(screen.getByTestId('b').className).toBe(labelClass);
    expect(screen.getByText('BPM').className).toBe(labelClass);
  });
});

describe('EmptyState (spec §3.6 one empty-state voice)', () => {
  it('renders the description alone when there is no next step to name', () => {
    render(<EmptyState message="No layers yet." data-testid="empty" />);
    expect(screen.getByTestId('empty')).toHaveTextContent('No layers yet.');
  });

  // The voice the props exist to enforce: guidance never replaces the description, it
  // follows it. Before this primitive, three modes rendered only the instruction.
  it('puts the hint after the description rather than in place of it', () => {
    render(
      <EmptyState message="No inserts on this channel yet." hint="Add one from the slot picker above." />,
    );
    expect(
      screen.getByText('No inserts on this channel yet. Add one from the slot picker above.'),
    ).toBeInTheDocument();
  });

  it('renders a list item when it sits inside the list it describes', () => {
    render(
      <ul>
        <EmptyState as="li" message="No samples yet." data-testid="empty" />
      </ul>,
    );
    expect(screen.getByTestId('empty').tagName).toBe('LI');
  });

  it('renders the same chassis for both element kinds', () => {
    const { unmount } = render(<EmptyState message="A" data-testid="a" />);
    const paragraphClass = screen.getByTestId('a').className;
    unmount();
    render(
      <ul>
        <EmptyState as="li" message="B" data-testid="b" />
      </ul>,
    );
    expect(screen.getByTestId('b').className).toBe(paragraphClass);
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

  // Clicking prose, a label or the body padding drops focus to `<body>`; the trap has to
  // survive that, since it is an ordinary thing to do inside a dialog.
  it('closes on Escape after focus has fallen to the body', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Modal open title="Quantise" onClose={onClose}>
        <p>Snap every note to the nearest division.</p>
      </Modal>,
    );
    screen.getByRole('dialog', { name: 'Quantise' }).blur();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('pulls focus back when it escapes to the body', () => {
    render(
      <Modal open title="Quantise" onClose={vi.fn()}>
        <p>Snap every note to the nearest division.</p>
      </Modal>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Quantise' });
    dialog.blur();
    expect(dialog).toHaveFocus();
  });

  it('re-enters the dialog when Tab is pressed from outside it', async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">Behind the dialog</button>
        <Modal open title="Quantise" onClose={vi.fn()}>
          <button type="button">Apply</button>
        </Modal>
      </>,
    );
    screen.getByRole('dialog', { name: 'Quantise' }).blur();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Close dialog' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Behind the dialog' })).not.toHaveFocus();
  });

  it('treats a <summary> as a tab stop inside the trap (spec §8.2)', async () => {
    const user = userEvent.setup();
    render(
      <Modal open title="Storage" onClose={vi.fn()}>
        <details>
          <summary>Usage breakdown</summary>
          <p>4.2 MB of samples.</p>
        </details>
      </Modal>,
    );
    // The summary is the last stop in the dialog, so Tab from it wraps to the first rather
    // than escaping. (jsdom's own tab-order model omits `summary`, hence the explicit focus.)
    screen.getByText('Usage breakdown').focus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Close dialog' })).toHaveFocus();
  });
});

describe('Toast (spec §8.2 severity → announcement role)', () => {
  it.each([
    ['info', 'status'],
    ['success', 'status'],
    ['warning', 'alert'],
    ['error', 'alert'],
  ] as const)('announces a %s notice as role="%s"', (tone, role) => {
    render(<Toast message="Autosave failed" tone={tone} onDismiss={vi.fn()} />);
    const toast = screen.getByRole(role);
    expect(toast).toHaveTextContent('Autosave failed');
    expect(toast).toHaveAttribute('data-tone', tone);
  });

  it('dismisses through a labelled control (spec §8.2)', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(<Toast message="Project saved" tone="success" onDismiss={onDismiss} />);
    await user.click(screen.getByRole('button', { name: 'Dismiss notification' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
