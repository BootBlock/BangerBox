/**
 * Mixer mode — spec §8.5.6: channel strips across four tabs (pads of the active program,
 * tracks, returns, master), each with a fader on the perceptual dB law, pan, mute/solo,
 * four send dials, an insert slot list (add/replace/reorder/bypass, tapping a slot opens
 * its parameter panel), a meter per strip (spec §5.8), and the master PDC readout.
 *
 * Every control writes to `useMixerStore` and reaches the graph through the sync layer —
 * this mode never touches an AudioNode (spec §3.1 unidirectional flow). Fader and knob
 * drags run on the transient channel and commit once at gesture end (spec §3.3), which is
 * the behaviour the primitives already implement.
 */
import { useMemo, useState } from 'react';
import {
  useMixerStore,
  useProgramStore,
  useProjectStore,
  useSequenceStore,
  useTransportStore,
  useUIStore,
} from '@/store';
import { channelLevelPath, channelPanPath, channelSendPath } from '@/core/audio/params/registry';
import { bounceTrack } from '@/core/audio/bounceService';
import { downloadBlob, downloadFileStem } from '@/core/platform/download';
import { readFile } from '@/core/storage/opfs';
import { sampleEditContext } from '../sample-edit/sampleContext';
import { Button, EmptyState, Fader, Knob, MeterCanvas, SegmentControl, Toggle } from '@/ui/primitives';
import { LEVEL_RANGE, PAN_RANGE, SEND_LEVEL_RANGE, type EffectType } from '@/core/project/schemas';
import { EFFECT_TYPES } from '@/core/project/schemas';
import { Panel } from '@/ui/shell/Panel';
import { getAudioEngine } from '@/core/project/session';
import { InsertPanel } from './InsertPanel';

type StripTab = 'pads' | 'tracks' | 'returns' | 'master';

const TAB_OPTIONS = [
  { value: 'pads' as const, label: 'Pads' },
  { value: 'tracks' as const, label: 'Tracks' },
  { value: 'returns' as const, label: 'Returns' },
  { value: 'master' as const, label: 'Master' },
];

const RETURN_COUNT = 4;
const PADS_PER_BANK = 16;

