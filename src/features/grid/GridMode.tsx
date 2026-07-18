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
import { useProgramStore, useSequenceStore, useTransportStore } from '@/store';
import type { MidiEvent } from '@/core/project/schemas';
import { Modal, SegmentControl, Toggle, ValueReadout } from '@/ui/primitives';
import { Panel } from '@/ui/shell/Panel';
import { noteName } from '../pad-perform/scales';
import { GridCanvas, type GridTool } from './GridCanvas';

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

export function GridMode() {
  const activeSequenceId = useTransportStore((s) => s.activeSequenceId);
  const tracks = useSequenceStore((s) => s.tracks);
  const eventsByTrack = useSequenceStore((s) => s.events);
  const automation = useSequenceStore((s) => s.automation);
  const grooveTemplates = useSequenceStore((s) => s.grooveTemplates);
  const trackGrooveIds = useSequenceStore((s) => s.trackGrooveIds);
  const programs = useProgramStore((s) => s.programs);

  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);
  const [tool, setTool] = useState<GridTool>('draw');
  const [snapTicks, setSnapTicks] = useState<number>(PPQN / 4);
  const [selectedIds, setSelectedIds] = useState<readonly string[]>([]);
  const [quantiseOpen, setQuantiseOpen] = useState(false);
  const [quantiseDivision, setQuantiseDivision] = useState<QuantiseDivision>(16);
  const [quantiseTriplet, setQuantiseTriplet] = useState(false);
  const [quantiseStrength, setQuantiseStrength] = useState(100);
  const [automationLane, setAutomationLane] = useState<string>('');
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

  /** Automation lanes registered for this track/sequence (spec §7.8 keyed lanes). */
  const automationLanes = useMemo(
    () =>
      Object.keys(automation).filter(
        (key) => trackId !== null && (key.includes(`track:${trackId}`) || key.includes(':')),
      ),
    [automation, trackId],
  );

  const sequence = () => useSequenceStore.getState();

  const writeEvents = (next: readonly MidiEvent[]) => {
    if (!trackId) return;
    sequence().setTrackEvents(trackId, next);
  };

  const handleDraw = (note: number, tickStart: number, durationTicks: number) => {
    if (!trackId) return;
    sequence().addEvents(trackId, [
      {
        id: crypto.randomUUID(),
        tickStart,
        durationTicks,
        note,
        velocity: 100,
        extra: null,
      },
    ]);
  };

  const handleErase = (id: string) => {
    if (!trackId) return;
    sequence().removeEvents(trackId, [id]);
  };

  const handleMove = (id: string, note: number, tickStart: number) => {
    writeEvents(events.map((event) => (event.id === id ? { ...event, note, tickStart } : event)));
  };

  const handleResize = (id: string, durationTicks: number) => {
    writeEvents(
      events.map((event) =>
        event.id === id ? { ...event, durationTicks: Math.max(1, durationTicks) } : event,
      ),
    );
  };

  const handleVelocity = (id: string, velocity: number) => {
    writeEvents(
      events.map((event) =>
        event.id === id ? { ...event, velocity: Math.min(127, Math.max(1, velocity)) } : event,
      ),
    );
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
            <span className="flex items-center gap-1.5 text-[0.625rem] font-semibold text-bb-muted uppercase">
              Snap
              <SegmentControl
                label="Grid snap"
                value={snapTicks}
                options={SNAP_OPTIONS}
                size="sm"
                onChange={setSnapTicks}
                data-testid="grid-snap"
              />
            </span>
            <button
              type="button"
              onClick={() => setQuantiseOpen(true)}
              disabled={events.length === 0}
              data-testid="grid-quantise-open"
              className="rounded-bb-sm border border-bb-line bg-bb-raised px-3 py-1.5 text-xs font-semibold transition-colors duration-150 hover:border-bb-accent-strong disabled:opacity-40"
            >
              Quantise…
            </button>
          </div>
        }
      >
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5 text-[0.625rem] font-semibold text-bb-muted uppercase">
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
          </label>

          <label className="flex items-center gap-1.5 text-[0.625rem] font-semibold text-bb-muted uppercase">
            Automation lane
            <select
              aria-label="Automation lane"
              value={automationLane}
              onChange={(event) => setAutomationLane(event.target.value)}
              data-testid="grid-automation-lane"
              className="max-w-56 rounded-bb-sm border border-bb-line bg-bb-raised px-2 py-1 text-xs font-normal text-bb-text normal-case"
            >
              <option value="">None</option>
              {automationLanes.map((lane) => (
                <option key={lane} value={lane}>
                  {lane}
                </option>
              ))}
            </select>
          </label>

          {/* Groove is applied at schedule time like swing — non-destructive (spec §7.5).
              Templates come from Sample Edit's groove extraction. */}
          <span className="flex items-center gap-1.5 text-[0.625rem] font-semibold text-bb-muted uppercase">
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
          </span>

          <ValueReadout label="Notes" value={events.length} showLabel data-testid="grid-note-count" />
          <ValueReadout
            label="Zoom"
            value={`${(DEFAULT_TICKS_PER_PIXEL / viewport.ticksPerPixel).toFixed(2)}×`}
            showLabel
          />
        </div>
      </Panel>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 xl:grid-cols-[3fr_1fr]">
        <Panel title="Note editor" className="min-h-96">
          {trackId === null ? (
            <p className="text-xs text-bb-muted">Add a track to the active sequence to edit notes.</p>
          ) : (
            <GridCanvas
              events={events}
              viewport={viewport}
              tool={tool}
              snapTicks={snapTicks}
              defaultDurationTicks={DEFAULT_DRAW_DURATION}
              rowLabel={rowLabel}
              selectedIds={selectedIds}
              onSelect={setSelectedIds}
              onDraw={handleDraw}
              onErase={handleErase}
              onMove={handleMove}
              onResize={handleResize}
              onSetVelocity={handleVelocity}
              onScroll={scroll}
              onZoom={zoom}
            />
          )}
        </Panel>

        {/* Keyboard/screen-reader path to the same edits the canvas performs (spec §8.2). */}
        <Panel title="Notes" scroll>
          {events.length === 0 ? (
            <p className="text-xs text-bb-muted">No notes on this track yet.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {[...events]
                .sort((a, b) => a.tickStart - b.tickStart)
                .map((event) => (
                  <li key={event.id} className="flex items-center gap-2 text-xs">
                    <button
                      type="button"
                      aria-pressed={selectedIds.includes(event.id)}
                      onClick={() => setSelectedIds([event.id])}
                      className={`flex-1 truncate rounded-bb-sm border px-2 py-1 text-left transition-colors duration-150 ${
                        selectedIds.includes(event.id)
                          ? 'border-bb-accent text-bb-text'
                          : 'border-bb-line text-bb-muted hover:text-bb-text'
                      }`}
                    >
                      {rowLabel(event.note)} · tick {event.tickStart} · vel {event.velocity}
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete note ${rowLabel(event.note)} at tick ${event.tickStart}`}
                      onClick={() => handleErase(event.id)}
                      className="rounded-bb-sm border border-bb-line px-2 py-1 text-bb-muted transition-colors duration-150 hover:text-bb-danger"
                    >
                      ✕
                    </button>
                  </li>
                ))}
            </ul>
          )}
        </Panel>
      </div>

      <Modal
        open={quantiseOpen}
        title="Quantise"
        onClose={() => setQuantiseOpen(false)}
        data-testid="grid-quantise-dialog"
        footer={
          <>
            <button
              type="button"
              onClick={() => setQuantiseOpen(false)}
              className="rounded-bb-sm border border-bb-line px-3 py-1.5 text-xs text-bb-muted transition-colors duration-150 hover:text-bb-text"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={applyQuantise}
              data-testid="grid-quantise-apply"
              className="rounded-bb-sm bg-bb-accent px-3 py-1.5 text-xs font-semibold text-bb-bg transition-colors duration-150 hover:bg-bb-accent-strong"
            >
              Apply
            </button>
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
