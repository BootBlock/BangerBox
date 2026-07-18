/**
 * Sample Edit mode barrel (spec §2.5, §8.5.4). The panel is mounted by the mode registry
 * as `SampleEditMode`; the shell supplies the heading and layout (spec §8.1).
 */
export { SampleEditPanel, SampleEditPanel as SampleEditMode } from './SampleEditPanel';
export { refreshSamples, sampleEditContext } from './sampleContext';
