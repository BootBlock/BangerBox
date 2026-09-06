/**
 * §8.5.6's Pads tab and a KEYGROUP program (spec §6, §8.5.6 — issue #139).
 *
 * The tab renders one strip per assigned pad of the active program. A keygroup has zones
 * rather than pads and exactly one set of mixer values, so it renders ONE strip — the §5.2
 * channel `resolveKeygroupVoice` already merges its voices into. Before this it rendered
 * none at all, and the empty state told the user to select a drum program while the keygroup
 * they had selected was sounding its own fader, pan, sends and insert rack unreachably.
 *
 * The controls are exercised through what a user operates (spec §8.2), so a strip that
 * renders but writes nothing would still fail.
 */
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import userEvent from '@testing-library/user-event';
import {
  createDefaultDrumProgram,
  createDefaultKeygroupProgram,
  type KeygroupProgram,
} from '@/core/project/schemas';
import { subscribePadStripMirror } from '@/store/derive/padStripMirror';
import { useMixerStore, useProgramStore, useTransportStore } from '@/store';
import { MixerMode } from './MixerMode';

const PROGRAM_ID = 'kg-1';
const CHANNEL = `pad:${PROGRAM_ID}:0`;

let dispose: (() => void) | null = null;

/** Open the Pads tab, which the mode does not start on. */
async function openPadsTab(): Promise<void> {
  const user = userEvent.setup();
  render(<MixerMode />);
  await user.click(screen.getByRole('radio', { name: 'Pads' }));
}

/** The keygroup program as the §6 payload holds it right now. */
function storedKeygroup(): KeygroupProgram {
  const program = useProgramStore.getState().programs[PROGRAM_ID];
  if (program?.type !== 'keygroup') throw new Error('the fixture keygroup is gone');
  return program;
}

beforeEach(() => {
  useMixerStore.getState().setChannels({});
  useProgramStore.getState().setPrograms({});
  useProgramStore.getState().setActiveProgram(null);
  useTransportStore.getState().setActiveSequenceId(null);
  dispose?.();
  dispose = null;
});

describe('the Pads tab with a keygroup program selected (issue #139)', () => {
  beforeEach(() => {
    const program = createDefaultKeygroupProgram('Bass', PROGRAM_ID);
    useProgramStore.getState().setPrograms({ [program.id]: program });
    useProgramStore.getState().setActiveProgram(program.id);
    dispose = subscribePadStripMirror();
  });

  it('renders ONE strip, named after the program', async () => {
    await openPadsTab();
    expect(screen.getByTestId(`mixer-strip-${CHANNEL}`)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Bass channel strip' })).toBeInTheDocument();
  });

  it('shows the fader at the §6 program-scope level rather than a default', async () => {
    // Re-open from scratch: the mirror never clobbers a strip already in the store, so the
    // program has to carry these values before the publish that derives the strip from it.
    dispose?.();
    useMixerStore.getState().setChannels({});
    useProgramStore.getState().setPrograms({
      [PROGRAM_ID]: {
        ...createDefaultKeygroupProgram('Bass', PROGRAM_ID),
        mixer: { level: 0.4, pan: -0.5, sendLevels: [0, 0, 0, 0] },
      },
    });
    dispose = subscribePadStripMirror();
    await openPadsTab();
    expect(screen.getByTestId(`mixer-fader-${CHANNEL}`)).toHaveAttribute('aria-valuenow', '0.4');
    expect(screen.getByTestId(`mixer-pan-${CHANNEL}`)).toHaveAttribute('aria-valuenow', '-0.5');
  });

  it('moves the §6 payload when the fader is operated (spec §3.4)', async () => {
    const user = userEvent.setup();
    await openPadsTab();
    const fader = screen.getByTestId(`mixer-fader-${CHANNEL}`);
    fader.focus();
    await user.keyboard('{ArrowDown}');
    expect(storedKeygroup().mixer.level).toBeLessThan(1);
    expect(useMixerStore.getState().channels[CHANNEL]?.level).toBe(storedKeygroup().mixer.level);
  });

  it('offers the insert rack, which §6 gives a keygroup at program scope', async () => {
    await openPadsTab();
    expect(screen.getByTestId(`mixer-inserts-${CHANNEL}`)).toBeInTheDocument();
  });
});

describe('the Pads tab with nothing to show', () => {
  it('still says what is empty and what to do, for a drum program with no pads', async () => {
    const program = createDefaultDrumProgram('Kit', 'drum-1');
    useProgramStore.getState().setPrograms({ [program.id]: program });
    useProgramStore.getState().setActiveProgram(program.id);
    dispose = subscribePadStripMirror();
    await openPadsTab();
    expect(screen.getByText(/No pad channels yet\./)).toBeInTheDocument();
    expect(screen.getByText(/Select a keygroup program/)).toBeInTheDocument();
  });
});
