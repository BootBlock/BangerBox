/**
 * Browser-mode Factory section (spec §8.5 item 7, §9.8).
 *
 * Lists the `/factory/index.json` catalogue with each pack's title, kind and size, and
 * installs on tap — a `kit` merging into the active project, a `demo` opening as a new one.
 * Packs are fetched on demand, so the section states when a pack is not yet cached, and it
 * surfaces a fetch failure as a RETRYABLE error rather than an empty list (an empty list
 * would read as "no factory content exists", which is a different and wrong message).
 */
import { useEffect, useState } from 'react';
import {
  describeInstall,
  fetchFactoryCatalogue,
  installFactoryPack,
  isPackCached,
  reportInstallFailure,
  type FactoryCatalogue,
  type FactoryPack,
} from '@/core/project';
import { useProjectStore, useUIStore } from '@/store';
import { refreshSamples } from '../sample-edit/sampleContext';

/** en-GB size readout (spec §1.3.1 — `Intl`, no formatting library). */
const SIZE_FORMAT = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 });

function formatSize(bytes: number): string {
  return `${SIZE_FORMAT.format(bytes / 1024 / 1024)} MB`;
}

export function FactorySection() {
  const [catalogue, setCatalogue] = useState<FactoryCatalogue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState<string | null>(null);
  const [cached, setCached] = useState<Record<string, boolean>>({});
  const projectId = useProjectStore((state) => state.projectId);
  const pushToast = useUIStore((state) => state.pushToast);

  /** Bumped by Retry to re-run the catalogue load (spec §8.5 item 7 retryable failure). */
  const [reloadToken, setReloadToken] = useState(0);

  // Follows the async-IIFE-with-cancellation pattern used elsewhere in this panel: the
  // initial `loading`/`error` state already describes a load in flight, so nothing is set
  // synchronously in the effect body, and a late response cannot write to an unmounted
  // component.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const packs = await fetchFactoryCatalogue();
        if (cancelled) return;
        setCatalogue(packs);
        const states = await Promise.all(
          packs.map(async (pack) => [pack.id, await isPackCached(pack)] as const),
        );
        if (!cancelled) setCached(Object.fromEntries(states));
      } catch (cause) {
        if (cancelled) return;
        setCatalogue(null);
        setError(cause instanceof Error ? cause.message : 'Could not load the factory catalogue.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  const retry = () => {
    setLoading(true);
    setError(null);
    setReloadToken((token) => token + 1);
  };

  const install = async (pack: FactoryPack) => {
    setInstalling(pack.id);
    try {
      const result = await installFactoryPack(pack, projectId);
      // A kit merges new samples into the open project; the library list must follow.
      await refreshSamples();
      setCached((current) => ({ ...current, [pack.id]: true }));
      pushToast(describeInstall(result, pack), 'success');
    } catch (cause) {
      reportInstallFailure(cause);
    } finally {
      setInstalling(null);
    }
  };

  return (
    <section aria-labelledby="factory-heading" className="flex flex-col gap-2">
      <h3 id="factory-heading" className="text-[0.625rem] font-semibold text-bb-muted uppercase">
        Factory content
      </h3>

      {loading && <p className="text-xs text-bb-muted">Loading factory content…</p>}

      {error !== null && (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-bb-muted">
          <span>{error}</span>
          <button
            type="button"
            data-testid="factory-retry"
            onClick={retry}
            className="rounded-bb-sm border border-bb-line bg-bb-raised px-2 py-0.5"
          >
            Retry
          </button>
        </div>
      )}

      {catalogue !== null && catalogue.length === 0 && (
        <p className="text-xs text-bb-muted">No factory packs are available in this build.</p>
      )}

      {catalogue !== null && catalogue.length > 0 && (
        <ul className="rounded-bb-sm border border-bb-line" aria-label="Factory packs">
          {catalogue.map((pack) => (
            <li
              key={pack.id}
              className="flex items-center justify-between gap-2 border-b border-bb-line px-2 py-1.5 text-xs last:border-b-0"
            >
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{pack.title}</span>
                <span className="truncate text-[0.625rem] text-bb-muted">{pack.description}</span>
              </span>
              <span className="shrink-0 rounded-bb-sm border border-bb-line px-1.5 py-0.5 text-[0.625rem] text-bb-muted uppercase">
                {pack.kind}
              </span>
              <span className="shrink-0 text-[0.625rem] text-bb-muted">{formatSize(pack.bytes)}</span>
              {/* Packs are fetched on demand — say so before the user commits to a download. */}
              <span className="shrink-0 text-[0.625rem] text-bb-muted">
                {cached[pack.id] === true ? 'Cached' : 'Not cached'}
              </span>
              <button
                type="button"
                disabled={installing !== null}
                data-testid={`factory-install-${pack.id}`}
                aria-label={
                  pack.kind === 'kit'
                    ? `Merge ${pack.title} into this project`
                    : `Open ${pack.title} as a new project`
                }
                onClick={() => void install(pack)}
                className="shrink-0 rounded-bb-sm border border-bb-line bg-bb-raised px-2 py-0.5 disabled:opacity-50"
              >
                {installing === pack.id ? 'Installing…' : pack.kind === 'kit' ? 'Merge' : 'Open'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
