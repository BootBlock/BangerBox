/**
 * Fader — the bespoke channel-fader primitive (spec §8.5.6). Shares the gesture engine and
 * ARIA contract with {@link Knob} (spec §3.6 zero DRY): an ARIA `slider` with a human-unit
 * `aria-valuetext`, full keyboard operation, and a cap position painted by direct ref
 * style writes during a drag rather than React state (spec §3.3).
 *
 * The mixer's fader *law* (position → dB → gain) is not duplicated here — callers pass the
 * `faderLevel` unit or their own `formatValue`, and the graph-side taper stays the single
 * source of truth in `core/audio/params/faderLaw.ts` (spec §8.5.6).
 *
 * ## Orientation
 *
 * `vertical` is the channel fader §8.5.6 describes. `horizontal` is the same control lying
 * down, for a setting that belongs on one line of a toolbar or a dialog — the Grid's
 * quantise strength, Sample Edit's transient sensitivity. Both were native
 * `<input type="range">` elements, which §1.3 #10 forbids and which announced bare numbers
 * (issue #35); a variant here is what §3.6 asks for instead of re-styling at the call site.
 */
import { useEffect, useRef } from 'react';
import { formatValueText, valueToNormalised, type ControlCurve, type ControlRange } from './controlMaths';
import { ControlChassis } from './ControlChassis';
import { useContinuousControl } from './useContinuousControl';

export type FaderOrientation = 'vertical' | 'horizontal';

/**
 * Cap and fill are driven by transforms alone so a drag stays composite-only — no layout
 * property is written on a gesture frame (spec §8.3, §11.5 60 fps budget).
 *
 * The cap's positioner spans the full travel, so a percentage translate resolves against
 * the track's own length; the cap inside it is offset by half its own thickness to centre
 * on the travel point. The fill scales from the track's origin edge — the bottom when
 * upright, the left when lying down.
 */
const capTransform = (normalised: number, orientation: FaderOrientation) =>
  orientation === 'vertical' ? `translateY(${-normalised * 100}%)` : `translateX(${normalised * 100}%)`;
const fillTransform = (normalised: number, orientation: FaderOrientation) =>
  orientation === 'vertical' ? `scaleY(${normalised})` : `scaleX(${normalised})`;

/** Track geometry per orientation — the only thing the two variants do not share. */
const TRACK_CLASS: Record<FaderOrientation, string> = {
  vertical: 'h-32 w-7',
  horizontal: 'h-7 w-32',
};
const FILL_CLASS: Record<FaderOrientation, string> = {
  vertical: 'origin-bottom',
  horizontal: 'origin-left',
};
const CAP_TRACK_CLASS: Record<FaderOrientation, string> = {
  vertical: 'inset-x-0.5 inset-y-0',
  horizontal: 'inset-x-0 inset-y-0.5',
};
const CAP_CLASS: Record<FaderOrientation, string> = {
  vertical: 'inset-x-0 bottom-0 h-3 translate-y-1/2',
  horizontal: 'inset-y-0 left-0 w-3 -translate-x-1/2',
};

export interface FaderProps {
  label: string;
  value: number;
  range: ControlRange;
  unit?: string;
  curve?: ControlCurve;
  step?: number;
  fineStep?: number;
  defaultValue?: number;
  disabled?: boolean;
  /**
   * A fuller accessible name for a fader whose visible caption is only meaningful beside
   * its neighbours. Must *begin with* the visible label — WCAG 2.5.3 (Label in Name).
   */
  accessibleName?: string;
  /** Upright channel fader (default), or lying down for an inline setting. */
  orientation?: FaderOrientation;
  /**
   * Snap the dragged value onto the `step` lattice. Off by default, because a channel
   * fader is continuous; a discrete setting — a quantise strength in whole percent — turns
   * it on so a drag lands where the keyboard steps do.
   */
  quantise?: boolean;
  /** Override the readout/`aria-valuetext` where no unit token can express the wording. */
  formatValue?: (value: number) => string;
  /** Hide the textual readout when the caller renders its own (spec §3.6 no re-styling). */
  showValue?: boolean;
  /** The §7.8 address this fader drives, so a §10.3 Q-Link turn moves it live (issue #27). */
  livePath?: string;
  onTransient?: (value: number) => void;
  onCommit: (value: number) => void;
  'data-testid'?: string;
}

