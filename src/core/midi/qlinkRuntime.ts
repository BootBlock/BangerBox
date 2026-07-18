/**
 * Q-Link runtime — spec §10.3's execution flow:
 *
 *   CC in → look up the binding for the current mode → scale into [min,max] per curve →
 *   dispatch to the target store action (transient during the turn, commit on idle) →
 *   sync layer updates the node → UI reacts concurrently.
 *
 * The dispatch deliberately keys off the *parsed registry address* rather than the
 * binding's `targetStore` field: the address is authoritative and the two can never
 * disagree with each other (spec §7.8 "only registered parameters"). Nothing here touches
 * the audio graph — spec §10.2 forbids the MIDI listener doing so, and the sync layer
 * already carries every one of these store changes to the nodes (spec §4.3).
 */
import {
  parseParamTarget,
  targetRange,
  type ParamTarget,
} from '@/core/audio/params/registry';
import type { QLinkBinding } from '@/core/project/schemas';
import {
  useHardwareStore,
  useMixerStore,
  useProgramStore,
  useTransportStore,
  useUIStore,
} from '@/store';
import { bindingForCc, defaultBindingsForMode, DEFAULT_QLINK_CC_BASE, nextValueForCc } from './qlink';

/**
 * Idle gap after which a turning encoder's value is committed as one undo entry
 * (spec §10.3 "transient during turn, commit on 250 ms idle").
 */
export const QLINK_COMMIT_IDLE_MS = 250;

export interface QLinkRuntime {
  /** Route one incoming Control Change through the active mode's bindings (spec §10.3). */
  handleControlChange: (cc: number, value: number) => void;
  /** The bindings in force right now — what the Q-Link Edit table displays (spec §8.5.11). */
  effectiveBindings: () => QLinkBinding[];
  /** Cancel any pending idle commits (disconnect / unmount — spec §3.5 lens 5). */
  dispose: () => void;
}

/** Read the value a registered address currently holds, for relative-encoder stepping. */
function readCurrentValue(target: ParamTarget): number | null {
  switch (target.kind) {
    case 'channelLevel':
      return useMixerStore.getState().channels[target.channelId]?.level ?? null;
    case 'channelPan':
      return useMixerStore.getState().channels[target.channelId]?.pan ?? null;
    case 'channelSend':
      return useMixerStore.getState().channels[target.channelId]?.sendLevels[target.sendIndex] ?? null;
    case 'insertParam': {
      const slot = useMixerStore.getState().channels[target.channelId]?.inserts[target.slot - 1];
      return slot?.params[target.param] ?? null;
    }
    case 'programParam': {
      const program = useProgramStore.getState().programs[target.programId];
      if (program?.type !== 'drum') return null;
      const pad = program.pads.find((candidate) => candidate.padIndex === target.padIndex);
      if (!pad) return null;
      switch (target.param) {
        case 'filter.cutoff':
          return pad.filter.cutoff;
        case 'filter.resonance':
          return pad.filter.resonance;
        case 'pitch':
          return pad.layers[0]?.tuneSemitones ?? 0;
        case 'amp':
          return pad.mixer.level;
        case 'pan':
          return pad.mixer.pan;
        case 'amp.attack':
          return pad.envelopes.amp.attack;
        case 'amp.release':
          return pad.envelopes.amp.release;
        default:
          return null;
      }
    }
    case 'transportParam':
      return target.param === 'swing'
        ? useTransportStore.getState().swingAmount
        : useTransportStore.getState().bpm;
  }
}

/** Dispatch a value to the store that owns the address (spec §10.3, §4.2 ownership). */
function dispatch(target: ParamTarget, path: string, value: number, commit: boolean): void {
  switch (target.kind) {
    case 'channelLevel':
    case 'channelPan':
    case 'channelSend':
    case 'insertParam': {
      const mixer = useMixerStore.getState();
      if (commit) mixer.commit(path, value);
      else mixer.setTransient(path, value);
      return;
    }
    case 'programParam': {
      const programs = useProgramStore.getState();
      if (commit) programs.commitPadParam(path, value);
      else programs.setPadParamTransient(path, value);
      return;
    }
    case 'transportParam': {
      // Transport values are not undoable (spec §4.5 "not undoable: transport actions"),
      // so both phases of the gesture are the same single setter.
      const transport = useTransportStore.getState();
      if (target.param === 'swing') transport.setSwing(value);
      else transport.setBpm(value);
      return;
    }
  }
}

/**
 * Screen-mode bindings, derived from whichever panel currently holds focus (spec §10.3).
 * Panels publish their parameters through `useQLinkFocus`, and they map onto the encoders
 * in the order the panel lists them.
 */
function screenBindings(): QLinkBinding[] {
  const params = useUIStore.getState().focusedControlParams;
  const bindings: QLinkBinding[] = [];
  params.forEach((param) => {
    const target = parseParamTarget(param.targetParameterPath);
    const range = target ? targetRange(target) : null;
    if (!target || !range) return;
    bindings.push({
      encoderIndex: bindings.length,
      cc: DEFAULT_QLINK_CC_BASE + bindings.length,
      targetStore: target.kind === 'programParam' ? 'program' : 'mixer',
      targetParameterPath: param.targetParameterPath,
      minValue: range[0],
      maxValue: range[1],
      curve: 'linear',
      mode: 'absolute',
    });
  });
  return bindings;
}

export function createQLinkRuntime(): QLinkRuntime {
  /** Pending idle-commit timers, keyed by parameter path (spec §10.3). */
  const commitTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const effectiveBindings = (): QLinkBinding[] => {
    const { qLinkMode, qLinkBindings } = useHardwareStore.getState();
    // Bindings the user has actually made always win over a mode's defaults (spec §10.3).
    if (qLinkBindings.length > 0) return [...qLinkBindings];
    if (qLinkMode === 'screen') return screenBindings();
    return defaultBindingsForMode(qLinkMode, {
      programId: useProgramStore.getState().activeProgramId,
      padIndex: useProgramStore.getState().activePadId,
    });
  };

  return {
    effectiveBindings,

    handleControlChange: (cc, value) => {
      const binding = bindingForCc(effectiveBindings(), cc);
      if (!binding) return;
      const path = binding.targetParameterPath;
      const target = parseParamTarget(path);
      if (!target) return; // unregistered address — never dispatched (spec §7.8 gate)

      const current = readCurrentValue(target);
      const next = nextValueForCc(current ?? binding.minValue, value, binding);
      dispatch(target, path, next, false);

      // Restart the idle window; the encoder settling is what ends the gesture and
      // records the single undo entry (spec §10.3, §3.3 gesture coalescing).
      const existing = commitTimers.get(path);
      if (existing !== undefined) clearTimeout(existing);
      commitTimers.set(
        path,
        setTimeout(() => {
          commitTimers.delete(path);
          dispatch(target, path, next, true);
        }, QLINK_COMMIT_IDLE_MS),
      );
    },

    dispose: () => {
      for (const timer of commitTimers.values()) clearTimeout(timer);
      commitTimers.clear();
    },
  };
}
