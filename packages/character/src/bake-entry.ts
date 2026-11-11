/**
 * The normal-map bake's Worker host and its messages, for code that runs the product's bake job
 * outside the Surface (the C7 measurement harness in `experiments/character-perf/`).
 */
export { BakeJobs, type BakeRun } from './bake-job';
export { runBake } from './bake-protocol';
export type { BakeDone, BakeRequest, BakeResponse } from './bake-protocol';
