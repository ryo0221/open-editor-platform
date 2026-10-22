import { canonicalJson } from '@editor-platform/artifact-core';
import { evaluationOrder, longestPath, upstreamFeatures, type ParameterValues } from './graph';
import {
  cadLimits,
  cadToleranceV1,
  quaternionNormTolerance,
  type CadDiagnostic,
  type CadDocument,
} from './model';

type Rec = Record<string, unknown>;
type Pt = [number, number];
const reservedKeys = ['__proto__', 'constructor', 'prototype', 'toJSON'];
export const record = (v: unknown): v is Rec =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;
const codePoints = (s: string) => [...s].length;
/** Artifact-scoped stable ID: 1–128 code points, no controls, whitespace edges or reserved keys. */
export const cadId = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.length > 0 &&
  codePoints(v) <= cadLimits.idCodePoints &&
  v.trim() === v &&
  !/\p{Cc}/u.test(v) &&
  !reservedKeys.includes(v);
const cadName = (v: unknown): v is string =>
  typeof v === 'string' && codePoints(v) <= cadLimits.nameCodePoints && !/\p{Cc}/u.test(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const tuple = (v: unknown, n: number): v is unknown[] =>
  Array.isArray(v) && v.length === n && [...Array(n).keys()].every((i) => Object.hasOwn(v, i));

/** Plain JSON data only, depth-limited before any domain traversal. */
export function cadJsonShape(value: unknown): { code: string; path: string } | undefined {
  const seen = new Set<object>();
  function visit(v: unknown, depth: number, path: string): { code: string; path: string } | void {
    if (depth > cadLimits.jsonDepth) return { code: 'json-depth', path };
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
    if (typeof v === 'number') return Number.isFinite(v) ? undefined : { code: 'number', path };
    if (typeof v !== 'object' || seen.has(v)) return { code: 'json-value', path };
    const isArray = Array.isArray(v);
    if (Object.getPrototypeOf(v) !== (isArray ? Array.prototype : Object.prototype))
      return { code: 'json-value', path };
    seen.add(v);
    for (const key of Reflect.ownKeys(v)) {
      if (isArray && key === 'length') continue;
      if (typeof key !== 'string' || reservedKeys.includes(key)) return { code: 'json-key', path };
      if (isArray && !/^(0|[1-9][0-9]*)$/.test(key)) return { code: 'json-key', path };
      const d = Object.getOwnPropertyDescriptor(v, key)!;
      if (!('value' in d) || !d.enumerable) return { code: 'json-value', path };
      const r = visit(d.value, depth + 1, isArray ? `${path}[${key}]` : `${path}.${key}`);
      if (r) return r;
    }
    if (isArray && Object.keys(v).length !== (v as unknown[]).length)
      return { code: 'json-sparse', path };
    seen.delete(v);
  }
  return visit(value, 0, '$') ?? undefined;
}
/** UTF-8 bytes of the canonical native content (the hash input). */
export const canonicalContentBytes = (value: unknown) =>
  new TextEncoder().encode(canonicalJson(value)).length;

class Check {
  d: CadDiagnostic[] = [];
  ids = new Set<string>();
  params: Map<string, { type: 'length' | 'angle'; value: number }> = new Map();
  error(code: string, path: string) {
    this.d.push({ code, path, severity: 'error' });
    return false;
  }
  keys(v: Rec, required: string[], path: string, optional: string[] = []) {
    let ok = true;
    for (const k of required)
      if (!Object.hasOwn(v, k)) ok = this.error('missing-field', `${path}.${k}`);
    for (const k of Object.keys(v))
      if (!required.includes(k) && !optional.includes(k))
        ok = this.error('unknown-field', `${path}.${k}`);
    return ok;
  }
  id(v: unknown, path: string): v is string {
    if (!cadId(v)) return this.error('id', path);
    if (this.ids.has(v)) return this.error('duplicate-id', path);
    this.ids.add(v);
    return true;
  }
  name(v: unknown, path: string) {
    return cadName(v) || this.error('name', path);
  }
  /** Validates a Length and returns its resolved mm value. */
  length(v: unknown, path: string, use: 'coordinate' | 'dimension'): number | undefined {
    if (!record(v)) return void this.error('length', path);
    let value: number;
    if (Object.hasOwn(v, 'literalMm')) {
      if (!this.keys(v, ['literalMm'], path) || !finite(v.literalMm))
        return void this.error('length', path);
      value = v.literalMm;
    } else {
      const ref = (Object.hasOwn(v, 'affine') ? v.affine : v) as Rec;
      if (Object.hasOwn(v, 'affine')) {
        if (!this.keys(v, ['affine'], path) || !record(ref)) return void this.error('length', path);
        if (!this.keys(ref, ['parameterId', 'scale', 'offsetMm'], `${path}.affine`)) return;
        if (!finite(ref.scale) || Math.abs(ref.scale) > cadLimits.affineScale)
          return void this.error('affine-scale', path);
        if (!finite(ref.offsetMm) || Math.abs(ref.offsetMm) > cadLimits.coordinateMm)
          return void this.error('affine-offset', path);
      } else if (!this.keys(v, ['parameterId'], path)) return;
      const p = this.params.get(ref.parameterId as string);
      if (!p) return void this.error('parameter-missing', path);
      if (p.type !== 'length') return void this.error('parameter-type', path);
      value = ref === v ? p.value : (ref.scale as number) * p.value + (ref.offsetMm as number);
    }
    if (use === 'coordinate' && !(Math.abs(value) <= cadLimits.coordinateMm))
      return void this.error('coordinate-range', path);
    if (
      use === 'dimension' &&
      !(value >= cadLimits.minDimensionMm && value <= cadLimits.maxDimensionMm)
    )
      return void this.error('dimension-range', path);
    return value;
  }
  angle(v: unknown, path: string): number | undefined {
    if (!record(v)) return void this.error('angle', path);
    let value: number;
    if (Object.hasOwn(v, 'literalRad')) {
      if (!this.keys(v, ['literalRad'], path) || !finite(v.literalRad))
        return void this.error('angle', path);
      value = v.literalRad;
    } else {
      if (!this.keys(v, ['parameterId'], path)) return;
      const p = this.params.get(v.parameterId as string);
      if (!p) return void this.error('parameter-missing', path);
      if (p.type !== 'angle') return void this.error('parameter-type', path);
      value = p.value;
    }
    if (!(value > 0 && value <= 2 * Math.PI)) return void this.error('angle-range', path);
    return value;
  }
  position(v: unknown, path: string) {
    if (!tuple(v, 3)) return void this.error('position', path);
    const r = v.map((l, i) => this.length(l, `${path}[${i}]`, 'coordinate'));
    return r.every((x) => x !== undefined) ? (r as [number, number, number]) : undefined;
  }
  quaternion(v: unknown, path: string): v is [number, number, number, number] {
    if (!tuple(v, 4) || !v.every(finite)) return this.error('quaternion', path);
    const norm = Math.hypot(...(v as number[]));
    return Math.abs(norm - 1) <= quaternionNormTolerance || this.error('quaternion-norm', path);
  }
  vec3(v: unknown, path: string): v is [number, number, number] {
    return (
      (tuple(v, 3) && v.every((n) => finite(n) && Math.abs(n) <= cadLimits.coordinateMm)) ||
      this.error('vec3', path)
    );
  }
}

const segmentsCross = (a: Pt, b: Pt, c: Pt, d: Pt) => {
  const o = (p: Pt, q: Pt, r: Pt) =>
    Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  const on = (p: Pt, q: Pt, r: Pt) =>
    Math.min(p[0], r[0]) <= q[0] &&
    q[0] <= Math.max(p[0], r[0]) &&
    Math.min(p[1], r[1]) <= q[1] &&
    q[1] <= Math.max(p[1], r[1]);
  const [o1, o2, o3, o4] = [o(a, b, c), o(a, b, d), o(c, d, a), o(c, d, b)];
  if (o1 !== o2 && o3 !== o4) return true;
  return (
    (!o1 && on(a, c, b)) || (!o2 && on(a, d, b)) || (!o3 && on(c, a, d)) || (!o4 && on(c, b, d))
  );
};
/** 2D extent of a profile: boundary points and circle data for axis checks. */
type Profile2D = { points: Pt[]; circle?: { center: Pt; radius: number } };

function validateProfile(c: Check, p: unknown, path: string): Profile2D | undefined {
  if (!record(p)) return void c.error('profile', path);
  c.keys(p, ['id', 'name', 'plane', 'shape'], path);
  c.id(p.id, `${path}.id`);
  c.name(p.name, `${path}.name`);
  if (!record(p.plane)) c.error('plane', `${path}.plane`);
  else {
    c.keys(p.plane, ['origin', 'orientation'], `${path}.plane`);
    c.position(p.plane.origin, `${path}.plane.origin`);
    c.quaternion(p.plane.orientation, `${path}.plane.orientation`);
  }
  const s = p.shape;
  const sp = `${path}.shape`;
  if (!record(s)) return void c.error('profile-shape', sp);
  if (s.type === 'rectangle') {
    c.keys(s, ['type', 'width', 'height'], sp);
    const w = c.length(s.width, `${sp}.width`, 'dimension');
    const h = c.length(s.height, `${sp}.height`, 'dimension');
    if (w === undefined || h === undefined) return;
    return {
      points: [
        [0, 0],
        [w, 0],
        [w, h],
        [0, h],
      ],
    };
  }
  if (s.type === 'circle') {
    c.keys(s, ['type', 'radius'], sp);
    const r = c.length(s.radius, `${sp}.radius`, 'dimension');
    return r === undefined
      ? undefined
      : { points: [[0, 0]], circle: { center: [0, 0], radius: r } };
  }
  if (s.type !== 'polyline') return void c.error('profile-shape', `${sp}.type`);
  c.keys(s, ['type', 'vertices'], sp);
  if (!Array.isArray(s.vertices) || s.vertices.length < 3)
    return void c.error('polyline-vertices', `${sp}.vertices`);
  if (s.vertices.length > cadLimits.verticesPerProfile)
    return void c.error('limit-vertices', `${sp}.vertices`);
  const pts: Pt[] = [];
  for (const [i, v] of s.vertices.entries()) {
    const vp = `${sp}.vertices[${i}]`;
    if (!record(v)) return void c.error('polyline-vertex', vp);
    c.keys(v, ['id', 'u', 'v'], vp);
    c.id(v.id, `${vp}.id`);
    const u = c.length(v.u, `${vp}.u`, 'coordinate');
    const w = c.length(v.v, `${vp}.v`, 'coordinate');
    if (u === undefined || w === undefined) return;
    pts.push([u, w]);
  }
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const [a, b] = [pts[i], pts[(i + 1) % n]];
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < cadLimits.minDimensionMm)
      return void c.error('polyline-degenerate-edge', `${sp}.vertices[${i}]`);
  }
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      if (segmentsCross(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n]))
        return void c.error('polyline-self-intersection', `${sp}.vertices[${j}]`);
    }
  // Relative to the first vertex: absolute coordinates cancel small areas far from the origin.
  const [ox, oy] = pts[0];
  const area =
    pts.reduce((a, p, i) => {
      const q = pts[(i + 1) % n];
      return a + (p[0] - ox) * (q[1] - oy) - (q[0] - ox) * (p[1] - oy);
    }, 0) / 2;
  if (Math.abs(area) < cadLimits.minDimensionMm ** 2) return void c.error('profile-zero-area', sp);
  return { points: pts };
}

