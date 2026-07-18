/**
 * FieldLabel — the small uppercase caption that names a control (spec §3.6). The chassis
 * was hand-rolled at 14 call sites and had drifted into three variants: `gap-1.5` in Grid,
 * Browser and Insert, `gap-2` in Pad Perform, Q-Link and XYFX, and a third inside
 * ValueReadout that added `tracking-wide`. This settles it at one: `gap-1.5`, tracked.
 *
 * Most call sites wrap their control as a child, which is why the default element is a
 * `<label>` — that associates the caption with the control without needing an id. Pass
 * `as="span"` when the caption names something that is not a form control (a canvas, a
 * pad grid), where a `<label>` would be wrong rather than merely unnecessary.
 */
import type { ReactNode } from 'react';

export interface FieldLabelProps {
  /** The caption text, followed by the control it names when the control is a child. */
  children: ReactNode;
  as?: 'label' | 'span';
  /** Associate with a control by id instead of wrapping it. `as="label"` only. */
  htmlFor?: string;
  'data-testid'?: string;
}

const CHASSIS =
  'flex items-center gap-1.5 text-[0.625rem] font-semibold tracking-wide text-bb-muted uppercase';

export function FieldLabel({ children, as = 'label', htmlFor, 'data-testid': testId }: FieldLabelProps) {
  if (as === 'span') {
    return (
      <span className={CHASSIS} data-testid={testId}>
        {children}
      </span>
    );
  }
  return (
    <label className={CHASSIS} htmlFor={htmlFor} data-testid={testId}>
      {children}
    </label>
  );
}
