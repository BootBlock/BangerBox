/**
 * InsertPanel — the insert slot list and effect parameter editor for one channel
 * (spec §8.5.6: "insert slot list (add/replace/reorder/bypass; tapping opens the effect's
 * parameter panel)").
 *
 * Replace is in-place rather than remove-then-add, so the slot holds its chain position and
 * the first-slot Q-Link binding below survives an effect swap.
 *
 * Parameter ranges, units and names all come from the effect registry (spec §5.7) rather
 * than being restated here, so a knob can never offer a value the store would clamp away,
 * announce a number in the wrong unit, or read out a frozen store key as though it were
 * words (spec §8.2, issues #35 and #58). A parameter the registry gives named choices for
 * (`EFFECT_PARAM_CHOICES` — the filter's type, the saturator's curve, the delay's synced
 * division) is rendered as a select instead: those are index-encoded integers, and a knob
 * reading "7" for a dotted eighth is a control no one can use. Slot changes go through
 * `useMixerStore`, making them undoable and autosaved (spec §4.5).
 *
 * ## Naming inside a slot
 *
 * Every control in a slot names its slot AND its effect. Four inserts present four move
 * buttons, four removes and four bypasses, and a screen reader lists them out of context —
 * so "Bypass insert 2, Delay" is the whole of what distinguishes one from another. The
 * `<li>` carries the same name, for browsing by list item.
 */
