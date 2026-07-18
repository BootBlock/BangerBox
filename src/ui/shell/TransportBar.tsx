/**
 * TransportBar — the persistent transport strip (spec §8.1): play/stop/rec, position
 * readout, BPM, swing, metronome, save-dot, undo/redo. Every control is wired end to end
 * through its store → sync layer → scheduler worker (spec §3.4 — no dead controls).
 *
 * The bar shows the *coarse* bar:beat readout the transport store publishes at ≤ 4 Hz
 * (spec §4.2); the sample-accurate playhead never reaches React — it lives in the
 * scheduler SAB and is drawn by canvases via rAF (spec §7.1.4).
 */
import { useEffect, useRef } from 'react';
import { useProjectStore, useTransportStore, useUndoStore } from '@/store';
import { BPM_RANGE, SWING_RANGE } from '@/core/project/schemas';
import { Button, FieldLabel, Knob, SegmentControl, Toggle, ValueReadout, announce } from '@/ui/primitives';
import {
  IconFullscreenEnter,
  IconFullscreenExit,
  IconLoop,
  IconMetronome,
  IconPlay,
  IconRecord,
  IconRedo,
  IconSave,
  IconStop,
  IconUndo,
} from '@/ui/icons';
import { StorageGauge } from './StorageGauge';
import { useFullscreen } from './useFullscreen';

const COUNT_IN_OPTIONS = [
  { value: 0, label: 'Off' },
  { value: 1, label: '1 bar' },
  { value: 2, label: '2 bars' },
] as const;

