/**
 * SequencerTransport — the Phase 4 minimal transport UI (spec §12; the polished transport
 * bar is Phase 7, §8.1). Play/stop, record-arm, metronome, tempo, and a coarse bar:beat
 * readout, each wired end to end through `useTransportStore` → the sequencer sync layer →
 * the scheduler worker (spec §4.3, §7.1.3) — no dead controls (spec §3.4). The coarse
 * position is refreshed at ≤ 4×/second by the playhead pump (spec §4.2), safe for React.
 */
import { useTransportStore } from '@/store';
import { BPM_RANGE } from '@/core/project/schemas';

export function SequencerTransport() {
  const isPlaying = useTransportStore((s) => s.isPlaying);
  const isRecording = useTransportStore((s) => s.isRecording);
  const metronomeEnabled = useTransportStore((s) => s.metronomeEnabled);
  const bpm = useTransportStore((s) => s.bpm);
  const position = useTransportStore((s) => s.coarsePosition);

  const togglePlay = () => {
    const transport = useTransportStore.getState();
    if (isPlaying) transport.stop();
    else transport.play();
  };

  return (
    <section aria-labelledby="sequencer-transport-heading" className="border-t border-bb-line pt-4">
      <h4 id="sequencer-transport-heading" className="text-xs font-semibold text-bb-muted">
        Transport
      </h4>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <button
          type="button"
          data-testid="transport-play"
          aria-pressed={isPlaying}
          onClick={togglePlay}
          className={`rounded-bb-md px-4 py-2 text-sm font-semibold transition-colors duration-150 ${
            isPlaying ? 'bg-bb-accent text-bb-bg' : 'bg-bb-raised text-bb-text hover:bg-bb-line'
          }`}
        >
          {isPlaying ? 'Stop' : 'Play'}
        </button>

        <button
          type="button"
          data-testid="transport-record"
          aria-pressed={isRecording}
          aria-label="Arm recording"
          onClick={() => useTransportStore.getState().setRecording(!isRecording)}
          className={`rounded-bb-md px-4 py-2 text-sm font-semibold transition-colors duration-150 ${
            isRecording ? 'bg-bb-warn text-bb-bg' : 'bg-bb-raised text-bb-text hover:bg-bb-line'
          }`}
        >
          ● Rec
        </button>

        <button
          type="button"
          data-testid="transport-metronome"
          aria-pressed={metronomeEnabled}
          aria-label="Toggle metronome"
          onClick={() => useTransportStore.getState().setMetronomeEnabled(!metronomeEnabled)}
          className={`rounded-bb-sm border border-bb-line px-3 py-2 text-xs font-semibold ${
            metronomeEnabled ? 'bg-bb-accent text-bb-bg' : 'hover:bg-bb-raised'
          }`}
        >
          Click
        </button>

        <label className="flex items-center gap-2 text-xs font-semibold text-bb-muted">
          Tempo
          <input
            type="number"
            data-testid="transport-bpm"
            aria-label="Tempo in beats per minute"
            min={BPM_RANGE[0]}
            max={BPM_RANGE[1]}
            step={1}
            value={Math.round(bpm)}
            onChange={(event) => useTransportStore.getState().setBpm(Number(event.target.value))}
            className="w-16 rounded-bb-sm border border-bb-line bg-bb-raised px-2 py-1 text-bb-text"
          />
          <span className="text-bb-muted">bpm</span>
        </label>

        <output
          data-testid="transport-position"
          aria-label="Playback position"
          className="ml-auto rounded-bb-sm border border-bb-line bg-bb-raised px-3 py-1 font-mono text-sm tabular-nums text-bb-text"
        >
          {position.bar}:{position.beat}
        </output>
      </div>
    </section>
  );
}
