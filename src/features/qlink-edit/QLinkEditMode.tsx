/**
 * Q-Link Edit mode — spec §8.5.11: the table of encoder bindings for the active Q-Link
 * mode, a learn flow, a registry-driven manual path picker, and min/max/curve per binding
 * (spec §10.3). It also hosts the input-latency offset setting (spec §10.2).
 *
 * This mode owns the *editing* surface. The runtime that turns incoming CC into store
 * actions is Phase 8 (spec §12), which is why the learn flow arms a pending encoder and
 * accepts a parameter tap: with no transport connected yet, tapping a parameter is the
 * half of the flow that exists, and the same armed state will accept a CC in Phase 8
 * without changing this UI.
 */
import { useMemo, useState } from 'react';
import { INPUT_LATENCY_DEFAULT_MS, INPUT_LATENCY_RANGE, useHardwareStore, useMixerStore } from '@/store';
import {
  channelLevelPath,
  channelPanPath,
  channelSendPath,
  isAutomatable,
  parseParamTarget,
  targetRange,
} from '@/core/audio/params/registry';
import { qLinkModeSchema, type QLinkBinding, type QLinkMode } from '@/core/project/schemas';
import { Knob, SegmentControl, Toggle, ValueReadout } from '@/ui/primitives';
import { Panel } from '@/ui/shell/Panel';
import { IconRemove } from '@/ui/icons';

/** Physical encoders by default; the model supports up to 16 (spec §1.3.1, §10.3). */
const DEFAULT_ENCODERS = 4;
const MAX_ENCODERS = 16;

const MODE_OPTIONS = qLinkModeSchema.options.map((mode) => ({
  value: mode,
  label: mode.charAt(0).toUpperCase() + mode.slice(1),
}));

interface ParamChoice {
  readonly path: string;
  readonly label: string;
}

/** Assignable parameters, built through the registry's own builders (spec §7.8). */
function assignableParams(channelIds: readonly string[]): ParamChoice[] {
  const choices: ParamChoice[] = [];
  for (const channelId of channelIds) {
    const candidates: ParamChoice[] = [
      { path: channelLevelPath(channelId), label: `${channelId} · level` },
      { path: channelPanPath(channelId), label: `${channelId} · pan` },
      ...[0, 1, 2, 3].map((index) => ({
        path: channelSendPath(channelId, index),
        label: `${channelId} · send ${index + 1}`,
      })),
    ];
    for (const candidate of candidates) {
      if (isAutomatable(candidate.path)) choices.push(candidate);
    }
  }
  return choices;
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
  const channels = useMixerStore((s) => s.channels);
  const inputLatencyMs = useHardwareStore((s) => s.inputLatencyMs);

  /** Encoder awaiting a parameter tap during the learn flow (spec §8.5.11). */
  const [learningEncoder, setLearningEncoder] = useState<number | null>(null);
  const [encoderCount, setEncoderCount] = useState(DEFAULT_ENCODERS);

  const choices = useMemo(() => assignableParams(Object.keys(channels).sort()), [channels]);

  const bindingFor = (encoderIndex: number): QLinkBinding | undefined =>
    bindings.find((binding) => binding.encoderIndex === encoderIndex);

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
      cc: existing?.cc ?? encoderIndex,
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
            value={connectionState === 'connected' ? 'Connected' : 'Not connected'}
            showLabel
            tone={connectionState === 'connected' ? 'accent' : 'muted'}
            data-testid="qlink-connection"
          />
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
        <p className="mt-3 text-xs text-bb-muted">
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
