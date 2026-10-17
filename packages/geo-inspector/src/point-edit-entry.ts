/** Provisional editing subpath; the accepted readonly entry remains unchanged. */
export {
  geoPointEditorDefinition,
  pointEditPort,
  type PointControllerFactory,
} from './point-edit/definition';
export { draftFor, type PointDraft, type PointTarget } from './point-edit/model';

export { createGeoPointEditorSurface } from './point-edit/surface';
export type { GeoPointEditProfile } from './point-edit/profile';
