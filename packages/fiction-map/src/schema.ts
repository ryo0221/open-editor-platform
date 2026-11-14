import { validatePlanarPoint } from '@editor-platform/geometry-core/planar';
import { fictionMapLimits as limits } from './limits';
import { fail, pointer } from './result';
import type {
  FictionMapBounds,
  FictionMapContent,
  FictionMapCoordinateSpace,
  FictionMapArtifactRef,
  FictionMapFeature,
  FictionMapGeometry,
  FictionMapLayer,
  FictionMapNamedView,
  FictionMapPoint,
  FictionMapPrecision,
} from './types';

export function record(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid-field', path);
  const o = value as Record<string, unknown>;
  for (const key of required) if (!Object.hasOwn(o, key)) fail('invalid-field', pointer(path, key));
  for (const key of Object.keys(o).sort())
    if (!required.includes(key) && !optional.includes(key))
      fail('unknown-field', pointer(path, key));
  return o;
}
export function text(
  value: unknown,
  path: string,
  max = 512,
  min = 1,
  description = false,
): string {
  if (typeof value !== 'string') fail('invalid-string', path);
  if (value.length < min || value.length > max || (min > 0 && !value.trim()))
    fail('invalid-string', path);
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 32 && !(description && [9, 10, 13].includes(c))) fail('invalid-string', path);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = value.charCodeAt(++i);
      if (!(d >= 0xdc00 && d <= 0xdfff)) fail('invalid-string', path);
    } else if (c >= 0xdc00 && c <= 0xdfff) fail('invalid-string', path);
  }
  return value;
}
export function finite(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail('invalid-field', path);
  return value;
}
function literal<T extends string>(value: unknown, options: readonly T[], path: string): T {
  if (!options.includes(value as T)) fail('invalid-field', path);
  return value as T;
}
function bool(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail('invalid-field', path);
  return value;
}
function list(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail('invalid-field', path);
  return value;
}
export function readPoint(value: unknown, path: string): FictionMapPoint {
  if (!Array.isArray(value) || value.length !== 2) fail('invalid-field', path);
  for (let i = 0; i < 2; i++) {
    if (typeof value[i] !== 'number') fail('invalid-field', pointer(path, i));
    if (!Number.isFinite(value[i])) fail('coordinate-not-finite', pointer(path, i));
  }
  const p = validatePlanarPoint(value);
  if (!p.ok) fail('invalid-geometry', path, { cause: p.diagnostic });
  return p.value;
}
export function readBounds(value: unknown, path: string): FictionMapBounds {
  const o = record(value, path, ['minX', 'minY', 'maxX', 'maxY']);
  return {
    minX: finite(o.minX, path + '/minX'),
    minY: finite(o.minY, path + '/minY'),
    maxX: finite(o.maxX, path + '/maxX'),
    maxY: finite(o.maxY, path + '/maxY'),
  };
}
export function readSpace(value: unknown, path = '/coordinateSpace'): FictionMapCoordinateSpace {
  const o = record(value, path, ['kind', 'bounds', 'unit', 'yAxis']);
  literal(o.kind, ['local-plane'], path + '/kind');
  const bounds = readBounds(o.bounds, path + '/bounds'),
    u = record(o.unit, path + '/unit', ['name'], ['distancePerUnit']);
  const unit: FictionMapCoordinateSpace['unit'] = { name: text(u.name, path + '/unit/name', 32) };
  let conversion: FictionMapCoordinateSpace['unit']['distancePerUnit'];
  if (Object.hasOwn(u, 'distancePerUnit')) {
    const d = record(u.distancePerUnit, path + '/unit/distancePerUnit', ['value', 'unit']);
    const value = finite(d.value, path + '/unit/distancePerUnit/value');
    if (value <= 0) fail('invalid-field', path + '/unit/distancePerUnit/value');
    conversion = { value, unit: literal(d.unit, ['m', 'km'], path + '/unit/distancePerUnit/unit') };
  }
  return {
    kind: 'local-plane',
    bounds,
    unit: conversion ? { ...unit, distancePerUnit: conversion } : unit,
    yAxis: literal(o.yAxis, ['up', 'down'], path + '/yAxis'),
  };
}
export function checkPrecision(p: FictionMapPrecision, path = '/precision'): void {
  for (const k of ['minEdgeLength', 'minPolygonArea'] as const)
    if (p[k] < 0) fail('invalid-precision', pointer(path, k));
  const step = p.snapGrid?.step;
  if (
    step !== undefined &&
    (step < 2 ** -20 ||
      step > 2 ** 20 ||
      !Number.isInteger(Math.log2(step)) ||
      2 ** Math.log2(step) !== step)
  )
    fail('invalid-precision', path + '/snapGrid/step');
}
export function readPrecision(
  value: unknown,
  path = '/precision',
  semantic = true,
): FictionMapPrecision {
  const o = record(value, path, ['minEdgeLength', 'minPolygonArea'], ['snapGrid']);
  for (const k of ['minEdgeLength', 'minPolygonArea'])
    if (typeof o[k] !== 'number' || !Number.isFinite(o[k]))
      fail('invalid-precision', pointer(path, k));
  let precision: FictionMapPrecision = {
    minEdgeLength: o.minEdgeLength as number,
    minPolygonArea: o.minPolygonArea as number,
  };
  if (Object.hasOwn(o, 'snapGrid')) {
    const g = record(o.snapGrid, path + '/snapGrid', ['step']);
    if (typeof g.step !== 'number' || !Number.isFinite(g.step))
      fail('invalid-precision', path + '/snapGrid/step');
    precision = { ...precision, snapGrid: { step: g.step } };
  }
  if (semantic) checkPrecision(precision, path);
  return precision;
}
export function readGeometry(value: unknown, path: string): FictionMapGeometry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid-field', path);
  const type = literal(
    (value as Record<string, unknown>).type,
    ['point', 'polyline', 'polygon'],
    path + '/type',
  );
  const key = type === 'polygon' ? 'outer' : 'coordinates',
    o = record(value, path, ['type', key]);
  if (type === 'point')
    return { type, coordinates: readPoint(o.coordinates, path + '/coordinates') };
  const points = list(o[key], pointer(path, key)).map((p, i) =>
    readPoint(p, pointer(pointer(path, key), i)),
  );
  return type === 'polygon' ? { type, outer: points } : { type, coordinates: points };
}
function readLayer(value: unknown, path: string): FictionMapLayer {
  const o = record(value, path, ['id', 'name', 'purpose', 'visibleByDefault']);
  return {
    id: text(o.id, path + '/id'),
    name: text(o.name, path + '/name', 128),
    purpose: literal(
      o.purpose,
      ['terrain', 'political', 'route', 'settlement', 'annotation'],
      path + '/purpose',
    ),
    visibleByDefault: bool(o.visibleByDefault, path + '/visibleByDefault'),
  };
}
function readFeature(value: unknown, path: string): FictionMapFeature {
  const o = record(
    value,
    path,
    ['id', 'layerId', 'featureKind', 'geometry', 'name'],
    ['description', 'category', 'style', 'worldEntityRef', 'artifactRefs'],
  );
  const basic = {
    id: text(o.id, path + '/id'),
    layerId: text(o.layerId, path + '/layerId'),
    featureKind: literal(
      o.featureKind,
      ['place', 'path', 'region', 'landform'],
      path + '/featureKind',
    ),
    geometry: readGeometry(o.geometry, path + '/geometry'),
    name: text(o.name, path + '/name', 128),
  };
  // Build optional properties explicitly; absent and undefined are distinct input states.
  const description = Object.hasOwn(o, 'description')
    ? { description: text(o.description, path + '/description', 4096, 0, true) }
    : {};
  const category = Object.hasOwn(o, 'category')
    ? { category: text(o.category, path + '/category', 64, 0) }
    : {};
  let style: FictionMapFeature['style'];
  if (Object.hasOwn(o, 'style')) {
    const v = record(o.style, path + '/style', [], ['color', 'lineWidth', 'label']);
    style = {};
    if (Object.hasOwn(v, 'color')) {
      if (typeof v.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(v.color))
        fail('invalid-field', path + '/style/color');
      style = { ...style, color: v.color };
    }
    if (Object.hasOwn(v, 'lineWidth')) {
      const w = finite(v.lineWidth, path + '/style/lineWidth');
      if (w <= 0 || w > 64) fail('invalid-field', path + '/style/lineWidth');
      style = { ...style, lineWidth: w };
    }
    if (Object.hasOwn(v, 'label'))
      style = { ...style, label: bool(v.label, path + '/style/label') };
  }
  let worldEntityRef: FictionMapFeature['worldEntityRef'];
  if (Object.hasOwn(o, 'worldEntityRef')) {
    const r = record(o.worldEntityRef, path + '/worldEntityRef', ['namespace', 'entityId']);
    worldEntityRef = {
      namespace: text(r.namespace, path + '/worldEntityRef/namespace'),
      entityId: text(r.entityId, path + '/worldEntityRef/entityId'),
    };
  }
  const artifactRefs = Object.hasOwn(o, 'artifactRefs')
    ? { artifactRefs: readArtifactRefs(o.artifactRefs, path + '/artifactRefs') }
    : {};
  return {
    ...basic,
    ...description,
    ...category,
    ...(style ? { style } : {}),
    ...(worldEntityRef ? { worldEntityRef } : {}),
    ...artifactRefs,
  };
}
/** GV2a: 1..8 pinned versions per feature, each Artifact at most once. */
export function readArtifactRefs(value: unknown, path: string): FictionMapArtifactRef[] {
  const items = list(value, path);
  if (items.length < 1 || items.length > limits.artifactRefsPerFeature)
    fail('invalid-field', path, { limit: limits.artifactRefsPerFeature, actual: items.length });
  const seen = new Set<string>();
  return items.map((item, i) => {
    const p = pointer(path, i),
      r = record(item, p, ['artifactId', 'domain', 'versionId', 'contentHash'], ['label']);
    const artifactId = text(r.artifactId, p + '/artifactId');
    if (seen.has(artifactId)) fail('duplicate-id', p + '/artifactId', { id: artifactId });
    seen.add(artifactId);
    const domain = text(r.domain, p + '/domain', 64);
    if (!/^[a-z][a-z0-9-]*$/.test(domain)) fail('invalid-field', p + '/domain');
    const contentHash = text(r.contentHash, p + '/contentHash', 64);
    if (!/^[a-f0-9]{64}$/.test(contentHash)) fail('invalid-field', p + '/contentHash');
    return {
      artifactId,
      domain,
      versionId: text(r.versionId, p + '/versionId'),
      contentHash,
      ...(Object.hasOwn(r, 'label') ? { label: text(r.label, p + '/label', 128) } : {}),
    };
  });
}
function readView(value: unknown, path: string): FictionMapNamedView {
  const o = record(value, path, ['id', 'name', 'extent', 'visibleLayerIds']);
  return {
    id: text(o.id, path + '/id'),
    name: text(o.name, path + '/name', 128),
    extent: readBounds(o.extent, path + '/extent'),
    visibleLayerIds: list(o.visibleLayerIds, path + '/visibleLayerIds').map((id, i) =>
      text(id, pointer(path + '/visibleLayerIds', i)),
    ),
  };
}
export function readContent(value: unknown): FictionMapContent {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (value as Record<string, unknown>).kind !== 'fiction-map'
  )
    fail('unsupported-format', '/kind');
  if ((value as Record<string, unknown>).schemaVersion !== 1)
    fail('unsupported-schema', '/schemaVersion');
  const o = record(value, '', [
    'kind',
    'schemaVersion',
    'coordinateSpace',
    'precision',
    'layers',
    'features',
    'namedViews',
  ]);
  return {
    kind: 'fiction-map',
    schemaVersion: 1,
    coordinateSpace: readSpace(o.coordinateSpace),
    precision: readPrecision(o.precision, '/precision', false),
    layers: list(o.layers, '/layers').map((l, i) => readLayer(l, pointer('/layers', i))),
    features: list(o.features, '/features').map((f, i) => readFeature(f, pointer('/features', i))),
    namedViews: list(o.namedViews, '/namedViews').map((v, i) =>
      readView(v, pointer('/namedViews', i)),
    ),
  };
}
export function checkCoordinate(value: number, path: string): void {
  if (Math.abs(value) > limits.coordinate)
    fail('coordinate-out-of-range', path, { limit: limits.coordinate, actual: Math.abs(value) });
}
export function checkBounds(b: FictionMapBounds, path: string): void {
  for (const k of ['minX', 'minY', 'maxX', 'maxY'] as const)
    checkCoordinate(b[k], pointer(path, k));
  if (!(b.minX < b.maxX && b.minY < b.maxY)) fail('invalid-bounds', path);
}
export const contains = (b: FictionMapBounds, p: FictionMapPoint) =>
  p[0] >= b.minX && p[0] <= b.maxX && p[1] >= b.minY && p[1] <= b.maxY;
