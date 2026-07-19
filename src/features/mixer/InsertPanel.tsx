/**
 * InsertPanel — the insert slot list and effect parameter editor for one channel
 * (spec §8.5.6: "insert slot list (add/replace/reorder/bypass; tapping opens the effect's
 * parameter panel)").
 *
 * Replace is in-place rather than remove-then-add, so the slot holds its chain position and
 * the first-slot Q-Link binding below survives an effect swap.
 *
 * Parameter ranges come from the effect registry (spec §5.7 `EFFECT_PARAM_RANGES`) rather
 * than being restated here, so a knob can never offer a value the store would clamp away.
 * Slot changes go through `useMixerStore`, making them undoable and autosaved (spec §4.5).
 */
import { useMemo } from 'react';
import { useMixerStore } from '@/store';
import { useQLinkFocus } from '@/ui/useQLinkFocus';
import { EFFECT_PARAM_RANGES } from '@/core/audio/inserts/effectParams';
import { insertParamPath } from '@/core/audio/params/registry';
import type { EffectType } from '@/core/project/schemas';
import { Button, EmptyState, FieldLabel, Knob, Toggle } from '@/ui/primitives';
import { Panel } from '@/ui/shell/Panel';
import { IconChevronDown, IconChevronUp, IconRemove } from '@/ui/icons';

export interface InsertPanelProps {
  channelId: string;
  availableEffects: readonly EffectType[];
  onClose: () => void;
}

/** Human labels for effect ids (spec §5.7 ids are the naming-frozen keys — spec §13.6). */
const EFFECT_LABELS: Readonly<Record<EffectType, string>> = {
  eq4: '4-band EQ',
  filter: 'Filter',
  delay: 'Delay',
  compressor: 'Compressor',
  saturator: 'Saturator',
  reverb: 'Reverb',
  multibandComp: 'Multiband compressor',
  limiter: 'Limiter',
};

