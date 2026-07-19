/**
 * Looper mode (spec §8.5, mode 8) — resamples the master bus through the recorder worklet →
 * ring buffer → WAV worker → OPFS (spec §8.5.8), producing a sample assignable to pads/tracks.
 * The capture length is locked to the transport: bars are converted through the active
 * sequence's time signature and the effective tempo, so a take is a whole number of bars at
 * whatever tempo it was recorded. Record replaces the held take, overdub sums onto it, clear
 * discards it, save writes it out. The live meter reuses the §5.8 metering SAB through the
 * shared meter loop and the progress ring rides the capture drain loop, so neither adds a rAF
 * loop nor a React render (spec §3.3, §8.4). Every control is wired end to end (§3.4).
 *
 * Mic-source capture stays out until the `getUserMedia` capability gate lands (§2.1).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { getAudioEngine } from '@/core/project';
import type { Looper } from '@/core/audio/looper';
import type { TimeSignature } from '@/core/project/schemas';
import { barsToTicks, ticksToSeconds } from '@/core/sequencer/ppqn';
import { useProjectStore, useSequenceStore, useTransportStore, useUIStore } from '@/store';
import { Button, FieldLabel, MeterCanvas, SegmentControl } from '@/ui/primitives';
import { refreshSamples, sampleEditContext } from '../sample-edit/sampleContext';
import { LooperRing } from './LooperRing';

/** 0 bars = free running: capture until stopped by hand, ignoring the bar lock. */
const LENGTH_OPTIONS = [
  { value: 0, label: 'Free' },
  { value: 1, label: '1 bar' },
  { value: 2, label: '2 bars' },
  { value: 4, label: '4 bars' },
  { value: 8, label: '8 bars' },
] as const;

/** Used until a sequence is active — the same default a new sequence carries (spec §4.2). */
const DEFAULT_TIME_SIG: TimeSignature = { numerator: 4, denominator: 4 };

export function LooperPanel() {
  const looperRef = useRef<Looper | null>(null);
  const ringSetter = useRef<((progress: number) => void) | null>(null);
  const [recording, setRecording] = useState(false);
  const [hasTake, setHasTake] = useState(false);
  const [bars, setBars] = useState<number>(0);
  const pushToast = useUIStore((state) => state.pushToast);
  const sampleRate = useProjectStore((state) => state.sampleRate);
  const bpm = useTransportStore((state) => state.bpm);
  const activeSequenceId = useTransportStore((state) => state.activeSequenceId);
  const timeSig = useSequenceStore((state) =>
    activeSequenceId ? state.sequences[activeSequenceId]?.timeSig : undefined,
  );

  const effectiveTimeSig = timeSig ?? DEFAULT_TIME_SIG;
  const barSeconds = ticksToSeconds(barsToTicks(bars, effectiveTimeSig), bpm);

  useEffect(() => {
    return () => {
      looperRef.current?.destroy();
      looperRef.current = null;
    };
  }, []);

  const bindRing = useCallback((set: ((progress: number) => void) | null) => {
    ringSetter.current = set;
  }, []);

  const capture = (overdub: boolean) => {
    const engine = getAudioEngine();
    if (!engine) {
      pushToast('Start the audio engine before recording the Looper.', 'warning');
      return;
    }
    const looper = (looperRef.current ??= engine.createLooper());
    looper.startRecording({
      // Resolved at record time from the live tempo and time signature, so a tempo change
      // between takes sizes the next take rather than mis-sizing the one already running.
      targetFrames: bars > 0 ? Math.round(barSeconds * sampleRate) : 0,
      overdub,
      onProgress: (progress) => ringSetter.current?.(progress),
      onComplete: () => {
        // The bar line stopped the capture for us; catch the UI up.
        setRecording(false);
        setHasTake(looper.hasTake);
      },
    });
    setRecording(true);
  };

  const stop = async () => {
    const looper = looperRef.current;
    if (!looper) return;
    setRecording(false);
    const captured = await looper.stopRecording();
    setHasTake(looper.hasTake);
    if (!captured) pushToast('Nothing was captured.', 'warning');
  };

  const save = async () => {
    const looper = looperRef.current;
    if (!looper) return;
    try {
      const row = await looper.save(sampleRate, sampleEditContext());
      if (!row) {
        pushToast('Nothing was captured.', 'warning');
        return;
      }
      await refreshSamples();
      pushToast('Looper take saved as a sample.', 'success');
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Looper capture failed.', 'error');
    }
  };

  const clear = () => {
    looperRef.current?.clear();
    setHasTake(false);
    ringSetter.current?.(0);
  };

  return (
    <section aria-labelledby="looper-heading" className="mt-6">
      <h3 id="looper-heading" className="text-lg font-bold">
        Looper
      </h3>
      <p className="mt-1 text-xs leading-relaxed text-bb-muted">
        Resample the master output into a new sample. Start the engine and play something, then record.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-4">
        <FieldLabel as="span">
          Length
          <SegmentControl
            label="Looper capture length"
            value={bars}
            options={LENGTH_OPTIONS}
            onChange={setBars}
            // Changing the length mid-capture would mis-size the take already running.
            disabled={recording}
            size="sm"
            data-testid="looper-length"
          />
        </FieldLabel>
        <p className="text-xs text-bb-muted" data-testid="looper-length-readout">
          {bars > 0
            ? `${barSeconds.toFixed(2)} s at ${bpm} BPM, ${effectiveTimeSig.numerator}/${effectiveTimeSig.denominator}`
            : 'Free running — stop by hand'}
        </p>
      </div>

      <div className="mt-3 flex items-center gap-4">
        <LooperRing label="Looper capture progress" bindSetter={bindRing} />
        <FieldLabel as="span">
          Input
          <MeterCanvas meterId="master" label="Looper input" />
        </FieldLabel>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {recording ? (
          // Accent marks the confirming action while a take is in flight (spec §3.6).
          <Button label="Stop" variant="accent" data-testid="looper-stop" onClick={() => void stop()} />
        ) : (
          <Button label="Record" data-testid="looper-record" onClick={() => capture(false)} />
        )}
        <Button
          label="Overdub"
          disabled={recording || !hasTake}
          data-testid="looper-overdub"
          onClick={() => capture(true)}
        />
        <Button
          label="Save as sample"
          variant="accent"
          disabled={recording || !hasTake}
          data-testid="looper-save"
          onClick={() => void save()}
        />
        <Button
          label="Clear"
          variant="danger"
          disabled={recording || !hasTake}
          data-testid="looper-clear"
          onClick={clear}
        />
      </div>
    </section>
  );
}
