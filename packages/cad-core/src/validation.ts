import { canonicalJson } from '@editor-platform/artifact-core';
import { assemblyKeys, validateAssembly } from './assembly-validation';
import {
  cadExpressionLimits,
  CadExpressionError,
  checkExpressionShape,
  evaluateExpression,
  type CadExprType,
  type CadParameterType,
} from './expression';
import {
  dependencyOrder,
  evaluateParameters,
  parameterValueCode,
  evaluationOrder,
  featureKind,
  upstreamFeatures,
  type ParameterValues,
} from './graph';
import {
  cadAssetMediaTypes,
  cadLengthUnits,
  cadBooleanTools,
  cadLoftSections,
  cadBoundaryCurves,
  cadSewInputs,
  cadSewToleranceMm,
  cadLimits,
  cadPatternCopies,
  cadShellOpenFaces,
  cadTolerance,
  cadToleranceSetOf,
  quaternionNormTolerance,
  type CadAssetKind,
  type CadKernelProfile,
  type CadDiagnostic,
  type CadDocument,
  type CadParameter,
} from './model';
import {
  cadSketchLimits,
  pathSamples,
  regionExtremes,
  sketchMismatches,
  sketchPath,
  sketchRegion,
  sketchElement,
  splineSelfIntersects,
  sketchSolvedKeys,
  type CadSketch,
  type SketchPathGeometry,
  type SketchRegionGeometry,
} from './sketch';
import { cadTopologyLimits, faceNameFits, faceNameKey, type CadTopologyKind } from './topology';

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
  /** Each ID with the path that used it first. */
  ids = new Map<string, string>();
  params: Map<string, { type: CadParameterType; value: number }> = new Map();
  /** Expression nodes in the whole document. */
  nodes = 0;
  /** Topology references in the whole document. */
  refs = 0;
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
    const first = this.ids.get(v);
    if (first !== undefined) {
      this.d.push({ code: 'duplicate-id', path, severity: 'error', firstPath: first, id: v });
      return false;
    }
    this.ids.set(v, path);
    return true;
  }
  name(v: unknown, path: string) {
    return cadName(v) || this.error('name', path);
  }
  /** Shape, schema and type of an expression; its value against the evaluated parameters. */
  expression(v: unknown, path: string, type: CadExprType): number | undefined {
    try {
      checkExpressionShape(v, cadId);
      this.nodes += ((v as Rec).postfix as unknown[]).length;
      const r = evaluateExpression(v as never, this.params);
      if (r.type !== type) return void this.error('expression-type', path);
      return r.value;
    } catch (e) {
      const x = e instanceof CadExpressionError ? e : new CadExpressionError('expression');
      return void this.error(x.code, x.node === undefined ? path : `${path}.postfix[${x.node}]`);
    }
  }
  /** Validates a Length and returns its resolved mm value. */
  length(v: unknown, path: string, use: 'coordinate' | 'dimension'): number | undefined {
    if (!record(v)) return void this.error('length', path);
    let value: number;
    if (Object.hasOwn(v, 'expression')) {
      if (!this.keys(v, ['expression'], path)) return;
      const r = this.expression(v.expression, `${path}.expression`, 'length');
      if (r === undefined) return;
      value = r;
    } else if (Object.hasOwn(v, 'literalMm')) {
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
  /** Validates a Count and returns its whole-number value (1–1,000). */
  count(v: unknown, path: string): number | undefined {
    if (!record(v)) return void this.error('count', path);
    let value: number;
    if (Object.hasOwn(v, 'expression')) {
      if (!this.keys(v, ['expression'], path)) return;
      const r = this.expression(v.expression, `${path}.expression`, 'scalar');
      if (r === undefined) return;
      value = r;
    } else if (Object.hasOwn(v, 'literal')) {
      if (!this.keys(v, ['literal'], path) || !finite(v.literal))
        return void this.error('count', path);
      value = v.literal;
    } else {
      if (!this.keys(v, ['parameterId'], path)) return;
      const p = this.params.get(v.parameterId as string);
      if (!p) return void this.error('parameter-missing', path);
      if (p.type !== 'count') return void this.error('parameter-type', path);
      value = p.value;
    }
    if (parameterValueCode('count', value)) return void this.error('count-range', path);
    return value;
  }
  /** A unit vector in world axes. */
  unit(v: unknown, path: string, code: string): v is [number, number, number] {
    return (
      (tuple(v, 3) &&
        v.every(finite) &&
        Math.abs(Math.hypot(...(v as number[])) - 1) <= quaternionNormTolerance) ||
      this.error(code, path)
    );
  }
  /** Pattern copies in the whole document. */
  copies = 0;
  /** A dimension angle is in (0, 2π]; a joint angle (R2b-2) within one turn either way. */
  angle(v: unknown, path: string, use: 'dimension' | 'joint' = 'dimension'): number | undefined {
    if (!record(v)) return void this.error('angle', path);
    let value: number;
    if (Object.hasOwn(v, 'expression')) {
      if (!this.keys(v, ['expression'], path)) return;
      const r = this.expression(v.expression, `${path}.expression`, 'angle');
      if (r === undefined) return;
      value = r;
    } else if (Object.hasOwn(v, 'literalRad')) {
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
    if (use === 'joint' ? !(Math.abs(value) <= 2 * Math.PI) : !(value > 0 && value <= 2 * Math.PI))
      return void this.error('angle-range', path);
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
  /**
   * A stored topology reference (docs/cad/r1-modeling.md, 参照の形): its kind, an input of the
   * feature that uses it, a well-formed name, an optional `select` and a finite hint. Whether it
   * resolves is decided by evaluation, never here.
   */
  ref(v: unknown, path: string, kind: CadTopologyKind, inputs: unknown): boolean {
    this.refs++;
    if (!record(v)) return this.error('reference', path);
    if (!this.keys(v, ['kind', 'featureId', 'name', 'hint'], path, ['select'])) return false;
    let ok = true;
    if (v.kind !== kind) ok = this.error('reference-kind', `${path}.kind`);
    if (!Array.isArray(inputs) || !inputs.includes(v.featureId))
      ok = this.error('reference-feature', `${path}.featureId`);
    if (!topoName(v.name, kind)) ok = this.error('reference-name', `${path}.name`);
    if (Object.hasOwn(v, 'select')) {
      const sel = v.select;
      const sp = `${path}.select`;
      if (!record(sel) || !this.keys(sel, ['adjacent'], sp))
        ok = this.error('reference-select', sp);
      else if (
        !Array.isArray(sel.adjacent) ||
        !sel.adjacent.length ||
        sel.adjacent.length > cadTopologyLimits.refsPerFeature ||
        !sel.adjacent.every((n) => topoName(n, kind)) ||
        new Set(sel.adjacent.map((n) => JSON.stringify(n))).size !== sel.adjacent.length
      )
        ok = this.error('reference-select', `${sp}.adjacent`);
    }
    const h = v.hint;
    const hp = `${path}.hint`;
    if (!record(h) || !this.keys(h, ['centroid', 'size'], hp, ['normal']))
      return this.error('reference-hint', hp);
    if (!this.vec3(h.centroid, `${hp}.centroid`)) ok = false;
    if (Object.hasOwn(h, 'normal')) {
      const n = h.normal;
      if (!tuple(n, 3) || !n.every(finite) || Math.abs(Math.hypot(...(n as number[])) - 1) > 1e-6)
        ok = this.error('reference-hint', `${hp}.normal`);
    }
    if (!finite(h.size) || h.size < 0) ok = this.error('reference-hint', `${hp}.size`);
    return ok;
  }
  /** `min`–`max` (default 1–256) distinct references of one kind. */
  refList(
    v: unknown,
    path: string,
    kind: CadTopologyKind,
    inputs: unknown,
    min = 1,
    max: number = cadTopologyLimits.refsPerFeature,
  ) {
    if (!Array.isArray(v) || v.length < min || v.length > max)
      return void this.error('reference-count', path);
    v.forEach((r, i) => this.ref(r, `${path}[${i}]`, kind, inputs));
    const keys = v.map((r) => JSON.stringify(record(r) ? [r.featureId, r.name, r.select] : r));
    if (new Set(keys).size !== keys.length) this.error('reference-duplicate', path);
  }
}
/** A face name (1–64 segments, 1,024 characters), or the sorted face names of an edge. */
const faceName = (v: unknown): v is string[] =>
  Array.isArray(v) &&
  v.length > 0 &&
  v.every((s) => typeof s === 'string' && s.length > 0 && !/\p{Cc}/u.test(s)) &&
  faceNameFits(v);
/** One face name for a face, two for an edge, and 1–64 (the faces around it) for a vertex. */
function topoName(v: unknown, kind: CadTopologyKind): boolean {
  if (!Array.isArray(v) || !v.every(faceName)) return false;
  if (
    kind === 'vertex'
      ? !v.length || v.length > cadTopologyLimits.nameSegments
      : v.length !== (kind === 'face' ? 1 : 2)
  )
    return false;
  const keys = v.map(faceNameKey);
  return keys.every((k, i) => i === 0 || keys[i - 1]! <= k);
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

/** Element and constraint fields: the element types each may name. */
const sketchFields: Record<string, [string, string[]][]> = {
  coincident: [
    ['a', ['point']],
    ['b', ['point']],
  ],
  horizontal: [['line', ['line']]],
  vertical: [['line', ['line']]],
  parallel: [
    ['a', ['line']],
    ['b', ['line']],
  ],
  perpendicular: [
    ['a', ['line']],
    ['b', ['line']],
  ],
  tangent: [
    ['a', ['line', 'arc', 'circle']],
    ['b', ['line', 'arc', 'circle']],
  ],
  equal: [
    ['a', ['line', 'arc', 'circle']],
    ['b', ['line', 'arc', 'circle']],
  ],
  midpoint: [
    ['point', ['point']],
    ['line', ['line']],
  ],
  pointOnLine: [
    ['point', ['point']],
    ['line', ['line']],
  ],
  pointOnCurve: [
    ['point', ['point']],
    ['curve', ['arc', 'circle']],
  ],
  symmetric: [
    ['a', ['point']],
    ['b', ['point']],
    ['line', ['line']],
  ],
  fix: [['point', ['point']]],
  distance: [
    ['a', ['point']],
    ['b', ['point']],
  ],
  horizontalDistance: [
    ['a', ['point']],
    ['b', ['point']],
  ],
  verticalDistance: [
    ['a', ['point']],
    ['b', ['point']],
  ],
  pointLineDistance: [
    ['point', ['point']],
    ['line', ['line']],
  ],
  angle: [
    ['a', ['line']],
    ['b', ['line']],
  ],
  radius: [['curve', ['arc', 'circle']]],
  diameter: [['curve', ['arc', 'circle']]],
};
const dimensioned = new Set([
  'distance',
  'horizontalDistance',
  'verticalDistance',
  'pointLineDistance',
  'angle',
  'radius',
  'diameter',
]);
const entityFields: Record<string, string[]> = {
  point: [],
  line: ['start', 'end'],
  arc: ['center', 'start', 'end', 'clockwise'],
  circle: ['center'],
  spline: ['poles', 'degree'],
};

/**
 * A sketch (docs/cad/r1-modeling.md, 拘束付きsketch（F2）): its plane, elements, constraints and
 * stored solution. The stored coordinates must meet every constraint with the current parameter
 * values; nothing is solved here. Returns the sketch when it is entirely valid.
 */
function validateSketch(
  c: Check,
  s: unknown,
  path: string,
  featureIds: string[],
): CadSketch | undefined {
  const before = c.d.length;
  if (!record(s)) return void c.error('sketch', path);
  c.keys(s, ['id', 'name', 'plane', 'entities', 'constraints', 'solved'], path);
  c.id(s.id, `${path}.id`);
  c.name(s.name, `${path}.name`);
  const pl = s.plane;
  const pp = `${path}.plane`;
  if (!record(pl)) c.error('plane', pp);
  else if (Object.hasOwn(pl, 'face')) {
    c.keys(pl, ['face', 'offset'], pp);
    c.ref(pl.face, `${pp}.face`, 'face', featureIds);
    c.length(pl.offset, `${pp}.offset`, 'coordinate');
  } else {
    c.keys(pl, ['origin', 'orientation'], pp);
    c.position(pl.origin, `${pp}.origin`);
    c.quaternion(pl.orientation, `${pp}.orientation`);
  }
  // Element and constraint IDs are local to the sketch and share one namespace there.
  const local = new Set<string>();
  const localId = (v: unknown, at: string) => {
    if (!cadId(v)) return c.error('id', at);
    if (local.has(v)) return c.error('sketch-duplicate-id', at);
    local.add(v);
    return true;
  };
  const types = new Map<string, string>();
  const entities = s.entities;
  const ep = `${path}.entities`;
  if (!Array.isArray(entities)) return void c.error('collection', ep);
  if (entities.length > cadSketchLimits.entities) c.error('limit-sketch-entities', ep);
  for (const [i, e] of entities.entries()) {
    const at = `${ep}[${i}]`;
    if (!record(e) || typeof e.type !== 'string' || !Object.hasOwn(entityFields, e.type)) {
      c.error('sketch-entity', at);
      continue;
    }
    c.keys(
      e,
      ['id', 'type', ...entityFields[e.type]],
      at,
      e.type === 'point' ? [] : e.type === 'spline' ? ['closed', 'construction'] : ['construction'],
    );
    if (localId(e.id, `${at}.id`)) types.set(e.id as string, e.type);
    if (Object.hasOwn(e, 'construction') && typeof e.construction !== 'boolean')
      c.error('sketch-entity', `${at}.construction`);
    if (e.type === 'arc' && typeof e.clockwise !== 'boolean')
      c.error('sketch-entity', `${at}.clockwise`);
    if (e.type === 'spline') {
      if (!(cadSketchLimits.splineDegrees as readonly unknown[]).includes(e.degree))
        c.error('sketch-spline-degree', `${at}.degree`);
      if (Object.hasOwn(e, 'closed') && typeof e.closed !== 'boolean')
        c.error('sketch-entity', `${at}.closed`);
      const [min, max] = cadSketchLimits.splinePoles;
      if (!Array.isArray(e.poles)) c.error('sketch-entity', `${at}.poles`);
      else if (
        e.poles.length < Math.max(min, typeof e.degree === 'number' ? e.degree + 1 : 0) ||
        e.poles.length > max
      )
        c.error('sketch-spline-poles', `${at}.poles`);
    }
  }
  for (const [i, e] of entities.entries()) {
    if (!record(e) || typeof e.type !== 'string' || !Object.hasOwn(entityFields, e.type)) continue;
    if (e.type === 'spline') {
      // Control points: each a point, none twice.
      if (!Array.isArray(e.poles)) continue;
      e.poles.forEach((q, j) => {
        if (types.get(q as string) !== 'point')
          c.error('sketch-reference', `${ep}[${i}].poles[${j}]`);
      });
      if (new Set(e.poles).size !== e.poles.length) c.error('sketch-degenerate', `${ep}[${i}]`);
      continue;
    }
    const ends = entityFields[e.type].filter((k) => k !== 'clockwise');
    for (const k of ends)
      if (types.get(e[k] as string) !== 'point') c.error('sketch-reference', `${ep}[${i}].${k}`);
    if (new Set(ends.map((k) => e[k])).size !== ends.length)
      c.error('sketch-degenerate', `${ep}[${i}]`);
  }
  const constraints = s.constraints;
  const cp = `${path}.constraints`;
  if (!Array.isArray(constraints)) return void c.error('collection', cp);
  if (constraints.length > cadSketchLimits.constraints) c.error('limit-sketch-constraints', cp);
  for (const [i, k] of constraints.entries()) {
    const at = `${cp}[${i}]`;
    if (!record(k) || typeof k.type !== 'string' || !Object.hasOwn(sketchFields, k.type)) {
      c.error('sketch-constraint', at);
      continue;
    }
    const fields = sketchFields[k.type];
    const dimension = k.type === 'fix' ? ['at'] : dimensioned.has(k.type) ? ['value'] : [];
    c.keys(k, ['id', 'type', ...fields.map(([f]) => f), ...dimension], at);
    localId(k.id, `${at}.id`);
    for (const [f, allowed] of fields)
      if (!allowed.includes(types.get(k[f] as string) as string))
        c.error('sketch-reference', `${at}.${f}`);
    const named = fields.map(([f]) => k[f]);
    if (new Set(named).size !== named.length) c.error('sketch-reference', at);
    const [ta, tb] = [types.get(k.a as string), types.get(k.b as string)];
    if (k.type === 'tangent' && ta === 'line' && tb === 'line') c.error('sketch-reference', at);
    if (k.type === 'equal' && ta && tb && (ta === 'line') !== (tb === 'line'))
      c.error('sketch-reference', at);
    if (k.type === 'fix') {
      if (!tuple(k.at, 2)) c.error('sketch-constraint', `${at}.at`);
      else k.at.forEach((l, j) => c.length(l, `${at}.at[${j}]`, 'coordinate'));
    } else if (k.type === 'angle') c.angle(k.value, `${at}.value`);
    else if (dimension.length) c.length(k.value, `${at}.value`, 'dimension');
  }
  const solved = s.solved;
  const sp = `${path}.solved`;
  if (!record(solved)) return void c.error('sketch-solution-mismatch', sp);
  const keys = new Set(
    sketchSolvedKeys({ entities: entities.filter(record) as CadSketch['entities'] }),
  );
  for (const id of keys)
    if (!Object.hasOwn(solved, id)) c.error('sketch-solution-mismatch', `${sp}.${id}`);
  for (const [id, v] of Object.entries(solved)) {
    const at = `${sp}.${id}`;
    if (!keys.has(id)) {
      c.error('sketch-solution-mismatch', at);
      continue;
    }
    if (!tuple(v, 2) || !v.every(finite)) {
      c.error('sketch-solved', at);
      continue;
    }
    const [x, y] = v as number[];
    if (types.get(id) === 'circle') {
      if (y !== 0) c.error('sketch-solved', at);
      if (!(x >= cadLimits.minDimensionMm && x <= cadLimits.maxDimensionMm))
        c.error('dimension-range', at);
    } else if (!(Math.abs(x) <= cadLimits.coordinateMm && Math.abs(y) <= cadLimits.coordinateMm))
      c.error('coordinate-range', at);
  }
  if (c.d.length !== before) return;
  const sketch = s as unknown as CadSketch;
  const p = (id: string) => sketch.solved[id];
  const gap = (a: string, b: string) => Math.hypot(p(a)[0] - p(b)[0], p(a)[1] - p(b)[1]);
  sketch.entities.forEach((e, i) => {
    if (
      (e.type === 'line' && gap(e.start, e.end) < cadLimits.minDimensionMm) ||
      (e.type === 'arc' &&
        (gap(e.center, e.start) < cadLimits.minDimensionMm ||
          gap(e.start, e.end) < cadLimits.minDimensionMm))
    )
      c.error('sketch-degenerate', `${ep}[${i}]`);
    if (e.type === 'spline') {
      // Neighbouring control points apart (around the loop for a closed one), and no crossing.
      const n = e.poles.length;
      const pairs = e.closed ? n : n - 1;
      for (let j = 0; j < pairs; j++)
        if (gap(e.poles[j]!, e.poles[(j + 1) % n]!) < cadLimits.minDimensionMm)
          return void c.error('sketch-degenerate', `${ep}[${i}]`);
      if (!e.closed && gap(e.poles[0]!, e.poles[n - 1]!) < cadLimits.minDimensionMm)
        return void c.error('sketch-degenerate', `${ep}[${i}]`);
      if (splineSelfIntersects(sketchElement(sketch, e.id)!))
        c.error('sketch-self-intersection', `${ep}[${i}]`);
    }
  });
  if (c.d.length !== before) return;
  // Stored coordinates against the current constraints (docs: 保存座標の検証), never re-solved.
  for (const at of sketchMismatches(sketch, c.params))
    c.error('sketch-solution-mismatch', `${path}.${at}`);
  return c.d.length === before ? sketch : undefined;
}

/** A sketch region of an extrude or revolve, checked against its (valid) sketch. */
function validateRegion(
  c: Check,
  a: Rec,
  ap: string,
  sketches: Map<string, CadSketch | undefined>,
): SketchRegionGeometry | undefined {
  if (!sketches.has(a.sketchId as string)) c.error('sketch-missing', `${ap}.sketchId`);
  const r = a.region;
  const rp = `${ap}.region`;
  if (!record(r) || !c.keys(r, ['outer', 'holes'], rp)) return void c.error('region', rp);
  if (!Array.isArray(r.holes)) return void c.error('region', `${rp}.holes`);
  if (r.holes.length > cadSketchLimits.holes)
    return void c.error('limit-region-holes', `${rp}.holes`);
  const loops = [r.outer, ...r.holes];
  if (
    !loops.every(
      (l) =>
        Array.isArray(l) && l.length > 0 && l.length <= cadSketchLimits.entities && l.every(cadId),
    )
  )
    return void c.error('region', rp);
  const sketch = sketches.get(a.sketchId as string);
  if (!sketch) return;
  const g = sketchRegion(sketch, r as never);
  if ('code' in g) return void c.error(g.code, `${rp}.${g.path}`);
  return g;
}

/**
 * A loft section or sweep profile: a valid region of a sketch, without holes (R1e). Returns the
 * section when its shape is right, whether or not the region checked out.
 */
function sweptSection(
  c: Check,
  x: unknown,
  path: string,
  sketches: Map<string, CadSketch | undefined>,
): Rec | undefined {
  if (!record(x) || !c.keys(x, ['sketchId', 'region'], path)) return void c.error('section', path);
  const g = validateRegion(c, x, path, sketches);
  if (g && g.loops.length > 1) c.error('section-holes', `${path}.region.holes`);
  return x;
}

/** K6: the scale of a derived section, a factor within these bounds. */
export const cadDerivedScale = Object.freeze({ min: 0.001, max: 1000 });
/** K6: a derived section reads an earlier sketch section (not another derived one) of its loft. */
function derivedSection(c: Check, x: Rec, path: string, earlier: unknown[]) {
  if (!c.keys(x, ['derivedFrom', 'offset', 'scale', 'angle'], path)) return;
  const from = x.derivedFrom;
  if (
    !Number.isInteger(from) ||
    (from as number) < 0 ||
    (from as number) >= earlier.length ||
    !record(earlier[from as number]) ||
    Object.hasOwn(earlier[from as number] as Rec, 'derivedFrom')
  )
    c.error('derived-section-source', `${path}.derivedFrom`);
  c.position(x.offset, `${path}.offset`);
  c.angle(x.angle, `${path}.angle`, 'joint');
  const scale = x.scale;
  let value: number | undefined;
  if (!record(scale)) return void c.error('derived-section-scale', `${path}.scale`);
  if (Object.hasOwn(scale, 'expression')) {
    if (c.keys(scale, ['expression'], `${path}.scale`))
      value = c.expression(scale.expression, `${path}.scale.expression`, 'scalar');
  } else if (c.keys(scale, ['literal'], `${path}.scale`)) {
    if (!finite(scale.literal)) return void c.error('derived-section-scale', `${path}.scale`);
    value = scale.literal;
  }
  if (value !== undefined && !(value >= cadDerivedScale.min && value <= cadDerivedScale.max))
    c.error('derived-section-scale', `${path}.scale`);
}

const primitiveArgs: Record<string, string[]> = {
  box: ['size', 'origin', 'orientation'],
  cylinder: ['radius', 'height', 'origin', 'orientation'],
  sphere: ['radius', 'origin', 'orientation'],
};
/** Whether `n` inputs fit the feature type; false for anything that is not a supported type. */
const arityOk = (type: unknown, n: number) => {
  if (typeof type !== 'string' || !Object.hasOwn(featureArity, type)) return false;
  const [min, max] = featureArity[type]!;
  return n >= min && n <= max;
};
/** Input counts `[min, max]`: a Boolean has its target and 1–256 tools. */
const featureArity: Record<string, [number, number]> = {
  box: [0, 0],
  cylinder: [0, 0],
  sphere: [0, 0],
  extrude: [0, 0],
  revolve: [0, 0],
  loft: [0, 0],
  sweep: [0, 0],
  extrudeSurface: [0, 0],
  revolveSurface: [0, 0],
  surfaceLoft: [0, 0],
  surfaceSweep: [0, 0],
  boundarySurface: [0, 0],
  fill: [0, 0],
  transform: [1, 1],
  boolean: [2, 1 + cadBooleanTools],
  imported: [0, 0],
  fillet: [1, 1],
  chamfer: [1, 1],
  shell: [1, 1],
  draft: [1, 1],
  pattern: [2, 2],
  mirror: [1, 1],
  trim: [1, 1],
  sew: [2, cadSewInputs],
  thicken: [1, 1],
};
const sha256Ref = (v: unknown): v is string =>
  typeof v === 'string' && /^sha256:[0-9a-f]{64}$/.test(v);
const assetBytes: Record<CadAssetKind, number> = {
  'source-step': cadLimits.stepBytes,
  'normalized-brep': cadLimits.brepBytes,
};

/** D2 asset refs: shape, per-kind media type and size, one ref per kind and hash. */
function validateAssets(c: Check, assets: unknown[]): Map<string, CadAssetKind> {
  const kinds = new Map<string, CadAssetKind>();
  const hashes = new Set<string>();
  let total = 0;
  if (assets.length > cadLimits.assets) c.error('limit-assets', '$.assets');
  for (const [i, a] of assets.entries()) {
    const path = `$.assets[${i}]`;
    if (!record(a)) {
      c.error('asset', path);
      continue;
    }
    c.keys(a, ['id', 'kind', 'sha256', 'byteLength', 'mediaType'], path);
    const idOk = c.id(a.id, `${path}.id`);
    if (a.kind !== 'source-step' && a.kind !== 'normalized-brep') {
      c.error('asset-kind', `${path}.kind`);
      continue;
    }
    if (!sha256Ref(a.sha256)) c.error('asset-hash', `${path}.sha256`);
    else if (hashes.has(`${a.kind} ${a.sha256}`)) c.error('asset-duplicate', `${path}.sha256`);
    else hashes.add(`${a.kind} ${a.sha256}`);
    const n = a.byteLength;
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1 || n > assetBytes[a.kind])
      c.error('asset-size', `${path}.byteLength`);
    else total += n;
    if (a.mediaType !== cadAssetMediaTypes[a.kind])
      c.error('asset-media-type', `${path}.mediaType`);
    if (idOk) kinds.set(a.id as string, a.kind);
  }
  if (total > cadLimits.assetBytes) c.error('limit-asset-bytes', '$.assets');
  return kinds;
}

/** Features whose inputs must be sheets (R2a-3): trim, sew and thicken. */
const needsSheet = (f: CadDocument['features'][number]) =>
  f.type === 'trim' || f.type === 'sew' || f.type === 'thicken';
/** Features whose inputs must be solids: Booleans, detail features and a mirror's union. */
const needsSolid = (f: CadDocument['features'][number]) =>
  ['boolean', 'fillet', 'chamfer', 'shell', 'draft', 'pattern'].includes(f.type) ||
  (f.type === 'mirror' && (f.args as { union?: unknown } | null | undefined)?.union !== false);
/** A sweep's or surface feature's `{ sketchId, elements }` chain, checked against its sketch. */
function validatePath(
  c: Check,
  path: unknown,
  pp: string,
  sketches: Map<string, CadSketch | undefined>,
  closed: 'allow' | 'refuse',
): { sketch: CadSketch; g: SketchPathGeometry } | undefined {
  if (!record(path) || !c.keys(path, ['sketchId', 'elements'], pp))
    return void c.error('sweep-path', pp);
  if (!sketches.has(path.sketchId as string)) c.error('sketch-missing', `${pp}.sketchId`);
  const ids = path.elements;
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    ids.length > cadSketchLimits.entities ||
    !ids.every(cadId)
  )
    return void c.error('sweep-path', `${pp}.elements`);
  const sketch = sketches.get(path.sketchId as string);
  if (!sketch) return;
  const g = sketchPath(sketch, ids as string[], closed);
  if ('code' in g) return void c.error(g.code, `${pp}.elements${g.path}`);
  return { sketch, g };
}
/**
 * A surface feature's boundary curves (R2a-2c): each one line, arc or open spline of a sketch, or
 * a reference to an edge of a feature's result, each once. Whether they close a loop in space is
 * decided by the kernel (`boundary-open`), as sketch frames may come from faces.
 */
function validateCurves(
  c: Check,
  curves: [unknown, string][],
  sketches: Map<string, CadSketch | undefined>,
  featureIds: string[],
) {
  const seen = new Set<string>();
  for (const [x, cp] of curves) {
    if (!record(x)) {
      c.error('boundary-curve', cp);
      continue;
    }
    if (Object.hasOwn(x, 'edge')) {
      c.keys(x, ['edge'], cp);
      if (c.ref(x.edge, `${cp}.edge`, 'edge', featureIds)) {
        const e = x.edge as { featureId: unknown; name: unknown; select?: unknown };
        const key = JSON.stringify([e.featureId, e.name, e.select]);
        if (seen.has(key)) c.error('boundary-curve-duplicate', cp);
        seen.add(key);
      }
      continue;
    }
    if (!c.keys(x, ['sketchId', 'element'], cp)) continue;
    if (!sketches.has(x.sketchId as string)) {
      c.error('sketch-missing', `${cp}.sketchId`);
      continue;
    }
    const sketch = sketches.get(x.sketchId as string);
    if (!sketch) continue;
    const e = typeof x.element === 'string' ? sketchElement(sketch, x.element) : undefined;
    // One curve with two ends: a circle or a closed spline is a loop by itself.
    if (!e || e.ends.length !== 2) {
      c.error('boundary-curve', `${cp}.element`);
      continue;
    }
    const key = JSON.stringify([x.sketchId, x.element]);
    if (seen.has(key)) c.error('boundary-curve-duplicate', cp);
    seen.add(key);
  }
}
function validateFeature(
  c: Check,
  f: unknown,
  path: string,
  profiles: Map<string, Profile2D | undefined>,
  sketches: Map<string, CadSketch | undefined>,
  assets: Map<string, CadAssetKind>,
  used: Set<string>,
  featureIds: string[],
) {
  if (!record(f)) return void c.error('feature', path);
  c.keys(f, ['id', 'name', 'type', 'inputFeatureIds', 'args'], path);
  c.id(f.id, `${path}.id`);
  c.name(f.name, `${path}.name`);
  if (typeof f.type !== 'string' || !Object.hasOwn(featureArity, f.type))
    return void c.error('feature-type', `${path}.type`);
  const inputs = f.inputFeatureIds;
  if (!Array.isArray(inputs) || !arityOk(f.type, inputs.length) || !inputs.every(cadId))
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
      if (Object.hasOwn(a, 'sketchId')) {
        c.keys(a, ['sketchId', 'region', 'distance', 'direction'], ap);
        validateRegion(c, a, ap, sketches);
      } else {
        c.keys(a, ['profileId', 'distance', 'direction'], ap);
        if (!profiles.has(a.profileId as string)) c.error('profile-missing', `${ap}.profileId`);
      }
      c.length(a.distance, `${ap}.distance`, 'dimension');
      if (a.direction !== 1 && a.direction !== -1) c.error('extrude-direction', `${ap}.direction`);
      return;
    case 'revolve': {
      const fromSketch = Object.hasOwn(a, 'sketchId');
      c.keys(
        a,
        [
          fromSketch ? 'sketchId' : 'profileId',
          ...(fromSketch ? ['region'] : []),
          'axisOrigin',
          'axisDirection',
          'angle',
        ],
        ap,
      );
      c.angle(a.angle, `${ap}.angle`);
      let profile = profiles.get(a.profileId as string);
      let region: SketchRegionGeometry | undefined;
      if (fromSketch) region = validateRegion(c, a, ap, sketches);
      else if (!profiles.has(a.profileId as string)) c.error('profile-missing', `${ap}.profileId`);
      if (!tuple(a.axisOrigin, 2)) return void c.error('revolve-axis', `${ap}.axisOrigin`);
      const o = a.axisOrigin.map((l, i) => c.length(l, `${ap}.axisOrigin[${i}]`, 'coordinate'));
      const dir = a.axisDirection;
      if (!tuple(dir, 2) || !dir.every(finite))
        return void c.error('revolve-axis', `${ap}.axisDirection`);
      const [dx, dy] = dir as number[];
      if (Math.abs(Math.hypot(dx, dy) - 1) > quaternionNormTolerance)
        return void c.error('axis-norm', `${ap}.axisDirection`);
      if (region) profile = { points: regionExtremes(region, [-dy, dx]) };
      if (!profile || o.some((x) => x === undefined)) return;
      const [ox, oy] = o as number[];
      const side = (p: Pt) => dx * (p[1] - oy) - dy * (p[0] - ox);
      const eps = cadTolerance.linearToleranceMm;
      const crosses = profile.circle
        ? Math.abs(side(profile.circle.center)) < profile.circle.radius - eps
        : profile.points.some((p) => side(p) > eps) && profile.points.some((p) => side(p) < -eps);
      if (crosses) c.error('revolve-crosses-axis', ap);
      return;
    }
    case 'loft': {
      c.keys(a, ['sections', 'ruled'], ap);
      if (typeof a.ruled !== 'boolean') c.error('loft-ruled', `${ap}.ruled`);
      const sections = a.sections;
      if (!Array.isArray(sections) || sections.length < 2)
        return void c.error('loft-sections', `${ap}.sections`);
      if (sections.length > cadLoftSections)
        return void c.error('limit-loft-sections', `${ap}.sections`);
      const seen = new Set<unknown>();
      sections.forEach((x, i) => {
        const sp = `${ap}.sections[${i}]`;
        // K6: a section derived from an earlier sketch section of this loft.
        if (record(x) && Object.hasOwn(x, 'derivedFrom'))
          return void derivedSection(c, x, sp, sections.slice(0, i));
        const section = sweptSection(c, x, sp, sketches);
        if (!section) return;
        // Each section lies on a plane of its own: two regions of one sketch are coplanar.
        if (seen.has(section.sketchId)) c.error('loft-same-sketch', `${sp}.sketchId`);
        seen.add(section.sketchId);
      });
      return;
    }
    case 'sweep': {
      c.keys(a, ['profile', 'path', 'orientation'], ap);
      if (a.orientation !== 'frenet' && a.orientation !== 'fixed')
        c.error('sweep-orientation', `${ap}.orientation`);
      const profile = sweptSection(c, a.profile, `${ap}.profile`, sketches);
      const pp = `${ap}.path`;
      // In its own sketch the profile would lie in the path's plane.
      if (profile && record(a.path) && a.path.sketchId === profile.sketchId)
        c.error('sweep-same-sketch', `${pp}.sketchId`);
      validatePath(c, a.path, pp, sketches, 'refuse');
      return;
    }
    case 'extrudeSurface':
      c.keys(a, ['path', 'distance', 'direction'], ap);
      validatePath(c, a.path, `${ap}.path`, sketches, 'allow');
      c.length(a.distance, `${ap}.distance`, 'dimension');
      if (a.direction !== 1 && a.direction !== -1) c.error('extrude-direction', `${ap}.direction`);
      return;
    case 'revolveSurface': {
      c.keys(a, ['path', 'axisOrigin', 'axisDirection', 'angle'], ap);
      c.angle(a.angle, `${ap}.angle`);
      const chain = validatePath(c, a.path, `${ap}.path`, sketches, 'allow');
      if (!tuple(a.axisOrigin, 2)) return void c.error('revolve-axis', `${ap}.axisOrigin`);
      const o = a.axisOrigin.map((l, i) => c.length(l, `${ap}.axisOrigin[${i}]`, 'coordinate'));
      const dir = a.axisDirection;
      if (!tuple(dir, 2) || !dir.every(finite))
        return void c.error('revolve-axis', `${ap}.axisDirection`);
      const [dx, dy] = dir as number[];
      if (Math.abs(Math.hypot(dx, dy) - 1) > quaternionNormTolerance)
        return void c.error('axis-norm', `${ap}.axisDirection`);
      if (!chain || o.some((x) => x === undefined)) return;
      const [ox, oy] = o as number[];
      const side = (p: Pt) => dx * (p[1] - oy) - dy * (p[0] - ox);
      const eps = cadTolerance.linearToleranceMm;
      const points = pathSamples(chain.g);
      if (points.some((p) => side(p) > eps) && points.some((p) => side(p) < -eps))
        c.error('revolve-crosses-axis', ap);
      return;
    }
    case 'surfaceLoft': {
      c.keys(a, ['sections', 'ruled'], ap);
      if (typeof a.ruled !== 'boolean') c.error('loft-ruled', `${ap}.ruled`);
      const sections = a.sections;
      if (!Array.isArray(sections) || sections.length < 2)
        return void c.error('loft-sections', `${ap}.sections`);
      if (sections.length > cadLoftSections)
        return void c.error('limit-loft-sections', `${ap}.sections`);
      const seen = new Set<unknown>();
      let closed: boolean | undefined;
      sections.forEach((x, i) => {
        const sp = `${ap}.sections[${i}]`;
        // A chain of edges of a result (R2a-2c): read, never consumed; the kernel chains them.
        if (record(x) && Object.hasOwn(x, 'edges')) {
          c.keys(x, ['edges'], sp);
          c.refList(x.edges, `${sp}.edges`, 'edge', featureIds);
          return;
        }
        const chain = validatePath(c, x, sp, sketches, 'allow');
        if (!chain) return;
        if (seen.has(chain.sketch.id)) c.error('loft-same-sketch', `${sp}.sketchId`);
        seen.add(chain.sketch.id);
        // A loft joins open chains end to end, or loops; one of each has no surface between.
        if (closed !== undefined && chain.g.closed !== closed)
          c.error('loft-section-closure', `${sp}.elements`);
        closed ??= chain.g.closed;
      });
      return;
    }
    case 'surfaceSweep': {
      c.keys(a, ['profile', 'path', 'orientation'], ap);
      if (a.orientation !== 'frenet' && a.orientation !== 'fixed')
        c.error('sweep-orientation', `${ap}.orientation`);
      const profile = validatePath(c, a.profile, `${ap}.profile`, sketches, 'allow');
      const pp = `${ap}.path`;
      if (profile && record(a.path) && a.path.sketchId === profile.sketch.id)
        c.error('sweep-same-sketch', `${pp}.sketchId`);
      validatePath(c, a.path, pp, sketches, 'refuse');
      return;
    }
    case 'boundarySurface': {
      c.keys(a, ['curves'], ap);
      const [min, max] = cadBoundaryCurves.surface;
      if (!Array.isArray(a.curves) || a.curves.length < min || a.curves.length > max)
        return void c.error('boundary-curves', `${ap}.curves`);
      validateCurves(
        c,
        a.curves.map((x, i) => [x, `${ap}.curves[${i}]`]),
        sketches,
        featureIds,
      );
      return;
    }
    case 'fill': {
      c.keys(a, ['boundary'], ap);
      const [min, max] = cadBoundaryCurves.fill;
      const list = a.boundary;
      if (!Array.isArray(list) || list.length < min || list.length > max)
        return void c.error('fill-boundary', `${ap}.boundary`);
      const curves: [unknown, string][] = [];
      list.forEach((b, i) => {
        const bp = `${ap}.boundary[${i}]`;
        if (!record(b) || !c.keys(b, ['curve', 'continuity'], bp))
          return void c.error('fill-boundary', bp);
        if (b.continuity !== 'G0' && b.continuity !== 'G1')
          c.error('fill-continuity', `${bp}.continuity`);
        // G1 meets the face beside a referenced edge; a sketch curve has none.
        else if (b.continuity === 'G1' && record(b.curve) && !Object.hasOwn(b.curve, 'edge'))
          c.error('fill-no-adjacent-face', `${bp}.continuity`);
        curves.push([b.curve, `${bp}.curve`]);
      });
      validateCurves(c, curves, sketches, featureIds);
      return;
    }
    case 'trim': {
      c.keys(a, ['tool', 'keep'], ap);
      const t = a.tool;
      const tp = `${ap}.tool`;
      let sides: string[] = ['front', 'back'];
      if (record(t) && Object.hasOwn(t, 'sketchId')) {
        // A closed chain cut along its sketch's normal: its inside or its outside is kept.
        sides = ['inside', 'outside'];
        const chain = validatePath(c, t, tp, sketches, 'allow');
        if (chain && !chain.g.closed) c.error('trim-tool-open', `${tp}.elements`);
      } else if (record(t) && Object.hasOwn(t, 'plane')) {
        c.keys(t, ['plane'], tp);
        const pl = t.plane;
        if (!record(pl) || !c.keys(pl, ['origin', 'normal'], `${tp}.plane`))
          c.error('trim-tool', `${tp}.plane`);
        else {
          c.position(pl.origin, `${tp}.plane.origin`);
          c.unit(pl.normal, `${tp}.plane.normal`, 'trim-normal');
        }
      } else if (record(t) && Object.hasOwn(t, 'featureId')) {
        // Another sheet's result, read like a referenced edge's feature (never consumed).
        c.keys(t, ['featureId'], tp);
        if (!featureIds.includes(t.featureId as string))
          c.error('reference-feature', `${tp}.featureId`);
        else if (Array.isArray(inputs) && inputs.includes(t.featureId))
          c.error('trim-tool-self', `${tp}.featureId`);
      } else return void c.error('trim-tool', tp);
      if (!sides.includes(a.keep as string)) c.error('trim-keep', `${ap}.keep`);
      return;
    }
    case 'sew': {
      c.keys(a, ['toleranceMm', 'solid'], ap);
      const [min, max] = cadSewToleranceMm;
      const t = a.toleranceMm;
      if (!finite(t) || t < min || t > max) c.error('sew-tolerance', `${ap}.toleranceMm`);
      if (typeof a.solid !== 'boolean') c.error('sew-solid', `${ap}.solid`);
      if (Array.isArray(inputs) && new Set(inputs).size !== inputs.length)
        c.error('sew-same-input', `${path}.inputFeatureIds`);
      return;
    }
    case 'thicken':
      c.keys(a, ['thickness', 'side'], ap);
      c.length(a.thickness, `${ap}.thickness`, 'dimension');
      if (a.side !== 'front' && a.side !== 'back' && a.side !== 'both')
        c.error('thicken-side', `${ap}.side`);
      return;
    case 'transform':
      c.keys(a, ['translation', 'rotation'], ap);
      c.position(a.translation, `${ap}.translation`);
      c.quaternion(a.rotation, `${ap}.rotation`);
      return;
    case 'boolean':
      c.keys(a, ['mode'], ap);
      if (!['union', 'cut', 'common'].includes(a.mode as string))
        c.error('boolean-mode', `${ap}.mode`);
      if (Array.isArray(inputs) && new Set(inputs).size !== inputs.length)
        c.error('boolean-same-input', `${path}.inputFeatureIds`);
      return;
    case 'fillet':
      c.keys(a, ['edges', 'radius'], ap);
      c.refList(a.edges, `${ap}.edges`, 'edge', inputs);
      c.length(a.radius, `${ap}.radius`, 'dimension');
      return;
    case 'shell':
      c.keys(a, ['openFaces', 'thickness', 'side'], ap);
      c.refList(a.openFaces, `${ap}.openFaces`, 'face', inputs, 0, cadShellOpenFaces);
      c.length(a.thickness, `${ap}.thickness`, 'dimension');
      if (a.side !== 'inside' && a.side !== 'outside') c.error('shell-side', `${ap}.side`);
      return;
    case 'pattern': {
      c.keys(a, ['mode', 'layout'], ap);
      if (a.mode !== 'union' && a.mode !== 'cut') c.error('pattern-mode', `${ap}.mode`);
      if (Array.isArray(inputs) && inputs.length === 2 && inputs[0] === inputs[1])
        c.error('boolean-same-input', `${path}.inputFeatureIds`);
      const l = a.layout;
      const lp = `${ap}.layout`;
      if (!record(l) || (l.type !== 'linear' && l.type !== 'circular' && l.type !== 'curve'))
        return void c.error('pattern-layout', lp);
      if (l.type === 'curve') {
        // K5a: along an open chain of lines and arcs a sketch draws.
        c.keys(l, ['type', 'path', 'count', 'align'], lp);
        const chain = validatePath(c, l.path, `${lp}.path`, sketches, 'refuse');
        const spline = chain?.g.elements.findIndex((e) => e.type === 'spline') ?? -1;
        if (spline >= 0) c.error('pattern-path', `${lp}.path.elements[${spline}]`);
        if (typeof l.align !== 'boolean') c.error('pattern-align', `${lp}.align`);
      } else if (l.type === 'linear') {
        c.keys(l, ['type', 'direction', 'count', 'spacing'], lp);
        c.unit(l.direction, `${lp}.direction`, 'pattern-direction');
        c.length(l.spacing, `${lp}.spacing`, 'dimension');
      } else {
        c.keys(l, ['type', 'axisOrigin', 'axisDirection', 'count', 'angle'], lp);
        c.position(l.axisOrigin, `${lp}.axisOrigin`);
        c.unit(l.axisDirection, `${lp}.axisDirection`, 'pattern-direction');
        c.angle(l.angle, `${lp}.angle`);
      }
      const n = c.count(l.count, `${lp}.count`);
      if (n !== undefined) c.copies += n;
      return;
    }
    case 'mirror': {
      c.keys(a, ['plane', 'union'], ap);
      if (typeof a.union !== 'boolean') c.error('mirror-union', `${ap}.union`);
      const pl = a.plane;
      const pp = `${ap}.plane`;
      if (!record(pl)) return void c.error('mirror-plane', pp);
      if (Object.hasOwn(pl, 'face')) {
        c.keys(pl, ['face'], pp);
        c.ref(pl.face, `${pp}.face`, 'face', inputs);
      } else {
        c.keys(pl, ['origin', 'normal'], pp);
        c.position(pl.origin, `${pp}.origin`);
        c.unit(pl.normal, `${pp}.normal`, 'mirror-normal');
      }
      return;
    }
    case 'draft': {
      c.keys(a, ['faces', 'neutral', 'angle', 'direction'], ap);
      c.refList(a.faces, `${ap}.faces`, 'face', inputs);
      c.ref(a.neutral, `${ap}.neutral`, 'face', inputs);
      const angle = c.angle(a.angle, `${ap}.angle`);
      if (angle !== undefined && angle > Math.PI / 4) c.error('draft-angle', `${ap}.angle`);
      const d = a.direction;
      if (
        !tuple(d, 3) ||
        !d.every(finite) ||
        Math.abs(Math.hypot(...(d as number[])) - 1) > quaternionNormTolerance
      )
        c.error('draft-direction', `${ap}.direction`);
      return;
    }
    case 'chamfer': {
      const two = Object.hasOwn(a, 'distance2') || Object.hasOwn(a, 'face');
      c.keys(a, ['edges', 'distance', ...(two ? ['distance2', 'face'] : [])], ap);
      c.refList(a.edges, `${ap}.edges`, 'edge', inputs);
      c.length(a.distance, `${ap}.distance`, 'dimension');
      if (two) {
        c.length(a.distance2, `${ap}.distance2`, 'dimension');
        c.ref(a.face, `${ap}.face`, 'face', inputs);
      }
      return;
    }
    case 'imported': {
      c.keys(
        a,
        ['kind', 'sourceAssetId', 'brepAssetId', 'importer', 'sourceUnit', 'scaleToMm'],
        ap,
      );
      if (a.kind !== 'solid' && a.kind !== 'sheet') c.error('body-kind', `${ap}.kind`);
      for (const [key, kind] of [
        ['sourceAssetId', 'source-step'],
        ['brepAssetId', 'normalized-brep'],
      ] as const) {
        if (assets.get(a[key] as string) !== kind) c.error('asset-missing', `${ap}.${key}`);
        else used.add(a[key] as string);
      }
      const im = a.importer;
      if (!record(im)) c.error('importer', `${ap}.importer`);
      else {
        c.keys(im, ['id', 'buildHash'], `${ap}.importer`);
        if (!cadId(im.id)) c.error('id', `${ap}.importer.id`);
        if (typeof im.buildHash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(im.buildHash))
          c.error('kernel-build-hash', `${ap}.importer.buildHash`);
      }
      const unit = a.sourceUnit;
      if (typeof unit !== 'string' || !Object.hasOwn(cadLengthUnits, unit))
        c.error('source-unit', `${ap}.sourceUnit`);
      else if (a.scaleToMm !== cadLengthUnits[unit as keyof typeof cadLengthUnits])
        c.error('source-scale', `${ap}.scaleToMm`);
    }
  }
}

/**
 * Parameter shapes, then values in dependency order. Only parameters that evaluate enter
 * `c.params`, so a reference to a broken one reports `parameter-missing` where it is read.
 */
function validateParameters(c: Check, parameters: unknown[]) {
  const shaped: { index: number; p: CadParameter }[] = [];
  for (const [i, p] of parameters.entries()) {
    const path = `$.parameters[${i}]`;
    if (!record(p)) {
      c.error('parameter', path);
      continue;
    }
    const expression = Object.hasOwn(p, 'expression');
    c.keys(p, ['id', 'name', 'type', expression ? 'expression' : 'value'], path);
    c.name(p.name, `${path}.name`);
    const idOk = c.id(p.id, `${path}.id`);
    const typeOk = p.type === 'length' || p.type === 'angle' || p.type === 'count';
    if (!typeOk) c.error('parameter-type', `${path}.type`);
    let ok = idOk && typeOk;
    if (expression) {
      try {
        checkExpressionShape(p.expression, cadId);
        c.nodes += ((p.expression as Rec).postfix as unknown[]).length;
      } catch (e) {
        const x = e instanceof CadExpressionError ? e : new CadExpressionError('expression');
        const at = `${path}.expression`;
        ok = c.error(x.code, x.node === undefined ? at : `${at}.postfix[${x.node}]`);
      }
    } else if (!finite(p.value)) ok = c.error('parameter-value', `${path}.value`);
    if (ok) shaped.push({ index: i, p: p as CadParameter });
  }
  const { values, errors } = evaluateParameters(shaped.map((s) => s.p));
  for (const e of errors) {
    const { index, p } = shaped[e.index];
    const at = `$.parameters[${index}].${'expression' in p ? 'expression' : 'value'}`;
    c.error(e.code, e.node === undefined ? at : `${at}.postfix[${e.node}]`);
  }
  for (const [id, v] of values) c.params.set(id, v);
}

const countLimits = [
  ['parameters', cadLimits.parameters],
  ['profiles', cadLimits.profiles],
  ['sketches', cadSketchLimits.sketches],
  ['features', cadLimits.features],
  ['bodies', cadLimits.allBodies],
  ['namedViews', cadLimits.namedViews],
] as const;

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
  // Schema 2 only: CAD is unreleased, and schema 1 development data is not read.
  if (value.schemaVersion !== 2)
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
      'sketches',
      'features',
      'bodies',
      'namedViews',
      'assets',
      ...assemblyKeys,
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
    if (k.semanticsVersion !== 2)
      c.error('unsupported-semantics', '$.kernelProfile.semanticsVersion');
    // K2: the values of one named set (`cadToleranceSets`), never a mixture.
    const set = cadToleranceSetOf(k as unknown as CadKernelProfile);
    if (!set)
      for (const [key, expected] of Object.entries(cadTolerance))
        if (k[key] !== expected) c.error('kernel-tolerance', `$.kernelProfile.${key}`);
  }
  for (const [key, max] of countLimits) {
    if (!Array.isArray(value[key]))
      return [...c.d, { code: 'collection', path: `$.${key}`, severity: 'error' }];
    if ((value[key] as unknown[]).length > max) c.error(`limit-${key}`, `$.${key}`);
  }
  // CM-U3: 64 active bodies; consumed tools stay in the history up to `allBodies` in all.
  const activeBodies = (value.bodies as unknown[]).filter(
    (b) => !record(b) || b.state !== 'consumed',
  ).length;
  if (activeBodies > cadLimits.bodies) c.error('limit-active-bodies', '$.bodies');
  const assets = Array.isArray(value.assets)
    ? validateAssets(c, value.assets)
    : (c.error('collection', '$.assets'), new Map<string, CadAssetKind>());
  const usedAssets = new Set<string>();

  validateParameters(c, value.parameters as unknown[]);
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
  const featureIds = features.flatMap((f) => (record(f) && cadId(f.id) ? [f.id] : []));
  const sketches = new Map<string, CadSketch | undefined>();
  for (const [i, s] of (value.sketches as unknown[]).entries()) {
    const r = validateSketch(c, s, `$.sketches[${i}]`, featureIds);
    if (record(s) && cadId(s.id)) sketches.set(s.id, r);
  }
  features.forEach((f, i) =>
    validateFeature(c, f, `$.features[${i}]`, profiles, sketches, assets, usedAssets, featureIds),
  );
  // The closure is exact: an asset no feature reads is not kept in the content.
  if (Array.isArray(value.assets))
    value.assets.forEach(
      (a, i) =>
        record(a) &&
        assets.has(a.id as string) &&
        !usedAssets.has(a.id as string) &&
        c.error('asset-unreferenced', `$.assets[${i}]`),
    );
  const typed = features.filter(
    (f): f is CadDocument['features'][number] =>
      record(f) && cadId(f.id) && Array.isArray(f.inputFeatureIds),
  );
  const byId = new Map(typed.map((f) => [f.id, f]));
  const position = new Map(typed.map((f, i) => [f.id, i]));
  // Wrong arity is already reported; graph helpers only run on well-formed input lists.
  let graphOk =
    typed.length === features.length &&
    typed.every((f) => arityOk(f.type, f.inputFeatureIds.length));
  typed.forEach((f, i) =>
    (arityOk(f.type, f.inputFeatureIds.length) ? f.inputFeatureIds : []).forEach((input, j) => {
      const path = `$.features[${i}].inputFeatureIds[${j}]`;
      if (!byId.has(input)) graphOk = c.error('feature-missing', path);
      else if (position.get(input)! >= i) c.error('feature-order', path);
    }),
  );
  if (graphOk) {
    if (!evaluationOrder(typed)) c.error('feature-cycle', '$.features');
    else {
      // Features and sketches form one graph (docs/cad/r1-modeling.md, 依存関係と評価順).
      const graph = dependencyOrder({
        features: typed,
        sketches: (value.sketches as unknown[]).filter(
          (s): s is CadSketch => record(s) && cadId(s.id),
        ),
      });
      if ('cycle' in graph)
        c.d.push({
          code: 'cad-dependency-cycle',
          path: '$',
          severity: 'error',
          nodes: graph.cycle,
        });
      else if (graph.depth > cadLimits.dagDepth) c.error('limit-dag-depth', '$.features');
      else
        // A sheet has no inside: what needs a volume refuses it (docs/cad/r2a-freeform.md).
        typed.forEach((f, i) => {
          if (needsSolid(f))
            f.inputFeatureIds.forEach((input, j) => {
              if (featureKind({ features: typed }, input) === 'sheet')
                c.error('sheet-not-solid', `$.features[${i}].inputFeatureIds[${j}]`);
            });
          // A trim, sew or thicken works on sheets; a solid is refused (R2a-3).
          if (needsSheet(f))
            f.inputFeatureIds.forEach((input, j) => {
              if (featureKind({ features: typed }, input) === 'solid')
                c.error('solid-not-sheet', `$.features[${i}].inputFeatureIds[${j}]`);
            });
          if (f.type === 'trim' && record(f.args?.tool) && 'featureId' in f.args.tool) {
            const id = f.args.tool.featureId;
            if (byId.has(id) && featureKind({ features: typed }, id) !== 'sheet')
              c.error('solid-not-sheet', `$.features[${i}].args.tool.featureId`);
          }
        });
    }
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
        'kind',
        'resultFeatureId',
        'state',
        'appearance',
        ...(consumed ? ['consumedByFeatureId'] : []),
      ],
      path,
    );
    if (b.kind !== 'solid' && b.kind !== 'sheet') c.error('body-kind', `${path}.kind`);
    c.id(b.id, `${path}.id`);
    c.name(b.name, `${path}.name`);
    if (b.state !== 'active' && !consumed) c.error('body-state', `${path}.state`);
    const result = byId.get(b.resultFeatureId as string);
    if (!result || result.type !== 'transform')
      c.error('body-result-not-placement', `${path}.resultFeatureId`);
    else if (results.has(result.id)) c.error('body-result-duplicate', `${path}.resultFeatureId`);
    else {
      results.set(result.id, i);
      const kind = graphOk ? featureKind({ features: typed }, result.id) : undefined;
      if (kind && (b.kind === 'solid' || b.kind === 'sheet') && b.kind !== kind)
        c.error('body-kind', `${path}.kind`);
    }
    if (consumed) {
      const by = byId.get(b.consumedByFeatureId as string);
      if (
        !by ||
        (by.type !== 'boolean' && by.type !== 'pattern' && by.type !== 'sew') ||
        !(by.inputFeatureIds as string[]).slice(1).includes(b.resultFeatureId as string)
      )
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
  validateAssembly(c, value);
  if (c.nodes > cadExpressionLimits.documentNodes) c.error('limit-expression-nodes', '$');
  if (c.refs > cadTopologyLimits.refsPerDocument) c.error('limit-references', '$.features');
  if (c.copies > cadPatternCopies) c.error('limit-pattern-copies', '$.features');
  return c.d;
}
export class CadValidationError extends Error {
  constructor(readonly diagnostics: CadDiagnostic[]) {
    const d = diagnostics[0];
    // A duplicate ID names the place that used it first, since IDs share one namespace.
    const detail = d?.firstPath ? ` (ID "${d.id}" is already used at ${d.firstPath})` : '';
    super(`cad-invalid:${d?.code ?? 'unknown'}@${d?.path ?? '$'}${detail}`);
  }
}
export function assertCad(value: unknown): asserts value is CadDocument {
  const errors = validateCad(value).filter((d) => d.severity === 'error');
  if (errors.length) throw new CadValidationError(errors);
}
export type { ParameterValues };
