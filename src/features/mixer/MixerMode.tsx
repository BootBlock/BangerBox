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
import { useMixerStore, useProgramStore, useSequenceStore, useTransportStore } from '@/store';
import { channelLevelPath, channelPanPath, channelSendPath } from '@/core/audio/params/registry';
import { faderLevelToDb } from '@/core/audio/params/faderLaw';
import {
  formatValueText,
  Button,
  Fader,
  Knob,
  MeterCanvas,
  SegmentControl,
  Toggle,
} from '@/ui/primitives';
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

/** Format a fader position as dB through the shared law — never a bespoke calculation. */
function faderValueText(level: number): string {
  return formatValueText(faderLevelToDb(level), 'dB');
}

export function MixerMode() {
  const channels = useMixerStore((s) => s.channels);
  const tracks = useSequenceStore((s) => s.tracks);
  const activeSequenceId = useTransportStore((s) => s.activeSequenceId);
  const activeProgramId = useProgramStore((s) => s.activeProgramId);
  const programs = useProgramStore((s) => s.programs);

  const [tab, setTab] = useState<StripTab>('tracks');
  /** Channel whose insert chain is open in the parameter panel (spec §8.5.6). */
  const [openInserts, setOpenInserts] = useState<string | null>(null);

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

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <Panel
        title="Mixer"
        actions={
          <div className="flex items-center gap-3">
            <span
              className="text-[0.625rem] text-bb-muted"
              title="Total insert latency on the master chain, compensated on parallel dry paths (spec §5.7.3)"
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
          <p className="text-xs text-bb-muted">
            {tab === 'pads'
              ? 'Select a drum program with assigned pads to mix its pads.'
              : 'No channels in this group yet.'}
          </p>
        ) : (
          <div className="flex gap-3 overflow-x-auto pb-2">
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
                  <h4 className="w-full truncate text-center text-[0.625rem] font-bold text-bb-text">
                    {strip.name}
                  </h4>

                  <div className="flex items-end gap-2">
                    <Fader
                      label={`${strip.name} level`}
                      value={level}
                      range={LEVEL_RANGE}
                      defaultValue={1}
                      formatValue={faderValueText}
                      onTransient={(value) => mixer().setTransient(channelLevelPath(strip.id), value)}
                      onCommit={(value) => mixer().commit(channelLevelPath(strip.id), value)}
                      data-testid={`mixer-fader-${strip.id}`}
                    />
                    <MeterCanvas meterId={strip.id} label={strip.name} />
                  </div>

                  <Knob
                    label="Pan"
                    value={pan}
                    range={PAN_RANGE}
                    step={0.01}
                    size="sm"
                    defaultValue={0}
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
                          value={sendLevel}
                          range={SEND_LEVEL_RANGE}
                          step={0.01}
                          size="sm"
                          showValue={false}
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
