/** Provisional trusted-Host integration only; not a stable/shared extension contract.
 * No source-backed persistence, source-free editing bypass or resource permission. */
export { createImportWorkbench } from './import-workbench/surface';
export type { ImportWorkbenchHost, StagedImportSource } from './import-workbench/surface';
export { createFeatureTable } from './feature-table';
export { createPointMap, preparePointScene } from './point-map';
export { createGeoDataExportWorkbench } from './data-export/surface';
export type { GeoDataExportHost } from './data-export/surface';
export { createGeoWorkspaceSurface } from './workspace/surface';
export type { GeoWorkspaceHost } from './workspace/port';
export { createGeoPng } from './workspace/png';
export type { GeoPngBundle } from './workspace/png';
export { inspectGeoPhoto } from './workspace/photo';