export function Fader({
  label,
  value,
  range,
  unit = '',
  curve = 'linear',
  step,
  fineStep,
  defaultValue,
  disabled = false,
  accessibleName,
  orientation = 'vertical',
  quantise = false,
  formatValue,
  showValue = true,
  livePath,
  onTransient,
  onCommit,
  'data-testid': testId,
}: FaderProps) {
  const capRef = useRef<HTMLDivElement | null>(null);
  const fillRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const readoutRef = useRef<HTMLSpanElement | null>(null);

  const describe = (v: number) => formatValue?.(v) ?? formatValueText(v, unit);

  const paint = (next: number, normalised: number) => {
    if (capRef.current) capRef.current.style.transform = capTransform(normalised, orientation);
    if (fillRef.current) fillRef.current.style.transform = fillTransform(normalised, orientation);
    const text = describe(next);
    if (readoutRef.current) readoutRef.current.textContent = text;
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
    orientation,
    quantise,
    livePath,
    onTransient,
    onCommit,
    render: paint,
  });

  const normalised = valueToNormalised(value, range, curve);
  const valueText = describe(value);

  // Keep the ref-painted visuals honest when the value changes outside a gesture
  // (undo, automation, Q-Link) — spec §3.4.
  useEffect(() => {
    if (capRef.current) capRef.current.style.transform = capTransform(normalised, orientation);
    if (fillRef.current) fillRef.current.style.transform = fillTransform(normalised, orientation);
    if (readoutRef.current) readoutRef.current.textContent = valueText;
  }, [normalised, valueText, orientation]);

  return (
    <ControlChassis label={label} valueText={valueText} readoutRef={readoutRef} showValue={showValue}>
      <div
        ref={rootRef}
        role="slider"
        aria-orientation={orientation}
        tabIndex={disabled ? -1 : 0}
        aria-label={accessibleName ?? label}
        aria-valuemin={range[0]}
        aria-valuemax={range[1]}
        aria-valuenow={value}
        aria-valuetext={valueText}
        aria-disabled={disabled || undefined}
        data-testid={testId}
        onPointerDown={control.onPointerDown}
        onKeyDown={control.onKeyDown}
        onDoubleClick={control.onDoubleClick}
        className={`relative touch-none rounded-bb-sm border border-bb-line bg-bb-bg ${
          TRACK_CLASS[orientation]
        } ${disabled ? 'opacity-40' : 'cursor-grab active:cursor-grabbing'}`}
      >
        {/* Travel fill behind the cap; scaled from the track's origin edge. */}
        <div
          ref={fillRef}
          aria-hidden="true"
          className={`absolute inset-0 rounded-bb-sm bg-bb-accent/25 will-change-transform ${FILL_CLASS[orientation]}`}
          style={{ transform: fillTransform(normalised, orientation) }}
        />
        {/* Cap positioner: full travel length, so a percentage translate tracks the fader. */}
        <div
          ref={capRef}
          aria-hidden="true"
          className={`pointer-events-none absolute will-change-transform ${CAP_TRACK_CLASS[orientation]}`}
          style={{ transform: capTransform(normalised, orientation) }}
        >
          {/* Cap; offset by half its own thickness so it centres on the travel point. */}
          <div
            className={`absolute rounded-bb-sm border border-bb-line bg-bb-raised shadow-bb-raised ${CAP_CLASS[orientation]}`}
          />
        </div>
      </div>
    </ControlChassis>
  );
}
