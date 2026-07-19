/**
 * Mode registry — the single table describing the 12 application modes (spec §8.5). The
 * rail renders from it, the content area mounts from it, and `useUIStore.activeMode`
 * selects between them; there is no router (spec §1.3 #9).
 *
 * Order comes from `MODES` in `useUIStore`, which is the §8.5 order — the rail cannot
 * drift out of step with it, and `Record<Mode, …>` makes omitting a mode a type error.
 * Ids match the `src/features/*` directory names (spec §2.5).
 */
import type { ComponentType } from 'react';
import { MODES, type Mode } from '@/store';
import type { LucideIcon } from '@/ui/icons';
import {
  IconBrowser,
  IconGrid,
  IconLooper,
  IconMain,
  IconMixer,
  IconMute,
  IconPadPerform,
  IconProgramEdit,
  IconQLink,
  IconSampleEdit,
  IconSong,
  IconXyfx,
} from '@/ui/icons';
import { MainMode } from './main';
import { GridMode } from './grid';
import { MutingMode } from './muting';
import { SampleEditMode } from './sample-edit';
import { ProgramEditMode } from './program-edit';
import { MixerMode } from './mixer';
import { BrowserMode } from './browser';
import { LooperMode } from './looper';
import { PadPerformMode } from './pad-perform';
import { XyfxMode } from './xyfx';
import { QLinkEditMode } from './qlink-edit';
import { SongMode } from './song';

export interface ModeDefinition {
  readonly id: Mode;
  /** Rail label — kept short so the touch target stays legible (spec §8.1). */
  readonly label: string;
  /** Full name for the panel heading and the accessible mode announcement. */
  readonly title: string;
  readonly icon: LucideIcon;
  readonly Component: ComponentType;
}

/** Everything about a mode except its id, which the `MODES` key supplies. */
const MODE_TABLE: Readonly<Record<Mode, Omit<ModeDefinition, 'id'>>> = {
  main: { label: 'Main', title: 'Main', icon: IconMain, Component: MainMode },
  grid: { label: 'Grid', title: 'Grid / Piano Roll', icon: IconGrid, Component: GridMode },
  muting: { label: 'Mute', title: 'Track & Pad Mute', icon: IconMute, Component: MutingMode },
  'sample-edit': {
    label: 'Sample',
    title: 'Sample Edit',
    icon: IconSampleEdit,
    Component: SampleEditMode,
  },
  'program-edit': {
    label: 'Program',
    title: 'Program Edit',
    icon: IconProgramEdit,
    Component: ProgramEditMode,
  },
  mixer: { label: 'Mixer', title: 'Mixer', icon: IconMixer, Component: MixerMode },
  browser: { label: 'Browser', title: 'Browser', icon: IconBrowser, Component: BrowserMode },
  looper: { label: 'Looper', title: 'Looper', icon: IconLooper, Component: LooperMode },
  'pad-perform': {
    label: 'Perform',
    title: 'Pad Perform',
    icon: IconPadPerform,
    Component: PadPerformMode,
  },
  xyfx: { label: 'XYFX', title: 'XYFX', icon: IconXyfx, Component: XyfxMode },
  'qlink-edit': { label: 'Q-Link', title: 'Q-Link Edit', icon: IconQLink, Component: QLinkEditMode },
  song: { label: 'Song', title: 'Song', icon: IconSong, Component: SongMode },
};

export const MODE_DEFINITIONS: readonly ModeDefinition[] = MODES.map((id) => ({
  id,
  ...MODE_TABLE[id],
}));

/** Look up a mode definition; falls back to Main so an unknown id can never blank the UI. */
export function modeDefinition(id: Mode): ModeDefinition {
  return MODE_DEFINITIONS.find((mode) => mode.id === id) ?? MODE_DEFINITIONS[0]!;
}
