/**
 * Main mode — the dashboard (spec §8.5.1): active sequence/track/program summary, bar
 * counter, a quick pad grid for the current bank, recent projects, and storage usage.
 *
 * Everything here is a live view of the stores; the pad grid sounds through the shared
 * dual-path trigger (spec §7.6), so no control on this screen is decorative (spec §3.4).
 */
import { useEffect, useState } from 'react';
import { useProgramStore, useProjectStore, useSequenceStore, useTransportStore } from '@/store';
import { estimateStorage } from '@/core/storage/safeguards';
import { Pad, SegmentControl, ValueReadout } from '@/ui/primitives';
import { Panel } from '@/ui/shell/Panel';
import { AudioEnginePanel } from '@/ui/AudioEnginePanel';
import { StoragePanel } from '@/ui/StoragePanel';
import { usePadTrigger } from '@/ui/usePadTrigger';

/** Pads per bank (spec §1.3.1 — 128 pads as 8 banks × 16). */
const PADS_PER_BANK = 16;
const BANKS = [0, 1, 2, 3, 4, 5, 6, 7] as const;

const BANK_OPTIONS = BANKS.map((bank) => ({ value: bank, label: String.fromCharCode(65 + bank) }));

/** Format bytes in en-GB units for the storage readout (spec §1.3.1 — Intl, no libraries). */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 }).format(value)} ${units[unitIndex]}`;
}

export function MainMode() {
  const projectName = useProjectStore((s) => s.projectName);
  const sampleRate = useProjectStore((s) => s.sampleRate);
  const bitDepth = useProjectStore((s) => s.bitDepth);
  const activeSequenceId = useTransportStore((s) => s.activeSequenceId);
  const position = useTransportStore((s) => s.coarsePosition);
  const bpm = useTransportStore((s) => s.bpm);
  const sequences = useSequenceStore((s) => s.sequences);
  const tracks = useSequenceStore((s) => s.tracks);
  const programs = useProgramStore((s) => s.programs);
  const activeProgramId = useProgramStore((s) => s.activeProgramId);
  const activePadId = useProgramStore((s) => s.activePadId);

  const [bank, setBank] = useState<number>(0);
  const [storage, setStorage] = useState<{ usage: number; quota: number } | null>(null);

  const { trigger, release, trackId } = usePadTrigger();

  // Storage usage is read once per mount — an estimate call per frame would be wasteful
  // and the figure moves slowly (spec §9.7).
  useEffect(() => {
    let cancelled = false;
    void estimateStorage().then((estimate) => {
      if (!cancelled) setStorage({ usage: estimate.usage, quota: estimate.quota });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const activeSequence = activeSequenceId ? sequences[activeSequenceId] : undefined;
  const activeProgram = activeProgramId ? programs[activeProgramId] : undefined;
  const sequenceTracks = Object.values(tracks).filter(
    (track) => activeSequenceId === null || track.sequenceId === activeSequenceId,
  );

  // Assigned pads for the visible bank — drum programs hold a sparse pad array (spec §6).
  const padsByIndex = new Map<number, string>();
  if (activeProgram?.type === 'drum') {
    for (const pad of activeProgram.pads) padsByIndex.set(pad.padIndex, pad.name);
  }

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[2fr_1fr]">
      <div className="flex min-h-0 flex-col gap-3">
        <Panel title="Now playing">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <ValueReadout label="Project" value={projectName || '—'} showLabel />
            <ValueReadout
              label="Sequence"
              value={activeSequence?.name ?? '—'}
              showLabel
              data-testid="main-active-sequence"
            />
            <ValueReadout label="Program" value={activeProgram?.name ?? '—'} showLabel />
            <ValueReadout
              label="Position"
              value={`${String(position.bar).padStart(3, '0')}:${position.beat}`}
              showLabel
              tone="accent"
              data-testid="main-bar-counter"
            />
            <ValueReadout label="Tempo" value={`${Math.round(bpm)} bpm`} showLabel />
            <ValueReadout
              label="Length"
              value={activeSequence ? `${activeSequence.lengthBars} bars` : '—'}
              showLabel
            />
            <ValueReadout label="Tracks" value={sequenceTracks.length} showLabel />
            <ValueReadout
              label="Format"
              value={`${new Intl.NumberFormat('en-GB').format(sampleRate)} Hz · ${bitDepth}`}
              showLabel
            />
          </div>
        </Panel>

        <Panel
          title="Quick pads"
          actions={
            <SegmentControl
              label="Pad bank"
              value={bank}
              options={BANK_OPTIONS}
              size="sm"
              onChange={setBank}
              data-testid="main-bank"
            />
          }
        >
          <div className="grid grid-cols-4 gap-2">
            {Array.from({ length: PADS_PER_BANK }, (_, slot) => {
              const padIndex = bank * PADS_PER_BANK + slot;
              const name = padsByIndex.get(padIndex);
              return (
                <Pad
                  key={padIndex}
                  label={name ?? `Pad ${padIndex + 1}`}
                  padIndex={padIndex}
                  assigned={name !== undefined}
                  selected={activePadId === padIndex}
                  disabled={trackId === null}
                  onTrigger={(index, velocity) => trigger(index, velocity)}
                  onRelease={(index) => release(index)}
                  onSelect={(index) => useProgramStore.getState().setActivePad(index)}
                  data-testid={`main-pad-${padIndex}`}
                />
              );
            })}
          </div>
          {trackId === null && (
            <p className="mt-3 text-xs text-bb-muted">Add a track to the active sequence to play pads.</p>
          )}
        </Panel>
      </div>

      <div className="flex min-h-0 flex-col gap-3">
        <Panel title="Engine">
          <AudioEnginePanel />
        </Panel>

        <Panel title="Sequences" scroll>
          <ul className="flex flex-col gap-1">
            {Object.values(sequences).length === 0 && (
              <li className="text-xs text-bb-muted">No sequences yet.</li>
            )}
            {Object.values(sequences)
              .sort((a, b) => a.position - b.position)
              .map((sequence) => (
                <li key={sequence.id}>
                  <button
                    type="button"
                    aria-current={sequence.id === activeSequenceId}
                    onClick={() => useTransportStore.getState().setActiveSequenceId(sequence.id)}
                    className={`flex w-full items-center justify-between rounded-bb-sm border px-2 py-1.5 text-left text-xs transition-colors duration-150 ${
                      sequence.id === activeSequenceId
                        ? 'border-bb-accent bg-bb-raised text-bb-text'
                        : 'border-bb-line text-bb-muted hover:text-bb-text'
                    }`}
                  >
                    <span className="truncate">{sequence.name}</span>
                    <span className="ml-2 shrink-0 font-mono tabular-nums">{sequence.lengthBars} bars</span>
                  </button>
                </li>
              ))}
          </ul>
        </Panel>

        <Panel title="Storage">
          {storage ? (
            <div className="flex flex-col gap-2">
              <ValueReadout
                label="Used"
                value={`${formatBytes(storage.usage)} of ${formatBytes(storage.quota)}`}
                showLabel
                data-testid="main-storage"
              />
              <div
                role="progressbar"
                aria-label="Storage used"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={storage.quota > 0 ? Math.round((storage.usage / storage.quota) * 100) : 0}
                className="h-2 overflow-hidden rounded-full bg-bb-raised"
              >
                <div
                  className="h-full bg-bb-accent"
                  style={{
                    width: `${storage.quota > 0 ? Math.min(100, (storage.usage / storage.quota) * 100) : 0}%`,
                  }}
                />
              </div>
            </div>
          ) : (
            <p className="text-xs text-bb-muted">Reading storage estimate…</p>
          )}

          {/* Durable-layer diagnostics + the §9.7 persistence/eviction notice. */}
          <div className="mt-3 border-t border-bb-line pt-3">
            <StoragePanel />
          </div>
        </Panel>
      </div>
    </div>
  );
}