const primitiveArgs: Record<string, string[]> = {
  box: ['size', 'origin', 'orientation'],
  cylinder: ['radius', 'height', 'origin', 'orientation'],
  sphere: ['radius', 'origin', 'orientation'],
};
/** Declared input count; -1 for anything that is not a supported type string (never indexes). */
const arity = (type: unknown) =>
  typeof type === 'string' && Object.hasOwn(featureArity, type) ? featureArity[type] : -1;
const featureArity: Record<string, number> = {
  box: 0,
  cylinder: 0,
  sphere: 0,
  extrude: 0,
  revolve: 0,
  transform: 1,
  boolean: 2,
};

function validateFeature(
  c: Check,
  f: unknown,
  path: string,
  profiles: Map<string, Profile2D | undefined>,
) {
  if (!record(f)) return void c.error('feature', path);
  c.keys(f, ['id', 'name', 'type', 'inputFeatureIds', 'args'], path);
  c.id(f.id, `${path}.id`);
  c.name(f.name, `${path}.name`);
  if (typeof f.type !== 'string' || !Object.hasOwn(featureArity, f.type))
    return void c.error(
      f.type === 'imported' ? 'feature-unsupported' : 'feature-type',
      `${path}.type`,
    );
  const inputs = f.inputFeatureIds;
  if (!Array.isArray(inputs) || inputs.length !== featureArity[f.type] || !inputs.every(cadId))
    c.error('feature-arity', `${path}.inputFeatureIds`);
  const a = f.args;
  const ap = `${path}.args`;
  if (!record(a)) return void c.error('feature-args', ap);
  switch (f.type) {
    case 'box':
    case 'cylinder':
    case 'sphere':
      c.keys(a, primitiveArgs[f.type], ap);
      if (f.type === 'box') {
        if (!tuple(a.size, 3)) c.error('box-size', `${ap}.size`);
        else a.size.forEach((l, i) => c.length(l, `${ap}.size[${i}]`, 'dimension'));
      } else c.length(a.radius, `${ap}.radius`, 'dimension');
      if (f.type === 'cylinder') c.length(a.height, `${ap}.height`, 'dimension');
      c.position(a.origin, `${ap}.origin`);
      c.quaternion(a.orientation, `${ap}.orientation`);
      return;
    case 'extrude':
      c.keys(a, ['profileId', 'distance', 'direction'], ap);
      if (!profiles.has(a.profileId as string)) c.error('profile-missing', `${ap}.profileId`);
      c.length(a.distance, `${ap}.distance`, 'dimension');
      if (a.direction !== 1 && a.direction !== -1) c.error('extrude-direction', `${ap}.direction`);
      return;
    case 'revolve': {
      c.keys(a, ['profileId', 'axisOrigin', 'axisDirection', 'angle'], ap);
      c.angle(a.angle, `${ap}.angle`);
      const profile = profiles.get(a.profileId as string);
      if (!profiles.has(a.profileId as string)) c.error('profile-missing', `${ap}.profileId`);
      if (!tuple(a.axisOrigin, 2)) return void c.error('revolve-axis', `${ap}.axisOrigin`);
      const o = a.axisOrigin.map((l, i) => c.length(l, `${ap}.axisOrigin[${i}]`, 'coordinate'));
      const dir = a.axisDirection;
      if (!tuple(dir, 2) || !dir.every(finite))
        return void c.error('revolve-axis', `${ap}.axisDirection`);
      const [dx, dy] = dir as number[];
      if (Math.abs(Math.hypot(dx, dy) - 1) > quaternionNormTolerance)
        return void c.error('axis-norm', `${ap}.axisDirection`);
      if (!profile || o.some((x) => x === undefined)) return;
      const [ox, oy] = o as number[];
      const side = (p: Pt) => dx * (p[1] - oy) - dy * (p[0] - ox);
      const eps = cadToleranceV1.linearToleranceMm;
      const crosses = profile.circle
        ? Math.abs(side(profile.circle.center)) < profile.circle.radius - eps
        : profile.points.some((p) => side(p) > eps) && profile.points.some((p) => side(p) < -eps);
      if (crosses) c.error('revolve-crosses-axis', ap);
      return;
    }
    case 'transform':
      c.keys(a, ['translation', 'rotation'], ap);
      c.position(a.translation, `${ap}.translation`);
      c.quaternion(a.rotation, `${ap}.rotation`);
      return;
    case 'boolean':
      c.keys(a, ['mode'], ap);
      if (!['union', 'cut', 'common'].includes(a.mode as string))
        c.error('boolean-mode', `${ap}.mode`);
      if (Array.isArray(inputs) && inputs.length === 2 && inputs[0] === inputs[1])
        c.error('boolean-same-input', `${path}.inputFeatureIds`);
  }
}

