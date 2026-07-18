/**
 * Q-Link Edit mode — spec §8.5.11: the table of encoder bindings for the active Q-Link
 * mode, a learn flow, a registry-driven manual path picker, and min/max/curve per binding
 * (spec §10.3). It also hosts the input-latency offset setting (spec §10.2).
 *
 * This mode owns the *editing* surface; the runtime that turns incoming CC into store
 * actions lives in `core/midi/qlinkRuntime.ts`. The learn flow arms an encoder and then
 * takes whichever half arrives first: a parameter tap from this table, or a real CC from
 * the controller (spec §8.5.11 "turn an encoder, tap a parameter").
 *
 * It also hosts the connection surface (spec §10.4), including the Windows pairing note —
 * on Windows the ESP32 must be paired in Settings → Bluetooth *before* the in-app chooser
 * will show it, which is the single most common setup failure.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  INPUT_LATENCY_DEFAULT_MS,
  INPUT_LATENCY_RANGE,
  useHardwareStore,
  useMixerStore,
  useProgramStore,
  useUIStore,
} from '@/store';
import { hardwareService } from '@/core/midi/hardwareService';
import { DEFAULT_QLINK_CC_BASE } from '@/core/midi/qlink';
import type { ConnectionState } from '@/store/useHardwareStore';
import {
  channelLevelPath,
  channelPanPath,
  channelSendPath,
  isAutomatable,
  parseParamTarget,
  programParamPath,
  PROGRAM_PARAM_RANGES,
  targetRange,
  transportParamPath,
  TRANSPORT_PARAM_RANGES,
  type TransportParam,
} from '@/core/audio/params/registry';
import { qLinkModeSchema, type QLinkBinding, type QLinkMode } from '@/core/project/schemas';
import { Knob, SegmentControl, Toggle, ValueReadout } from '@/ui/primitives';
import { Panel } from '@/ui/shell/Panel';
import { IconRemove } from '@/ui/icons';

/** Physical encoders by default; the model supports up to 16 (spec §1.3.1, §10.3). */
const DEFAULT_ENCODERS = 4;
const MAX_ENCODERS = 16;

/** Connection status wording (spec §10.4 lifecycle states). */
const CONNECTION_LABELS: Readonly<Record<ConnectionState, string>> = {
  idle: 'Not connected',
  connecting: 'Connecting…',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
};

const MODE_OPTIONS = qLinkModeSchema.options.map((mode) => ({
  value: mode,
  label: mode.charAt(0).toUpperCase() + mode.slice(1),
}));

interface ParamChoice {
  readonly path: string;
  readonly label: string;
}

/**
 * Assignable parameters for the manual path picker (spec §8.5.11 "registry-driven"), built
 * through the registry's own builders (spec §7.8) and filtered by its own gate — so the
 * picker can never offer an address the runtime would refuse.
 */
function assignableParams(
  channelIds: readonly string[],
  programId: string | null,
  padIndex: number | null,
): ParamChoice[] {
  const candidates: ParamChoice[] = [];

  // Global transport macros (spec §10.3 project mode).
  for (const param of Object.keys(TRANSPORT_PARAM_RANGES) as TransportParam[]) {
    candidates.push({ path: transportParamPath(param), label: `transport · ${param}` });
  }

  // The selected pad's sound-design leaves (spec §10.3 pad/program modes).
  if (programId !== null && padIndex !== null) {
    for (const param of Object.keys(PROGRAM_PARAM_RANGES)) {
      candidates.push({
        path: programParamPath(programId, padIndex, param),
        label: `pad ${padIndex + 1} · ${param}`,
      });
    }
  }

  for (const channelId of channelIds) {
    candidates.push(
      { path: channelLevelPath(channelId), label: `${channelId} · level` },
      { path: channelPanPath(channelId), label: `${channelId} · pan` },
      ...[0, 1, 2, 3].map((index) => ({
        path: channelSendPath(channelId, index),
        label: `${channelId} · send ${index + 1}`,
      })),
    );
  }

  return candidates.filter((candidate) => isAutomatable(candidate.path));
}

/** Which store a registry path belongs to, for the binding's `targetStore` (spec §10.3). */
function storeForPath(path: string): QLinkBinding['targetStore'] {
  const target = parseParamTarget(path);
  if (target?.kind === 'programParam') return 'program';
  return 'mixer';
}

