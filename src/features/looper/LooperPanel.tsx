/**
 * Looper mode (spec §8.5, mode 8) — resamples the master bus, or captures the microphone,
 * through the recorder worklet → ring buffer → WAV worker → OPFS (spec §8.5.8), producing a
 * sample assignable to pads/tracks. The capture length is locked to the transport: bars are
 * converted through the active sequence's time signature and the effective tempo, so a take is
 * a whole number of bars at whatever tempo it was recorded. Record replaces the held take,
 * overdub sums onto it, clear discards it, save writes it out. The live meter reuses the §5.8
 * metering SAB through the shared meter loop and the progress ring rides the capture drain
 * loop, so neither adds a rAF loop nor a React render (spec §3.3, §8.4). Every control is wired
 * end to end (§3.4).
 *
 * The mic source is a §2.1 soft capability: without `getUserMedia` the option is disabled and
 * says why rather than vanishing, so the absence reads as this browser's limit, not a missing
 * feature. Selecting it opens the stream up front — so the permission prompt and any refusal
 * land on the source choice rather than mid-take — and the panel falls back to the master bus
 * if that fails.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { getAudioEngine } from '@/core/project';
import type { Looper, LooperSource } from '@/core/audio/looper';
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

const NO_MIC_REASON = 'This browser cannot capture microphone input.';

const SOURCE_HELP: Record<LooperSource, string> = {
  master: 'Resample the master output into a new sample. Start the engine and play something, then record.',
  microphone: 'Record the microphone into a new sample. Only the mic is captured — the master output is not.',
};

export function LooperPanel() {
  const looperRef = useRef<Looper | null>(null);
  const ringSetter = useRef<((progress: number) => void) | null>(null);
  const [recording, setRecording] = useState(false);
  const [hasTake, setHasTake] = useState(false);
  const [bars, setBars] = useState<number>(0);
  const [source, setSource] = useState<LooperSource>('master');
  const pushToast = useUIStore((state) => state.pushToast);
  const micAvailable = useUIStore((state) => state.capabilities?.soft.microphone ?? false);
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

  /** The Looper is created on first use, so the engine has to be running by then (spec §8.5.8). */
  const requireLooper = (): Looper | null => {
    const engine = getAudioEngine();
    if (!engine) {
      pushToast('Start the audio engine before recording the Looper.', 'warning');
      return null;
    }
    return (looperRef.current ??= engine.createLooper());
  };

  /**
   * Point the recorder at the chosen source, reverting the control to the master bus if the
   * source cannot be opened — the selector must never show a source that is not actually live.
   */
  const applySource = async (looper: Looper, next: LooperSource): Promise<boolean> => {
    if (looper.source === next) return true;
    try {
      await looper.setSource(next);
      return true;
    } catch (error) {
      setSource(looper.source);
      pushToast(error instanceof Error ? error.message : 'The Looper source could not be changed.', 'error');
      return false;
    }
  };

  const changeSource = async (next: LooperSource) => {
    setSource(next);
    const looper = requireLooper();
    // Without an engine the choice is still remembered; `capture` applies it when one starts.
    if (looper) await applySource(looper, next);
  };

  const capture = async (overdub: boolean) => {
    const looper = requireLooper();
    if (!looper) return;
    // A Looper created after the source was chosen still starts on the master bus; reconcile
    // before arming, so the first take honours the selector rather than the second one.
    if (!(await applySource(looper, source))) return;
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
      <p className="mt-1 text-xs leading-relaxed text-bb-muted" data-testid="looper-source-help">
        {SOURCE_HELP[source]}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-4">
        <FieldLabel as="span">
          Source
          <SegmentControl
            label="Looper record source"
            value={source}
            options={[
              { value: 'master', label: 'Master' },
              {
                value: 'microphone',
                label: 'Mic',
                disabled: !micAvailable,
                title: micAvailable ? undefined : NO_MIC_REASON,
              },
            ]}
            onChange={(next) => void changeSource(next)}
            // Swapping the input mid-take would splice two sources into one take.
            disabled={recording}
            size="sm"
            data-testid="looper-source"
          />
        </FieldLabel>
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

      {!micAvailable && (
        // A tooltip alone is unreachable by touch and by keyboard, so the reason is on the page
        // too — the same belt-and-braces the Bluetooth gate uses (spec §2.1, §8.2).
        <p className="mt-2 text-xs text-bb-muted" data-testid="looper-no-mic">
          {NO_MIC_REASON}
        </p>
      )}

      <div className="mt-3 flex items-center gap-4">
        <LooperRing label="Looper capture progress" bindSetter={bindRing} />
        {source === 'master' ? (
          <FieldLabel as="span">
            Input
            <MeterCanvas meterId="master" label="Looper input" />
          </FieldLabel>
        ) : (
          // The §5.8 meter slots are allocated per mixer channel, and the mic is not one — so
          // there is no mic level to show, and showing the master's would be a lie about what
          // is being recorded. Metering the mic is tracked separately.
          <p className="text-xs text-bb-muted" data-testid="looper-mic-note">
            Mic level is not metered yet — check the take after recording.
          </p>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {recording ? (
          // Accent marks the confirming action while a take is in flight (spec §3.6).
          <Button label="Stop" variant="accent" data-testid="looper-stop" onClick={() => void stop()} />
        ) : (
          <Button label="Record" data-testid="looper-record" onClick={() => void capture(false)} />
        )}
        <Button
          label="Overdub"
          disabled={recording || !hasTake}
          data-testid="looper-overdub"
          onClick={() => void capture(true)}
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
