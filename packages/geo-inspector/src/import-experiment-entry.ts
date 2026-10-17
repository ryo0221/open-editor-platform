/** Provisional trusted-Host integration only; not a stable/shared extension contract.
 * No source-backed persistence, source-free editing bypass or resource permission. */
export { createImportWorkbench } from './import-workbench/surface';
export type { ImportWorkbenchHost, StagedImportSource } from './import-workbench/surface';
export { createFeatureTable } from './feature-table';
export { createPointMap, preparePointScene } from './point-map';
