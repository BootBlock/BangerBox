/**
 * Fader — the bespoke channel-fader primitive (spec §8.5.6). Shares the gesture engine and
 * ARIA contract with {@link Knob} (spec §3.6 zero DRY): an ARIA `slider` with a human-unit
 * `aria-valuetext`, full keyboard operation, and a cap position painted by direct ref
 * style writes during a drag rather than React state (spec §3.3).
 *
 * The mixer's fader *law* (position → dB → gain) is not duplicated here — callers pass a
 * `unit`/`formatValue` pair, and the graph-side taper stays the single source of truth in
 * `core/audio/params/faderLaw.ts` (spec §8.5.6).
 */
import { useEffect, useRef } from 'react';
import { formatValueText, valueToNormalised, type ControlCurve, type ControlRange } from './controlMaths';
import { useContinuousControl } from './useContinuousControl';

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
  /** Override the readout/`aria-valuetext` — the mixer shows dB for a 0..1.2 position. */
  formatValue?: (value: number) => string;
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
  formatValue,
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
    const percent = `${normalised * 100}%`;
    if (capRef.current) capRef.current.style.bottom = percent;
    if (fillRef.current) fillRef.current.style.height = percent;
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
    onTransient,
    onCommit,
    render: paint,
  });

  const normalised = valueToNormalised(value, range, curve);
  const valueText = describe(value);

  // Keep the ref-painted visuals honest when the value changes outside a gesture
  // (undo, automation, Q-Link) — spec §3.4.
  useEffect(() => {
    const percent = `${normalised * 100}%`;
    if (capRef.current) capRef.current.style.bottom = percent;
    if (fillRef.current) fillRef.current.style.height = percent;
    if (readoutRef.current) readoutRef.current.textContent = valueText;
  }, [normalised, valueText]);

  return (
    <div className="flex flex-col items-center gap-1">
      <div
        ref={rootRef}
        role="slider"
        aria-orientation="vertical"
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
        className={`relative h-32 w-7 touch-none rounded-bb-sm border border-bb-line bg-bb-bg ${
          disabled ? 'opacity-40' : 'cursor-grab active:cursor-grabbing'
        }`}
      >
        {/* Travel fill below the cap. */}
        <div
          ref={fillRef}
          aria-hidden="true"
          className="absolute inset-x-0 bottom-0 rounded-bb-sm bg-bb-accent/25"
          style={{ height: `${normalised * 100}%` }}
        />
        {/* Cap; translated up by its own half-height so it centres on the travel point. */}
        <div
          ref={capRef}
          aria-hidden="true"
          className="absolute inset-x-0.5 h-3 -translate-y-1/2 rounded-bb-sm border border-bb-line bg-bb-raised shadow-bb-raised will-change-transform"
          style={{ bottom: `${normalised * 100}%` }}
        />
      </div>
      <span className="max-w-16 truncate text-center text-[0.625rem] leading-tight text-bb-muted">
        {label}
      </span>
      <span
        ref={readoutRef}
        aria-hidden="true"
        className="font-mono text-[0.625rem] tabular-nums text-bb-text"
      >
        {valueText}
      </span>
    </div>
  );
}
