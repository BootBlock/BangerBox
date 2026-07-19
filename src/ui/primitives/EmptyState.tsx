/**
 * EmptyState — the line a panel shows when it has nothing to list (spec §3.6).
 *
 * Every mode had one, which is right, but the wording had split into two incompatible
 * voices: some described the state ("No sequences yet.") and some only prescribed an
 * action ("Add a sequence below to start the arrangement."), so the same situation read
 * as a status in one mode and as an instruction in the next. The prescriptive ones were
 * also the ones that went stale, because a sentence that names an action stops being true
 * the moment that action moves.
 *
 * The props settle one voice structurally rather than by convention: `message` always
 * describes the state and is mandatory, `hint` optionally names what to do next and is
 * always secondary. A call site cannot render guidance without first saying what is empty.
 *
 * `hint` is for a step the user can take *from this surface*. Where the app has no such
 * step yet, omit it — a description that is merely unhelpful is better than an
 * instruction that cannot be followed (see #37 and #40 for the two gaps that leaves).
 */

export interface EmptyStateProps {
  /**
   * What is empty, as a sentence describing the state — "No layers yet." Never phrase
   * this as an instruction; that is what `hint` is for.
   */
  message: string;
  /** Optional following sentence naming the next step, where the UI offers one. */
  hint?: string;
  /**
   * Render as a list item when the empty line sits inside the very `<ul>` it describes,
   * where a bare `<p>` would be invalid content.
   */
  as?: 'p' | 'li';
  'data-testid'?: string;
}

export function EmptyState({ message, hint, as = 'p', 'data-testid': testId }: EmptyStateProps) {
  // One line, muted, at the panel's body size — matching what the populated list renders at,
  // so an empty panel reads as the same surface rather than as a different kind of message.
  const className = 'text-xs text-bb-muted';
  const content = hint === undefined ? message : `${message} ${hint}`;
  return as === 'li' ? (
    <li className={className} data-testid={testId}>
      {content}
    </li>
  ) : (
    <p className={className} data-testid={testId}>
      {content}
    </p>
  );
}