const countLimits = [
  ['parameters', cadLimits.parameters],
  ['profiles', cadLimits.profiles],
  ['features', cadLimits.features],
  ['bodies', cadLimits.bodies],
  ['namedViews', cadLimits.namedViews],
] as const;

/** Strict schema 1 validation from `unknown`. Numeric/reference validity only; solid validity is the kernel's. */
/** Full CAD validation from unknown input: schema, references, graph and limits. */
export function isCadDocument(value: unknown): value is CadDocument {
  return validateCad(value).length === 0;
}
export function validateCad(value: unknown): CadDiagnostic[] {
  const c = new Check();
  const shape = cadJsonShape(value);
  if (shape) return [{ ...shape, severity: 'error' }];
  if (canonicalContentBytes(value) > cadLimits.contentBytes)
    return [{ code: 'limit-bytes', path: '$', severity: 'error' }];
  if (!record(value)) return [{ code: 'document', path: '$', severity: 'error' }];
  if (value.schemaVersion !== 1)
    return [{ code: 'unsupported-schema', path: '$.schemaVersion', severity: 'error' }];
  c.keys(
    value,
    [
      'schemaVersion',
      'units',
      'axes',
      'kernelProfile',
      'parameters',
      'profiles',
      'features',
      'bodies',
      'namedViews',
      'assets',
    ],
    '$',
  );
  if (value.units !== 'mm') c.error('units', '$.units');
  if (value.axes !== 'right-handed-z-up') c.error('axes', '$.axes');
  const k = value.kernelProfile;
  if (!record(k)) c.error('kernel-profile', '$.kernelProfile');
  else {
    c.keys(
      k,
      [
        'id',
        'buildHash',
        'semanticsVersion',
        'linearToleranceMm',
        'angularToleranceRad',
        'maxResultLinearToleranceMm',
      ],
      '$.kernelProfile',
    );
    if (!cadId(k.id)) c.error('id', '$.kernelProfile.id');
    if (typeof k.buildHash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(k.buildHash))
      c.error('kernel-build-hash', '$.kernelProfile.buildHash');
    if (k.semanticsVersion !== 1)
      c.error('unsupported-semantics', '$.kernelProfile.semanticsVersion');
    for (const [key, expected] of Object.entries(cadToleranceV1))
      if (k[key] !== expected) c.error('kernel-tolerance', `$.kernelProfile.${key}`);
  }
  for (const [key, max] of countLimits) {
    if (!Array.isArray(value[key]))
      return [...c.d, { code: 'collection', path: `$.${key}`, severity: 'error' }];
    if ((value[key] as unknown[]).length > max) c.error(`limit-${key}`, `$.${key}`);
  }
  if (!Array.isArray(value.assets)) c.error('collection', '$.assets');
  else if (value.assets.length) c.error('assets-unsupported', '$.assets');

  for (const [i, p] of (value.parameters as unknown[]).entries()) {
    const path = `$.parameters[${i}]`;
    if (!record(p)) {
      c.error('parameter', path);
      continue;
    }
    c.keys(p, ['id', 'name', 'type', 'value'], path);
    c.name(p.name, `${path}.name`);
    const typeOk = p.type === 'length' || p.type === 'angle';
    if (!typeOk) c.error('parameter-type', `${path}.type`);
    if (!finite(p.value)) c.error('parameter-value', `${path}.value`);
    else if (p.type === 'length' && Math.abs(p.value) > cadLimits.coordinateMm)
      c.error('coordinate-range', `${path}.value`);
    if (c.id(p.id, `${path}.id`) && typeOk && finite(p.value))
      c.params.set(p.id, { type: p.type as 'length' | 'angle', value: p.value });
  }
  const profiles = new Map<string, Profile2D | undefined>();
  let vertices = 0;
  for (const [i, p] of (value.profiles as unknown[]).entries()) {
    const r = validateProfile(c, p, `$.profiles[${i}]`);
    if (record(p) && cadId(p.id)) profiles.set(p.id, r);
    if (record(p) && record(p.shape) && Array.isArray(p.shape.vertices))
      vertices += p.shape.vertices.length;
  }
  if (vertices > cadLimits.vertices) c.error('limit-vertices', '$.profiles');
  const features = value.features as unknown[];
  features.forEach((f, i) => validateFeature(c, f, `$.features[${i}]`, profiles));
  const typed = features.filter(
    (f): f is CadDocument['features'][number] =>
      record(f) && cadId(f.id) && Array.isArray(f.inputFeatureIds),
  );
  const byId = new Map(typed.map((f) => [f.id, f]));
  const position = new Map(typed.map((f, i) => [f.id, i]));
  // Wrong arity is already reported; graph helpers only run on well-formed input lists.
  let graphOk =
    typed.length === features.length &&
    typed.every((f) => f.inputFeatureIds.length === arity(f.type));
  typed.forEach((f, i) =>
    f.inputFeatureIds.slice(0, Math.max(0, arity(f.type))).forEach((input, j) => {
      const path = `$.features[${i}].inputFeatureIds[${j}]`;
      if (!byId.has(input)) graphOk = c.error('feature-missing', path);
      else if (position.get(input)! >= i) c.error('feature-order', path);
    }),
  );
  if (graphOk) {
    const order = evaluationOrder(typed);
    if (!order) c.error('feature-cycle', '$.features');
    else if (longestPath(typed, order) > cadLimits.dagDepth)
      c.error('limit-dag-depth', '$.features');
  }

  const bodies = value.bodies as unknown[];
  const results = new Map<string, number>();
  const active: { id: string; result: string }[] = [];
  for (const [i, b] of bodies.entries()) {
    const path = `$.bodies[${i}]`;
    if (!record(b)) {
      c.error('body', path);
      continue;
    }
    const consumed = b.state === 'consumed';
    c.keys(
      b,
      [
        'id',
        'name',
        'resultFeatureId',
        'state',
        'appearance',
        ...(consumed ? ['consumedByFeatureId'] : []),
      ],
      path,
    );
    c.id(b.id, `${path}.id`);
    c.name(b.name, `${path}.name`);
    if (b.state !== 'active' && !consumed) c.error('body-state', `${path}.state`);
    const result = byId.get(b.resultFeatureId as string);
    if (!result || result.type !== 'transform')
      c.error('body-result-not-placement', `${path}.resultFeatureId`);
    else if (results.has(result.id)) c.error('body-result-duplicate', `${path}.resultFeatureId`);
    else results.set(result.id, i);
    if (consumed) {
      const by = byId.get(b.consumedByFeatureId as string);
      if (!by || by.type !== 'boolean' || !by.inputFeatureIds.includes(b.resultFeatureId as string))
        c.error('body-consumed-by', `${path}.consumedByFeatureId`);
    } else if (b.state === 'active' && result && cadId(b.id))
      active.push({ id: b.id, result: result.id });
    const ap = `${path}.appearance`;
    if (!record(b.appearance)) c.error('appearance', ap);
    else {
      c.keys(b.appearance, ['color', 'opacity'], ap);
      if (typeof b.appearance.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(b.appearance.color))
        c.error('appearance-color', `${ap}.color`);
      const o = b.appearance.opacity;
      if (!finite(o) || o < 0 || o > 1) c.error('appearance-opacity', `${ap}.opacity`);
    }
  }
  if (graphOk && !c.d.some((x) => x.code === 'feature-cycle'))
    for (const a of active) {
      const ancestors = upstreamFeatures(typed, [a.result]);
      for (const other of active)
        if (other !== a && ancestors.has(other.result))
          c.error('body-active-overlap', `$.bodies[${results.get(a.result)}]`);
    }

  const activeIds = new Set(active.map((a) => a.id));
  for (const [i, v] of (value.namedViews as unknown[]).entries()) {
    const path = `$.namedViews[${i}]`;
    if (!record(v)) {
      c.error('named-view', path);
      continue;
    }
    c.keys(v, ['id', 'name', 'bodyIds', 'camera', 'projection'], path);
    c.id(v.id, `${path}.id`);
    c.name(v.name, `${path}.name`);
    if (
      !Array.isArray(v.bodyIds) ||
      !v.bodyIds.length ||
      new Set(v.bodyIds).size !== v.bodyIds.length
    )
      c.error('view-bodies', `${path}.bodyIds`);
    else
      v.bodyIds.forEach(
        (id, j) => activeIds.has(id as string) || c.error('view-body', `${path}.bodyIds[${j}]`),
      );
    const cam = v.camera;
    if (!record(cam)) c.error('camera', `${path}.camera`);
    else {
      c.keys(cam, ['position', 'target', 'up'], `${path}.camera`);
      if (
        c.vec3(cam.position, `${path}.camera.position`) &&
        c.vec3(cam.target, `${path}.camera.target`) &&
        c.vec3(cam.up, `${path}.camera.up`)
      ) {
        const dir = cam.target.map((t, j) => t - (cam.position as number[])[j]);
        const up = cam.up;
        const cross = [
          dir[1] * up[2] - dir[2] * up[1],
          dir[2] * up[0] - dir[0] * up[2],
          dir[0] * up[1] - dir[1] * up[0],
        ];
        if (
          Math.hypot(...dir) < cadLimits.minDimensionMm ||
          Math.hypot(...cross) <= 1e-12 * Math.hypot(...dir) * Math.hypot(...up)
        )
          c.error('camera-degenerate', `${path}.camera`);
      }
    }
    const pr = v.projection;
    if (!record(pr)) c.error('projection', `${path}.projection`);
    else if (pr.type === 'perspective') {
      c.keys(pr, ['type', 'fovRad'], `${path}.projection`);
      if (!finite(pr.fovRad) || pr.fovRad <= 0 || pr.fovRad >= Math.PI)
        c.error('projection-fov', `${path}.projection.fovRad`);
    } else if (pr.type === 'orthographic') {
      c.keys(pr, ['type', 'spanMm'], `${path}.projection`);
      if (
        !finite(pr.spanMm) ||
        pr.spanMm < cadLimits.minDimensionMm ||
        pr.spanMm > cadLimits.maxDimensionMm
      )
        c.error('projection-span', `${path}.projection.spanMm`);
    } else c.error('projection', `${path}.projection.type`);
  }
  return c.d;
}
export class CadValidationError extends Error {
  constructor(readonly diagnostics: CadDiagnostic[]) {
    super(`cad-invalid:${diagnostics[0]?.code ?? 'unknown'}@${diagnostics[0]?.path ?? '$'}`);
  }
}
export function assertCad(value: unknown): asserts value is CadDocument {
  const errors = validateCad(value).filter((d) => d.severity === 'error');
  if (errors.length) throw new CadValidationError(errors);
}
export type { ParameterValues };