export function TransportBar() {
  const isPlaying = useTransportStore((s) => s.isPlaying);
  const isRecording = useTransportStore((s) => s.isRecording);
  const metronomeEnabled = useTransportStore((s) => s.metronomeEnabled);
  const loopEnabled = useTransportStore((s) => s.loopEnabled);
  const countInBars = useTransportStore((s) => s.countInBars);
  const recordMode = useTransportStore((s) => s.recordMode);
  const bpm = useTransportStore((s) => s.bpm);
  const swingAmount = useTransportStore((s) => s.swingAmount);
  const position = useTransportStore((s) => s.coarsePosition);

  const modified = useProjectStore((s) => s.modifiedSinceLastSave);
  const canUndo = useUndoStore((s) => s.canUndo);
  const canRedo = useUndoStore((s) => s.canRedo);
  const undoLabel = useUndoStore((s) => s.undoLabel);
  const redoLabel = useUndoStore((s) => s.redoLabel);

  const fullscreen = useFullscreen();

  // Announce transport state changes through the single polite region (spec §8.2).
  const previouslyPlaying = useRef(isPlaying);
  useEffect(() => {
    if (previouslyPlaying.current === isPlaying) return;
    previouslyPlaying.current = isPlaying;
    announce(isPlaying ? 'Playing' : 'Stopped');
  }, [isPlaying]);

  const transport = () => useTransportStore.getState();

  return (
    <div
      role="toolbar"
      aria-label="Transport"
      aria-orientation="horizontal"
      className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-bb-line bg-bb-surface px-4 py-2"
    >
      <div className="flex items-center gap-2">
        <Toggle
          label={isPlaying ? 'Stop' : 'Play'}
          pressed={isPlaying}
          onChange={() => (isPlaying ? transport().stop() : transport().play())}
          icon={
            isPlaying ? <IconStop size={16} aria-hidden="true" /> : <IconPlay size={16} aria-hidden="true" />
          }
          iconOnly
          data-testid="transport-play"
        />
        <Toggle
          label="Arm recording"
          pressed={isRecording}
          tone="danger"
          onChange={(next) => transport().setRecording(next)}
          icon={<IconRecord size={16} aria-hidden="true" />}
          iconOnly
          data-testid="transport-record"
        />
        <Toggle
          label="Loop"
          pressed={loopEnabled}
          onChange={(next) => transport().setLoop({ enabled: next })}
          icon={<IconLoop size={16} aria-hidden="true" />}
          iconOnly
          data-testid="transport-loop"
        />
        <Toggle
          label="Metronome"
          pressed={metronomeEnabled}
          onChange={(next) => transport().setMetronomeEnabled(next)}
          icon={<IconMetronome size={16} aria-hidden="true" />}
          iconOnly
          data-testid="transport-metronome"
        />
      </div>

      <ValueReadout
        label="Playback position"
        value={`${String(position.bar).padStart(3, '0')}:${position.beat}`}
        size="lg"
        tone="accent"
        data-testid="transport-position"
      />

      <div className="flex items-end gap-3">
        <Knob
          label="Tempo"
          value={bpm}
          range={BPM_RANGE}
          unit="bpm"
          step={1}
          fineStep={0.1}
          size="sm"
          onCommit={(value) => transport().setBpm(value)}
          data-testid="transport-bpm"
        />
        <Knob
          label="Swing"
          value={swingAmount}
          range={SWING_RANGE}
          unit="%"
          step={1}
          size="sm"
          defaultValue={50}
          onCommit={(value) => transport().setSwing(value)}
          data-testid="transport-swing"
        />
      </div>

      <div className="flex items-center gap-3">
        <FieldLabel as="span">
          Count-in
          <SegmentControl
            label="Count-in bars"
            value={countInBars}
            options={COUNT_IN_OPTIONS}
            size="sm"
            onChange={(value) => transport().setCountInBars(value)}
            data-testid="transport-count-in"
          />
        </FieldLabel>
        <FieldLabel as="span">
          Rec mode
          <SegmentControl
            label="Record mode"
            value={recordMode}
            options={[
              { value: 'overdub', label: 'Overdub' },
              { value: 'replace', label: 'Replace' },
            ]}
            size="sm"
            onChange={(value) => transport().setRecordMode(value)}
            data-testid="transport-record-mode"
          />
        </FieldLabel>
      </div>

      <div className="ml-auto flex items-center gap-2">
        {/* Room left before the §9.7 hard stop — persistent, because that limit bites
            mid-session while importing, not while looking at a dashboard. */}
        <StorageGauge />

        {/* Unobtrusive unsaved-dot until the autosave queue flushes (spec §4.4). */}
        <span
          data-testid="transport-unsaved-dot"
          data-modified={modified || undefined}
          title={modified ? 'Unsaved changes' : 'All changes saved'}
          className={`h-2 w-2 rounded-full transition-colors duration-150 ${
            modified ? 'bg-bb-warn' : 'bg-bb-line'
          }`}
        />
        <span className="sr-only" aria-live="polite">
          {modified ? 'Unsaved changes' : 'All changes saved'}
        </span>

        <Button
          label="Save project now"
          title="Save now"
          iconOnly
          icon={<IconSave size={16} aria-hidden="true" />}
          data-testid="transport-save"
          onClick={() => {
            void useProjectStore
              .getState()
              .saveNow()
              .then(() => announce('Project saved'));
          }}
        />

        <Button
          label={undoLabel ? `Undo ${undoLabel}` : 'Undo'}
          iconOnly
          icon={<IconUndo size={16} aria-hidden="true" />}
          disabled={!canUndo}
          data-testid="transport-undo"
          onClick={() => useUndoStore.getState().undo()}
        />
        <Button
          label={redoLabel ? `Redo ${redoLabel}` : 'Redo'}
          iconOnly
          icon={<IconRedo size={16} aria-hidden="true" />}
          disabled={!canRedo}
          data-testid="transport-redo"
          onClick={() => useUndoStore.getState().redo()}
        />

        {/* Hidden outright where the browser forbids fullscreen — a soft capability is
            never shown as a dead control (spec §2.1/§3.4). */}
        {fullscreen.available && (
          <Toggle
            label={fullscreen.active ? 'Exit fullscreen' : 'Enter fullscreen'}
            pressed={fullscreen.active}
            onChange={() => fullscreen.toggle()}
            icon={
              fullscreen.active ? (
                <IconFullscreenExit size={16} aria-hidden="true" />
              ) : (
                <IconFullscreenEnter size={16} aria-hidden="true" />
              )
            }
            iconOnly
            data-testid="transport-fullscreen"
          />
        )}
      </div>
    </div>
  );
}
