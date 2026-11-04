/**
 * The automatic-weights Worker host and its messages, for code that runs the product's weights
 * job outside the Surface (the C5 measurement harness in `experiments/character-perf/`).
 */
export { WeightJobs } from './weights-job';
export type { WeightsRequest, WeightsResponse } from './weights-protocol';
export { meshBuffers } from './subdivision-protocol';
