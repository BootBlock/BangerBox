/**
 * Primitive barrel — the bespoke control set (spec §2.5, §8). Features import controls
 * from here, never from a component library (spec §1.3 #10) and never by re-styling a
 * primitive at the call site (spec §3.6).
 */
export { Button, type ButtonProps, type ButtonVariant, type ButtonSize } from './Button';
export { FieldLabel, type FieldLabelProps } from './FieldLabel';
export { Pad, type PadProps } from './Pad';
export { Knob, type KnobProps } from './Knob';
export { Fader, type FaderProps } from './Fader';
export { XYSurface, type XYSurfaceProps, type XYAxis } from './XYSurface';
export { MeterCanvas } from './MeterCanvas';
export { WaveformCanvas } from './WaveformCanvas';
export { WaveformEditor, type WaveformEditorProps } from './WaveformEditor';
export { Toggle, type ToggleProps, type ToggleTone } from './Toggle';
export { SegmentControl, type SegmentControlProps, type SegmentOption } from './SegmentControl';
export { ValueReadout, type ValueReadoutProps } from './ValueReadout';
export { Modal, type ModalProps } from './Modal';
export { Toast, type ToastProps } from './Toast';
export { LiveRegion, announce } from './LiveRegion';
export {
  formatValueText,
  normalisedToValue,
  quantiseToStep,
  stepValue,
  valueToNormalised,
  type ControlCurve,
  type ControlRange,
} from './controlMaths';
export { useContinuousControl, type ContinuousControlOptions } from './useContinuousControl';
