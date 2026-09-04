/**
 * LiveRegion — the app's only announcer (spec §8.2: "live announcements (transport state,
 * save confirmations) through a single polite LiveRegion"). One announcer avoids the
 * competing-announcement problem that appears when several components each mount their
 * own: two live regions produce an unpredictable order, and in practice drop messages.
 *
 * Callers announce through {@link announce} from anywhere — including non-React code such
 * as the sync layer — and the mounted regions relay it. Messages are visually hidden but
 * present in the accessibility tree.
 *
 * ## Why there are two regions and not one
 *
 * A polite region waits for the screen reader to finish what it is saying; an assertive one
 * interrupts. Severity used to pick between the two by giving each toast its own
 * `role="status"` or `role="alert"` (issue #34), which is exactly the competing-region
 * defect. Losing the distinction instead would announce "Your work cannot be saved on this
 * device" behind whatever was already queued. So the announcer carries both channels, both
 * permanently mounted, and {@link announce} picks the channel. Two is the whole set: a
 * third would be a competing region again.
 *
 * Mounted by `App` rather than by `AppShell`, so it exists before the §5.1 start gate has
 * been passed and stays mounted for the session. The three blocking screens
 * (`CapabilityGate`, `AlreadyOpenScreen`, `AppErrorFallback`) render INSTEAD of `App` and
 * so cannot compete; they keep their own regions.
 */
import { useEffect, useState } from 'react';

/** Which channel a message takes: polite waits its turn, assertive interrupts (§8.2). */
export type AnnounceUrgency = 'polite' | 'assertive';

type Listener = (message: string) => void;

const listeners: Record<AnnounceUrgency, Set<Listener>> = {
  polite: new Set(),
  assertive: new Set(),
};
const lastMessage: Record<AnnounceUrgency, string> = { polite: '', assertive: '' };

/** Zero-width space, built from its code point so no invisible character appears in
 *  source (`no-irregular-whitespace` rejects those, and they are a maintenance hazard). */
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

/**
 * Announce a message. Repeating an identical message appends a zero-width space so screen
 * readers treat it as a fresh announcement rather than an unchanged node.
 *
 * `urgency` defaults to polite: interrupting is for what the user must act on now — a
 * failure, a refusal, a warning — never for confirming that something worked.
 */
export function announce(message: string, urgency: AnnounceUrgency = 'polite'): void {
  const text = message === lastMessage[urgency] ? `${message}${ZERO_WIDTH_SPACE}` : message;
  lastMessage[urgency] = text;
  for (const listener of listeners[urgency]) listener(text);
}

/**
 * Announce `message` whenever it becomes a new non-null value, and say nothing when it
 * clears. This is the shape almost every call site wants — an error string, a status line,
 * a notice that has just appeared — and having it here rather than as an effect at each
 * site is what keeps those sites from growing live regions of their own again (issue #34).
 */
export function useAnnounce(message: string | null, urgency: AnnounceUrgency = 'polite'): void {
  useEffect(() => {
    if (message === null || message === '') return;
    announce(message, urgency);
  }, [message, urgency]);
}

function useAnnouncedMessage(urgency: AnnounceUrgency): string {
  const [message, setMessage] = useState('');
  useEffect(() => {
    const channel = listeners[urgency];
    channel.add(setMessage);
    return () => {
      channel.delete(setMessage);
    };
  }, [urgency]);
  return message;
}

export function LiveRegion() {
  const polite = useAnnouncedMessage('polite');
  const assertive = useAnnouncedMessage('assertive');

  return (
    <>
      <div
        // `aria-live` without `role="status"`: the implicit role would make this announcer
        // and any transient notice indistinguishable to assistive tech (and to queries).
        // Announcement behaviour is identical; the ambiguity is not.
        aria-live="polite"
        aria-atomic="true"
        data-testid="live-region"
        // Visually hidden but kept in the accessibility tree — `display:none` would mute it.
        className="sr-only"
      >
        {polite}
      </div>
      <div aria-live="assertive" aria-atomic="true" data-testid="live-region-assertive" className="sr-only">
        {assertive}
      </div>
    </>
  );
}
