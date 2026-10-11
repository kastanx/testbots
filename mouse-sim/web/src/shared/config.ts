// The same JSON files the Python side reads, so recorder, pipeline and harness agree.
import cellsJson from '../../../config/cells.json';
import recorderJson from '../../../config/recorder.json';
import pipelineJson from '../../../config/pipeline.json';
import mmJson from '../../../config/motion_matching.json';
import harnessJson from '../../../config/harness.json';

export const cells = cellsJson;
export const recorderConfig = recorderJson;
export const pipelineConfig = pipelineJson;
export const motionMatchingConfig = mmJson;
export const harnessConfig = harnessJson;

export type RecorderConfig = typeof recorderJson;
export type MotionMatchingConfig = typeof mmJson;