export function InsertPanel({ channelId, availableEffects, onClose }: InsertPanelProps) {
  const strip = useMixerStore((s) => s.channels[channelId]);
  // Memoised so the empty fallback keeps a stable identity for the focus-registry memo.
  const inserts = useMemo(() => strip?.inserts ?? [], [strip]);
  const mixer = () => useMixerStore.getState();

  /**
   * Screen-mode Q-Link parameters for this panel — spec §10.3's own example: "opening a
   * Delay insert maps knobs to Time/Feedback/Mix/Tone". The first effect in the chain
   * owns the encoders, and they follow whatever effect that slot holds.
   */
  const focusParams = useMemo(() => {
    const first = inserts.findIndex((slot) => slot.effectType !== null);
    if (first < 0) return [];
    const effectType = inserts[first]!.effectType!;
    return Object.keys(EFFECT_PARAM_RANGES[effectType]).map((param) => ({
      label: `${EFFECT_LABELS[effectType]} ${param}`,
      targetParameterPath: insertParamPath(channelId, first + 1, param),
    }));
  }, [channelId, inserts]);
  useQLinkFocus(focusParams);

  /** Reorder by rewriting the slot array — the store commits it as one undo entry. */
  const moveSlot = (index: number, delta: number) => {
    const target = index + delta;
    if (!strip || target < 0 || target >= inserts.length) return;
    const reordered = [...inserts];
    const [moved] = reordered.splice(index, 1);
    if (!moved) return;
    reordered.splice(target, 0, moved);
    mixer().upsertChannel({ ...strip, inserts: reordered });
  };

  const setParam = (slotIndex: number, param: string, value: number, commit: boolean) => {
    const path = insertParamPath(channelId, slotIndex + 1, param);
    if (commit) mixer().commit(path, value);
    else mixer().setTransient(path, value);
  };

  return (
    <Panel
      title={`Inserts — ${channelId}`}
      scroll
      actions={
        <div className="flex items-center gap-2">
          <FieldLabel>
            Add
            <select
              aria-label={`Add an insert effect to ${channelId}`}
              value=""
              onChange={(event) => {
                if (!event.target.value) return;
                mixer().addInsert(channelId, event.target.value as EffectType);
              }}
              data-testid="insert-add"
              className="rounded-bb-sm border border-bb-line bg-bb-raised px-2 py-1 text-xs font-normal text-bb-text normal-case"
            >
              <option value="">Choose an effect…</option>
              {availableEffects.map((effect) => (
                <option key={effect} value={effect}>
                  {EFFECT_LABELS[effect]}
                </option>
              ))}
            </select>
          </FieldLabel>
          <Button label="Close" variant="quiet" size="sm" onClick={onClose} />
        </div>
      }
    >
      {inserts.length === 0 ? (
        <EmptyState message="No inserts on this channel yet." hint="Add one from the slot picker above." />
      ) : (
        <ol className="flex flex-col gap-2">
          {inserts.map((slot, index) => {
            const effectType = slot.effectType;
            const ranges = effectType ? EFFECT_PARAM_RANGES[effectType] : {};
            return (
              <li
                key={slot.id}
                data-testid={`insert-slot-${index}`}
                className="rounded-bb-sm border border-bb-line bg-bb-raised p-2"
              >
                <div className="flex items-center gap-2">
                  <span className="w-6 font-mono text-xs tabular-nums text-bb-muted">{index + 1}</span>
                  {/*
                   * The slot's name doubles as its replace control — a sibling of the Add
                   * select rather than a second way to name an effect. No FieldLabel: the
                   * caption chassis is for a visible caption, and the row number already
                   * names the slot, so the accessible name carries it instead (spec §8.2).
                   */}
                  <select
                    aria-label={`Replace insert ${index + 1}`}
                    value={effectType ?? ''}
                    onChange={(event) => {
                      if (!event.target.value) return;
                      mixer().replaceInsert(channelId, slot.id, event.target.value as EffectType);
                    }}
                    data-testid={`insert-replace-${index}`}
                    className="flex-1 rounded-bb-sm border border-bb-line bg-bb-base px-2 py-1 text-xs font-semibold text-bb-text"
                  >
                    {!effectType && <option value="">Empty slot</option>}
                    {availableEffects.map((effect) => (
                      <option key={effect} value={effect}>
                        {EFFECT_LABELS[effect]}
                      </option>
                    ))}
                  </select>
                  <Toggle
                    label="Enabled"
                    pressed={slot.enabled}
                    size="sm"
                    onChange={(enabled) => mixer().setInsertEnabled(channelId, slot.id, enabled)}
                    data-testid={`insert-enabled-${index}`}
                  />
                  <Button
                    label={`Move insert ${index + 1} earlier`}
                    variant="quiet"
                    size="sm"
                    iconOnly
                    icon={<IconChevronUp size={14} aria-hidden="true" />}
                    disabled={index === 0}
                    onClick={() => moveSlot(index, -1)}
                  />
                  <Button
                    label={`Move insert ${index + 1} later`}
                    variant="quiet"
                    size="sm"
                    iconOnly
                    icon={<IconChevronDown size={14} aria-hidden="true" />}
                    disabled={index === inserts.length - 1}
                    onClick={() => moveSlot(index, 1)}
                  />
                  <Button
                    label={`Remove insert ${index + 1}`}
                    variant="danger"
                    size="sm"
                    iconOnly
                    icon={<IconRemove size={14} aria-hidden="true" />}
                    onClick={() => mixer().removeInsert(channelId, slot.id)}
                  />
                </div>

                {effectType && (
                  <div className="mt-2 flex flex-wrap gap-3 border-t border-bb-line pt-2">
                    {Object.entries(ranges).map(([param, range]) => (
                      <Knob
                        key={param}
                        label={param}
                        value={slot.params[param] ?? range[0]}
                        range={range}
                        size="sm"
                        // Frequency-domain params read naturally on a log taper (spec §5.7).
                        curve={param.toLowerCase().includes('freq') || param === 'cutoff' ? 'log' : 'linear'}
                        onTransient={(value) => setParam(index, param, value, false)}
                        onCommit={(value) => setParam(index, param, value, true)}
                        data-testid={`insert-param-${index}-${param}`}
                      />
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </Panel>
  );
}
