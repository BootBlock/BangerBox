/**
 * LiveRegion — the single polite announcer for the whole app (spec §8.2: "live
 * announcements (transport state, save confirmations) through a single polite
 * LiveRegion"). One region avoids the competing-announcement problem that appears when
 * several components each mount their own.
 *
 * Callers announce through {@link announce} from anywhere — including non-React code such
 * as the sync layer — and the mounted region relays it. Messages are visually hidden but
 * present in the accessibility tree.
 */
import { useEffect, useState } from 'react';

type Listener = (message: string) => void;

const listeners = new Set<Listener>();
let lastMessage = '';

/** Zero-width space, built from its code point so no invisible character appears in
 *  source (`no-irregular-whitespace` rejects those, and they are a maintenance hazard). */
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

/**
 * Announce a message politely. Repeating an identical message appends a zero-width space
 * so screen readers treat it as a fresh announcement rather than an unchanged node.
 */
export function announce(message: string): void {
  const text = message === lastMessage ? `${message}${ZERO_WIDTH_SPACE}` : message;
  lastMessage = text;
  for (const listener of listeners) listener(text);
}

export function LiveRegion() {
  const [message, setMessage] = useState('');

  useEffect(() => {
    listeners.add(setMessage);
    return () => {
      listeners.delete(setMessage);
    };
  }, []);

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-testid="live-region"
      // Visually hidden but kept in the accessibility tree — `display:none` would mute it.
      className="sr-only"
    >
      {message}
    </div>
  );
}
