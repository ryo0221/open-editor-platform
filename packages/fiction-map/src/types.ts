export type FictionMapId = string;
export type FictionMapPoint = readonly [number, number];
export type FictionMapBounds = {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
};
export type FictionMapCoordinateSpace = {
  readonly kind: 'local-plane';
  readonly bounds: FictionMapBounds;
  readonly unit: {
    readonly name: string;
    readonly distancePerUnit?: { readonly value: number; readonly unit: 'm' | 'km' };
  };
  readonly yAxis: 'up' | 'down';
};
export type FictionMapPrecision = {
  readonly minEdgeLength: number;
  readonly minPolygonArea: number;
  readonly snapGrid?: { readonly step: number };
};
export type FictionMapGeometry =
  | { readonly type: 'point'; readonly coordinates: FictionMapPoint }
  | { readonly type: 'polyline'; readonly coordinates: readonly FictionMapPoint[] }
  | { readonly type: 'polygon'; readonly outer: readonly FictionMapPoint[] };
export type FictionMapLayer = {
  readonly id: FictionMapId;
  readonly name: string;
  readonly purpose: 'terrain' | 'political' | 'route' | 'settlement' | 'annotation';
  readonly visibleByDefault: boolean;
};
export type FictionMapFeature = {
  readonly id: FictionMapId;
  readonly layerId: FictionMapId;
  readonly featureKind: 'place' | 'path' | 'region' | 'landform';
  readonly geometry: FictionMapGeometry;
  readonly name: string;
  readonly description?: string;
  readonly category?: string;
  readonly style?: {
    readonly color?: string;
    readonly lineWidth?: number;
    readonly label?: boolean;
  };
  readonly worldEntityRef?: { readonly namespace: string; readonly entityId: string };
};
export type FictionMapNamedView = {
  readonly id: FictionMapId;
  readonly name: string;
  readonly extent: FictionMapBounds;
  readonly visibleLayerIds: readonly FictionMapId[];
};
export type FictionMapContent = {
  readonly kind: 'fiction-map';
  readonly schemaVersion: 1;
  readonly coordinateSpace: FictionMapCoordinateSpace;
  readonly precision: FictionMapPrecision;
  readonly layers: readonly FictionMapLayer[];
  readonly features: readonly FictionMapFeature[];
  readonly namedViews: readonly FictionMapNamedView[];
};
// 以下は変更要求の全field。各optional fieldを省略するとその部分を維持する。
export type FictionMapChange = {
  readonly create?: readonly FictionMapFeature[];
  readonly update?: readonly FictionMapFeature[]; // 存在するIDの完全置換、ID改名は禁止
  readonly delete?: readonly FictionMapId[]; // 全IDが現在存在すること
  readonly featureOrder?: readonly FictionMapId[]; // 最終全feature IDの重複なし順列
  readonly layers?: readonly FictionMapLayer[]; // 省略時維持、指定時は最終配列
  readonly namedViews?: readonly FictionMapNamedView[]; // 同上
  readonly coordinateSpace?: FictionMapCoordinateSpace;
  readonly precision?: FictionMapPrecision;
};
export type FictionMapCode =
  | 'input-byte-limit'
  | 'input-structure-limit'
  | 'invalid-json'
  | 'invalid-data'
  | 'unsupported-format'
  | 'unsupported-schema'
  | 'unknown-field'
  | 'invalid-field'
  | 'invalid-string'
  | 'coordinate-not-finite'
  | 'layer-limit'
  | 'feature-limit'
  | 'view-limit'
  | 'geometry-vertex-limit'
  | 'map-vertex-limit'
  | 'native-byte-limit'
  | 'duplicate-id'
  | 'missing-feature'
  | 'missing-layer'
  | 'dangling-view-layer'
  | 'invalid-remap'
  | 'import-space-mismatch'
  | 'geometry-kind-mismatch'
  | 'coordinate-out-of-range'
  | 'invalid-bounds'
  | 'view-out-of-bounds'
  | 'invalid-precision'
  | 'operation-byte-limit'
  | 'operation-feature-limit'
  | 'operation-vertex-limit'
  | 'operation-pair-limit'
  | 'invalid-geometry'
  | 'zero-length-edge'
  | 'edge-below-minimum'
  | 'area-below-minimum'
  | 'coordinate-precision-loss'
  | 'snap-out-of-bounds'
  | 'permission-denied'
  | 'stale-revision'
  | 'prepared-base-mismatch'
  | 'prepared-policy-mismatch'
  | 'prepared-consumed';

export interface FictionMapDiagnostic {
  readonly code: FictionMapCode;
  readonly path: string;
  readonly source: 'input' | 'source' | 'candidate' | 'commit';
  readonly cause?: import('@editor-platform/geometry-core/planar').PlanarDiagnostic;
  readonly id?: string;
  readonly limit?: number;
  readonly actual?: number;
}
export type FictionMapResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly diagnostic: FictionMapDiagnostic };
