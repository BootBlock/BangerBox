/**
 * Grid / Piano Roll mode — spec §8.5.2: the canvas note editor with drum rows (pad names)
 * or a piano roll (keygroups), draw/erase/select/move/resize, a velocity lane, a per-track
 * automation lane selector, zoom/scroll, a grid snap selector including off, and the
 * quantise dialog (spec §7.4).
 *
 * The canvas is a pointer surface; every edit it performs is also reachable from the note
 * list beside it, which is the keyboard/screen-reader path (spec §8.2 — a canvas alone is
 * not operable). Both routes call the same store actions, so both are undoable (spec §4.5).
 */
import { useMemo, useState } from 'react';
import { PPQN } from '@/core/constants';
import { gridTicks, quantiseEvents, type QuantiseGrid } from '@/core/sequencer/quantise';
import {
  endUndoGesture,
  useMixerStore,
  useProgramStore,
  useSequenceStore,
  useTransportStore,
  useUndoStore,
} from '@/store';
import { automationLaneKey, type AutomationPoint, type MidiEvent } from '@/core/project/schemas';
import {
  channelAutomatableParams,
  programAutomatableParams,
  type AutomatableParam,
} from '@/core/audio/params/catalogue';
import { isAutomatable, parseParamTarget, targetRange } from '@/core/audio/params/registry';
import { IconRemove } from '@/ui/icons';
import { Button, EmptyState, FieldLabel, Modal, SegmentControl, Toggle, ValueReadout } from '@/ui/primitives';
import { announce } from '@/ui/primitives/LiveRegion';
import { Panel } from '@/ui/shell/Panel';
import { noteName } from '../pad-perform/scales';
import { GridCanvas, type GridTool } from './GridCanvas';
import { automationBounds } from './gridGeometry';

/** Snap options in ticks; 0 is "off" (spec §8.5.2 "grid snap selector incl. off"). */
const SNAP_OPTIONS = [
  { value: 0, label: 'Off' },
  { value: PPQN, label: '1/4' },
  { value: PPQN / 2, label: '1/8' },
  { value: PPQN / 4, label: '1/16' },
  { value: PPQN / 8, label: '1/32' },
] as const;

const QUANTISE_DIVISIONS = [4, 8, 16, 32, 64] as const;
type QuantiseDivision = (typeof QUANTISE_DIVISIONS)[number];

const DEFAULT_ROW_HEIGHT = 20;
const DEFAULT_TICKS_PER_PIXEL = 8;
const MIN_TICKS_PER_PIXEL = 1;
const MAX_TICKS_PER_PIXEL = 64;
/** A drawn note defaults to a sixteenth — the usual step-sequencing unit. */
const DEFAULT_DRAW_DURATION = PPQN / 4;
/**
 * One press of a zoom button. Coarser than the wheel's 1.15 because a button press is a
 * deliberate discrete step, not a continuous scroll — the whole range is then five presses
 * rather than thirty (issue #43).
 */
const ZOOM_BUTTON_STEP = 1.5;

/** Curve of the span leaving a point (spec §7.8 `'step' | 'linear' | 'exp'`). */
const CURVE_OPTIONS = [
  { value: 'step', label: 'Step' },
  { value: 'linear', label: 'Linear' },
  { value: 'exp', label: 'Exp' },
] as const satisfies readonly { value: AutomationPoint['curve']; label: string }[];

/**
 * Value span of an automation lane, phrased for the accessible readout (spec §8.2). The
 * raw span, not {@link automationBounds} — that pads a flat lane so the drawn line has
 * somewhere to sit, and reading the padding back out would misreport the values.
 */
function laneRangeText(points: readonly AutomationPoint[]): string {
  const values = points.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const round = (value: number) => Number(value.toFixed(3));
  return min === max ? `flat at ${round(min)}` : `${round(min)} to ${round(max)}`;
}

/** Round a lane value for display without pretending to a precision it has not got. */
function displayValue(value: number): string {
  return Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(3);
}

