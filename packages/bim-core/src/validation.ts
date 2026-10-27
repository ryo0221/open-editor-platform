import { canonicalJson } from '@editor-platform/artifact-core';
import { deriveBim } from './derive';
import { distance } from './geometry';
import {
  bimDrawingScales,
  bimLimits,
  bimTolerance,
  bimMaterialCategories,
  bimPropertyTypes,
  bimReservedPropertyPrefixes,
  type BimDiagnostic,
  type BimDocument,
  type BimElementKind,
  type BimTypeKind,
  type Vec2,
} from './model';

type Rec = Record<string, unknown>;
const reservedKeys = ['__proto__', 'constructor', 'prototype', 'toJSON'];
export const record = (v: unknown): v is Rec =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;
const codePoints = (s: string) => [...s].length;
/** Artifact-scoped stable ID: 1–128 code points, no controls, whitespace edges or reserved keys. */
export const bimId = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.length > 0 &&
  codePoints(v) <= bimLimits.idCodePoints &&
  v.trim() === v &&
  !/\p{Cc}/u.test(v) &&
  !reservedKeys.includes(v);
const text = (v: unknown, max: number = bimLimits.nameCodePoints): v is string =>
  typeof v === 'string' && codePoints(v) <= max && !/\p{Cc}/u.test(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const tuple = (v: unknown, n: number): v is unknown[] =>
  Array.isArray(v) && v.length === n && [...Array(n).keys()].every((i) => Object.hasOwn(v, i));

/** Plain JSON data only, depth-limited before any domain traversal. */
export function bimJsonShape(value: unknown): { code: string; path: string } | undefined {
  const seen = new Set<object>();
  function visit(v: unknown, depth: number, path: string): { code: string; path: string } | void {
    if (depth > bimLimits.jsonDepth) return { code: 'json-depth', path };
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

const typeKindsFor: Partial<Record<BimElementKind, BimTypeKind>> = {
  wall: 'wall',
  slab: 'slab',
  column: 'column',
  beam: 'beam',
  door: 'door',
  window: 'window',
  roof: 'roof',
  part: 'part',
};

class Check {
  d: BimDiagnostic[] = [];
  ids = new Map<string, string>();
  error(code: string, path: string, id?: string) {
    this.d.push({ code, path, severity: 'error', ...(id ? { id } : {}) });
    return false;
  }
  /** Exact keys: all `required` present, nothing outside `required` and `optional`. */
  keys(v: Rec, required: string[], path: string, optional: string[] = []) {
    let ok = true;
    for (const k of required)
      if (!Object.hasOwn(v, k)) ok = this.error('missing-key', `${path}.${k}`);
    for (const k of Object.keys(v))
      if (!required.includes(k) && !optional.includes(k))
        ok = this.error('unknown-key', `${path}.${k}`);
    return ok;
  }
  id(v: unknown, path: string) {
    if (!bimId(v)) return this.error('id', path);
    const first = this.ids.get(v);
    if (first !== undefined) {
      this.d.push({ code: 'duplicate-id', path, severity: 'error', id: v, firstPath: first });
      return false;
    }
    this.ids.set(v, path);
    return true;
  }
  name(v: unknown, path: string) {
    return text(v) || this.error('name', path);
  }
  coordinate(v: unknown, path: string) {
    return (finite(v) && Math.abs(v) <= bimLimits.coordinateMm) || this.error('coordinate', path);
  }
  vec2(v: unknown, path: string) {
    if (!tuple(v, 2)) return this.error('vec2', path);
    return this.coordinate(v[0], `${path}[0]`) && this.coordinate(v[1], `${path}[1]`);
  }
  vec3(v: unknown, path: string) {
    if (!tuple(v, 3)) return this.error('vec3', path);
    return [0, 1, 2].every((i) => this.coordinate(v[i], `${path}[${i}]`));
  }
  dimension(v: unknown, path: string, max: number = bimLimits.coordinateMm) {
    return (
      (finite(v) && v >= bimLimits.minDimensionMm && v <= max) || this.error('dimension', path)
    );
  }
  nonNegative(v: unknown, path: string) {
    return (finite(v) && v >= 0 && v <= bimLimits.coordinateMm) || this.error('dimension', path);
  }
  angle(v: unknown, path: string, max = 2 * Math.PI) {
    return (finite(v) && Math.abs(v) <= max) || this.error('angle', path);
  }
  bulge(v: unknown, path: string) {
    return (finite(v) && v !== 0 && Math.abs(v) <= 1) || this.error('bulge', path);
  }
  loop(v: unknown, path: string) {
    if (!Array.isArray(v) || v.length < 3) return this.error('loop', path);
    if (v.length > bimLimits.loopVertices) return this.error('limit-vertices', path);
    let ok = true;
    v.forEach((p, i) => {
      const at = `${path}[${i}]`;
      if (!Array.isArray(p) || (p.length !== 2 && p.length !== 3))
        ok = this.error('loop-vertex', at);
      else {
        ok = this.coordinate(p[0], `${at}[0]`) && ok;
        ok = this.coordinate(p[1], `${at}[1]`) && ok;
        if (p.length === 3) ok = this.bulge(p[2], `${at}[2]`) && ok;
      }
    });
    return ok;
  }
}

/**
 * Strict validation of unknown data as a BIM document: JSON shape, schema, exact keys, IDs,
 * references and their kinds, limits, then the derived checks (joins, openings, loops, levels).
 */
export function validateBim(value: unknown): BimDiagnostic[] {
  const shape = bimJsonShape(value);
  if (shape) return [{ ...shape, severity: 'error' }];
  if (canonicalContentBytes(value) > bimLimits.contentBytes)
    return [{ code: 'limit-bytes', path: '$', severity: 'error' }];
  if (!record(value)) return [{ code: 'document', path: '$', severity: 'error' }];
  // Schema 1 is the only schema of this new domain; no other version is read.
  if (value.schemaVersion !== 1)
    return [{ code: 'unsupported-schema', path: '$.schemaVersion', severity: 'error' }];
  const c = new Check();
  const collections = [
    'levels',
    'grids',
    'materials',
    'types',
    'elements',
    'joins',
    'views',
    'propertySets',
  ] as const;
  c.keys(value, ['schemaVersion', 'units', 'axes', 'project', ...collections], '$');
  if (value.units !== 'mm') c.error('units', '$.units');
  if (value.axes !== 'right-handed-z-up') c.error('axes', '$.axes');
  for (const k of collections) if (!Array.isArray(value[k])) c.error('collection', `$.${k}`);
  if (c.d.length) return c.d;
  const v = value as unknown as Record<(typeof collections)[number], unknown[]> & Rec;
  const limits: Record<string, number> = {
    levels: bimLimits.levels,
    grids: bimLimits.gridAxes,
    materials: bimLimits.materials,
    types: bimLimits.types,
    elements: bimLimits.elements,
    joins: bimLimits.joins,
    views: bimLimits.views,
    propertySets: bimLimits.propertySets,
  };
  for (const k of collections) if (v[k].length > limits[k]) c.error('limit-count', `$.${k}`);
  if (c.d.length) return c.d;

  const p = value.project;
  if (!record(p)) c.error('project', '$.project');
  else if (c.keys(p, ['name', 'trueNorthRad', 'siteElevationMm'], '$.project')) {
    c.name(p.name, '$.project.name');
    c.angle(p.trueNorthRad, '$.project.trueNorthRad');
    c.coordinate(p.siteElevationMm, '$.project.siteElevationMm');
  }

  // Pass 1: entity shapes and IDs (one namespace for the whole document).
  const kindOf = new Map<string, string>();
  const levelElevations: number[] = [];
  v.levels.forEach((l, i) => {
    const at = `$.levels[${i}]`;
    if (!record(l) || !c.keys(l, ['id', 'name', 'elevationMm'], at))
      return void c.error('level', at);
    if (c.id(l.id, `${at}.id`)) kindOf.set(l.id as string, 'level');
    c.name(l.name, `${at}.name`);
    if (c.coordinate(l.elevationMm, `${at}.elevationMm`))
      levelElevations.push(l.elevationMm as number);
  });
  const sorted = [...levelElevations].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i] - sorted[i - 1];
    if (gap < bimLimits.minStoreyMm || gap > bimLimits.maxStoreyMm)
      c.error('level-spacing', '$.levels');
  }
  v.grids.forEach((g, i) => {
    const at = `$.grids[${i}]`;
    if (!record(g) || !c.keys(g, ['id', 'label', 'start', 'end'], at))
      return void c.error('grid', at);
    if (c.id(g.id, `${at}.id`)) kindOf.set(g.id as string, 'grid');
    c.name(g.label, `${at}.label`);
    if (c.vec2(g.start, `${at}.start`) && c.vec2(g.end, `${at}.end`)) {
      const [s, e] = [g.start as number[], g.end as number[]];
      if (Math.hypot(e[0] - s[0], e[1] - s[1]) < bimLimits.minDimensionMm)
        c.error('grid-degenerate', at);
    }
  });
  v.materials.forEach((m, i) => {
    const at = `$.materials[${i}]`;
    if (!record(m) || !c.keys(m, ['id', 'name', 'category'], at))
      return void c.error('material', at);
    if (c.id(m.id, `${at}.id`)) kindOf.set(m.id as string, 'material');
    c.name(m.name, `${at}.name`);
    if (!(bimMaterialCategories as readonly unknown[]).includes(m.category))
      c.error('material-category', `${at}.category`);
  });
  const psetDefs = new Map<string, Map<string, string>>();
  v.propertySets.forEach((s, i) => {
    const at = `$.propertySets[${i}]`;
    if (!record(s) || !c.keys(s, ['id', 'name', 'properties'], at))
      return void c.error('property-set', at);
    if (c.id(s.id, `${at}.id`)) kindOf.set(s.id as string, 'propertySet');
    if (
      c.name(s.name, `${at}.name`) &&
      bimReservedPropertyPrefixes.some((x) => (s.name as string).startsWith(x))
    )
      c.error('property-name-reserved', `${at}.name`);
    // At least one property: IFC's property set template holds one or more (R2c-4b).
    if (
      !Array.isArray(s.properties) ||
      s.properties.length === 0 ||
      s.properties.length > bimLimits.propertiesPerSet
    )
      return void c.error('property-set', `${at}.properties`);
    const defs = new Map<string, string>();
    s.properties.forEach((d, j) => {
      const dp = `${at}.properties[${j}]`;
      if (
        !record(d) ||
        !c.keys(d, ['name', 'type'], dp) ||
        !text(d.name) ||
        (d.name as string).length === 0
      )
        return void c.error('property-def', dp);
      if (!(bimPropertyTypes as readonly unknown[]).includes(d.type))
        return void c.error('property-type', `${dp}.type`);
      if (defs.has(d.name as string)) return void c.error('property-duplicate', `${dp}.name`);
      defs.set(d.name as string, d.type as string);
    });
    if (bimId(s.id)) psetDefs.set(s.id, defs);
  });
  const described = (o: Rec, at: string) => {
    if (o.common !== undefined) {
      const cm = o.common;
      // Empty records are absent, not empty: IFC has no empty property set to keep them.
      if (
        !record(cm) ||
        Object.keys(cm).length === 0 ||
        !c.keys(cm, [], `${at}.common`, ['isExternal', 'loadBearing', 'fireRating', 'reference'])
      )
        return void c.error('common-properties', `${at}.common`);
      for (const k of ['isExternal', 'loadBearing'])
        if (cm[k] !== undefined && typeof cm[k] !== 'boolean')
          c.error('property-value', `${at}.common.${k}`);
      for (const k of ['fireRating', 'reference'])
        if (cm[k] !== undefined && !text(cm[k])) c.error('property-value', `${at}.common.${k}`);
    }
    if (o.properties !== undefined) {
      const ps = o.properties;
      if (!record(ps) || Object.keys(ps).length === 0)
        return void c.error('properties', `${at}.properties`);
      for (const [setId, values] of Object.entries(ps)) {
        const sp = `${at}.properties.${setId}`;
        const defs = psetDefs.get(setId);
        if (!defs) {
          c.error('reference-missing', sp);
          continue;
        }
        if (!record(values) || Object.keys(values).length === 0) {
          c.error('properties', sp);
          continue;
        }
        for (const [name, val] of Object.entries(values)) {
          const type = defs.get(name);
          const ok =
            type === 'string'
              ? text(val, bimLimits.propertyStringCodePoints)
              : type === 'number'
                ? finite(val)
                : type === 'boolean'
                  ? typeof val === 'boolean'
                  : type === 'length'
                    ? finite(val) && Math.abs(val) <= bimLimits.coordinateMm
                    : false;
          if (!ok) c.error(type ? 'property-value' : 'property-unknown', `${sp}.${name}`);
        }
      }
    }
  };
  const typeKinds = new Map<string, BimTypeKind>();
  v.types.forEach((t, i) => {
    const at = `$.types[${i}]`;
    if (!record(t)) return void c.error('type', at);
    const base = ['id', 'kind', 'name'];
    const opt = ['common', 'properties'];
    const ok =
      t.kind === 'wall' || t.kind === 'slab' || t.kind === 'roof'
        ? c.keys(t, [...base, 'layers'], at, opt)
        : t.kind === 'column' || t.kind === 'beam'
          ? c.keys(t, [...base, 'profile', 'materialId'], at, opt)
          : t.kind === 'door' || t.kind === 'window'
            ? c.keys(t, [...base, 'widthMm', 'heightMm'], at, opt)
            : t.kind === 'part'
              ? c.keys(t, [...base, 'source', 'hintBounds'], at, opt)
              : c.error('type-kind', `${at}.kind`);
    if (!ok) return;
    if (c.id(t.id, `${at}.id`)) {
      kindOf.set(t.id as string, 'type');
      typeKinds.set(t.id as string, t.kind as BimTypeKind);
    }
    c.name(t.name, `${at}.name`);
    described(t, at);
  });
  // Pass 2 of types needs materials; elements need levels, grids, types, and other elements.
  const ref = (id: unknown, kind: string, path: string) =>
    (bimId(id) && kindOf.get(id) === kind) ||
    c.error(kindOf.has(id as string) ? 'reference-kind' : 'reference-missing', path);
  v.types.forEach((t, i) => {
    if (!record(t) || !typeKinds.has(t.id as string)) return;
    const at = `$.types[${i}]`;
    if (Array.isArray(t.layers) || t.layers !== undefined) {
      if (!Array.isArray(t.layers) || t.layers.length === 0 || t.layers.length > bimLimits.layers)
        return void c.error('layers', `${at}.layers`);
      let total = 0;
      t.layers.forEach((l, j) => {
        const lp = `${at}.layers[${j}]`;
        if (!record(l) || !c.keys(l, ['materialId', 'thicknessMm'], lp))
          return void c.error('layer', lp);
        ref(l.materialId, 'material', `${lp}.materialId`);
        if (c.dimension(l.thicknessMm, `${lp}.thicknessMm`, bimLimits.maxSectionMm))
          total += l.thicknessMm as number;
      });
      if (total > bimLimits.maxSectionMm) c.error('dimension', `${at}.layers`);
    }
    if (t.kind === 'column' || t.kind === 'beam') {
      ref(t.materialId, 'material', `${at}.materialId`);
      profile(t.profile, `${at}.profile`);
    }
    if (t.kind === 'door' || t.kind === 'window') {
      c.dimension(t.widthMm, `${at}.widthMm`, bimLimits.maxSectionMm);
      c.dimension(t.heightMm, `${at}.heightMm`, bimLimits.maxSectionMm);
    }
    if (t.kind === 'part') {
      const s = t.source;
      if (
        !record(s) ||
        !c.keys(s, ['artifactId', 'versionId', 'contentHash'], `${at}.source`) ||
        ![s.artifactId, s.versionId].every(bimId) ||
        typeof s.contentHash !== 'string' ||
        !/^[0-9a-f]{64}$/.test(s.contentHash)
      )
        c.error('part-source', `${at}.source`);
      const b = t.hintBounds;
      if (
        !record(b) ||
        !c.keys(b, ['min', 'max'], `${at}.hintBounds`) ||
        !c.vec3(b.min, `${at}.hintBounds.min`) ||
        !c.vec3(b.max, `${at}.hintBounds.max`) ||
        [0, 1, 2].some((k) => (b.min as number[])[k] > (b.max as number[])[k])
      )
        c.error('part-bounds', `${at}.hintBounds`);
    }
  });
  function profile(pr: unknown, at: string) {
    if (!record(pr)) return c.error('profile', at);
    const dims: Record<string, string[]> = {
      rect: ['widthMm', 'depthMm'],
      circle: ['diameterMm'],
      h: ['depthMm', 'widthMm', 'webMm', 'flangeMm'],
      channel: ['depthMm', 'widthMm', 'webMm', 'flangeMm'],
      l: ['depthMm', 'widthMm', 'thicknessMm'],
      box: ['depthMm', 'widthMm', 'wallMm'],
    };
    const keys =
      typeof pr.shape === 'string' && Object.hasOwn(dims, pr.shape) ? dims[pr.shape] : undefined;
    if (!keys) return c.error('profile', `${at}.shape`);
    if (!c.keys(pr, ['shape', ...keys], at)) return false;
    if (!keys.every((k) => c.dimension(pr[k], `${at}.${k}`, bimLimits.maxSectionMm))) return false;
    const n = pr as Record<string, number>;
    const thin =
      pr.shape === 'h' || pr.shape === 'channel'
        ? 2 * n.flangeMm >= n.depthMm || n.webMm >= n.widthMm
        : pr.shape === 'l'
          ? n.thicknessMm >= Math.min(n.widthMm, n.depthMm)
          : pr.shape === 'box'
            ? 2 * n.wallMm >= Math.min(n.widthMm, n.depthMm)
            : false;
    return !thin || c.error('profile-proportion', at);
  }

  // Elements: shape first, references after every ID is known.
  const elementKinds = new Map<string, BimElementKind>();
  const elementKeys: Record<string, string[]> = {
    wall: ['typeId', 'start', 'end', 'location', 'base', 'top'],
    slab: ['typeId', 'top', 'boundary', 'holes'],
    column: ['typeId', 'at', 'rotationRad', 'base', 'top'],
    beam: ['typeId', 'start', 'end', 'top'],
    opening: ['hostId'],
    door: ['typeId', 'hostId', 'alongMm', 'flipFacing', 'flipHand'],
    window: ['typeId', 'hostId', 'alongMm', 'sillMm', 'flipFacing'],
    roof: ['typeId', 'base', 'boundary', 'shape'],
    space: ['number', 'base', 'boundary'],
    part: ['typeId', 'at', 'base', 'rotationRad'],
  };
  const elementOptional: Record<string, string[]> = {
    wall: ['bulge', 'clipBy'],
    column: ['clipBy'],
    space: ['top'],
    opening: ['wall', 'slab'],
  };
  v.elements.forEach((e, i) => {
    const at = `$.elements[${i}]`;
    if (!record(e) || typeof e.kind !== 'string' || !Object.hasOwn(elementKeys, e.kind))
      return void c.error('element-kind', `${at}.kind`);
    const ok = c.keys(e, ['id', 'kind', ...elementKeys[e.kind]], at, [
      'name',
      'ifcGlobalId',
      'common',
      'properties',
      ...(elementOptional[e.kind] ?? []),
    ]);
    if (!ok) return;
    if (c.id(e.id, `${at}.id`)) {
      kindOf.set(e.id as string, 'element');
      elementKinds.set(e.id as string, e.kind as BimElementKind);
    }
  });
  const levelHeight = (h: unknown, at: string) =>
    record(h) && c.keys(h, ['level', 'offsetMm'], at)
      ? ref(h.level, 'level', `${at}.level`) && c.coordinate(h.offsetMm, `${at}.offsetMm`)
      : c.error('level-height', at);
  const top = (t: unknown, at: string) =>
    record(t) && Object.hasOwn(t, 'heightMm')
      ? c.keys(t, ['heightMm'], at) && c.dimension(t.heightMm, `${at}.heightMm`)
      : levelHeight(t, at);
  const point = (pt: unknown, at: string) => {
    if (!record(pt)) return c.error('point', at);
    if (Object.hasOwn(pt, 'xy')) return c.keys(pt, ['xy'], at) && c.vec2(pt.xy, `${at}.xy`);
    if (!c.keys(pt, ['grid'], at) || !tuple(pt.grid, 2)) return c.error('point', at);
    return ref(pt.grid[0], 'grid', `${at}.grid[0]`) && ref(pt.grid[1], 'grid', `${at}.grid[1]`);
  };
  const elementOf = (id: unknown, kinds: BimElementKind[], at: string) => {
    if (!ref(id, 'element', at)) return false;
    return kinds.includes(elementKinds.get(id as string)!) || c.error('host-kind', at);
  };
  const typeOf = (e: Rec, at: string) => {
    if (!ref(e.typeId, 'type', `${at}.typeId`)) return false;
    return (
      typeKinds.get(e.typeId as string) === typeKindsFor[e.kind as BimElementKind] ||
      c.error('type-kind', `${at}.typeId`)
    );
  };
  const ifcGlobalId = /^[0-9A-Za-z_$]{22}$/;
  const openingsPerHost = new Map<string, number>();
  v.elements.forEach((e, i) => {
    if (!record(e) || !elementKinds.has(e.id as string)) return;
    const at = `$.elements[${i}]`;
    if (e.name !== undefined) c.name(e.name, `${at}.name`);
    if (
      e.ifcGlobalId !== undefined &&
      !(typeof e.ifcGlobalId === 'string' && ifcGlobalId.test(e.ifcGlobalId))
    )
      c.error('ifc-global-id', `${at}.ifcGlobalId`);
    described(e, at);
    if (typeKindsFor[e.kind as BimElementKind]) typeOf(e, at);
    switch (e.kind) {
      case 'wall':
        point(e.start, `${at}.start`);
        point(e.end, `${at}.end`);
        if (e.bulge !== undefined) c.bulge(e.bulge, `${at}.bulge`);
        if (!['center', 'left', 'right'].includes(e.location as string))
          c.error('wall-location', `${at}.location`);
        levelHeight(e.base, `${at}.base`);
        top(e.top, `${at}.top`);
        if (e.clipBy !== undefined) elementOf(e.clipBy, ['roof'], `${at}.clipBy`);
        break;
      case 'slab':
        levelHeight(e.top, `${at}.top`);
        c.loop(e.boundary, `${at}.boundary`);
        if (!Array.isArray(e.holes) || e.holes.length > bimLimits.holes)
          c.error('holes', `${at}.holes`);
        else e.holes.forEach((h, j) => c.loop(h, `${at}.holes[${j}]`));
        break;
      case 'column':
        point(e.at, `${at}.at`);
        c.angle(e.rotationRad, `${at}.rotationRad`);
        levelHeight(e.base, `${at}.base`);
        top(e.top, `${at}.top`);
        if (e.clipBy !== undefined) elementOf(e.clipBy, ['roof'], `${at}.clipBy`);
        break;
      case 'beam':
        point(e.start, `${at}.start`);
        point(e.end, `${at}.end`);
        levelHeight(e.top, `${at}.top`);
        break;
      case 'opening': {
        const hasWall = Object.hasOwn(e, 'wall');
        if (hasWall === Object.hasOwn(e, 'slab')) {
          c.error('opening-host', at);
          break;
        }
        if (!elementOf(e.hostId, [hasWall ? 'wall' : 'slab'], `${at}.hostId`)) break;
        countOpening(e.hostId as string, at);
        if (hasWall) {
          const w = e.wall;
          if (!record(w)) {
            c.error('opening-host', `${at}.wall`);
            break;
          }
          if (!c.keys(w, ['alongMm', 'sillMm', 'widthMm', 'heightMm'], `${at}.wall`)) break;
          c.nonNegative(w.alongMm, `${at}.wall.alongMm`);
          c.nonNegative(w.sillMm, `${at}.wall.sillMm`);
          c.dimension(w.widthMm, `${at}.wall.widthMm`);
          c.dimension(w.heightMm, `${at}.wall.heightMm`);
        } else {
          const s = e.slab;
          if (!record(s)) c.error('opening-host', `${at}.slab`);
          else if (c.keys(s, ['boundary'], `${at}.slab`)) c.loop(s.boundary, `${at}.slab.boundary`);
        }
        break;
      }
      case 'door':
      case 'window':
        if (elementOf(e.hostId, ['wall'], `${at}.hostId`)) countOpening(e.hostId as string, at);
        c.nonNegative(e.alongMm, `${at}.alongMm`);
        if (e.kind === 'window') c.nonNegative(e.sillMm, `${at}.sillMm`);
        if (typeof e.flipFacing !== 'boolean') c.error('flag', `${at}.flipFacing`);
        if (e.kind === 'door' && typeof e.flipHand !== 'boolean') c.error('flag', `${at}.flipHand`);
        break;
      case 'roof': {
        levelHeight(e.base, `${at}.base`);
        c.loop(e.boundary, `${at}.boundary`);
        const s = e.shape;
        if (record(s) && s.form === 'flat') c.keys(s, ['form'], `${at}.shape`);
        else if (record(s) && s.form === 'mono') {
          if (c.keys(s, ['form', 'slopeRad', 'directionRad'], `${at}.shape`)) {
            if (!(finite(s.slopeRad) && s.slopeRad > 0 && s.slopeRad <= (60 * Math.PI) / 180))
              c.error('roof-slope', `${at}.shape.slopeRad`);
            c.angle(s.directionRad, `${at}.shape.directionRad`);
          }
        } else if (record(s) && (s.form === 'gable' || s.form === 'hip')) {
          const keys = s.form === 'gable' ? ['form', 'slopeRad', 'ridgeRad'] : ['form', 'slopeRad'];
          if (c.keys(s, keys, `${at}.shape`)) {
            if (!(finite(s.slopeRad) && s.slopeRad > 0 && s.slopeRad <= (60 * Math.PI) / 180))
              c.error('roof-slope', `${at}.shape.slopeRad`);
            if (s.form === 'gable') c.angle(s.ridgeRad, `${at}.shape.ridgeRad`);
          }
        } else c.error('roof-shape', `${at}.shape`);
        break;
      }
      case 'space':
        if (!text(e.number) || (e.number as string).length === 0)
          c.error('space-number', `${at}.number`);
        levelHeight(e.base, `${at}.base`);
        if (e.top !== undefined) top(e.top, `${at}.top`);
        c.loop(e.boundary, `${at}.boundary`);
        break;
      case 'part':
        point(e.at, `${at}.at`);
        levelHeight(e.base, `${at}.base`);
        c.angle(e.rotationRad, `${at}.rotationRad`);
        break;
    }
  });
  function countOpening(host: string, at: string) {
    const n = (openingsPerHost.get(host) ?? 0) + 1;
    openingsPerHost.set(host, n);
    if (n === bimLimits.openingsPerHost + 1) c.error('limit-openings', at);
  }
  const wallPairs = new Set<string>();
  v.joins.forEach((j, i) => {
    const at = `$.joins[${i}]`;
    if (!record(j) || !c.keys(j, ['id', 'walls', 'kind'], at, ['through']))
      return void c.error('join', at);
    if (c.id(j.id, `${at}.id`)) kindOf.set(j.id as string, 'join');
    if (!tuple(j.walls, 2)) return void c.error('join-walls', `${at}.walls`);
    const ok =
      elementOf(j.walls[0], ['wall'], `${at}.walls[0]`) &&
      elementOf(j.walls[1], ['wall'], `${at}.walls[1]`);
    if (!['butt', 'miter'].includes(j.kind as string)) c.error('join-kind', `${at}.kind`);
    if (ok && j.walls[0] === j.walls[1]) c.error('join-walls', `${at}.walls`);
    if (j.through !== undefined && (j.kind !== 'butt' || !j.walls.includes(j.through)))
      c.error('join-through', `${at}.through`);
    if (!ok) return;
    const key = [...(j.walls as string[])].sort().join('\u0000');
    if (wallPairs.has(key)) c.error('join-duplicate', at);
    wallPairs.add(key);
  });
  v.views.forEach((w, i) => {
    const at = `$.views[${i}]`;
    if (!record(w)) return void c.error('view', at);
    const ok =
      w.kind === 'plan'
        ? c.keys(w, ['id', 'kind', 'name', 'level', 'cutHeightMm', 'depthMm', 'scale'], at)
        : w.kind === 'section'
          ? c.keys(w, ['id', 'kind', 'name', 'line', 'direction', 'depthMm', 'scale'], at)
          : c.error('view-kind', `${at}.kind`);
    if (!ok) return;
    if (c.id(w.id, `${at}.id`)) kindOf.set(w.id as string, 'view');
    c.name(w.name, `${at}.name`);
    c.dimension(w.depthMm, `${at}.depthMm`);
    if (!(bimDrawingScales as readonly unknown[]).includes(w.scale))
      c.error('view-scale', `${at}.scale`);
    if (w.kind === 'plan') {
      ref(w.level, 'level', `${at}.level`);
      c.dimension(w.cutHeightMm, `${at}.cutHeightMm`);
    } else {
      if (
        !tuple(w.line, 2) ||
        !c.vec2(w.line[0], `${at}.line[0]`) ||
        !c.vec2(w.line[1], `${at}.line[1]`) ||
        // A section looks across its line: the line must have a direction.
        distance(w.line[0] as Vec2, w.line[1] as Vec2) < bimTolerance
      )
        c.error('view-line', `${at}.line`);
      if (!['left', 'right'].includes(w.direction as string))
        c.error('view-direction', `${at}.direction`);
    }
  });
  if (c.d.length) return c.d;
  // Every reference resolves: derive shapes for the checks that need geometry.
  return deriveBim(value as unknown as BimDocument).diagnostics;
}

export class BimValidationError extends Error {
  constructor(readonly diagnostics: BimDiagnostic[]) {
    const d = diagnostics[0];
    const detail = d?.firstPath ? ` (ID "${d.id}" is already used at ${d.firstPath})` : '';
    super(`bim-invalid:${d?.code ?? 'unknown'}@${d?.path ?? '$'}${detail}`);
  }
}
export function assertBim(value: unknown): asserts value is BimDocument {
  const errors = validateBim(value).filter((d) => d.severity === 'error');
  if (errors.length) throw new BimValidationError(errors);
}
export const isBimDocument = (value: unknown): value is BimDocument =>
  !validateBim(value).some((d) => d.severity === 'error');
