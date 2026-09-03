/**
 * ConfirmDialog — the one shape a destructive confirmation takes (spec §3.6, §8.1).
 *
 * ## When an action needs one (the rule, from issue #54)
 *
 * The test is **what the user can see going**, not whether the action is undoable:
 *
 * - **Confirm** an action that destroys a container whose contents are not on screen — a
 *   whole program (every pad, layer, envelope and mod route in it) or a whole pad (its
 *   layers, envelopes, LFOs and routes). The control names one thing and removes many, so
 *   the dialog's job is to count what is actually at stake before it goes.
 * - **Do not confirm** an action whose whole subject is the row it sits on — one velocity
 *   layer, one mod route, one insert, one song entry, one note. The user can see exactly
 *   what will go, a confirmation on every row makes editing unusable on a touch device, and
 *   §4.5 lists each of these as undoable. Those report through a toast that names Undo,
 *   because the issue's real finding was that nothing on screen said the deletion was
 *   recoverable — not that every deletion needed a gate.
 * - **Do not confirm** a §8.5.4 sample edit (trim, chop, normalise, reverse, fade, stretch).
 *   §8.5.4 has them render a NEW OPFS file and swap a pointer, so the original survives
 *   until the §8.5.7 purge; calling them destructive in the §8.1 sense would be wrong.
 * - **Confirm, and name the files** for a deletion that is genuinely irreversible and
 *   outside the undo stack: the §8.5.7 purge and the §8.1 hard reset. Both already do.
 *
 * `undoable` is what separates the two confirmations that exist. A program delete says so,
 * because a user who knows Ctrl+Z will bring it back answers the dialog differently from
 * one who thinks the pads are gone; the purge deliberately says the opposite.
 */
import type { ReactNode } from 'react';
import { Button } from './Button';
import { Modal } from './Modal';

export interface ConfirmDialogProps {
  open: boolean;
  /** Phrased as the question being answered — "Delete Program 1?". */
  title: string;
  /** What the action destroys, in the user's terms. Count it rather than describing it. */
  children: ReactNode;
  /** The confirming button's label, naming the act — "Delete program", not "OK". */
  confirmLabel: string;
  /** True when undo restores this (spec §4.5); false for a deletion outside the stack. */
  undoable?: boolean;
  /** Blocks both buttons while the action runs, so it cannot be started twice. */
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  'data-testid'?: string;
}

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  undoable = false,
  busy = false,
  onConfirm,
  onCancel,
  'data-testid': testId,
}: ConfirmDialogProps) {
  return (
    <Modal
      open={open}
      title={title}
      size="sm"
      onClose={onCancel}
      data-testid={testId}
      footer={
        <>
          <Button label="Cancel" variant="quiet" disabled={busy} onClick={onCancel} />
          <Button
            label={confirmLabel}
            variant="danger"
            disabled={busy}
            data-testid={testId ? `${testId}-confirm` : undefined}
            onClick={onConfirm}
          />
        </>
      }
    >
      <div className="flex flex-col gap-2 text-xs leading-relaxed text-bb-muted">
        {children}
        <p>
          {undoable
            ? 'Undo (Ctrl+Z) brings it back while this project stays open.'
            : 'This cannot be undone, and Undo will not bring it back.'}
        </p>
      </div>
    </Modal>
  );
}
