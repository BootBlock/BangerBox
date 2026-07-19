/**
 * Knob — the bespoke rotary primitive (spec §1.3 #10: no component library). Presented as
 * an ARIA `slider` with `aria-valuemin/max/now` + a human-unit `aria-valuetext`
 * (spec §8.2), fully keyboard-operable, and dragged through {@link useContinuousControl}.
 *
 * The pointer of the dial is rotated by a direct ref style write during a gesture — never
 * React state (spec §3.3) — so a turn costs zero re-renders. Between gestures the `value`
 * prop drives the same transform through the render pass, which keeps the control
 * reflecting the current store value on mount (spec §3.4 state-to-graph verification).
 */
import { useEffect, useRef } from 'react';
import { formatValueText, valueToNormalised, type ControlCurve, type ControlRange } from './controlMaths';
import { ControlChassis } from './ControlChassis';
import { useContinuousControl } from './useContinuousControl';

/** Dial sweep: 270° of travel centred on 12 o'clock, the hardware-encoder convention. */
const SWEEP_DEGREES = 270;
const MIN_ANGLE = -SWEEP_DEGREES / 2;

export interface KnobProps {
  label: string;
  value: number;
  range: ControlRange;
  /** Unit for `aria-valuetext` and the readout — 'dB', 'Hz', '%', 'ms', … (spec §8.2). */
  unit?: string;
  curve?: ControlCurve;
  step?: number;
  fineStep?: number;
  defaultValue?: number;
  disabled?: boolean;
  /** Hide the textual readout when the caller renders its own (spec §3.6 no re-styling). */
  showValue?: boolean;
  size?: 'sm' | 'md';
  onTransient?: (value: number) => void;
  onCommit: (value: number) => void;
  'data-testid'?: string;
}

const SIZE_CLASS: Record<'sm' | 'md', string> = {
  sm: 'h-9 w-9',
  md: 'h-12 w-12',
};

export function Knob({
  label,
  value,
  range,
  unit = '',
  curve = 'linear',
  step,
  fineStep,
  defaultValue,
  disabled = false,
  showValue = true,
  size = 'md',
  onTransient,
  onCommit,
  'data-testid': testId,
}: KnobProps) {
  const pointerRef = useRef<HTMLDivElement | null>(null);
  const readoutRef = useRef<HTMLSpanElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  /** Paint dial angle, readout text, and the live ARIA value without a re-render (§3.3). */
  const paint = (next: number, normalised: number) => {
    if (pointerRef.current) {
      pointerRef.current.style.transform = `rotate(${MIN_ANGLE + normalised * SWEEP_DEGREES}deg)`;
    }
    const text = formatValueText(next, unit);
    if (readoutRef.current) readoutRef.current.textContent = text;
    // Assistive tech must track the drag, so the ARIA pair is written directly too.
    rootRef.current?.setAttribute('aria-valuenow', String(next));
    rootRef.current?.setAttribute('aria-valuetext', text);
  };

  const control = useContinuousControl({
    value,
    range,
    curve,
    step,
    fineStep,
    defaultValue,
    disabled,
    onTransient,
    onCommit,
    render: paint,
  });

  const normalised = valueToNormalised(value, range, curve);
  const valueText = formatValueText(value, unit);

  // Re-sync the ref-painted visuals whenever the committed value changes underneath us
  // (undo, Q-Link, automation) — the render pass owns the value between gestures (§3.4).
  useEffect(() => {
    if (pointerRef.current) {
      pointerRef.current.style.transform = `rotate(${MIN_ANGLE + normalised * SWEEP_DEGREES}deg)`;
    }
    if (readoutRef.current) readoutRef.current.textContent = valueText;
  }, [normalised, valueText]);

  return (
    <ControlChassis label={label} valueText={valueText} readoutRef={readoutRef} showValue={showValue}>
      <div
        ref={rootRef}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={label}
        aria-valuemin={range[0]}
        aria-valuemax={range[1]}
        aria-valuenow={value}
        aria-valuetext={valueText}
        aria-disabled={disabled || undefined}
        data-testid={testId}
        onPointerDown={control.onPointerDown}
        onKeyDown={control.onKeyDown}
        onDoubleClick={control.onDoubleClick}
        // `bb-touch-target`: the 36 px `sm` circle is hard to *acquire* on touch even though
        // the drag itself is well tuned (FULL_TRAVEL_PX). The hit area reaches 44 px; the
        // circle stays 36 px so a transport bar of knobs keeps its density (spec §8.1).
        className={`bb-touch-target touch-none rounded-full border border-bb-line bg-bb-raised shadow-bb-raised transition-shadow duration-150 ease-bb-snap ${
          SIZE_CLASS[size]
        } ${disabled ? 'opacity-40' : 'cursor-grab hover:shadow-bb-glow active:cursor-grabbing'}`}
      >
        {/* Indicator line; rotated by ref during gestures (spec §3.3). */}
        <div
          ref={pointerRef}
          aria-hidden="true"
          className="absolute inset-0 flex justify-center will-change-transform"
          style={{ transform: `rotate(${MIN_ANGLE + normalised * SWEEP_DEGREES}deg)` }}
        >
          <span className="mt-1 block h-1/3 w-0.5 rounded-full bg-bb-accent" />
        </div>
      </div>
    </ControlChassis>
  );
}
