/**
 * Panel — the shared section container every mode composes from, so headings, padding,
 * and borders are identical across the 12 modes rather than re-invented per feature
 * (spec §3.5 lens 2 spatial consistency, §3.6 no call-site re-styling).
 */
import type { ReactNode } from 'react';

export interface PanelProps {
  title: string;
  children: ReactNode;
  /** Controls rendered on the heading row (filters, add buttons). */
  actions?: ReactNode;
  /** Let the body own its scrolling — used by list/canvas panels (spec §8.4). */
  scroll?: boolean;
  /**
   * Take the leftover height in the column and let the body shrink with it — for bodies
   * that scale rather than scroll (the pad grid). `scroll` implies this: a panel can only
   * scroll if something bounds its height.
   */
  fill?: boolean;
  className?: string;
}

export function Panel({ title, children, actions, scroll = false, fill = false, className }: PanelProps) {
  // A panel either takes the leftover space (`min-h-0` to permit shrinking below its
  // content) or holds its content height. It must never be merely shrinkable: `min-h-0`
  // on a fixed panel lets the border box collapse under its own body, painting the
  // children outside the panel (spec §8.4 — the mode fits the viewport, so the give has
  // to come from a panel that is built to absorb it).
  const sizing = scroll || fill ? 'min-h-0 flex-1' : 'shrink-0';
  return (
    <section
      aria-label={title}
      className={`flex flex-col rounded-bb-md border border-bb-line bg-bb-surface ${sizing} ${className ?? ''}`}
    >
      <header className="flex items-center justify-between gap-3 border-b border-bb-line px-3 py-2">
        <h3 className="text-xs font-bold tracking-wide text-bb-text uppercase">{title}</h3>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </header>
      {/* `fill` bodies become flex columns so the child that scales (a pad grid, a canvas)
          can claim the leftover height; header rows and notices keep their own. */}
      <div className={`min-h-0 flex-1 p-3 ${fill ? 'flex flex-col' : ''} ${scroll ? 'overflow-y-auto' : ''}`}>
        {children}
      </div>
    </section>
  );
}
