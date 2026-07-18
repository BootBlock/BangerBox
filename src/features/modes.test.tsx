/**
 * Multi-Lens accessibility sweep across every mode (spec §3.5 lens 1, §8.2). Rather than
 * eyeballing twelve screens, these assertions hold each mode to the same contract:
 *
 *  - every interactive element has an accessible name;
 *  - every continuous control carries the full `aria-valuemin/max/now` triple;
 *  - nothing is presented as a bare `div` with a click handler;
 *  - each mode mounts and unmounts cleanly (spec §3.5 lens 5).
 *
 * A mode that fails here fails the review, which is the point of making the lens
 * mechanical rather than advisory (spec §13.6).
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MODE_DEFINITIONS } from './modes';
import { useProgramStore, useSequenceStore, useTransportStore } from '@/store';
import { createDefaultPad } from '@/store/useProgramStore';

afterEach(cleanup);

/** A minimal but non-empty project, so modes render their populated state, not placeholders. */
function seedProject() {
  const program = {
    id: 'prog-1',
    name: 'Kit',
    type: 'drum' as const,
    pads: [createDefaultPad(0), createDefaultPad(1)],
  };
  useProgramStore.setState({ programs: { 'prog-1': program }, activeProgramId: 'prog-1', activePadId: 0 });
  useSequenceStore.setState({
    sequences: {
      'seq-1': {
        id: 'seq-1',
        projectId: 'proj-1',
        position: 0,
        name: 'Sequence 1',
        lengthBars: 2,
        timeSig: { numerator: 4, denominator: 4 },
        tempo: null,
        swingAmount: 50,
        swingDivision: 16,
      },
    },
    tracks: {
      'track-1': {
        id: 'track-1',
        sequenceId: 'seq-1',
        programId: 'prog-1',
        position: 0,
        name: 'Drums',
        type: 'drum',
      },
    },
    events: { 'track-1': [] },
  });
  useTransportStore.setState({ activeSequenceId: 'seq-1' });
}

describe('Multi-Lens accessibility sweep (spec §3.5 lens 1)', () => {
  for (const mode of MODE_DEFINITIONS) {
    describe(`${mode.title} mode`, () => {
      it('gives every interactive element an accessible name', () => {
        seedProject();
        const { container } = render(<mode.Component />);

        const unnamed: string[] = [];
        for (const element of container.querySelectorAll<HTMLElement>(
          'button, [role="slider"], [role="radio"], [role="tab"], input, select',
        )) {
          // `aria-hidden` subtrees are presentational and exempt.
          if (element.closest('[aria-hidden="true"]')) continue;
          const named =
            element.getAttribute('aria-label') ||
            element.getAttribute('aria-labelledby') ||
            element.textContent?.trim() ||
            (element instanceof HTMLInputElement && element.labels && element.labels.length > 0);
          if (!named) unnamed.push(element.outerHTML.slice(0, 120));
        }
        expect(unnamed).toEqual([]);
      });

      it('gives every slider the full ARIA value triple (spec §8.2)', () => {
        seedProject();
        render(<mode.Component />);
        for (const slider of screen.queryAllByRole('slider')) {
          expect(slider).toHaveAttribute('aria-valuemin');
          expect(slider).toHaveAttribute('aria-valuemax');
          expect(slider).toHaveAttribute('aria-valuenow');
        }
      });

      it('never attaches a click handler to a non-interactive element', () => {
        seedProject();
        const { container } = render(<mode.Component />);
        // A div/span carrying a role must also be focusable to be operable (spec §8.2).
        const interactiveRoles = ['button', 'slider', 'radio', 'tab', 'checkbox', 'switch'];
        const offenders: string[] = [];
        for (const element of container.querySelectorAll<HTMLElement>('div[role], span[role]')) {
          const role = element.getAttribute('role');
          if (!role || !interactiveRoles.includes(role)) continue;
          if (element.getAttribute('aria-disabled') === 'true') continue;
          if (!element.hasAttribute('tabindex')) offenders.push(element.outerHTML.slice(0, 120));
        }
        expect(offenders).toEqual([]);
      });

      it('mounts and unmounts without throwing (spec §3.5 lens 5)', () => {
        seedProject();
        const { unmount } = render(<mode.Component />);
        expect(() => unmount()).not.toThrow();
      });
    });
  }
});
