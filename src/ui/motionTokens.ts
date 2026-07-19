/**
 * Motion tokens — the `motion/react` half of the design tokens in `styles/index.css`
 * (spec §3.6, §8.3).
 *
 * Motion animates through JS, so it cannot read a CSS custom property: passing
 * `var(--ease-bb-snap)` to a `transition` does nothing. Before this module each motion call
 * site hand-copied the curve as a magic array — `ease: [0.2, 0, 0, 1]` appeared in `Modal`,
 * `Toast` and `PwaUpdatePrompt` — so retuning `--ease-bb-snap` left all three on the old
 * curve with nothing to flag the drift. The literals live here once instead, and
 * `--ease-bb-snap` in `index.css` carries a pointer back.
 *
 * Springs rather than durations for anything the user pushes on: §8.3 asks for the feel of
 * hardware, and a fixed-duration tween is a step change with no velocity or overshoot in it.
 * Durations stay where nothing is being pushed — a modal appearing, a toast arriving.
 */
import type { Transition } from 'motion/react';

/**
 * The token easing `--ease-bb-snap` as motion's cubic-bezier control points. Keep the two
 * in step: this is the same curve, expressed in the only form motion accepts.
 */
export const EASE_BB_SNAP: [number, number, number, number] = [0.2, 0, 0, 1];

/**
 * Press feedback for pads, buttons and toggles (spec §8.3: `whileTap` scale ≈ 0.95).
 *
 * Stiff and heavily damped: a press has to read as *contact*, so the control must reach
 * depth within a frame or two of the finger landing and settle without a visible wobble —
 * a bouncy press feels like jelly, not like a rubber pad over a switch.
 */
export const PRESS_SCALE = 0.95;

export const SPRING_BB_PRESS: Transition = {
  type: 'spring',
  stiffness: 900,
  damping: 45,
  mass: 0.6,
};

/**
 * Shared-layout movement — the mode rail's active indicator sliding between entries
 * (spec §8.3). Looser than the press spring because this one is watched rather than felt:
 * the travel is what communicates which mode was left, so it wants a visible arc.
 */
export const SPRING_BB_LAYOUT: Transition = {
  type: 'spring',
  stiffness: 420,
  damping: 34,
};
