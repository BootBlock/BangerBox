/**
 * Track & Pad Mute mode — spec §8.5.3: large touch hitboxes for live mute/solo toggling of
 * tracks and pads, in latched and momentary modes.
 *
 * Mute and solo are mixer-store state; solo becomes *computed* mutes in the sync layer
 * (solo-in-place), never here (spec §5.2 "solo logic ... evaluated in the sync layer,
 * never in the UI"). This mode only expresses intent.
 *
 * Momentary mode is a live performance gesture: the mute engages on press and reverts on
 * release, and — like all performance gestures — it is deliberately not undoable
 * (spec §4.5). Latched mode commits normally.
 */
import { useCallback, useRef, useState } from 'react';
import { useMixerStore, useProgramStore, useSequenceStore, useTransportStore } from '@/store';
import { SegmentControl, Toggle } from '@/ui/primitives';
import { Panel } from '@/ui/shell/Panel';

type HoldMode = 'latch' | 'momentary';

const PADS_PER_BANK = 16;
const BANK_OPTIONS = [0, 1, 2, 3, 4, 5, 6, 7].map((bank) => ({
  value: bank,
  label: String.fromCharCode(65 + bank),
}));

export function MutingMode() {
  const channels = useMixerStore((s) => s.channels);
  const tracks = useSequenceStore((s) => s.tracks);
  const activeSequenceId = useTransportStore((s) => s.activeSequenceId);
  const activeProgramId = useProgramStore((s) => s.activeProgramId);
  const programs = useProgramStore((s) => s.programs);

  const [holdMode, setHoldMode] = useState<HoldMode>('latch');
  const [bank, setBank] = useState(0);
  /** Channels a momentary press engaged, so release can restore their prior state. */
  const momentaryOrigins = useRef(new Map<string, boolean>());

  const sequenceTracks = Object.values(tracks)
    .filter((track) => activeSequenceId === null || track.sequenceId === activeSequenceId)
    .sort((a, b) => a.position - b.position);

  const activeProgram = activeProgramId ? programs[activeProgramId] : undefined;
  const padNames = new Map<number, string>();
  if (activeProgram?.type === 'drum') {
    for (const pad of activeProgram.pads) padNames.set(pad.padIndex, pad.name);
  }

  const setMute = useCallback((channelId: string, mute: boolean) => {
    useMixerStore.getState().setMute(channelId, mute);
  }, []);

  const pressMute = useCallback(
    (channelId: string, currentlyMuted: boolean) => {
      if (holdMode === 'latch') {
        setMute(channelId, !currentlyMuted);
        return;
      }
      momentaryOrigins.current.set(channelId, currentlyMuted);
      setMute(channelId, !currentlyMuted);
    },
    [holdMode, setMute],
  );

  const releaseMute = useCallback(
    (channelId: string) => {
      if (holdMode !== 'momentary') return;
      const origin = momentaryOrigins.current.get(channelId);
      if (origin === undefined) return;
      momentaryOrigins.current.delete(channelId);
      setMute(channelId, origin);
    },
    [holdMode, setMute],
  );

  /** One large mute/solo cell — the touch target the mode exists to provide (spec §8.5.3). */
  const renderCell = (channelId: string, label: string, testIdPrefix: string) => {
    const strip = channels[channelId];
    const muted = strip?.mute ?? false;
    const soloed = strip?.solo ?? false;
    return (
      <div key={channelId} className="flex flex-col gap-1">
        <button
          type="button"
          aria-label={`${label} mute`}
          aria-pressed={muted}
          data-testid={`${testIdPrefix}-mute`}
          onPointerDown={() => pressMute(channelId, muted)}
          onPointerUp={() => releaseMute(channelId)}
          onPointerCancel={() => releaseMute(channelId)}
          onPointerLeave={() => releaseMute(channelId)}
          // Keyboard operates the latch semantics — a key has no meaningful hold (spec §8.2).
          onKeyDown={(event) => {
            if (event.key !== ' ' && event.key !== 'Enter') return;
            event.preventDefault();
            setMute(channelId, !muted);
          }}
          className={`flex min-h-20 flex-col items-center justify-center rounded-bb-md border px-2 py-3 text-xs font-semibold transition-colors duration-150 ease-bb-snap ${
            muted
              ? 'border-bb-danger bg-bb-danger text-bb-bg'
              : 'border-bb-line bg-bb-raised text-bb-text hover:border-bb-accent-strong'
          }`}
        >
          <span className="line-clamp-2 text-center break-words">{label}</span>
          <span className="mt-1 text-[0.625rem] opacity-80">{muted ? 'Muted' : 'Live'}</span>
        </button>
        <Toggle
          label={`${label} solo`}
          pressed={soloed}
          tone="warn"
          // Sized to sit under the `min-h-20` mute button as a peer. §8.5.3 asks for large
          // hitboxes for live mute *and* solo; solo had been left at the default small
          // toggle, so the two halves of one performance gesture were 80 px and 24 px.
          size="lg"
          block
          onChange={(next) => useMixerStore.getState().setSolo(channelId, next)}
          data-testid={`${testIdPrefix}-solo`}
        />
      </div>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <Panel
        title="Mute mode"
        actions={
          <SegmentControl
            label="Hold behaviour"
            value={holdMode}
            options={[
              { value: 'latch', label: 'Latch' },
              { value: 'momentary', label: 'Momentary' },
            ]}
            size="sm"
            onChange={setHoldMode}
            data-testid="muting-hold-mode"
          />
        }
      >
        <p className="text-xs text-bb-muted">
          {holdMode === 'latch'
            ? 'Tap to toggle a mute; it stays until tapped again.'
            : 'Hold to mute; the channel returns to its previous state on release.'}
        </p>
      </Panel>

      <Panel title="Tracks" scroll>
        {sequenceTracks.length === 0 ? (
          <p className="text-xs text-bb-muted">No tracks in the active sequence.</p>
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
            {sequenceTracks.map((track) =>
              renderCell(`track:${track.id}`, track.name, `muting-track-${track.id}`),
            )}
          </div>
        )}
      </Panel>

      <Panel
        title="Pads"
        scroll
        actions={
          <SegmentControl
            label="Pad bank"
            value={bank}
            options={BANK_OPTIONS}
            size="sm"
            onChange={setBank}
            data-testid="muting-bank"
          />
        }
      >
        {activeProgramId === null ? (
          <p className="text-xs text-bb-muted">Select a program to mute its pads.</p>
        ) : (
          <div className="grid grid-cols-4 gap-2 sm:grid-cols-8">
            {Array.from({ length: PADS_PER_BANK }, (_, slot) => {
              const padIndex = bank * PADS_PER_BANK + slot;
              return renderCell(
                `pad:${activeProgramId}:${padIndex}`,
                padNames.get(padIndex) ?? `Pad ${padIndex + 1}`,
                `muting-pad-${padIndex}`,
              );
            })}
          </div>
        )}
      </Panel>
    </div>
  );
}
