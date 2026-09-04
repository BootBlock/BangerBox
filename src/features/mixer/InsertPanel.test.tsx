/**
 * InsertPanel — spec §8.5.6 requires the slot list to support replace, and replace is the
 * one of the four that a remove-then-add cannot stand in for: it must hold the slot's chain
 * position, and with it the §10.3 Q-Link binding the panel derives from the first non-empty
 * slot. These tests pin that down through the control a user actually operates (spec §8.2).
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultChannelStrip, EFFECT_TYPES, type EffectType } from '@/core/project/schemas';
import { defaultEffectParams, EFFECT_PARAM_CHOICES } from '@/core/audio/inserts/effectParams';
import { useMixerStore, useUIStore } from '@/store';
import { InsertPanel } from './InsertPanel';

const CHANNEL = 'track:1';

const stripNow = () => useMixerStore.getState().channels[CHANNEL]!;
const focusPaths = () => useUIStore.getState().focusedControlParams.map((param) => param.targetParameterPath);

beforeEach(() => {
  const strip = createDefaultChannelStrip(CHANNEL);
  useMixerStore.getState().setChannels({
    [CHANNEL]: {
      ...strip,
      inserts: [
        { ...strip.inserts[0]!, effectType: 'delay', enabled: true, params: { feedback: 0.6 } },
        { ...strip.inserts[1]!, effectType: 'limiter', enabled: true },
      ],
    },
  });
  useUIStore.getState().setFocusedControlParams([]);
});

function renderPanel() {
  render(
    <InsertPanel
      channelId={CHANNEL}
      availableEffects={EFFECT_TYPES as readonly EffectType[]}
      onClose={vi.fn()}
    />,
  );
}

describe('InsertPanel replace (spec §8.5.6)', () => {
  it('swaps the effect without moving the slot or the rest of the chain', async () => {
    const user = userEvent.setup();
    const before = stripNow().inserts[0]!;
    renderPanel();

    await user.selectOptions(screen.getByLabelText('Replace insert 1'), 'reverb');

    expect(stripNow().inserts[0]!.effectType).toBe('reverb');
    expect(stripNow().inserts[0]!.id).toBe(before.id);
    expect(stripNow().inserts[1]!.effectType).toBe('limiter');
  });

  it('does not carry the outgoing effect params into the new one', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.selectOptions(screen.getByLabelText('Replace insert 1'), 'reverb');

    // The incoming effect's own §5.7 defaults, which is what a slot the user just added
    // carries too (issue #131). What must not survive is the OUTGOING effect's taste:
    // `feedback` is a delay parameter and means nothing to a reverb.
    expect(stripNow().inserts[0]!.params).toEqual(defaultEffectParams('reverb'));
    expect(stripNow().inserts[0]!.params.feedback).toBeUndefined();
  });

  it('keeps the Q-Link binding on the same slot, now naming the new effect (spec §10.3)', async () => {
    const user = userEvent.setup();
    renderPanel();
    expect(focusPaths()[0]).toBe('insert:track:1:slot1.time');

    await user.selectOptions(screen.getByLabelText('Replace insert 2'), 'filter');
    // Slot 2 is not the first non-empty slot, so the binding must not follow it.
    expect(focusPaths()[0]).toBe('insert:track:1:slot1.time');

    await user.selectOptions(screen.getByLabelText('Replace insert 1'), 'filter');
    expect(focusPaths().every((path) => path.startsWith('insert:track:1:slot1.'))).toBe(true);
    expect(focusPaths()).toContain('insert:track:1:slot1.cutoff');
  });
});

describe('index-encoded parameters (spec §5.7)', () => {
  it('offers the delay’s synced divisions by name rather than by index', async () => {
    const user = userEvent.setup();
    renderPanel();
    const sync = screen.getByLabelText('Sync, insert 1, Delay');

    // spec §5.7 bounds the synced set at 1/2, so the whole note is deliberately absent.
    expect(screen.getByRole('option', { name: 'free' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '1/8.' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: '1/1' })).not.toBeInTheDocument();

    const dottedEighth = EFFECT_PARAM_CHOICES.delay!.sync!.indexOf('1/8.');
    await user.selectOptions(sync, dottedEighth.toString());
    expect(stripNow().inserts[0]!.params.sync).toBe(dottedEighth);
  });

  it('keeps a knob for the parameters that really are continuous', () => {
    renderPanel();
    expect(screen.getByTestId('insert-param-0-feedback').tagName).not.toBe('SELECT');
  });
});

describe('naming inside a slot (spec §8.2, issue #58)', () => {
  it('names each bypass toggle by its slot AND its effect', () => {
    renderPanel();
    // Four inserts used to present four buttons all called "Enabled", so a screen-reader
    // user could not tell which effect they were about to bypass.
    expect(screen.getByRole('button', { name: 'Bypass insert 1, Delay' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Bypass insert 2, Limiter' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Enabled' })).not.toBeInTheDocument();
  });

  it('gives every control in a slot a name unique across the whole panel', () => {
    renderPanel();
    const names = screen
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label') ?? button.textContent);
    expect(new Set(names).size).toBe(names.length);
  });

  it('names the list item, so browsing by list item is coherent too', () => {
    renderPanel();
    const items = screen.getAllByRole('listitem');
    expect(items[0]).toHaveAttribute('aria-label', 'Insert 1 — Delay');
    expect(items[1]).toHaveAttribute('aria-label', 'Insert 2 — Limiter');
  });

  it('presses when the slot is BYPASSED, following the verb §5.7 uses', async () => {
    const user = userEvent.setup();
    renderPanel();
    const bypass = screen.getByRole('button', { name: 'Bypass insert 1, Delay' });

    // §5.7 defines the slot's `enabled` field as true bypass via routing, so "Bypass" is
    // what the control does — and a bypass light is lit when the effect is out of circuit.
    expect(stripNow().inserts[0]!.enabled).toBe(true);
    expect(bypass).toHaveAttribute('aria-pressed', 'false');

    await user.click(bypass);
    expect(stripNow().inserts[0]!.enabled).toBe(false);
    expect(screen.getByRole('button', { name: 'Bypass insert 1, Delay' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('has nothing to bypass in an empty slot', async () => {
    const user = userEvent.setup();
    const strip = stripNow();
    useMixerStore.getState().setChannels({
      [CHANNEL]: { ...strip, inserts: [{ ...strip.inserts[0]!, effectType: null }] },
    });
    renderPanel();
    const bypass = screen.getByRole('button', { name: 'Bypass insert 1, empty' });
    expect(bypass).toBeDisabled();
    await user.click(bypass);
    expect(stripNow().inserts[0]!.enabled).toBe(true);
  });
});

describe('parameter knobs read as words and units (spec §8.2, issue #35)', () => {
  it('names a knob after the parameter rather than after its store key', () => {
    renderPanel();
    // `feedback` is a frozen §13.6 registry key chosen to be short in a payload, not words.
    expect(screen.getByRole('slider', { name: 'Feedback, insert 1, Delay' })).toBeInTheDocument();
    expect(screen.queryByRole('slider', { name: 'feedback' })).not.toBeInTheDocument();
  });

  it('announces each parameter in the unit its §5.7 range is stated in', () => {
    renderPanel();
    // The seeded value, which the completion leaves alone.
    expect(screen.getByRole('slider', { name: 'Feedback, insert 1, Delay' })).toHaveAttribute(
      'aria-valuetext',
      '60 %',
    );
    // The §5.7 defaults, which is what the graph is running — these read as the range FLOOR
    // ("1 ms", "200 Hz", "−6.0 dBFS") until issue #131, while the delay echoed at 350 ms.
    expect(screen.getByRole('slider', { name: 'Time, insert 1, Delay' })).toHaveAttribute(
      'aria-valuetext',
      '350 ms',
    );
    expect(screen.getByRole('slider', { name: 'Tone, insert 1, Delay' })).toHaveAttribute(
      'aria-valuetext',
      '6.0 kHz',
    );
    // §5.7 states the limiter's ceiling against full scale, and the readout keeps that.
    expect(screen.getByRole('slider', { name: 'Ceiling, insert 2, Limiter' })).toHaveAttribute(
      'aria-valuetext',
      '−0.3 dBFS',
    );
  });
});
