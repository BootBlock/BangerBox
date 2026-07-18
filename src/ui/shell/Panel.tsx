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
  className?: string;
}

export function Panel({ title, children, actions, scroll = false, className }: PanelProps) {
  return (
    <section
      aria-label={title}
      className={`flex min-h-0 flex-col rounded-bb-md border border-bb-line bg-bb-surface ${className ?? ''}`}
    >
      <header className="flex items-center justify-between gap-3 border-b border-bb-line px-3 py-2">
        <h3 className="text-xs font-bold tracking-wide text-bb-text uppercase">{title}</h3>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </header>
      <div className={`min-h-0 flex-1 p-3 ${scroll ? 'overflow-y-auto' : ''}`}>{children}</div>
    </section>
  );
}
