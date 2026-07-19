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

    expect(stripNow().inserts[0]!.params).toEqual({});
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
