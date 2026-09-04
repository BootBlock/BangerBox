/**
 * Song mode marks the §7.9 entry that is playing (issue #130).
 *
 * `songAdvanced { entryIndex }` had no production consumer, so nothing indexed the playlist
 * and nothing could be wrong about it. It has one now, and §7.9 states the rule the consumer
 * must keep: the index is into the POSITION-SORTED entry list, an entry consumes exactly one
 * index however many times it repeats, and an entry skipped for a missing sequence still
 * consumes one. These pin the consumer's half of that contract; the worker's half is pinned
 * by `core/sequencer/songEntryIndex.test.ts`.
 */
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/core/audio/bounceService', () => ({ bounceSong: vi.fn() }));
vi.mock('@/core/storage/opfs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/storage/opfs')>();
  return { ...actual, readFile: vi.fn() };
});
vi.mock('../sample-edit/sampleContext', () => ({ sampleEditContext: () => ({}) }));

const { SongMode } = await import('./SongMode');
const { useSequenceStore, useTransportStore } = await import('@/store');
const { createDefaultSequence } = await import('@/core/project/schemas');

const ALPHA = createDefaultSequence('proj', 0, 'Alpha', 'A');
const BETA = createDefaultSequence('proj', 1, 'Beta', 'B');

beforeEach(() => {
  useSequenceStore.getState().hydrate({
    sequences: { A: ALPHA, B: BETA },
    tracks: {},
    events: {},
    automation: {},
    // Written out of `position` order deliberately: §7.9 orders by the field, not the array.
    songEntries: [
      { id: 'e2', position: 1, sequenceId: 'B', repeats: 1 },
      { id: 'e1', position: 0, sequenceId: 'A', repeats: 2 },
    ],
  });
  useTransportStore.setState({ playbackMode: 'song', songEntryIndex: null, isPlaying: false });
});

/** A report only lands while the song is rolling, so a fixture presses play first. */
function reportEntry(index: number): void {
  useTransportStore.getState().play();
  useTransportStore.getState().setSongEntryIndex(index);
}

/** The row the playlist marks as playing, or null when none is marked. */
function playingRow(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-playing="true"]');
}

describe('SongMode playlist (spec §7.9, issue #130)', () => {
  it('renders the playlist in position order, not array order', () => {
    render(<SongMode />);
    expect(screen.getByTestId('song-entry-0')).toHaveTextContent('Alpha');
    expect(screen.getByTestId('song-entry-1')).toHaveTextContent('Beta');
  });

  it('marks nothing while the song is not rolling', () => {
    render(<SongMode />);
    expect(playingRow()).toBeNull();
  });

  it('marks the entry the worker reported, in the same sorted projection', () => {
    reportEntry(1);
    render(<SongMode />);
    // Entry index 1 is Beta by position. Indexing the raw array instead would mark Alpha,
    // which is exactly the projection mismatch §7.9 forbids.
    expect(playingRow()).toBe(screen.getByTestId('song-entry-1'));
    expect(playingRow()).toHaveTextContent('Beta');
    expect(playingRow()).toHaveAttribute('aria-current', 'true');
  });

  it('holds the mark across an entry’s repeats rather than stepping off it', () => {
    // Alpha repeats twice and so consumes ONE index. The worker reports 0 once and the row
    // stays marked for both plays; a repeat-expanded index would have moved to Beta.
    reportEntry(0);
    render(<SongMode />);
    expect(playingRow()).toHaveTextContent('Alpha');
    expect(screen.getByTestId('song-entry-1')).not.toHaveAttribute('data-playing');
  });

  it('clears the mark when the transport stops', () => {
    reportEntry(0);
    useTransportStore.getState().stop();
    render(<SongMode />);
    expect(playingRow()).toBeNull();
  });

  it('clears the mark when playback leaves song mode', () => {
    reportEntry(0);
    useTransportStore.getState().setPlaybackMode('sequence');
    render(<SongMode />);
    expect(playingRow()).toBeNull();
  });

  /**
   * The worker learns about a stop on its next wake (spec §7.1.4), so a `songAdvanced`
   * already in flight lands after `stop()` has cleared the readout. Nothing arrives after it
   * to correct the mistake, so the row would stay lit on a stopped transport for good.
   */
  it('ignores a report that arrives after the transport stopped', () => {
    reportEntry(0);
    useTransportStore.getState().stop();
    useTransportStore.getState().setSongEntryIndex(1);
    render(<SongMode />);
    expect(playingRow()).toBeNull();
  });
});