export function GridMode() {
  const activeSequenceId = useTransportStore((s) => s.activeSequenceId);
  const tracks = useSequenceStore((s) => s.tracks);
  const eventsByTrack = useSequenceStore((s) => s.events);
  const automation = useSequenceStore((s) => s.automation);
  const grooveTemplates = useSequenceStore((s) => s.grooveTemplates);
  const trackGrooveIds = useSequenceStore((s) => s.trackGrooveIds);
  const programs = useProgramStore((s) => s.programs);
  const channels = useMixerStore((s) => s.channels);

  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);
  const [tool, setTool] = useState<GridTool>('draw');
  const [snapTicks, setSnapTicks] = useState<number>(PPQN / 4);
  const [selectedIds, setSelectedIds] = useState<readonly string[]>([]);
  const [quantiseOpen, setQuantiseOpen] = useState(false);
  const [quantiseDivision, setQuantiseDivision] = useState<QuantiseDivision>(16);
  const [quantiseTriplet, setQuantiseTriplet] = useState(false);
  const [quantiseStrength, setQuantiseStrength] = useState(100);
  /**
   * Which §7.8 scope the lane being edited belongs to. Explicit, and never inferred from
   * whatever lane happens to exist, because track scope OVERRIDES sequence scope for the
   * same target at schedule time: editing the wrong one is silent, and the user has to be
   * able to see which one they are drawing on.
   */
  const [automationScope, setAutomationScope] = useState<AutomationPoint['scope']>('track');
  const [automationTarget, setAutomationTarget] = useState<string>('');
  const [drawCurve, setDrawCurve] = useState<AutomationPoint['curve']>('linear');
  const [selectedPointIds, setSelectedPointIds] = useState<readonly string[]>([]);
  const [viewport, setViewport] = useState({
    scrollTicks: 0,
    ticksPerPixel: DEFAULT_TICKS_PER_PIXEL,
    rowHeight: DEFAULT_ROW_HEIGHT,
    scrollRows: 0,
    topNote: 72,
  });

  const sequenceTracks = useMemo(
    () =>
      Object.values(tracks)
        .filter((track) => activeSequenceId === null || track.sequenceId === activeSequenceId)
        .sort((a, b) => a.position - b.position),
    [tracks, activeSequenceId],
  );

  const trackId = selectedTrackId ?? sequenceTracks[0]?.id ?? null;
  const track = trackId ? tracks[trackId] : undefined;
  const program = track?.programId ? programs[track.programId] : undefined;
  const events = useMemo(() => (trackId ? (eventsByTrack[trackId] ?? []) : []), [eventsByTrack, trackId]);

  /** Drum rows show pad names; keygroup rows show note names (spec §8.5.2). */
  const rowLabel = useMemo(() => {
    if (program?.type === 'drum') {
      const names = new Map(program.pads.map((pad) => [pad.padIndex, pad.name]));
      return (note: number) => names.get(note) ?? `Pad ${note + 1}`;
    }
    return noteName;
  }, [program]);

  /**
   * The entity that owns a lane in each §7.8 scope: the selected track, or the sequence
   * the transport is playing. A sequence lane belongs to the pattern, so it follows the
   * transport's active sequence rather than the track selector.
   */
  const automationOwnerId = automationScope === 'track' ? trackId : activeSequenceId;

  /**
   * Parameters this context can automate (spec §7.8 "only registered, automatable
   * parameters accept points"). Built through the registry catalogue, so the picker
   * cannot offer an address the store would refuse: the selected track's own mixer
   * channel and inserts, the master strip, and the sound-design leaves of the pads its
   * program actually has.
   */
  const targetOptions = useMemo(() => {
    const options: AutomatableParam[] = [];
    const trackChannelId = trackId ? `track:${trackId}` : null;
    const trackStrip = trackChannelId ? channels[trackChannelId] : undefined;
    if (trackChannelId && trackStrip) {
      options.push(...channelAutomatableParams(trackChannelId, trackStrip, track?.name ?? 'Track'));
    }
    const master = channels.master;
    if (master) options.push(...channelAutomatableParams('master', master, 'Master'));
    if (program) options.push(...programAutomatableParams(program));
    return options;
  }, [channels, program, track?.name, trackId]);

  /**
   * Lanes this scope and owner already hold. Listed alongside the registered targets so a
   * lane an older project carries — one whose address this build's registry no longer
   * recognises — stays reachable and readable rather than vanishing from the picker.
   */
  const existingTargets = useMemo(() => {
    if (automationOwnerId === null) return [];
    const prefix = `${automationScope}:${automationOwnerId}:`;
    return Object.keys(automation)
      .filter((key) => key.startsWith(prefix) && (automation[key]?.length ?? 0) > 0)
      .map((key) => key.slice(prefix.length))
      .sort();
  }, [automation, automationOwnerId, automationScope]);

  /** The picker's options: every registered target, plus any lane already written. */
  const laneChoices = useMemo(() => {
    const seen = new Set(targetOptions.map((option) => option.path));
    const extra = existingTargets
      .filter((path) => !seen.has(path))
      .map((path) => ({ path, label: `${path} (not automatable in this build)` }));
    return [...targetOptions, ...extra];
  }, [existingTargets, targetOptions]);

  /**
   * The chosen target, narrowed to one this context offers. Switching track or scope
   * leaves the previous choice in state; resolving it anyway would draw one owner's
   * automation over another's notes, so it falls back to "None" — and because the select
   * reads this rather than the raw state, it shows None to match.
   */
  const activeTarget = laneChoices.some((choice) => choice.path === automationTarget) ? automationTarget : '';

  const laneKey =
    activeTarget && automationOwnerId !== null
      ? automationLaneKey(automationScope, automationOwnerId, activeTarget)
      : null;

  /**
   * The lane the canvas draws and edits, or null for none. Its `bounds` come from the
   * §7.8 registry rather than from the points themselves: a drag has to write real
   * parameter values, and scaling to the lane's own contents would make the same pixel
   * mean a different value every time a point moved.
   */
  const selectedLane = useMemo(() => {
    if (activeTarget === '' || laneKey === null) return null;
    const points = automation[laneKey] ?? [];
    const target = parseParamTarget(activeTarget);
    const range = target ? targetRange(target) : null;
    const label = laneChoices.find((choice) => choice.path === activeTarget)?.label ?? activeTarget;
    return {
      label,
      points,
      bounds: range ? { min: range[0], max: range[1] } : automationBounds(points),
      editable: isAutomatable(activeTarget),
      selectedPointIds,
    };
  }, [activeTarget, automation, laneChoices, laneKey, selectedPointIds]);

  /**
   * Whether a track-scope lane is in force for this target (spec §7.8: "track scope
   * overrides sequence scope for the same target"). Any track's lane wins, not only the
   * selected track's, because the scheduler resolves by target path across every lane.
   */
  const trackScopeOverrides = useMemo(() => {
    if (activeTarget === '') return false;
    return Object.entries(automation).some(
      ([key, points]) =>
        key.startsWith('track:') && key.endsWith(`:${activeTarget}`) && (points?.length ?? 0) > 0,
    );
  }, [activeTarget, automation]);

  const sequence = () => useSequenceStore.getState();

  const writeEvents = (next: readonly MidiEvent[], coalesceKey?: string) => {
    if (!trackId) return;
    sequence().setTrackEvents(trackId, next, coalesceKey);
  };

  const handleDraw = (note: number, tickStart: number, durationTicks: number, coalesceKey?: string) => {
    if (!trackId) return;
    sequence().addEvents(
      trackId,
      [
        {
          id: crypto.randomUUID(),
          tickStart,
          durationTicks,
          note,
          velocity: 100,
          extra: null,
        },
      ],
      coalesceKey,
    );
  };

  const handleErase = (id: string, coalesceKey?: string) => {
    if (!trackId) return;
    sequence().removeEvents(trackId, [id], coalesceKey);
  };

  const handleMove = (id: string, note: number, tickStart: number, coalesceKey?: string) => {
    writeEvents(
      events.map((event) => (event.id === id ? { ...event, note, tickStart } : event)),
      coalesceKey,
    );
  };

  const handleResize = (id: string, durationTicks: number, coalesceKey?: string) => {
    writeEvents(
      events.map((event) =>
        event.id === id ? { ...event, durationTicks: Math.max(1, durationTicks) } : event,
      ),
      coalesceKey,
    );
  };

  /**
   * Reads live store events rather than the rendered `events`, unlike the other handlers.
   * A velocity drag writes many times per second and each write must build on the last:
   * from the render closure, a sample that sweeps no new bar would rewrite the pre-drag
   * snapshot and revert every bar the drag had already shaped.
   */
  const handleVelocity = (ids: readonly string[], velocity: number, coalesceKey?: string) => {
    if (!trackId) return;
    const clamped = Math.min(127, Math.max(1, velocity));
    const live = sequence().events[trackId] ?? [];
    writeEvents(
      live.map((event) => (ids.includes(event.id) ? { ...event, velocity: clamped } : event)),
      coalesceKey,
    );
  };

  /**
   * Write the lane back through the one store action that owns §7.8's gates. A refusal
   * carries a finished sentence, which is announced rather than swallowed — a control that
   * silently does nothing reads as broken (see `useProgramStore`'s AssignResult).
   */
  const writeLane = (points: readonly AutomationPoint[], coalesceKey?: string) => {
    if (activeTarget === '' || automationOwnerId === null) return;
    const result = sequence().setAutomationLane(
      automationScope,
      automationOwnerId,
      activeTarget,
      points,
      coalesceKey,
    );
    if (!result.ok) announce(result.reason);
  };

  const lanePoints = (): readonly AutomationPoint[] =>
    laneKey === null ? [] : (sequence().automation[laneKey] ?? []);

  /**
   * Hold a value inside the lane's registered range (spec §7.8). The canvas already clamps
   * a drag, but the point list's number fields do not — `min`/`max` on an input constrain
   * the spinners and nothing else.
   */
  const clampToLane = (value: number): number => {
    if (!selectedLane || !Number.isFinite(value)) return value;
    const { min, max } = selectedLane.bounds;
    return Math.min(max, Math.max(min, value));
  };

  const handleAutomationDraw = (tick: number, value: number, coalesceKey?: string) => {
    if (automationOwnerId === null || !Number.isFinite(value)) return;
    // A point already at this tick is replaced rather than stacked on: two points at one
    // tick make a lane whose value depends on array order, which nothing else respects.
    const kept = lanePoints().filter((point) => point.tick !== tick);
    writeLane(
      [
        ...kept,
        {
          id: crypto.randomUUID(),
          scope: automationScope,
          ownerId: automationOwnerId,
          targetPath: activeTarget,
          tick,
          value: clampToLane(value),
          curve: drawCurve,
        },
      ],
      coalesceKey,
    );
  };

  const handleAutomationMove = (id: string, tick: number, value: number, coalesceKey?: string) => {
    if (!Number.isFinite(value)) return; // a cleared number field is not a value of zero
    // Live points, not the rendered snapshot: a drag writes many times per second and each
    // write must build on the last (the same reason `handleVelocity` reads the store).
    const live = lanePoints();
    if (!live.some((point) => point.id === id)) return;
    // A drag stalls at a tick another point already holds rather than deleting it. Dragging
    // across a dense lane would otherwise wipe every point it passed, and an accidental
    // erase is a worse outcome than a drag that will not go where it is pushed.
    if (live.some((point) => point.id !== id && point.tick === tick)) return;
    writeLane(
      live.map((point) => (point.id === id ? { ...point, tick, value: clampToLane(value) } : point)),
      coalesceKey,
    );
  };

  const handleAutomationErase = (ids: readonly string[], coalesceKey?: string) => {
    const removed = new Set(ids);
    writeLane(
      lanePoints().filter((point) => !removed.has(point.id)),
      coalesceKey,
    );
    setSelectedPointIds((current) => current.filter((id) => !removed.has(id)));
  };

  /**
   * The curve control does double duty: it sets what a newly drawn point takes, and
   * re-curves whatever is selected. One control rather than two, because a curve is a
   * property of a point and the selection is how the user says which points they mean.
   */
  const handleCurveChange = (curve: AutomationPoint['curve']) => {
    setDrawCurve(curve);
    if (selectedPointIds.length === 0) return;
    const chosen = new Set(selectedPointIds);
    writeLane(lanePoints().map((point) => (chosen.has(point.id) ? { ...point, curve } : point)));
  };

  /**
   * Add a point from the keyboard, since the canvas is a pointer surface (spec §8.2). It
   * lands one snap step past the last point at the middle of the lane's range, which is a
   * predictable place to then adjust from — the row's own tick and value fields.
   */
  const handleAddPoint = () => {
    if (!selectedLane?.editable) return;
    const step = snapTicks > 0 ? snapTicks : PPQN / 4;
    const last = lanePoints().reduce((highest, point) => Math.max(highest, point.tick), -step);
    const { min, max } = selectedLane.bounds;
    handleAutomationDraw(last + step, min + (max - min) / 2);
  };

  const applyQuantise = () => {
    if (!trackId) return;
    const grid: QuantiseGrid = { division: quantiseDivision, triplet: quantiseTriplet };
    // Quantise the selection, or the whole track when nothing is selected (spec §7.4).
    const targeted = selectedIds.length > 0 ? events.filter((e) => selectedIds.includes(e.id)) : events;
    const quantised = quantiseEvents(targeted, { grid, strength: quantiseStrength / 100 });
    // Merge the quantised subset back over the untouched notes, preserving the rest.
    const byId = new Map(quantised.map((event) => [event.id, event]));
    writeEvents(events.map((event) => byId.get(event.id) ?? event));
    setQuantiseOpen(false);
  };

  const zoom = (factor: number) =>
    setViewport((current) => ({
      ...current,
      ticksPerPixel: Math.min(
        MAX_TICKS_PER_PIXEL,
        Math.max(MIN_TICKS_PER_PIXEL, current.ticksPerPixel * factor),
      ),
    }));

  const scroll = (deltaTicks: number, deltaRows: number) =>
    setViewport((current) => ({
      ...current,
      scrollTicks: Math.max(0, current.scrollTicks + deltaTicks),
      topNote: Math.min(127, Math.max(11, current.topNote - deltaRows)),
    }));

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <Panel
        title="Grid"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <SegmentControl
              label="Editing tool"
              value={tool}
              options={[
                { value: 'draw', label: 'Draw' },
                { value: 'select', label: 'Select' },
                { value: 'erase', label: 'Erase' },
              ]}
              size="sm"
              onChange={setTool}
              data-testid="grid-tool"
            />
            <FieldLabel as="span">
              Snap
              <SegmentControl
                label="Grid snap"
                value={snapTicks}
                options={SNAP_OPTIONS}
                size="sm"
                onChange={setSnapTicks}
                data-testid="grid-snap"
              />
            </FieldLabel>
            <Button
              label="Quantise…"
              onClick={() => setQuantiseOpen(true)}
              disabled={events.length === 0}
              data-testid="grid-quantise-open"
            />
          </div>
        }
      >
        <div className="flex flex-wrap items-center gap-3">
          <FieldLabel>
            Track
            <select
              aria-label="Track to edit"
              value={trackId ?? ''}
              onChange={(event) => setSelectedTrackId(event.target.value || null)}
              data-testid="grid-track"
              className="rounded-bb-sm border border-bb-line bg-bb-raised px-2 py-1 text-xs font-normal text-bb-text normal-case"
            >
              {sequenceTracks.length === 0 && <option value="">No tracks</option>}
              {sequenceTracks.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
            </select>
          </FieldLabel>

          {/* Scope is named before the parameter, because §7.8 makes track scope override
              sequence scope for the same target: which one is being drawn on has to be
              visible, not inferred from whichever lane happened to exist. */}
          <FieldLabel as="span">
            Automation scope
            <SegmentControl
              label="Automation scope"
              value={automationScope}
              options={[
                { value: 'track', label: 'Track' },
                { value: 'sequence', label: 'Sequence' },
              ]}
              size="sm"
              onChange={(value) => {
                setAutomationScope(value);
                setSelectedPointIds([]);
              }}
              data-testid="grid-automation-scope"
            />
          </FieldLabel>

          <FieldLabel>
            Automation lane
            <select
              aria-label="Automation lane"
              value={activeTarget}
              disabled={laneChoices.length === 0 || automationOwnerId === null}
              onChange={(event) => {
                setAutomationTarget(event.target.value);
                setSelectedPointIds([]);
              }}
              data-testid="grid-automation-lane"
              className="max-w-56 rounded-bb-sm border border-bb-line bg-bb-raised px-2 py-1 text-xs font-normal text-bb-text normal-case disabled:opacity-40"
            >
              <option value="">{laneChoices.length === 0 ? 'No parameters' : 'None'}</option>
              {laneChoices.map((choice) => (
                <option key={choice.path} value={choice.path}>
                  {choice.label}
                </option>
              ))}
            </select>
          </FieldLabel>

          {selectedLane !== null && (
            <FieldLabel as="span">
              Curve
              <SegmentControl
                label="Automation curve"
                value={drawCurve}
                options={CURVE_OPTIONS}
                size="sm"
                disabled={!selectedLane.editable}
                onChange={handleCurveChange}
                data-testid="grid-automation-curve"
              />
            </FieldLabel>
          )}

          {/* The lane is drawn on the canvas, which is aria-hidden, so its shape also
              needs saying in text (spec §8.2). */}
          {selectedLane !== null && (
            <ValueReadout
              label="Lane"
              value={
                selectedLane.points.length === 0
                  ? 'empty — draw on the lane below the velocity strip'
                  : `${selectedLane.points.length} point${
                      selectedLane.points.length === 1 ? '' : 's'
                    }, ${laneRangeText(selectedLane.points)}`
              }
              showLabel
              data-testid="grid-automation-summary"
            />
          )}

          {/* §7.8's precedence rule, said where the editing happens rather than left for
              the user to discover by hearing the wrong lane. */}
          {selectedLane !== null && automationScope === 'sequence' && trackScopeOverrides && (
            <p className="text-bb-micro text-bb-warn" data-testid="grid-automation-override">
              A track lane for this parameter overrides this sequence lane during playback.
            </p>
          )}
          {selectedLane !== null && !selectedLane.editable && (
            <p className="text-bb-micro text-bb-warn" data-testid="grid-automation-readonly">
              This lane&rsquo;s parameter is not in the automation registry, so it can be read but not edited.
            </p>
          )}

          {/* Groove is applied at schedule time like swing — non-destructive (spec §7.5).
              Templates come from Sample Edit's groove extraction. */}
          <FieldLabel as="span">
            Groove
            <select
              aria-label="Track groove"
              value={trackId ? (trackGrooveIds[trackId] ?? '') : ''}
              disabled={trackId === null}
              onChange={(event) => {
                if (!trackId) return;
                sequence().assignTrackGroove(trackId, event.target.value || null);
              }}
              data-testid="grid-groove"
              className="rounded-bb-sm border border-bb-line bg-bb-raised px-2 py-1 text-xs font-normal text-bb-text normal-case disabled:opacity-40"
            >
              <option value="">None</option>
              {Object.keys(grooveTemplates).map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </FieldLabel>

          <ValueReadout label="Notes" value={events.length} showLabel data-testid="grid-note-count" />
          {/* On-screen zoom, so the readout refers to something reachable without a wheel
              — the pinch gesture is the fast path, these are the discoverable one
              (issue #43). */}
          <div className="flex items-center gap-2">
            <ValueReadout
              label="Zoom"
              value={`${(DEFAULT_TICKS_PER_PIXEL / viewport.ticksPerPixel).toFixed(2)}×`}
              showLabel
            />
            <Button
              label="Zoom out"
              iconOnly
              icon={<span aria-hidden="true">−</span>}
              disabled={viewport.ticksPerPixel >= MAX_TICKS_PER_PIXEL}
              onClick={() => zoom(ZOOM_BUTTON_STEP)}
              data-testid="grid-zoom-out"
            />
            <Button
              label="Zoom in"
              iconOnly
              icon={<span aria-hidden="true">+</span>}
              disabled={viewport.ticksPerPixel <= MIN_TICKS_PER_PIXEL}
              onClick={() => zoom(1 / ZOOM_BUTTON_STEP)}
              data-testid="grid-zoom-in"
            />
            <Button
              label="Reset zoom"
              variant="quiet"
              disabled={viewport.ticksPerPixel === DEFAULT_TICKS_PER_PIXEL}
              onClick={() =>
                setViewport((current) => ({ ...current, ticksPerPixel: DEFAULT_TICKS_PER_PIXEL }))
              }
              data-testid="grid-zoom-reset"
            />
          </div>
        </div>
      </Panel>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 xl:grid-cols-[3fr_1fr]">
        <Panel title="Note editor" fill>
          {trackId === null ? (
            <EmptyState
              message="No track is selected."
              hint="Add one to the active sequence in Main's Tracks panel."
              data-testid="grid-no-track"
            />
          ) : (
            <GridCanvas
              events={events}
              viewport={viewport}
              tool={tool}
              snapTicks={snapTicks}
              defaultDurationTicks={DEFAULT_DRAW_DURATION}
              rowLabel={rowLabel}
              automation={selectedLane}
              selectedIds={selectedIds}
              onSelect={setSelectedIds}
              onSelectPoints={setSelectedPointIds}
              onAutomationDraw={handleAutomationDraw}
              onAutomationMove={handleAutomationMove}
              onAutomationErase={handleAutomationErase}
              onDraw={handleDraw}
              onErase={handleErase}
              onGestureEnd={endUndoGesture}
              // A drag the second finger turned into a pan rolls back through the normal
              // undo history, so the aborted edit leaves nothing behind (issue #43).
              onGestureCancel={() => useUndoStore.getState().undo()}
              onMove={handleMove}
              onResize={handleResize}
              onSetVelocity={handleVelocity}
              onScroll={scroll}
              onZoom={zoom}
            />
          )}
        </Panel>

        <div className="flex min-h-0 flex-col gap-3">
          {/* Keyboard/screen-reader path to the same edits the canvas performs (spec §8.2). */}
          <Panel title="Notes" scroll fill>
            {events.length === 0 ? (
              <EmptyState message="No notes on this track yet." hint="Draw one on the grid above." />
            ) : (
              <ul className="flex flex-col gap-1">
                {[...events]
                  .sort((a, b) => a.tickStart - b.tickStart)
                  .map((event) => (
                    <li key={event.id} className="flex items-center gap-2 text-xs">
                      <button
                        type="button"
                        // Selecting a note picks one of the list, so `aria-current`, not the
                        // `aria-pressed` of a toggle this used to carry (see ModeRail).
                        aria-current={selectedIds.includes(event.id)}
                        onClick={() => setSelectedIds([event.id])}
                        className={`flex-1 truncate rounded-bb-sm border px-2 py-1 text-left transition-colors duration-150 ${
                          selectedIds.includes(event.id)
                            ? 'border-bb-accent text-bb-text'
                            : 'border-bb-line text-bb-muted hover:text-bb-text'
                        }`}
                      >
                        {rowLabel(event.note)} · tick {event.tickStart} · vel {event.velocity}
                      </button>
                      <Button
                        label={`Delete note ${rowLabel(event.note)} at tick ${event.tickStart}`}
                        variant="danger"
                        size="sm"
                        iconOnly
                        icon={<IconRemove size={14} aria-hidden="true" />}
                        onClick={() => handleErase(event.id)}
                      />
                    </li>
                  ))}
              </ul>
            )}
          </Panel>

          {/* The lane's own keyboard path (spec §8.2): the canvas is aria-hidden, so every
            point it can draw, move or delete is also reachable here. */}
          {selectedLane !== null && (
            <Panel
              title="Automation"
              scroll
              fill
              actions={
                <div className="flex items-center gap-2">
                  <Button
                    label="Add point"
                    size="sm"
                    disabled={!selectedLane.editable}
                    onClick={handleAddPoint}
                    data-testid="grid-automation-add"
                  />
                  <Button
                    label="Delete selected points"
                    size="sm"
                    variant="danger"
                    disabled={!selectedLane.editable || selectedPointIds.length === 0}
                    onClick={() => handleAutomationErase(selectedPointIds)}
                    data-testid="grid-automation-delete"
                  />
                </div>
              }
            >
              {selectedLane.points.length === 0 ? (
                <EmptyState
                  message="This lane has no points yet."
                  hint="Draw on the lane under the velocity strip, or press Add point."
                  data-testid="grid-automation-empty"
                />
              ) : (
                <ul className="flex flex-col gap-1">
                  {[...selectedLane.points]
                    .sort((a, b) => a.tick - b.tick)
                    .map((point) => (
                      <li key={point.id} className="flex items-center gap-2 text-xs">
                        <button
                          type="button"
                          aria-current={selectedPointIds.includes(point.id)}
                          onClick={() => setSelectedPointIds([point.id])}
                          className={`flex-1 truncate rounded-bb-sm border px-2 py-1 text-left transition-colors duration-150 ${
                            selectedPointIds.includes(point.id)
                              ? 'border-bb-accent text-bb-text'
                              : 'border-bb-line text-bb-muted hover:text-bb-text'
                          }`}
                        >
                          tick {point.tick} · {displayValue(point.value)} · {point.curve}
                        </button>
                        <input
                          type="number"
                          aria-label={`Value at tick ${point.tick}`}
                          value={point.value}
                          min={selectedLane.bounds.min}
                          max={selectedLane.bounds.max}
                          step="any"
                          disabled={!selectedLane.editable}
                          onChange={(event) =>
                            handleAutomationMove(point.id, point.tick, Number(event.target.value))
                          }
                          className="w-20 rounded-bb-sm border border-bb-line bg-bb-raised px-1 py-1 text-bb-micro text-bb-text disabled:opacity-40"
                        />
                        <Button
                          label={`Delete point at tick ${point.tick}`}
                          variant="danger"
                          size="sm"
                          iconOnly
                          disabled={!selectedLane.editable}
                          icon={<IconRemove size={14} aria-hidden="true" />}
                          onClick={() => handleAutomationErase([point.id])}
                        />
                      </li>
                    ))}
                </ul>
              )}
            </Panel>
          )}
        </div>
      </div>

      <Modal
        open={quantiseOpen}
        title="Quantise"
        onClose={() => setQuantiseOpen(false)}
        data-testid="grid-quantise-dialog"
        footer={
          <>
            <Button label="Cancel" variant="quiet" onClick={() => setQuantiseOpen(false)} />
            <Button
              label="Apply"
              variant="accent"
              onClick={applyQuantise}
              data-testid="grid-quantise-apply"
            />
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <span className="flex items-center justify-between gap-3 text-xs text-bb-muted">
            Division
            <SegmentControl
              label="Quantise division"
              value={quantiseDivision}
              options={QUANTISE_DIVISIONS.map((division) => ({
                value: division,
                label: `1/${division}`,
              }))}
              size="sm"
              onChange={setQuantiseDivision}
            />
          </span>
          <Toggle label="Triplet" pressed={quantiseTriplet} onChange={setQuantiseTriplet} size="sm" />
          <label className="flex flex-col gap-1 text-xs text-bb-muted">
            <span>Strength: {quantiseStrength}%</span>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={quantiseStrength}
              onChange={(event) => setQuantiseStrength(Number(event.target.value))}
              aria-label="Quantise strength"
              className="accent-bb-accent"
            />
          </label>
          <p className="text-xs text-bb-muted">
            {selectedIds.length > 0
              ? `Quantising ${selectedIds.length} selected note${selectedIds.length === 1 ? '' : 's'}.`
              : `Quantising all ${events.length} notes on this track.`}{' '}
            Grid step: {gridTicks({ division: quantiseDivision, triplet: quantiseTriplet })} ticks.
          </p>
        </div>
      </Modal>
    </div>
  );
}