import { useMemo } from 'react';
import { freeInsertSlot, useMixerStore, useProjectStore, useUIStore, type InsertSlotResult } from '@/store';
import { useQLinkFocus } from '@/ui/useQLinkFocus';
import {
  EFFECT_PARAM_CHOICES,
  EFFECT_PARAM_RANGES,
  effectParamLabel,
  effectParamUnit,
} from '@/core/audio/inserts/effectParams';
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
  // spec §1.3.1 — how many slots this channel may hold (§9.3 `projects.insert_limit`). The
  // store owns the rule; this only decides which controls are worth offering (issue #135).
  const insertLimit = useProjectStore((s) => s.globalInsertLimit);
  const chainFull = freeInsertSlot(inserts, insertLimit) === null;

  /**
   * Show a store refusal verbatim (spec §4.2). `addInsert` and `replaceInsert` return a
   * finished sentence because the store is the only layer that knows which rule refused; a
   * silent return is what made the §8.5.6 picker read as broken past the limit (issue #135).
   */
  const report = (result: InsertSlotResult) => {
    if (!result.ok) useUIStore.getState().pushToast(result.reason, 'warning');
  };

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
      label: `${EFFECT_LABELS[effectType]} ${effectParamLabel(effectType, param)}`,
      targetParameterPath: insertParamPath(channelId, first + 1, param),
    }));
  }, [channelId, inserts]);
  useQLinkFocus(focusParams);

  /**
   * Reorder by rewriting the slot array — `upsertChannel` applies it as one bare `set`.
   *
   * This is the one surface that can move an effect between §7.8 addresses without CREATING a
   * slot, so the §1.3.1 limit is not applied by the store here (admission stays unbounded —
   * see `withCompleteInserts`). Inside a chain a project carried that is longer than the
   * limit, walking an effect past it would put a sounding effect where nothing can address
   * it, so the Move-later button that would do it is disabled (issue #135).
   */
  const moveSlot = (index: number, delta: number) => {
    const target = index + delta;
    if (!strip || target < 0 || target >= inserts.length) return;
    if (inserts[index]?.effectType !== null && target >= insertLimit) return;
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
                report(mixer().addInsert(channelId, event.target.value as EffectType));
              }}
              // A full channel says so on the control rather than only in a toast after the
              // fact — the `LayersEditor` precedent for a §6 cap (spec §1.3.1, issue #135).
              // The store still refuses, because the store owns the rule.
              disabled={chainFull}
              title={
                chainFull
                  ? `All ${insertLimit} insert slots are in use. Remove or replace one first.`
                  : undefined
              }
              data-testid="insert-add"
              className="rounded-bb-sm border border-bb-line bg-bb-raised px-2 py-1 text-xs font-normal text-bb-text normal-case disabled:opacity-50"
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
            // Past the §1.3.1 limit the §7.8 grammar addresses nothing here (issue #135).
            const beyondLimit = index >= insertLimit;
            // What every control in this slot is named after (spec §8.2).
            const slotName = effectType
              ? `insert ${index + 1}, ${EFFECT_LABELS[effectType]}`
              : `insert ${index + 1}, empty`;
            return (
              <li
                key={slot.id}
                // A list item with no name left "Enabled, toggle button, pressed" as the
                // only thing four identical rows said about themselves (issue #58).
                aria-label={`Insert ${index + 1}${effectType ? ` — ${EFFECT_LABELS[effectType]}` : ' — empty'}`}
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
                      report(mixer().replaceInsert(channelId, slot.id, event.target.value as EffectType));
                    }}
                    // A slot PAST the §1.3.1 limit exists only in a chain a project already
                    // carried (see `withCompleteInserts`), and the store will not put a new
                    // effect there — so the control says so rather than looking operable
                    // (issue #135). The copy claims only what is true: the §7.8 grammar bounds
                    // `slotN` by the configurable RANGE, so a slot past THIS project's limit
                    // may still be addressable, and one already sounding goes on sounding.
                    disabled={beyondLimit}
                    title={
                      beyondLimit
                        ? `Slot ${index + 1} is past this project's limit of ${insertLimit} insert slots, so no new effect can go here.`
                        : undefined
                    }
                    data-testid={`insert-replace-${index}`}
                    className="flex-1 rounded-bb-sm border border-bb-line bg-bb-base px-2 py-1 text-xs font-semibold text-bb-text disabled:opacity-50"
                  >
                    {!effectType && <option value="">Empty slot</option>}
                    {availableEffects.map((effect) => (
                      <option key={effect} value={effect}>
                        {EFFECT_LABELS[effect]}
                      </option>
                    ))}
                  </select>
                  {/*
                   * Bypass, not "Enabled" (issue #58). §5.7 defines the slot's `enabled`
                   * field as TRUE BYPASS via routing, so bypass is what the control does
                   * and what every desk calls the button; "Enabled" named a state rather
                   * than an action, and named it identically on all four slots. The
                   * pressed state follows the name — lit means bypassed, as the light on
                   * a bypass switch does — so the store field keeps its frozen §13.6 name
                   * and inverts here, at the one place the two meet.
                   */}
                  <Toggle
                    label="Bypass"
                    accessibleName={`Bypass ${slotName}`}
                    tone="warn"
                    // An EMPTY slot is not bypassed, it is empty — and a fresh slot carries
                    // `enabled: false`, so reading the field straight through lit every one
                    // of the four default slots as though the user had bypassed something.
                    pressed={effectType !== null && !slot.enabled}
                    size="sm"
                    disabled={!effectType}
                    onChange={(bypassed) => mixer().setInsertEnabled(channelId, slot.id, !bypassed)}
                    data-testid={`insert-enabled-${index}`}
                  />
                  <Button
                    label={`Move ${slotName} earlier`}
                    variant="quiet"
                    size="sm"
                    iconOnly
                    icon={<IconChevronUp size={14} aria-hidden="true" />}
                    disabled={index === 0}
                    onClick={() => moveSlot(index, -1)}
                  />
                  <Button
                    label={`Move ${slotName} later`}
                    variant="quiet"
                    size="sm"
                    iconOnly
                    icon={<IconChevronDown size={14} aria-hidden="true" />}
                    // Never into a position §1.3.1 forbids, which only an over-long chain
                    // from a project has at all (issue #135).
                    disabled={
                      index === inserts.length - 1 || (effectType !== null && index + 1 >= insertLimit)
                    }
                    onClick={() => moveSlot(index, 1)}
                  />
                  <Button
                    label={`Remove ${slotName}`}
                    variant="danger"
                    size="sm"
                    iconOnly
                    icon={<IconRemove size={14} aria-hidden="true" />}
                    // An EMPTY slot has nothing to remove, and a removal now EMPTIES a slot
                    // rather than dropping it (issue #142) — so the button would do nothing
                    // at all here. Disabled for the same reason, and from the same fact, as
                    // the bypass toggle beside it (spec §3.4).
                    disabled={!effectType}
                    onClick={() => mixer().removeInsert(channelId, slot.id)}
                  />
                </div>

                {effectType && (
                  <div className="mt-2 flex flex-wrap items-end gap-3 border-t border-bb-line pt-2">
                    {Object.entries(ranges).map(([param, range]) => {
                      const choices = EFFECT_PARAM_CHOICES[effectType]?.[param];
                      if (choices) {
                        return (
                          <FieldLabel key={param}>
                            {effectParamLabel(effectType, param)}
                            <select
                              aria-label={`${effectParamLabel(effectType, param)}, ${slotName}`}
                              value={String(Math.round(slot.params[param] ?? 0))}
                              onChange={(event) => setParam(index, param, Number(event.target.value), true)}
                              data-testid={`insert-param-${index}-${param}`}
                              className="rounded-bb-sm border border-bb-line bg-bb-base px-2 py-1 text-xs font-normal text-bb-text normal-case"
                            >
                              {choices.map((choice, choiceIndex) => (
                                <option key={choice} value={choiceIndex}>
                                  {choice}
                                </option>
                              ))}
                            </select>
                          </FieldLabel>
                        );
                      }
                      const unit = effectParamUnit(effectType, param);
                      return (
                        <Knob
                          key={param}
                          label={effectParamLabel(effectType, param)}
                          accessibleName={`${effectParamLabel(effectType, param)}, ${slotName}`}
                          // An occupied slot carries every parameter its effect declares
                          // (`useMixerStore`'s `withCompleteInserts`), so the range floor is
                          // the type's last resort rather than what a fresh insert draws.
                          // Drawing it was issue #131: a new delay read 1 ms and ran at 350.
                          value={slot.params[param] ?? range[0]}
                          range={range}
                          unit={unit}
                          size="sm"
                          // Frequency-domain params read naturally on a log taper (spec §5.7).
                          // The unit answers this where a substring match on the key used to:
                          // the two were derived side by side, and only one of them was right.
                          curve={unit === 'Hz' ? 'log' : 'linear'}
                          // spec §10.3 "UI reacts concurrently": a Q-Link turn moves this
                          // knob live, painted by ref rather than by a re-render (issue #27).
                          livePath={insertParamPath(channelId, index + 1, param)}
                          onTransient={(value) => setParam(index, param, value, false)}
                          onCommit={(value) => setParam(index, param, value, true)}
                          data-testid={`insert-param-${index}-${param}`}
                        />
                      );
                    })}
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
