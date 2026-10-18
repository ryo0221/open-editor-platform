/** M0 experiment: not a stable public or persisted compatibility contract. */
export type Scalar = string | number | boolean | null;
export type Position = [number, number];
export type Geometry =
  | { type: 'Point'; coordinates: Position }
  | { type: 'LineString' | 'MultiPoint'; coordinates: Position[] }
  | { type: 'Polygon' | 'MultiLineString'; coordinates: Position[][] }
  | { type: 'MultiPolygon'; coordinates: Position[][][] };
export interface Pin {
  artifactId: string;
  versionId: string;
  contentHash: string;
}
export interface SourceSnapshot {
  id: string;
  pin: Pin;
  resourceId: string;
  bytesHash: string;
  format: 'geojson' | 'csv' | 'png' | 'jpeg';
  adapterVersion: string;
  declaredCrs: 'OGC:CRS84';
  axis: 'longitude-latitude';
  attribution: string;
}
export interface Field {
  id: string;
  name: string;
  type: 'string' | 'number' | 'boolean';
}
export interface Feature {
  id: string;
  rowId: string;
  geometry: Geometry | null;
  values: Record<string, Scalar>;
  sourceRef?: { sourceId: string; externalId: string | number | null };
}
export interface VectorLayer {
  id: string;
  name: string;
  crs: 'OGC:CRS84';
  axis: 'longitude-latitude';
  fields: Field[];
  features: Feature[];
}
export interface GeoDocument {
  schemaVersion: 1;
  layers: VectorLayer[];
  sources: SourceSnapshot[];
  workspace?: import('./workspace-model').GeoWorkspace;
}
export interface Diagnostic {
  code: string;
  path: string;
  severity: 'error' | 'warning';
}
/** Limits supplied explicitly; deployment values require review, not performance claims. */
export interface Budgets {
  /** Host-supplied cap for one atomic command batch; provisional M0 contract. */
  actions: number;
  bytes: number;
  depth: number;
  layers: number;
  features: number;
  vertices: number;
}
export interface ReadonlyKeyJoin {
  readonly left: Pin;
  readonly right: Pin;
  readonly leftFieldId: string;
  readonly rightFieldId: string;
  readonly keyType: 'string' | 'number';
  readonly cardinality: 'one-to-one' | 'many-to-one';
  readonly normalization: 'none';
  readonly nullPolicy: 'unmatched';
  readonly duplicatePolicy: 'reject';
  readonly resultAccess: 'readonly';
}
export interface OutputReceipt {
  input: Pin;
  derivedInputs?: Pin[];
  sources: SourceSnapshot[];
  namedViewId: string;
  rendererVersion: string;
  transformerVersion: string;
  styleHash: string;
  extent: [number, number, number, number];
  displayProjection: string;
  pixels: [number, number];
  attribution: string[];
  outputBytesHash: string;
}
export const emptyGeo = (): GeoDocument => ({ schemaVersion: 1, layers: [], sources: [] });
