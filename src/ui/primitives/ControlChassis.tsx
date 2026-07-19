/**
 * ControlChassis — the frame a continuous control sits in: the stack, the caption beneath
 * it, and the monospaced readout beneath that (spec §3.6, which admits no DRY violation
 * inside `primitives/` at all).
 *
 * Knob and Fader carried byte-identical copies of all three. They are meant to be the same
 * object — a knob and a fader in the same strip must have their captions truncate at the
 * same width and their readouts sit on the same baseline, or the strip looks assembled from
 * parts. Nothing enforced that; the copies simply happened to agree, and the next edit to
 * one of them was the edit that broke it.
 *
 * Not exported from `index.ts`: this is the shared interior of two primitives, not a
 * primitive a feature may reach for (spec §3.6 — features compose primitives, they do not
 * build new controls out of a primitive's parts).
 */
import type { ReactNode, RefObject } from 'react';

export interface ControlChassisProps {
  /** Caption under the control. Truncates rather than widening the strip it sits in. */
  label: string;
  /** Rendered readout text, and the value the readout falls back to between gestures. */
  valueText: string;
  /**
   * The readout span, so the owning control can paint text straight into it during a drag
   * without a re-render (spec §3.3). Optional only because `showValue` may hide it.
   */
  readoutRef?: RefObject<HTMLSpanElement | null>;
  /** Hide the readout when the caller renders its own (spec §3.6 no re-styling). */
  showValue?: boolean;
  /** The control itself — the dial, the fader track. */
  children: ReactNode;
}

export function ControlChassis({
  label,
  valueText,
  readoutRef,
  showValue = true,
  children,
}: ControlChassisProps) {
  return (
    <div className="flex flex-col items-center gap-1">
      {children}
      <span className="max-w-16 truncate text-center text-bb-micro leading-tight text-bb-muted">{label}</span>
      {showValue && (
        <span
          ref={readoutRef}
          // The control's own `aria-valuetext` already speaks the value; announcing the
          // readout too would say it twice (spec §8.2).
          aria-hidden="true"
          className="font-mono text-bb-micro tabular-nums text-bb-text"
        >
          {valueText}
        </span>
      )}
    </div>
  );
}
