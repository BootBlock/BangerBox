/**
 * Reusable labelled form controls for the Program Edit mode (spec §8.5.5) — plain inputs,
 * accessible (label association, aria) and token-styled (spec §3.6). Program Edit has not
 * been moved onto the bespoke `Knob`/`Fader` primitives the rest of the shell uses; these
 * fields are also the keyboard-operable half of the §8.5.5 graphical editors, so any such
 * migration has to keep them reachable without a pointer (spec §8.2).
 */
import { useId, type ReactNode } from 'react';

const FIELD_CLASS = 'w-full rounded-bb-sm border border-bb-line bg-bb-raised px-2 py-1 text-xs text-bb-text';
const LABEL_CLASS = 'flex flex-col gap-1 text-xs text-bb-muted';

/** A labelled numeric input clamped to [min, max] with a step (spec §8.2 keyboard). */
export function NumberField({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  suffix,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  suffix?: string;
}) {
  const id = useId();
  return (
    <label className={LABEL_CLASS} htmlFor={id}>
      <span>
        {label}
        {suffix ? ` (${suffix})` : ''}
      </span>
      <input
        id={id}
        type="number"
        className={FIELD_CLASS}
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

/** A labelled select bound to a string-literal union (spec §8.2). */
export function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { readonly value: T; readonly label: string }[];
  onChange: (value: T) => void;
}) {
  const id = useId();
  return (
    <label className={LABEL_CLASS} htmlFor={id}>
      <span>{label}</span>
      <select
        id={id}
        className={FIELD_CLASS}
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** A labelled checkbox toggle (spec §8.2). */
export function ToggleField({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <label className="flex items-center gap-2 text-xs text-bb-muted" htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        className="accent-bb-accent"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

/** A titled group of controls in the editor grid (spec §3.5 spatial). */
export function ControlGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="rounded-bb-sm border border-bb-line bg-bb-surface p-3">
      <h4 className="mb-2 text-xs font-semibold text-bb-text">{title}</h4>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">{children}</div>
    </section>
  );
}