export function pointsOf(g: FictionMapGeometry): readonly FictionMapPoint[] {
  return g.type === 'polygon' ? g.outer : g.type === 'polyline' ? g.coordinates : [g.coordinates];
}
export function checkReferences(c: FictionMapContent): void {
  const layers = new Set<string>(),
    features = new Set<string>(),
    views = new Set<string>();
  const unique = (set: Set<string>, id: string, path: string) => {
    if (set.has(id)) fail('duplicate-id', path, { id });
    set.add(id);
  };
  c.layers.forEach((l, i) => unique(layers, l.id, `/layers/${i}/id`));
  c.features.forEach((f, i) => {
    unique(features, f.id, `/features/${i}/id`);
    if (!layers.has(f.layerId)) fail('missing-layer', `/features/${i}/layerId`, { id: f.layerId });
  });
  c.namedViews.forEach((v, i) => {
    unique(views, v.id, `/namedViews/${i}/id`);
    const ids = new Set<string>();
    v.visibleLayerIds.forEach((id, j) => {
      if (ids.has(id)) fail('duplicate-id', `/namedViews/${i}/visibleLayerIds/${j}`, { id });
      ids.add(id);
      if (!layers.has(id))
        fail('dangling-view-layer', `/namedViews/${i}/visibleLayerIds/${j}`, { id });
    });
  });
  checkBounds(c.coordinateSpace.bounds, '/coordinateSpace/bounds');
  c.features.forEach((f, i) => {
    pointsOf(f.geometry).forEach((p, j) => {
      const base =
        `/features/${i}/geometry/` +
        (f.geometry.type === 'polygon'
          ? 'outer'
          : f.geometry.type === 'point'
            ? 'coordinates'
            : `coordinates/${j}`);
      checkCoordinate(p[0], base + (f.geometry.type === 'polygon' ? `/${j}/0` : '/0'));
      checkCoordinate(p[1], base + (f.geometry.type === 'polygon' ? `/${j}/1` : '/1'));
      if (!contains(c.coordinateSpace.bounds, p)) fail('coordinate-out-of-range', base);
    });
  });
  c.namedViews.forEach((v, i) => {
    checkBounds(v.extent, `/namedViews/${i}/extent`);
    if (
      !contains(c.coordinateSpace.bounds, [v.extent.minX, v.extent.minY]) ||
      !contains(c.coordinateSpace.bounds, [v.extent.maxX, v.extent.maxY])
    )
      fail('view-out-of-bounds', `/namedViews/${i}/extent`);
  });
  checkPrecision(c.precision);
  c.features.forEach((f, i) => {
    if (
      f.featureKind !== 'landform' &&
      ({ place: 'point', path: 'polyline', region: 'polygon' } as const)[f.featureKind] !==
        f.geometry.type
    )
      fail('geometry-kind-mismatch', `/features/${i}/geometry/type`);
  });
}