export function QLinkEditMode() {
  const qLinkMode = useHardwareStore((s) => s.qLinkMode);
  const bindings = useHardwareStore((s) => s.qLinkBindings);
  const connectionState = useHardwareStore((s) => s.connectionState);
  const deviceName = useHardwareStore((s) => s.bleDeviceName);
  const channels = useMixerStore((s) => s.channels);
  const inputLatencyMs = useHardwareStore((s) => s.inputLatencyMs);
  const ccMappings = useHardwareStore((s) => s.ccMappings);
  const activeProgramId = useProgramStore((s) => s.activeProgramId);
  const activePadId = useProgramStore((s) => s.activePadId);

  /** Encoder awaiting either a parameter tap or a CC during the learn flow (spec §8.5.11). */
  const [learningEncoder, setLearningEncoder] = useState<number | null>(null);
  const [encoderCount, setEncoderCount] = useState(DEFAULT_ENCODERS);
  const [connectError, setConnectError] = useState<string | null>(null);
  const bluetoothAvailable = useUIStore((s) => s.capabilities?.soft.bluetooth ?? false);

  /**
   * The CC half of the learn flow (spec §8.5.11): while an encoder is armed, the next CC
   * the controller sends is adopted as that encoder's CC number.
   */
  useEffect(() => {
    if (learningEncoder === null) return;
    return hardwareService().onNextControlChange((cc) => {
      const existing = useHardwareStore
        .getState()
        .qLinkBindings.find((entry) => entry.encoderIndex === learningEncoder);
      // A CC alone cannot create a binding — there is no parameter yet — so it updates an
      // existing one and otherwise waits for the parameter tap to complete the pair.
      if (existing) {
        useHardwareStore.getState().upsertBinding({ ...existing, cc });
        setLearningEncoder(null);
      }
      useHardwareStore.getState().setCcMapping(cc, learningEncoder);
    });
  }, [learningEncoder]);

  const connect = async () => {
    setConnectError(null);
    try {
      await hardwareService().connect();
    } catch (error) {
      setConnectError(
        error instanceof Error ? error.message : 'The controller could not be connected.',
      );
    }
  };

  const choices = useMemo(
    () => assignableParams(Object.keys(channels).sort(), activeProgramId, activePadId),
    [channels, activeProgramId, activePadId],
  );

  const bindingFor = (encoderIndex: number): QLinkBinding | undefined =>
    bindings.find((binding) => binding.encoderIndex === encoderIndex);

  /** The CC most recently learned for an encoder, from the raw CC → encoder map (§4.2). */
  const ccMappingFor = (encoderIndex: number): number | undefined => {
    const entry = Object.entries(ccMappings).find(([, index]) => index === encoderIndex);
    return entry ? Number(entry[0]) : undefined;
  };

  /** Bind a parameter to an encoder, seeding min/max from the registry range (spec §10.3). */
  const bindParameter = (encoderIndex: number, path: string) => {
    const target = parseParamTarget(path);
    const range = target ? targetRange(target) : null;
    if (!range) return;
    const existing = bindingFor(encoderIndex);
    useHardwareStore.getState().upsertBinding({
      encoderIndex,
      // Until the BLE transport lands (Phase 8), the CC defaults to the encoder index;
      // the learn flow overwrites it with the real CC when hardware turns a knob.
      // A CC learned from the controller wins; otherwise the default block (spec §10.3).
      cc: existing?.cc ?? ccMappingFor(encoderIndex) ?? DEFAULT_QLINK_CC_BASE + encoderIndex,
      targetStore: storeForPath(path),
      targetParameterPath: path,
      minValue: existing?.minValue ?? range[0],
      maxValue: existing?.maxValue ?? range[1],
      curve: existing?.curve ?? 'linear',
      mode: existing?.mode ?? 'absolute',
    });
    setLearningEncoder(null);
  };

  const updateBinding = (encoderIndex: number, patch: Partial<QLinkBinding>) => {
    const existing = bindingFor(encoderIndex);
    if (!existing) return;
    useHardwareStore.getState().upsertBinding({ ...existing, ...patch });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <Panel
        title="Q-Link mode"
        actions={
          <SegmentControl
            label="Q-Link mode"
            value={qLinkMode}
            options={MODE_OPTIONS}
            size="sm"
            onChange={(mode) => useHardwareStore.getState().setQLinkMode(mode as QLinkMode)}
            data-testid="qlink-mode"
          />
        }
      >
        <div className="flex flex-wrap items-center gap-4">
          <ValueReadout
            label="Controller"
            value={CONNECTION_LABELS[connectionState]}
            showLabel
            tone={connectionState === 'connected' ? 'accent' : 'muted'}
            data-testid="qlink-connection"
          />
          <button
            type="button"
            disabled={!bluetoothAvailable || connectionState === 'connecting'}
            onClick={() => {
              if (connectionState === 'connected') void hardwareService().disconnect();
              else void connect();
            }}
            title={
              bluetoothAvailable
                ? undefined
                : 'Web Bluetooth is unavailable in this browser (spec §2.1).'
            }
            data-testid="qlink-connect"
            className="rounded-bb-sm border border-bb-line bg-bb-raised px-3 py-1.5 text-xs font-semibold text-bb-text transition-colors duration-150 hover:border-bb-accent disabled:opacity-40"
          >
            {connectionState === 'connected' ? 'Disconnect' : 'Connect controller'}
          </button>
          {deviceName !== null && (
            <ValueReadout label="Device" value={deviceName} showLabel data-testid="qlink-device" />
          )}
          <span className="flex items-center gap-2 text-[0.625rem] font-semibold text-bb-muted uppercase">
            Encoders
            <SegmentControl
              label="Encoder count"
              value={encoderCount}
              options={[4, 8, 16]
                .filter((count) => count <= MAX_ENCODERS)
                .map((count) => ({
                  value: count,
                  label: String(count),
                }))}
              size="sm"
              onChange={setEncoderCount}
              data-testid="qlink-encoder-count"
            />
          </span>
          <Knob
            label="Input latency"
            value={inputLatencyMs}
            range={INPUT_LATENCY_RANGE}
            unit="ms"
            step={1}
            size="sm"
            defaultValue={INPUT_LATENCY_DEFAULT_MS}
            onCommit={(value) => useHardwareStore.getState().setInputLatencyMs(value)}
            data-testid="qlink-input-latency"
          />
        </div>
        {connectError !== null && (
          <p className="mt-3 text-xs text-bb-danger" role="alert" data-testid="qlink-connect-error">
            {connectError}
          </p>
        )}
        {!bluetoothAvailable && (
          <p className="mt-3 text-xs text-bb-muted" data-testid="qlink-no-bluetooth">
            This browser does not expose Web Bluetooth, so hardware mode is unavailable. BangerBox needs a
            Chromium browser on desktop-class Windows (spec §1.3 #15).
          </p>
        )}
        <p className="mt-3 text-xs text-bb-muted" data-testid="qlink-pairing-help">
          <strong className="font-semibold text-bb-text">Windows pairing:</strong> pair your ESP32 controller
          in Windows Settings → Bluetooth &amp; devices <em>before</em> using Connect here — the browser&rsquo;s
          chooser only lists devices Windows has already paired.
        </p>
        <p className="mt-2 text-xs text-bb-muted">
          Bindings are stored per Q-Link mode. The input latency offset is subtracted from incoming hardware
          timestamps when recording (spec §10.2).
        </p>
      </Panel>

      <Panel title="Bindings" scroll className="flex-1">
        <table className="w-full border-collapse text-xs">
          <caption className="sr-only">Encoder bindings for the {qLinkMode} Q-Link mode</caption>
          <thead>
            <tr className="text-left text-bb-muted">
              <th scope="col" className="py-1 pr-2 font-semibold">
                Encoder
              </th>
              <th scope="col" className="py-1 pr-2 font-semibold">
                CC
              </th>
              <th scope="col" className="py-1 pr-2 font-semibold">
                Parameter
              </th>
              <th scope="col" className="py-1 pr-2 font-semibold">
                Min
              </th>
              <th scope="col" className="py-1 pr-2 font-semibold">
                Max
              </th>
              <th scope="col" className="py-1 pr-2 font-semibold">
                Curve
              </th>
              <th scope="col" className="py-1 pr-2 font-semibold">
                Mode
              </th>
              <th scope="col" className="py-1 font-semibold">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: encoderCount }, (_, encoderIndex) => {
              const binding = bindingFor(encoderIndex);
              const range = binding
                ? (parseParamTarget(binding.targetParameterPath) &&
                    targetRange(parseParamTarget(binding.targetParameterPath)!)) ||
                  ([0, 1] as const)
                : ([0, 1] as const);
              return (
                <tr
                  key={encoderIndex}
                  data-testid={`qlink-row-${encoderIndex}`}
                  className="border-t border-bb-line align-middle"
                >
                  <th scope="row" className="py-1.5 pr-2 text-left font-mono font-normal text-bb-text">
                    Q{encoderIndex + 1}
                  </th>
                  <td
                    className="py-1.5 pr-2 font-mono tabular-nums text-bb-muted"
                    data-testid={`qlink-cc-${encoderIndex}`}
                  >
                    {binding?.cc ?? ccMappingFor(encoderIndex) ?? '—'}
                  </td>
                  <td className="py-1.5 pr-2">
                    <select
                      aria-label={`Parameter for encoder ${encoderIndex + 1}`}
                      value={binding?.targetParameterPath ?? ''}
                      onChange={(event) => bindParameter(encoderIndex, event.target.value)}
                      data-testid={`qlink-param-${encoderIndex}`}
                      className="w-full max-w-64 rounded-bb-sm border border-bb-line bg-bb-raised px-2 py-1 text-bb-text"
                    >
                      <option value="">Unassigned</option>
                      {choices.map((choice) => (
                        <option key={choice.path} value={choice.path}>
                          {choice.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="py-1.5 pr-2">
                    <input
                      type="number"
                      aria-label={`Minimum value for encoder ${encoderIndex + 1}`}
                      disabled={!binding}
                      value={binding?.minValue ?? ''}
                      min={range[0]}
                      max={range[1]}
                      step={0.01}
                      onChange={(event) =>
                        updateBinding(encoderIndex, { minValue: Number(event.target.value) })
                      }
                      className="w-20 rounded-bb-sm border border-bb-line bg-bb-raised px-2 py-1 text-bb-text disabled:opacity-40"
                    />
                  </td>
                  <td className="py-1.5 pr-2">
                    <input
                      type="number"
                      aria-label={`Maximum value for encoder ${encoderIndex + 1}`}
                      disabled={!binding}
                      value={binding?.maxValue ?? ''}
                      min={range[0]}
                      max={range[1]}
                      step={0.01}
                      onChange={(event) =>
                        updateBinding(encoderIndex, { maxValue: Number(event.target.value) })
                      }
                      className="w-20 rounded-bb-sm border border-bb-line bg-bb-raised px-2 py-1 text-bb-text disabled:opacity-40"
                    />
                  </td>
                  <td className="py-1.5 pr-2">
                    <SegmentControl
                      label={`Curve for encoder ${encoderIndex + 1}`}
                      value={binding?.curve ?? 'linear'}
                      options={[
                        { value: 'linear', label: 'Lin' },
                        { value: 'log', label: 'Log' },
                      ]}
                      size="sm"
                      disabled={!binding}
                      onChange={(curve) => updateBinding(encoderIndex, { curve })}
                    />
                  </td>
                  <td className="py-1.5 pr-2">
                    <SegmentControl
                      label={`Encoder mode for encoder ${encoderIndex + 1}`}
                      value={binding?.mode ?? 'absolute'}
                      options={[
                        { value: 'absolute', label: 'Abs' },
                        { value: 'relative', label: 'Rel' },
                      ]}
                      size="sm"
                      disabled={!binding}
                      onChange={(mode) => updateBinding(encoderIndex, { mode })}
                    />
                  </td>
                  <td className="py-1.5">
                    <div className="flex items-center gap-1">
                      <Toggle
                        label={`Learn encoder ${encoderIndex + 1}`}
                        pressed={learningEncoder === encoderIndex}
                        size="sm"
                        onChange={(pressed) => setLearningEncoder(pressed ? encoderIndex : null)}
                        data-testid={`qlink-learn-${encoderIndex}`}
                      />
                      <button
                        type="button"
                        aria-label={`Clear binding for encoder ${encoderIndex + 1}`}
                        disabled={!binding}
                        onClick={() => useHardwareStore.getState().removeBinding(encoderIndex)}
                        className="rounded-bb-sm border border-bb-line p-1 text-bb-muted transition-colors duration-150 hover:text-bb-danger disabled:opacity-30"
                      >
                        <IconRemove size={14} aria-hidden="true" />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {learningEncoder !== null && (
          <p className="mt-3 text-xs text-bb-accent" role="status">
            Learning encoder Q{learningEncoder + 1} — choose a parameter from its row to bind it.
          </p>
        )}
        {choices.length === 0 && (
          <p className="mt-3 text-xs text-bb-muted">
            No automatable parameters yet — start the audio engine to build the mixer graph.
          </p>
        )}
      </Panel>
    </div>
  );
}
