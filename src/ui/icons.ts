/**
 * Icon registry — spec §1.3 #10: `lucide-react` is the only icon source, and it is
 * re-exported *exclusively* through this module so no feature imports the package
 * directly. That keeps the icon surface auditable (and the tree-shake narrow): adding an
 * icon to the app means adding a line here.
 *
 * Names are re-exported under BangerBox-facing aliases where the lucide name is opaque,
 * so call sites read as the domain concept rather than the glyph.
 */
export {
  // Transport (spec §8.1)
  Play as IconPlay,
  Square as IconStop,
  Circle as IconRecord,
  Repeat as IconLoop,
  Timer as IconMetronome,
  Undo2 as IconUndo,
  Redo2 as IconRedo,
  Save as IconSave,
  // Mode rail (spec §8.5 — one per mode, in mode order)
  LayoutDashboard as IconMain,
  Grid3x3 as IconGrid,
  VolumeX as IconMute,
  AudioWaveform as IconSampleEdit,
  SlidersHorizontal as IconProgramEdit,
  SlidersVertical as IconMixer,
  FolderOpen as IconBrowser,
  Disc3 as IconLooper,
  Piano as IconPadPerform,
  Move as IconXyfx,
  CircleDot as IconQLink,
  ListMusic as IconSong,
  // General controls
  Plus as IconAdd,
  Trash2 as IconRemove,
  X as IconClose,
  ChevronDown as IconChevronDown,
  ChevronUp as IconChevronUp,
  Power as IconPower,
  TriangleAlert as IconWarning,
  Gauge as IconPerf,
  Maximize as IconFullscreenEnter,
  Minimize as IconFullscreenExit,
} from 'lucide-react';

export type { LucideIcon } from 'lucide-react';
