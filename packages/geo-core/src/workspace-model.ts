import type { Field, Pin, Position, Scalar } from './model';

export type GeoExtent = [number, number, number, number];
export interface GeoMetric {
  kind: 'count' | 'rate';
  numerator: string;
  denominator: string | null;
  multiplier: number;
  indicator: string;
  unit: string;
  period: string;
}
export interface GeoLayerStyle {
  layerId: string;
  visible: boolean;
  mode: 'single' | 'category' | 'classes' | 'proportional';
  color: string;
  missingColor: string;
  radius: number;
  fieldId: string | null;
  labelFieldId: string | null;
  categories: { value: Scalar; color: string }[];
  boundaries: number[];
  colors: string[];
  metric: GeoMetric | null;
  filter: { fieldId: string; value: Scalar } | null;
}
export interface GeoAnnotation {
  id: string;
  text: string;
  position: Position;
}
export interface NamedGeoView {
  backgrounds?: import('./background').GeoBackgroundSetting[];
  id: string;
  name: string;
  extent: GeoExtent;
  styles: GeoLayerStyle[];
  annotations: GeoAnnotation[];
}
export interface PinnedGeoJoin {
  id: string;
  layerId: string;
  tableLayerId: string;
  leftFieldId: string;
  rightFieldId: string;
  cardinality: 'one-to-one' | 'many-to-one';
  inputs: { left: Pin; right: Pin };
  fields: Field[];
  rows: {
    featureId: string;
    status: 'matched' | 'unmatched' | 'null-key';
    values: Record<string, Scalar>;
  }[];
}
export interface GeoAsset {
  layerId: string;
  featureId: string;
  assetId: string;
  inspectedAt: string;
  accuracyMeters: number | null;
  notes: string;
  photos: { sourceId: string; name: string; required: boolean }[];
}
export interface GeoComparison {
  id: string;
  before: Pin;
  after: Pin;
  fieldIds: string[];
  toleranceDegrees: number;
  completeCoverage: boolean;
  changes: {
    layerId: string;
    featureId: string;
    kind: 'added' | 'removed' | 'no-counterpart' | 'changed';
    fields: string[];
    geometryChanged: boolean;
  }[];
}
/** Optional, versioned native extension. Old schema-1 documents remain byte-for-byte valid. */
export interface GeoWorkspace {
  schemaVersion: 1;
  styles: GeoLayerStyle[];
  annotations: GeoAnnotation[];
  views: NamedGeoView[];
  joins: PinnedGeoJoin[];
  assets: GeoAsset[];
  comparisons: GeoComparison[];
}
export const emptyGeoWorkspace = (): GeoWorkspace => ({
  schemaVersion: 1,
  styles: [],
  annotations: [],
  views: [],
  joins: [],
  assets: [],
  comparisons: [],
});
export const defaultGeoStyle = (layerId: string): GeoLayerStyle => ({
  layerId,
  visible: true,
  mode: 'single',
  color: '#247ba0',
  missingColor: '#b6bdc6',
  radius: 6,
  fieldId: null,
  labelFieldId: null,
  categories: [],
  boundaries: [],
  colors: ['#e5f5f9', '#99d8c9', '#2ca25f'],
  metric: null,
  filter: null,
});
