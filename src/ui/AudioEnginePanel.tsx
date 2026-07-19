/**
 * Audio engine diagnostics — the always-available proof that the graph is sounding
 * (spec §12 Phase 3 exit criteria, kept green by the §11.4 smoke): demo pad triggers over
 * the real OPFS sample path (§5.4), a metronome click (§5.9), the master fader wired
 * store → sync → graph (§4.3), and a live master meter (§5.8).
 *
 * The autoplay start gate is {@link StartGate}'s job (spec §5.1), so this panel only ever
 * renders with a running engine behind it. It lives in Main mode's diagnostics beside the
 * storage self-test. Transport controls are NOT duplicated here — the shell's persistent
 * TransportBar owns them (spec §8.1).
 */
import { useEffect, useState } from 'react';
import { getAudioEngine } from '@/core/project/session';
import { useMixerStore } from '@/store';
import { LEVEL_RANGE } from '@/core/project/schemas';
import { faderLevelToDb } from '@/core/audio/params/faderLaw';
import { Button, Fader, MeterCanvas, Pad, formatValueText } from './primitives';

/** The four bundled demo pads the engine proof triggers (spec §12 Phase 3). */
const DEMO_PADS = [0, 1, 2, 3];

export function AudioEnginePanel() {
  const masterLevel = useMixerStore((state) => state.channels.master?.level ?? 1);
  // Seeded from the live context rather than set inside the effect: a synchronous setState
  // in an effect triggers a cascading render, and the initial value is knowable up front.
  const [contextState, setContextState] = useState<AudioContextState>(
    () => getAudioEngine()?.context.state ?? 'running',
  );

  // Mirror the context state for the readout; the gate owns re-surfacing (spec §5.1).
  useEffect(() => {
    const engine = getAudioEngine();
    if (!engine) return;
    const onStateChange = () => setContextState(engine.context.state);
    engine.context.addEventListener('statechange', onStateChange);
    return () => engine.context.removeEventListener('statechange', onStateChange);
  }, []);

  const setMaster = (value: number, commit: boolean) => {
    const store = useMixerStore.getState();
    if (commit) store.commit('master.level', value);
    else store.setTransient('master.level', value);
  };

  const running = contextState === 'running';

  return (
    <section aria-labelledby="audio-engine-heading" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h4 id="audio-engine-heading" className="text-xs font-bold tracking-wide text-bb-text uppercase">
          Audio engine
        </h4>
        <span
          data-testid="audio-engine-status"
          data-status={running ? 'running' : 'suspended'}
          className={`text-xs font-semibold ${running ? 'text-bb-ok' : 'text-bb-warn'}`}
        >
          {running ? 'Running' : 'Suspended'}
        </span>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        {/* Real Pad primitives, not lookalikes. These sound a pad, so §3.6 says they *are*
            pads: hand-rolled ones drifted to a 75 ms press against every other pad's 150 ms,
            skipped the velocity glow and `aria-pressed` entirely, and carried a
            `hover:bg-bb-line` treatment used nowhere else in the app. Velocity now comes
            from where the pad is struck like everywhere else, rather than from a per-index
            constant — which makes this panel a truer proof of the §5.4 trigger path. */}
        <div role="group" aria-label="Demo pads">
          <p className="mb-2 text-bb-micro font-semibold text-bb-muted uppercase">Demo pads</p>
          {/* 96 px of grid, less the 8 px gap, gives each pad its 44 px touch minimum. */}
          <div className="grid w-24 grid-cols-2 gap-2">
            {DEMO_PADS.map((index) => (
              <Pad
                key={index}
                label={String(index + 1)}
                padIndex={index}
                assigned
                data-testid={`pad-trigger-${index}`}
                onTrigger={(_padIndex, velocity) => void getAudioEngine()?.triggerDemoPad(velocity)}
              />
            ))}
          </div>
        </div>

        <div className="flex items-end gap-2">
          <Fader
            label="Master level"
            value={masterLevel}
            range={LEVEL_RANGE}
            defaultValue={1}
            formatValue={(level) => formatValueText(faderLevelToDb(level), 'dB')}
            onTransient={(value) => setMaster(value, false)}
            onCommit={(value) => setMaster(value, true)}
            data-testid="master-fader"
          />
          <MeterCanvas meterId="master" label="Master" />
        </div>

        <Button
          label="Metronome click"
          data-testid="metronome-click"
          onClick={() => getAudioEngine()?.clickMetronome(true)}
        />
      </div>
    </section>
  );
}