export function MixerMode() {
  const channels = useMixerStore((s) => s.channels);
  const tracks = useSequenceStore((s) => s.tracks);
  const activeSequenceId = useTransportStore((s) => s.activeSequenceId);
  const activeProgramId = useProgramStore((s) => s.activeProgramId);
  const programs = useProgramStore((s) => s.programs);

  const [tab, setTab] = useState<StripTab>('tracks');
  /** Channel whose insert chain is open in the parameter panel (spec §8.5.6). */
  const [openInserts, setOpenInserts] = useState<string | null>(null);
  /**
   * The channel whose stem is rendering, or null (spec §9.5). One at a time: a bounce builds
   * a whole offline graph over the project's samples, and two at once would double the peak
   * memory for no gain the user asked for.
   */
  const [bouncingTrackId, setBouncingTrackId] = useState<string | null>(null);
  const projectId = useProjectStore((s) => s.projectId);
  const projectName = useProjectStore((s) => s.projectName);
  const pushToast = useUIStore((s) => s.pushToast);

  const activeProgram = activeProgramId ? programs[activeProgramId] : undefined;

  /** The strips for the active tab: id + display name. */
  const strips = useMemo(() => {
    switch (tab) {
      case 'master':
        return [{ id: 'master', name: 'Master' }];
      case 'returns':
        return Array.from({ length: RETURN_COUNT }, (_, index) => ({
          id: `return:${index}`,
          name: `Return ${index + 1}`,
        }));
      case 'tracks':
        return Object.values(tracks)
          .filter((track) => activeSequenceId === null || track.sequenceId === activeSequenceId)
          .sort((a, b) => a.position - b.position)
          .map((track) => ({ id: `track:${track.id}`, name: track.name }));
      case 'pads': {
        if (!activeProgramId || activeProgram?.type !== 'drum') return [];
        // Only assigned pads get a strip — 128 empty strips would be unusable (spec §6 sparse).
        return activeProgram.pads
          .slice()
          .sort((a, b) => a.padIndex - b.padIndex)
          .map((pad) => ({
            id: `pad:${activeProgramId}:${pad.padIndex}`,
            name: pad.name || `Pad ${(pad.padIndex % PADS_PER_BANK) + 1}`,
          }));
      }
    }
  }, [tab, tracks, activeSequenceId, activeProgramId, activeProgram]);

  /** Total insert latency on the master chain — the PDC readout (spec §5.7.3, §8.5.6). */
  const masterPdcSamples = getAudioEngine()?.graph.master.insertLatencySamples() ?? 0;
  const sampleRate = getAudioEngine()?.context.sampleRate ?? 48_000;

  const mixer = () => useMixerStore.getState();

  /**
   * Render one track of the active sequence and hand the WAV to the user (spec §9.5).
   *
   * The read-back matters as much as the render: `/bounces/` is an OPFS path no part of the
   * UI can browse and no file manager can open, so writing a stem and stopping there would
   * produce nothing retrievable (issue #104).
   */
  const bounceStem = async (trackId: string, trackName: string) => {
    setBouncingTrackId(`track:${trackId}`);
    try {
      const path = await bounceTrack(trackId, `stem-${trackId}`, sampleEditContext());
      const stem = downloadFileStem(trackName, 'track');
      downloadBlob(await readFile(path), `${downloadFileStem(projectName)}-${stem}.wav`);
      pushToast(`Bounced ${trackName}.`, 'success');
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Stem bounce failed.', 'error');
    } finally {
      setBouncingTrackId(null);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <Panel
        title="Mixer"
        actions={
          <div className="flex items-center gap-3">
            <span
              className="text-bb-micro text-bb-muted"
              // Spec §5.7.3.
              title="Total insert latency on the master chain, compensated on parallel dry paths"
              data-testid="mixer-pdc"
            >
              Master PDC: {masterPdcSamples} samples ({((masterPdcSamples / sampleRate) * 1000).toFixed(2)}{' '}
              ms)
            </span>
            <SegmentControl
              label="Strip group"
              value={tab}
              options={TAB_OPTIONS}
              size="sm"
              onChange={setTab}
              data-testid="mixer-tab"
            />
          </div>
        }
      >
        {strips.length === 0 ? (
          // The pads tab is empty for a reason the user can act on — the wrong program is
          // selected — so it says what is empty first, then what to do about it.
          tab === 'pads' ? (
            <EmptyState
              message="No pad channels yet."
              hint="Select a drum program with assigned pads to mix its pads."
            />
          ) : (
            <EmptyState message="No channels in this group yet." />
          )
        ) : (
          <div className="flex gap-3 overflow-x-auto overscroll-contain pb-2">
            {strips.map((strip) => {
              const state = channels[strip.id];
              const level = state?.level ?? 1;
              const pan = state?.pan ?? 0;
              const sends = state?.sendLevels ?? [0, 0, 0, 0];
              const inserts = state?.inserts ?? [];
              // Returns carry no sends — structurally feedback-safe (spec §5.2).
              const showSends = !strip.id.startsWith('return:') && strip.id !== 'master';

              return (
                <section
                  key={strip.id}
                  aria-label={`${strip.name} channel strip`}
                  data-testid={`mixer-strip-${strip.id}`}
                  className="flex w-32 shrink-0 flex-col items-center gap-2 rounded-bb-md border border-bb-line bg-bb-raised p-2"
                >
                  <h4 className="w-full truncate text-center text-bb-micro font-bold text-bb-text">
                    {strip.name}
                  </h4>

                  <div className="flex items-end gap-2">
                    <Fader
                      label={`${strip.name} level`}
                      value={level}
                      range={LEVEL_RANGE}
                      defaultValue={1}
                      // The `faderLevel` domain reads a §8.5.6 position as dB through the
                      // one fader law; a `formatValue` callback here would be a second
                      // place §8.2's wording for a level lived (spec §3.6).
                      unit="faderLevel"
                      // spec §10.3 "UI reacts concurrently": a Q-Link turn moves this fader
                      // as it turns, painted by ref rather than by a re-render (issue #27).
                      livePath={channelLevelPath(strip.id)}
                      onTransient={(value) => mixer().setTransient(channelLevelPath(strip.id), value)}
                      onCommit={(value) => mixer().commit(channelLevelPath(strip.id), value)}
                      data-testid={`mixer-fader-${strip.id}`}
                    />
                    <MeterCanvas meterId={strip.id} label={strip.name} />
                  </div>

                  <Knob
                    label="Pan"
                    accessibleName={`Pan, ${strip.name}`}
                    value={pan}
                    range={PAN_RANGE}
                    // "−0.3" says nothing about which side of the image the sound is on,
                    // which is the only thing a pan control means (spec §8.2, issue #35).
                    unit="pan"
                    step={0.01}
                    size="sm"
                    defaultValue={0}
                    livePath={channelPanPath(strip.id)}
                    onTransient={(value) => mixer().setTransient(channelPanPath(strip.id), value)}
                    onCommit={(value) => mixer().commit(channelPanPath(strip.id), value)}
                    data-testid={`mixer-pan-${strip.id}`}
                  />

                  <div className="flex w-full gap-1">
                    <Toggle
                      label="Mute"
                      pressed={state?.mute ?? false}
                      tone="danger"
                      size="sm"
                      onChange={(next) => mixer().setMute(strip.id, next)}
                      data-testid={`mixer-mute-${strip.id}`}
                    />
                    <Toggle
                      label="Solo"
                      pressed={state?.solo ?? false}
                      tone="warn"
                      size="sm"
                      onChange={(next) => mixer().setSolo(strip.id, next)}
                      data-testid={`mixer-solo-${strip.id}`}
                    />
                  </div>

                  {showSends && (
                    <div className="grid w-full grid-cols-2 gap-1">
                      {sends.map((sendLevel, index) => (
                        <Knob
                          key={index}
                          label={`Send ${index + 1}`}
                          accessibleName={`Send ${index + 1}, ${strip.name}`}
                          value={sendLevel}
                          range={SEND_LEVEL_RANGE}
                          unit="fraction"
                          step={0.01}
                          size="sm"
                          showValue={false}
                          livePath={channelSendPath(strip.id, index)}
                          onTransient={(value) =>
                            mixer().setTransient(channelSendPath(strip.id, index), value)
                          }
                          onCommit={(value) => mixer().commit(channelSendPath(strip.id, index), value)}
                          data-testid={`mixer-send-${strip.id}-${index}`}
                        />
                      ))}
                    </div>
                  )}

                  <Button
                    label={`Inserts (${inserts.filter((slot) => slot.effectType !== null).length})`}
                    variant="quiet"
                    size="sm"
                    block
                    aria-expanded={openInserts === strip.id}
                    onClick={() => setOpenInserts(openInserts === strip.id ? null : strip.id)}
                    data-testid={`mixer-inserts-${strip.id}`}
                  />

                  {/*
                   * Stem bounce (spec §9.5 "bounce selected track", issue #104). It belongs on
                   * the track strip because a stem is exactly what this strip is: post-insert,
                   * pre-master. The other three §9.5 paths already had a surface; this one had
                   * no caller anywhere in the repository, so the implementation was written,
                   * tested and unreachable.
                   */}
                  {strip.id.startsWith('track:') && (
                    <Button
                      label={bouncingTrackId === strip.id ? 'Bouncing…' : 'Bounce stem'}
                      accessibleName={`Bounce stem for ${strip.name}`}
                      variant="quiet"
                      size="sm"
                      block
                      disabled={bouncingTrackId !== null || !projectId}
                      title="Render this track alone, post-insert and pre-master, and download it"
                      onClick={() => void bounceStem(strip.id.slice('track:'.length), strip.name)}
                      data-testid={`mixer-bounce-${strip.id}`}
                    />
                  )}
                </section>
              );
            })}
          </div>
        )}
      </Panel>

      {openInserts && (
        <InsertPanel
          channelId={openInserts}
          onClose={() => setOpenInserts(null)}
          availableEffects={EFFECT_TYPES as readonly EffectType[]}
        />
      )}
    </div>
  );
}
