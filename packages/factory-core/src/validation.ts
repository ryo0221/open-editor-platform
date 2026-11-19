import {
  ladderVariableMap,
  validateLadder,
  type LadderDocument,
} from '@editor-platform/ladder-core';
import {
  FACTORY_SCHEMA,
  factoryActuatorSignals,
  factorySensorSignals,
  factoryDistributionTypes,
  factoryExitStrategies,
  factoryFactorKinds,
  factoryLimits as L,
  factoryObjectKinds,
  type FactoryActuatorSignal,
  type FactoryDiagnostic,
  type FactoryDocument,
  type FactoryObjectKind,
  type FactorySensorSignal,
} from './model';

type Rec = Record<string, unknown>;
const reservedKeys = ['__proto__', 'constructor', 'prototype', 'toJSON'];
const record = (v: unknown): v is Rec =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;
const codePoints = (s: string) => [...s].length;

/** Artifact-scoped stable ID: 1–128 code points, no controls, whitespace edges or reserved keys. */
export const factoryId = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.length > 0 &&
  codePoints(v) <= L.idCodePoints &&
  v.trim() === v &&
  !/\p{Cc}/u.test(v) &&
  !reservedKeys.includes(v);
const text = (v: unknown): v is string =>
  typeof v === 'string' && codePoints(v) <= L.nameCodePoints && !/\p{Cc}/u.test(v);
const int = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const num = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;

/** Plain JSON data only, depth-limited before any domain traversal. */
function jsonShape(value: unknown): { code: string; path: string } | undefined {
  const seen = new Set<object>();
  function visit(v: unknown, depth: number, path: string): { code: string; path: string } | void {
    if (depth > L.jsonDepth) return { code: 'json-depth', path };
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
    if (typeof v === 'number') return Number.isFinite(v) ? undefined : { code: 'number', path };
    if (typeof v !== 'object' || seen.has(v)) return { code: 'json-value', path };
    const isArray = Array.isArray(v);
    if (Object.getPrototypeOf(v) !== (isArray ? Array.prototype : Object.prototype))
      return { code: 'json-value', path };
    seen.add(v);
    if (isArray)
      for (let i = 0; i < v.length; i++)
        if (!Object.prototype.hasOwnProperty.call(v, i))
          return { code: 'json-value', path: `${path}.${i}` };
    for (const key of Reflect.ownKeys(v)) {
      if (isArray && key === 'length') continue;
      if (typeof key !== 'string' || reservedKeys.includes(key)) return { code: 'json-key', path };
      if (isArray && !/^(0|[1-9][0-9]*)$/.test(key)) return { code: 'json-key', path };
      const d = Object.getOwnPropertyDescriptor(v, key)!;
      if (!('value' in d)) return { code: 'json-value', path: `${path}.${key}` };
      const r = visit(d.value, depth + 1, `${path}.${key}`);
      if (r) return r;
    }
    seen.delete(v);
  }
  return visit(value, 0, '$') ?? undefined;
}

function onlyKeys(v: Rec, keys: string[], path: string, out: FactoryDiagnostic[]) {
  for (const k of Object.keys(v))
    if (!keys.includes(k)) out.push({ code: 'unknown-key', path: `${path}.${k}`, message: k });
}
function need(v: Rec, keys: string[], path: string, out: FactoryDiagnostic[]) {
  for (const k of keys)
    if (!(k in v)) out.push({ code: 'missing', path: `${path}.${k}`, message: `${k} is required` });
}

const T = L.maxTimeMs;

/** Checks a distribution of milliseconds; `positive` refuses one whose mean is 0. */
function checkDistribution(v: unknown, path: string, out: FactoryDiagnostic[]) {
  const bad = (code: string, message: string, at = path) => out.push({ code, path: at, message });
  if (!record(v)) return bad('distribution', 'expected a distribution');
  const type = v.type;
  if (!factoryDistributionTypes.includes(type as never))
    return bad('distribution-type', `unknown distribution ${shown(type)}`, `${path}.type`);
  const keys: Record<string, string[]> = {
    const: ['value'],
    uniform: ['min', 'max'],
    triangular: ['min', 'mode', 'max'],
    normal: ['mean', 'sd'],
    lognormal: ['mean', 'sd'],
    exponential: ['mean'],
    empirical: ['values'],
  };
  const required = keys[type as string]!;
  const optional = type === 'normal' ? ['min', 'max'] : [];
  onlyKeys(v, ['type', ...required, ...optional], path, out);
  need(v, required, path, out);
  for (const k of [...required, ...optional])
    if (k !== 'values' && k in v && !num(v[k], 0, T))
      bad('time', `${k} must be a number from 0 to ${T} ms`, `${path}.${k}`);
  const n = (k: string) => (typeof v[k] === 'number' ? (v[k] as number) : NaN);
  switch (type) {
    case 'uniform':
      if (n('min') > n('max')) bad('range', 'min is above max');
      break;
    case 'triangular':
      if (!(n('min') <= n('mode') && n('mode') <= n('max'))) bad('range', 'needs min ≤ mode ≤ max');
      break;
    case 'normal':
      if ('min' in v && 'max' in v && n('min') > n('max')) bad('range', 'min is above max');
      if ('max' in v && n('max') < 0) bad('range', 'max is below 0');
      break;
    case 'lognormal':
    case 'exponential':
      if (n('mean') === 0) bad('range', 'mean must be above 0', `${path}.mean`);
      break;
    case 'empirical': {
      const values = v.values;
      if (!Array.isArray(values) || values.length === 0 || values.length > L.empiricalValues) {
        bad('values', `1 to ${L.empiricalValues} values`, `${path}.values`);
        break;
      }
      let total = 0;
      values.forEach((x, i) => {
        const p = `${path}.values.${i}`;
        if (!record(x)) return bad('values', 'expected { value, weight }', p);
        onlyKeys(x, ['value', 'weight'], p, out);
        if (!num(x.value, 0, T)) bad('time', `value must be 0 to ${T} ms`, `${p}.value`);
        if (!num(x.weight, 0, 1e9)) bad('weight', 'weight must be ≥ 0', `${p}.weight`);
        else total += x.weight;
      });
      if (total <= 0) bad('weight', 'the weights must not all be 0', `${path}.values`);
      break;
    }
  }
}

/** A diagnostic's words for a reference, never coercing a value that is not a string. */
/** A value for a message, never coerced: a non-string object would throw in `String()`. */
/** FT6: the object kinds each signal applies to. */
const holding: FactoryObjectKind[] = [
  'source',
  'station',
  'parallel',
  'assembly',
  'buffer',
  'conveyor',
];
const processing: FactoryObjectKind[] = ['station', 'parallel', 'assembly'];
const taking: FactoryObjectKind[] = ['station', 'parallel', 'assembly', 'buffer', 'conveyor'];
export const factorySensorKinds: Readonly<
  Record<FactorySensorSignal, readonly FactoryObjectKind[]>
> = Object.freeze({
  occupied: holding,
  ready: holding,
  blocked: holding,
  full: taking,
  failed: processing,
});
export const factoryActuatorKinds: Readonly<
  Record<FactoryActuatorSignal, readonly FactoryObjectKind[]>
> = Object.freeze({
  run: ['conveyor'],
  release: holding,
  admit: [...taking, 'drain'],
});

const shown = (v: unknown) =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
    ? String(v)
    : v === null
      ? 'null'
      : `a value of type ${typeof v}`;
const named = (v: unknown, what: string) =>
  typeof v === 'string' ? `no ${what} ${v}`.trim() : `expected ${what || 'an'} ID`;

/**
 * Checks the shape and values of a model; returns every problem found (empty = valid). Whether
 * the model is complete enough to run sensibly (every object reachable) is `factoryWarnings`.
 */
export function validateFactory(value: unknown): FactoryDiagnostic[] {
  const out: FactoryDiagnostic[] = [];
  const bad = (code: string, path: string, message: string) => out.push({ code, path, message });
  const shape = jsonShape(value);
  if (shape) return [{ ...shape, message: 'not plain JSON data' }];
  if (!record(value)) return [{ code: 'document', path: '$', message: 'expected an object' }];
  const doc = value;
  onlyKeys(
    doc,
    [
      'schemaVersion',
      'name',
      'products',
      'objects',
      'links',
      'calendars',
      'workerPools',
      'paths',
      'fleets',
      'building',
      'control',
      'run',
      'experiment',
      'retiredIds',
    ],
    '$',
    out,
  );
  if (doc.schemaVersion !== FACTORY_SCHEMA)
    return [
      ...out,
      { code: 'schema', path: '$.schemaVersion', message: `expected ${FACTORY_SCHEMA}` },
    ];
  need(doc, ['name', 'products', 'objects', 'links', 'run'], '$', out);
  if ('name' in doc && !text(doc.name)) bad('name', '$.name', 'invalid name');

  const ids = new Set<string>();
  const retired = new Set<string>();
  if ('retiredIds' in doc) {
    if (!Array.isArray(doc.retiredIds) || doc.retiredIds.length > L.retiredIds)
      bad('retired', '$.retiredIds', `at most ${L.retiredIds} IDs`);
    else
      doc.retiredIds.forEach((id, i) => {
        if (!factoryId(id) || retired.has(id)) bad('id', `$.retiredIds.${i}`, 'invalid ID');
        else retired.add(id);
      });
  }
  const claim = (id: unknown, path: string) => {
    if (!factoryId(id)) return (bad('id', path, 'invalid ID'), false);
    if (ids.has(id)) return (bad('duplicate-id', path, `${id} is used twice`), false);
    if (retired.has(id)) return (bad('retired-id', path, `${id} was removed before`), false);
    ids.add(id);
    return true;
  };

  const products = new Set<string>();
  if (Array.isArray(doc.products)) {
    if (doc.products.length > L.products)
      bad('limit-exceeded', '$.products', `at most ${L.products}`);
    doc.products.forEach((p, i) => {
      const at = `$.products.${i}`;
      if (!record(p)) return bad('product', at, 'expected a product');
      onlyKeys(p, ['id', 'name'], at, out);
      if (claim(p.id, `${at}.id`)) products.add(p.id as string);
      if (!text(p.name)) bad('name', `${at}.name`, 'invalid name');
    });
  } else if ('products' in doc) bad('products', '$.products', 'expected a list');
  const product = (v: unknown, at: string) => {
    if (typeof v !== 'string' || !products.has(v)) bad('product-missing', at, named(v, 'product'));
  };
  const productTimes = (v: unknown, at: string) => {
    if (!Array.isArray(v) || v.length > L.productTimes)
      return bad('product-times', at, `at most ${L.productTimes}`);
    const seen = new Set<unknown>();
    v.forEach((x, j) => {
      const p = `${at}.${j}`;
      if (!record(x)) return bad('product-times', p, 'expected { productId, time }');
      onlyKeys(x, ['productId', 'time'], p, out);
      product(x.productId, `${p}.productId`);
      if (seen.has(x.productId)) bad('duplicate', `${p}.productId`, 'product listed twice');
      seen.add(x.productId);
      checkDistribution(x.time, `${p}.time`, out);
    });
  };

  const calendars = new Set<string>();
  if (Array.isArray(doc.calendars)) {
    if (doc.calendars.length > L.calendars)
      bad('limit-exceeded', '$.calendars', `at most ${L.calendars}`);
    doc.calendars.forEach((c, i) => {
      const at = `$.calendars.${i}`;
      if (!record(c)) return bad('calendar', at, 'expected a calendar');
      onlyKeys(c, ['id', 'name', 'cycleMs', 'shifts'], at, out);
      need(c, ['id', 'name', 'cycleMs', 'shifts'], at, out);
      if (claim(c.id, `${at}.id`)) calendars.add(c.id as string);
      if ('name' in c && !text(c.name)) bad('name', `${at}.name`, 'invalid name');
      const cycle = int(c.cycleMs, 60_000, T) ? c.cycleMs : undefined;
      if (!cycle) bad('time', `${at}.cycleMs`, `1 minute to ${T} ms, whole ms`);
      if (!Array.isArray(c.shifts) || c.shifts.length === 0 || c.shifts.length > L.shifts)
        return bad('shifts', `${at}.shifts`, `1 to ${L.shifts} shifts`);
      let last = 0;
      c.shifts.forEach((s, j) => {
        const p = `${at}.shifts.${j}`;
        if (!record(s)) return bad('shifts', p, 'expected { name, startMs, endMs }');
        onlyKeys(s, ['name', 'startMs', 'endMs'], p, out);
        need(s, ['name', 'startMs', 'endMs'], p, out);
        if ('name' in s && !text(s.name)) bad('name', `${p}.name`, 'invalid name');
        if (!int(s.startMs, 0, T) || !int(s.endMs, 0, T))
          return bad('time', p, 'start and end are whole ms');
        if (s.endMs <= s.startMs) bad('range', p, 'a shift ends after it starts');
        if (cycle && s.endMs > cycle) bad('range', `${p}.endMs`, 'ends after the cycle');
        if (s.startMs < last) bad('range', `${p}.startMs`, 'shifts in order, not overlapping');
        last = s.endMs;
      });
    });
  } else if ('calendars' in doc) bad('calendars', '$.calendars', 'expected a list');

  const skills = new Set<string>();
  let pools = 0;
  if (Array.isArray(doc.workerPools)) {
    if (doc.workerPools.length > L.workerPools)
      bad('limit-exceeded', '$.workerPools', `at most ${L.workerPools}`);
    doc.workerPools.forEach((w, i) => {
      const at = `$.workerPools.${i}`;
      if (!record(w)) return bad('worker-pool', at, 'expected a worker pool');
      onlyKeys(w, ['id', 'name', 'count', 'skills', 'walkSpeedMmS', 'home'], at, out);
      need(w, ['id', 'name', 'count', 'skills', 'walkSpeedMmS'], at, out);
      claim(w.id, `${at}.id`);
      pools++;
      if ('name' in w && !text(w.name)) bad('name', `${at}.name`, 'invalid name');
      if (!int(w.count, 1, L.workersPerPool))
        bad('count', `${at}.count`, `1 to ${L.workersPerPool} workers`);
      if (!num(w.walkSpeedMmS, 0, L.maxSpeedMmS) || w.walkSpeedMmS === 0)
        bad('speed', `${at}.walkSpeedMmS`, `above 0, at most ${L.maxSpeedMmS} mm/s`);
      if (!Array.isArray(w.skills) || w.skills.length > L.skills)
        bad('skills', `${at}.skills`, `at most ${L.skills} skills`);
      else
        w.skills.forEach((k, j) => {
          if (!factoryId(k)) bad('skill', `${at}.skills.${j}`, 'invalid skill');
          else skills.add(k);
        });
      if ('home' in w) {
        const h = w.home;
        if (!record(h)) bad('home', `${at}.home`, 'expected { x, y }');
        else {
          onlyKeys(h, ['x', 'y'], `${at}.home`, out);
          for (const k of ['x', 'y'])
            if (!int(h[k], -L.maxLengthMm, L.maxLengthMm))
              bad('home', `${at}.home.${k}`, `whole mm within ±${L.maxLengthMm}`);
        }
      }
    });
  } else if ('workerPools' in doc) bad('worker-pools', '$.workerPools', 'expected a list');

  const pathNodes = new Map<string, { x: number; y: number }>();
  if ('paths' in doc) {
    const pa = doc.paths;
    if (!record(pa)) bad('paths', '$.paths', 'expected { nodes, segments }');
    else {
      onlyKeys(pa, ['nodes', 'segments'], '$.paths', out);
      if (!Array.isArray(pa.nodes) || pa.nodes.length > L.pathNodes)
        bad('paths', '$.paths.nodes', `a list of at most ${L.pathNodes}`);
      else
        pa.nodes.forEach((n, i) => {
          const at = `$.paths.nodes.${i}`;
          if (!record(n)) return bad('path-node', at, 'expected { id, x, y }');
          onlyKeys(n, ['id', 'x', 'y'], at, out);
          const okXY = ['x', 'y'].every((k) => int(n[k], -L.maxLengthMm, L.maxLengthMm));
          if (!okXY) bad('at', at, `x and y in whole mm within ±${L.maxLengthMm}`);
          if (claim(n.id, `${at}.id`) && okXY)
            pathNodes.set(n.id as string, { x: n.x as number, y: n.y as number });
        });
      if (!Array.isArray(pa.segments) || pa.segments.length > L.pathSegments)
        bad('paths', '$.paths.segments', `a list of at most ${L.pathSegments}`);
      else {
        const pairs = new Set<string>();
        pa.segments.forEach((g, i) => {
          const at = `$.paths.segments.${i}`;
          if (!record(g)) return bad('segment', at, 'expected { id, from, to, twoWay? }');
          onlyKeys(g, ['id', 'from', 'to', 'twoWay'], at, out);
          claim(g.id, `${at}.id`);
          const a = pathNodes.get(g.from as string);
          const b = pathNodes.get(g.to as string);
          if (!a) bad('path-node-missing', `${at}.from`, `no path node ${shown(g.from)}`);
          if (!b) bad('path-node-missing', `${at}.to`, `no path node ${shown(g.to)}`);
          if (a && b && a.x === b.x && a.y === b.y) bad('segment', at, 'a segment of length 0');
          if ('twoWay' in g && typeof g.twoWay !== 'boolean')
            bad('segment', `${at}.twoWay`, 'true or false');
          const key = `${shown(g.from)}\u0000${shown(g.to)}`;
          const back = `${shown(g.to)}\u0000${shown(g.from)}`;
          if (pairs.has(key) || (g.twoWay && pairs.has(back)))
            bad('duplicate-segment', at, 'two segments between the same points');
          pairs.add(key);
          if (g.twoWay) pairs.add(back);
        });
      }
    }
  }
  const fleets = new Set<string>();
  if (Array.isArray(doc.fleets)) {
    if (doc.fleets.length > L.fleets) bad('limit-exceeded', '$.fleets', `at most ${L.fleets}`);
    doc.fleets.forEach((f, i) => {
      const at = `$.fleets.${i}`;
      if (!record(f)) return bad('fleet', at, 'expected a fleet');
      const keys = ['id', 'name', 'count', 'speedMmS', 'loadMs', 'unloadMs', 'homeNodeId'];
      onlyKeys(f, [...keys, 'battery', 'widthMm'], at, out);
      if ('widthMm' in f && !int(f.widthMm, 1, L.maxLengthMm))
        bad('size', `${at}.widthMm`, `1 to ${L.maxLengthMm} mm, whole mm`);
      need(f, keys, at, out);
      if (claim(f.id, `${at}.id`)) fleets.add(f.id as string);
      if ('name' in f && !text(f.name)) bad('name', `${at}.name`, 'invalid name');
      if (!int(f.count, 1, L.vehiclesPerFleet))
        bad('count', `${at}.count`, `1 to ${L.vehiclesPerFleet} vehicles`);
      if (!num(f.speedMmS, 0, L.maxSpeedMmS) || f.speedMmS === 0)
        bad('speed', `${at}.speedMmS`, `above 0, at most ${L.maxSpeedMmS} mm/s`);
      for (const k of ['loadMs', 'unloadMs'])
        if (!int(f[k], 0, T)) bad('time', `${at}.${k}`, `0 to ${T} ms, whole ms`);
      if (!pathNodes.has(f.homeNodeId as string))
        bad('path-node-missing', `${at}.homeNodeId`, `no path node ${shown(f.homeNodeId)}`);
      if ('battery' in f) {
        const b = f.battery;
        const p = `${at}.battery`;
        if (!record(b)) bad('battery', p, 'expected a battery');
        else {
          const bk = ['capacityMs', 'chargeMs', 'chargerNodeId', 'rechargeBelow'];
          onlyKeys(b, bk, p, out);
          need(b, bk, p, out);
          if (!int(b.capacityMs, 60_000, T)) bad('time', `${p}.capacityMs`, '1 minute or more');
          if (!int(b.chargeMs, 1, T)) bad('time', `${p}.chargeMs`, 'above 0, whole ms');
          if (!num(b.rechargeBelow, 0, 1)) bad('range', `${p}.rechargeBelow`, '0 to 1');
          if (!pathNodes.has(b.chargerNodeId as string))
            bad(
              'path-node-missing',
              `${p}.chargerNodeId`,
              `no path node ${shown(b.chargerNodeId)}`,
            );
        }
      }
    });
  } else if ('fleets' in doc) bad('fleets', '$.fleets', 'expected a list');

  const kinds = new Map<string, string>();
  const onPath = new Set<string>();
  if (Array.isArray(doc.objects)) {
    if (doc.objects.length > L.objects) bad('limit-exceeded', '$.objects', `at most ${L.objects}`);
    doc.objects.forEach((o, i) => {
      const at = `$.objects.${i}`;
      if (!record(o)) return bad('object', at, 'expected an object');
      const kind = o.kind;
      if (!factoryObjectKinds.includes(kind as never))
        return bad('kind', `${at}.kind`, `unknown kind ${shown(kind)}`);
      const base = ['id', 'name', 'kind', 'exit', 'at', 'size', 'look', 'calendarId', 'pathNodeId'];
      const keys: Record<string, [string[], string[]]> = {
        source: [
          ['interval', 'mix'],
          ['limit', 'startMs'],
        ],
        station: [['processTime'], ['productTimes', 'failures', 'setup', 'workers']],
        parallel: [
          ['count', 'processTime'],
          ['productTimes', 'failures', 'setup', 'workers'],
        ],
        assembly: [
          ['mainProductId', 'components', 'processTime'],
          ['outputProductId', 'failures', 'setup', 'workers'],
        ],
        buffer: [['capacity'], ['order']],
        conveyor: [['lengthMm', 'speedMmS', 'partLengthMm', 'accumulating'], []],
        drain: [[], []],
      };
      const [required, optional] = keys[kind as string]!;
      onlyKeys(o, [...base, ...required, ...optional], at, out);
      need(o, ['id', 'name', ...required], at, out);
      if (claim(o.id, `${at}.id`)) kinds.set(o.id as string, kind as string);
      if ('name' in o && !text(o.name)) bad('name', `${at}.name`, 'invalid name');
      if ('exit' in o && !factoryExitStrategies.includes(o.exit as never))
        bad('exit', `${at}.exit`, `unknown exit strategy ${shown(o.exit)}`);
      if ('at' in o) {
        const p = o.at;
        if (!record(p)) bad('at', `${at}.at`, 'expected { x, y, angle? }');
        else {
          onlyKeys(p, ['x', 'y', 'angle'], `${at}.at`, out);
          for (const k of ['x', 'y'])
            if (!int(p[k], -L.maxLengthMm, L.maxLengthMm))
              bad('at', `${at}.at.${k}`, `whole mm within ±${L.maxLengthMm}`);
          if ('angle' in p && !num(p.angle, 0, 360))
            bad('at', `${at}.at.angle`, '0 to 360 degrees');
          if (!('x' in p) || !('y' in p)) bad('missing', `${at}.at`, 'x and y are required');
        }
      }
      if ('size' in o) {
        const z = o.size;
        const sk = ['widthMm', 'depthMm', 'heightMm'];
        if (!record(z)) bad('size', `${at}.size`, 'expected { widthMm, depthMm, heightMm }');
        else {
          onlyKeys(z, sk, `${at}.size`, out);
          need(z, sk, `${at}.size`, out);
          for (const k of sk)
            if (k in z && !int(z[k], 1, L.maxLengthMm))
              bad('size', `${at}.size.${k}`, `1 to ${L.maxLengthMm} mm, whole mm`);
        }
      }
      if ('look' in o) {
        const r = o.look;
        const rk = ['artifactId', 'versionId', 'contentHash'];
        if (!record(r))
          bad('look', `${at}.look`, 'expected { artifactId, versionId, contentHash }');
        else {
          onlyKeys(r, rk, `${at}.look`, out);
          need(r, rk, `${at}.look`, out);
          for (const k of rk)
            if (k in r && (typeof r[k] !== 'string' || !r[k] || (r[k] as string).length > 200))
              bad('look', `${at}.look.${k}`, 'expected a non-empty string');
        }
      }
      if ('pathNodeId' in o) {
        if (typeof o.pathNodeId !== 'string' || !pathNodes.has(o.pathNodeId))
          bad('path-node-missing', `${at}.pathNodeId`, `no path node ${shown(o.pathNodeId)}`);
        else onPath.add(o.id as string);
      }
      if ('calendarId' in o) {
        if (!['source', 'station', 'parallel', 'assembly'].includes(kind as string))
          bad('calendar', `${at}.calendarId`, `a ${shown(kind)} has no calendar`);
        else if (typeof o.calendarId !== 'string' || !calendars.has(o.calendarId))
          bad('calendar-missing', `${at}.calendarId`, `no calendar ${shown(o.calendarId)}`);
      }
      if ('failures' in o) {
        const f = o.failures;
        const p = `${at}.failures`;
        if (!record(f)) bad('failures', p, 'expected { uptime, repair, basis? }');
        else {
          onlyKeys(f, ['uptime', 'repair', 'basis'], p, out);
          need(f, ['uptime', 'repair'], p, out);
          if ('uptime' in f) checkDistribution(f.uptime, `${p}.uptime`, out);
          if ('repair' in f) checkDistribution(f.repair, `${p}.repair`, out);
          if ('basis' in f && f.basis !== 'operating' && f.basis !== 'calendar')
            bad('basis', `${p}.basis`, 'operating or calendar');
        }
      }
      if ('setup' in o) {
        const st = o.setup;
        const p = `${at}.setup`;
        if (!record(st)) bad('setup', p, 'expected { time, productTimes? }');
        else {
          onlyKeys(st, ['time', 'productTimes'], p, out);
          need(st, ['time'], p, out);
          if ('time' in st) checkDistribution(st.time, `${p}.time`, out);
          if ('productTimes' in st) productTimes(st.productTimes, `${p}.productTimes`);
        }
      }
      if ('workers' in o) {
        const w = o.workers;
        const p = `${at}.workers`;
        if (!record(w)) bad('workers', p, 'expected { count, skill? }');
        else {
          onlyKeys(w, ['count', 'skill'], p, out);
          if (!int(w.count, 1, L.workersPerPool))
            bad('count', `${p}.count`, `1 to ${L.workersPerPool}`);
          if ('skill' in w) {
            if (typeof w.skill !== 'string' || !skills.has(w.skill))
              bad('skill-missing', `${p}.skill`, `no worker pool has ${shown(w.skill)}`);
          } else if (!pools) bad('worker-missing', p, 'no worker pool');
        }
      }
      if ('processTime' in o) checkDistribution(o.processTime, `${at}.processTime`, out);
      if ('productTimes' in o) productTimes(o.productTimes, `${at}.productTimes`);
      switch (kind) {
        case 'source': {
          if ('interval' in o) checkDistribution(o.interval, `${at}.interval`, out);
          if (!Array.isArray(o.mix) || o.mix.length === 0 || o.mix.length > L.mix) {
            bad('mix', `${at}.mix`, `1 to ${L.mix} products`);
            break;
          }
          let total = 0;
          const seen = new Set<unknown>();
          o.mix.forEach((m, j) => {
            const p = `${at}.mix.${j}`;
            if (!record(m)) return bad('mix', p, 'expected { productId, weight }');
            onlyKeys(m, ['productId', 'weight'], p, out);
            product(m.productId, `${p}.productId`);
            if (seen.has(m.productId)) bad('duplicate', `${p}.productId`, 'product listed twice');
            seen.add(m.productId);
            if (!num(m.weight, 0, 1e9)) bad('weight', `${p}.weight`, 'weight must be ≥ 0');
            else total += m.weight;
          });
          if (total <= 0) bad('weight', `${at}.mix`, 'the weights must not all be 0');
          if ('limit' in o && !int(o.limit, 1, 1e9)) bad('limit', `${at}.limit`, '1 or more');
          if ('startMs' in o && !int(o.startMs, 0, T)) bad('time', `${at}.startMs`, 'whole ms');
          break;
        }
        case 'parallel':
          if (!int(o.count, 1, L.parallelCount))
            bad('count', `${at}.count`, `1 to ${L.parallelCount} places`);
          break;
        case 'assembly': {
          product(o.mainProductId, `${at}.mainProductId`);
          if ('outputProductId' in o) product(o.outputProductId, `${at}.outputProductId`);
          if (
            !Array.isArray(o.components) ||
            o.components.length === 0 ||
            o.components.length > L.components
          ) {
            bad('components', `${at}.components`, `1 to ${L.components} components`);
            break;
          }
          const seen = new Set<unknown>([o.mainProductId]);
          o.components.forEach((c, j) => {
            const p = `${at}.components.${j}`;
            if (!record(c)) return bad('components', p, 'expected { productId, count }');
            onlyKeys(c, ['productId', 'count'], p, out);
            product(c.productId, `${p}.productId`);
            if (seen.has(c.productId))
              bad('duplicate', `${p}.productId`, 'listed twice or the main product');
            seen.add(c.productId);
            if (!int(c.count, 1, L.componentCount))
              bad('count', `${p}.count`, `1 to ${L.componentCount}`);
          });
          break;
        }
        case 'buffer':
          if (!int(o.capacity, 1, L.bufferCapacity))
            bad('capacity', `${at}.capacity`, `1 to ${L.bufferCapacity}`);
          if ('order' in o && o.order !== 'fifo' && o.order !== 'lifo')
            bad('order', `${at}.order`, 'fifo or lifo');
          break;
        case 'conveyor':
          if (!int(o.lengthMm, 1, L.maxLengthMm))
            bad('length', `${at}.lengthMm`, `1 to ${L.maxLengthMm} mm`);
          if (!int(o.partLengthMm, 1, L.maxLengthMm))
            bad('length', `${at}.partLengthMm`, `1 to ${L.maxLengthMm} mm`);
          else if (typeof o.lengthMm === 'number' && o.partLengthMm > o.lengthMm)
            bad('length', `${at}.partLengthMm`, 'longer than the conveyor');
          if (!num(o.speedMmS, 0, L.maxSpeedMmS) || o.speedMmS === 0)
            bad('speed', `${at}.speedMmS`, `above 0, at most ${L.maxSpeedMmS} mm/s`);
          if (typeof o.accumulating !== 'boolean')
            bad('accumulating', `${at}.accumulating`, 'true or false');
          break;
      }
    });
  } else if ('objects' in doc) bad('objects', '$.objects', 'expected a list');

  if (Array.isArray(doc.links)) {
    if (doc.links.length > L.links) bad('limit-exceeded', '$.links', `at most ${L.links}`);
    const pairs = new Set<string>();
    doc.links.forEach((l, i) => {
      const at = `$.links.${i}`;
      if (!record(l)) return bad('link', at, 'expected a link');
      onlyKeys(l, ['id', 'from', 'to', 'productIds', 'transport'], at, out);
      if ('transport' in l) {
        const t = l.transport;
        if (!record(t)) bad('transport', `${at}.transport`, 'expected { fleetId }');
        else {
          onlyKeys(t, ['fleetId'], `${at}.transport`, out);
          if (!fleets.has(t.fleetId as string))
            bad('fleet-missing', `${at}.transport.fleetId`, `no fleet ${shown(t.fleetId)}`);
          for (const end of ['from', 'to'] as const)
            if (kinds.has(l[end] as string) && !onPath.has(l[end] as string))
              bad('no-path-node', `${at}.${end}`, `${shown(l[end])} has no path node`);
        }
      }
      need(l, ['id', 'from', 'to'], at, out);
      claim(l.id, `${at}.id`);
      const from = kinds.get(l.from as string);
      const to = kinds.get(l.to as string);
      if (!from) bad('object-missing', `${at}.from`, named(l.from, 'object'));
      else if (from === 'drain') bad('link-from-drain', `${at}.from`, 'a drain has no exit');
      if (!to) bad('object-missing', `${at}.to`, named(l.to, 'object'));
      else if (to === 'source') bad('link-to-source', `${at}.to`, 'a source has no entry');
      if (l.from === l.to) bad('self-link', at, 'an object linked to itself');
      const key = `${named(l.from, '')}\u0000${named(l.to, '')}`;
      if (from && to && pairs.has(key))
        bad('duplicate-link', at, 'two links between the same objects');
      pairs.add(key);
      if ('productIds' in l) {
        if (!Array.isArray(l.productIds) || l.productIds.length === 0)
          bad('product-ids', `${at}.productIds`, 'a non-empty list');
        else {
          const seen = new Set<unknown>();
          l.productIds.forEach((p, j) => {
            product(p, `${at}.productIds.${j}`);
            if (seen.has(p)) bad('duplicate', `${at}.productIds.${j}`, 'product listed twice');
            seen.add(p);
          });
        }
      }
    });
    // A loop of buffers alone would pass parts round at one instant forever.
    if (!out.length) {
      const next = new Map<string, string[]>();
      for (const l of doc.links as { from: string; to: string }[])
        if (kinds.get(l.from) === 'buffer' && kinds.get(l.to) === 'buffer')
          next.set(l.from, [...(next.get(l.from) ?? []), l.to]);
      const state = new Map<string, number>();
      const loop = (id: string): boolean => {
        state.set(id, 1);
        for (const n of next.get(id) ?? []) {
          if (state.get(n) === 1 || (!state.has(n) && loop(n))) return true;
        }
        state.set(id, 2);
        return false;
      };
      for (const id of next.keys())
        if (!state.has(id) && loop(id)) {
          bad('buffer-loop', '$.links', `buffers linked in a loop through ${id}`);
          break;
        }
    }
  } else if ('links' in doc) bad('links', '$.links', 'expected a list');

  if ('building' in doc) {
    const b = doc.building;
    const bk = ['artifactId', 'versionId', 'contentHash'];
    if (!record(b))
      bad('building', '$.building', 'expected { artifactId, versionId, contentHash }');
    else {
      onlyKeys(b, bk, '$.building', out);
      need(b, bk, '$.building', out);
      for (const k of bk)
        if (k in b && (typeof b[k] !== 'string' || !b[k] || (b[k] as string).length > 200))
          bad('building', `$.building.${k}`, 'expected a non-empty string');
    }
  }
  if ('control' in doc) {
    const c = doc.control;
    const at = '$.control';
    if (!record(c)) bad('control', at, 'expected control settings');
    else {
      onlyKeys(c, ['program', 'sensors', 'actuators', 'stallMs'], at, out);
      need(c, ['program', 'sensors', 'actuators'], at, out);
      if ('stallMs' in c && !int(c.stallMs, 1, T)) bad('time', `${at}.stallMs`, `1 to ${T} ms`);
      // The ladder check may throw on hostile values (such as a name object without a usable
      // `toString`): that is a refused program too, never an exception out of validation.
      let ladder: ReturnType<typeof validateLadder>;
      try {
        ladder = 'program' in c ? validateLadder(c.program) : [];
      } catch {
        ladder = [{ severity: 'error', code: 'malformed', path: '$' }];
      }
      for (const d of ladder)
        if (d.severity === 'error')
          bad(
            'program',
            `${at}.program${d.path.replace(/^\$/, '')}`,
            `ladder program: ${d.code}${d.id ? ` (${d.id})` : ''}`,
          );
      const program = ladder.some((d) => d.severity === 'error')
        ? undefined
        : (c.program as LadderDocument);
      const vars = program ? ladderVariableMap(program) : undefined;
      const wire = (
        list: unknown,
        what: 'sensors' | 'actuators',
        signals: readonly string[],
        kindsOf: Readonly<Record<string, readonly FactoryObjectKind[]>>,
        role: 'input' | 'output',
      ) => {
        const path = `${at}.${what}`;
        if (!Array.isArray(list)) return bad('signals', path, 'expected a list');
        if (list.length > L.signals) bad('limit-exceeded', path, `at most ${L.signals}`);
        const pairs = new Set<string>();
        const used = new Set<string>();
        list.forEach((w, i) => {
          const p = `${path}.${i}`;
          if (!record(w)) return bad('signal', p, 'expected a wired signal');
          onlyKeys(w, ['id', 'objectId', 'signal', 'variable'], p, out);
          need(w, ['id', 'objectId', 'signal', 'variable'], p, out);
          claim(w.id, `${p}.id`);
          const kind = kinds.get(w.objectId as string);
          if (!kind) bad('object-missing', `${p}.objectId`, named(w.objectId, 'object'));
          if (!signals.includes(w.signal as string))
            bad('signal', `${p}.signal`, `one of ${signals.join(', ')}`);
          else if (kind && !kindsOf[w.signal as string]!.includes(kind as FactoryObjectKind))
            bad('signal-kind', `${p}.signal`, `a ${kind} has no ${shown(w.signal)} signal`);
          const pair = `${shown(w.objectId)}\u0000${shown(w.signal)}`;
          if (kind && pairs.has(pair))
            bad('duplicate-signal', p, `${shown(w.signal)} of ${shown(w.objectId)} is wired twice`);
          pairs.add(pair);
          if (!vars) return;
          const v = vars.get(w.variable as string);
          if (!v) return bad('variable-missing', `${p}.variable`, named(w.variable, 'variable'));
          if (v.type !== 'BOOL' || v.role !== role)
            bad('variable-type', `${p}.variable`, `${v.name} must be a BOOL ${role}`);
          // Two sensors would both write one input; one output may drive several actuators.
          const key = v.name.toUpperCase();
          if (role === 'input' && used.has(key))
            bad('duplicate-variable', `${p}.variable`, `${v.name} is wired to two sensors`);
          used.add(key);
        });
      };
      wire(c.sensors, 'sensors', factorySensorSignals, factorySensorKinds, 'input');
      wire(c.actuators, 'actuators', factoryActuatorSignals, factoryActuatorKinds, 'output');
    }
  }

  if (record(doc.run)) {
    const r = doc.run;
    onlyKeys(r, ['durationMs', 'warmupMs', 'seed'], '$.run', out);
    need(r, ['durationMs', 'seed'], '$.run', out);
    if ('durationMs' in r && !int(r.durationMs, 1, T))
      bad('time', '$.run.durationMs', `1 to ${T} ms`);
    if ('warmupMs' in r && !int(r.warmupMs, 0, T)) bad('time', '$.run.warmupMs', `0 to ${T} ms`);
    if (
      typeof r.durationMs === 'number' &&
      typeof r.warmupMs === 'number' &&
      r.durationMs + r.warmupMs > T
    )
      bad('time', '$.run', 'warm-up and duration together exceed one year');
    if ('seed' in r && !int(r.seed, 0, 0xffffffff)) bad('seed', '$.run.seed', '0 to 2³²−1');
  } else if ('run' in doc) bad('run', '$.run', 'expected run settings');
  if ('experiment' in doc) checkExperiment(doc, out);
  return out;
}

/** The largest value a factor of each kind takes (the smallest is 1). */
const factorMax = {
  'buffer-capacity': L.bufferCapacity,
  'parallel-count': L.parallelCount,
  'fleet-count': L.vehiclesPerFleet,
  'pool-count': L.workersPerPool,
  'time-scale': L.timeScalePercent,
} as const;

/** FT5: the experiment's shape, its targets and the size of its table. */
function checkExperiment(doc: Rec, out: FactoryDiagnostic[]) {
  const bad = (code: string, path: string, message: string) => out.push({ code, path, message });
  const e = doc.experiment;
  if (!record(e)) return bad('experiment', '$.experiment', 'expected an experiment');
  onlyKeys(e, ['replications', 'factors'], '$.experiment', out);
  need(e, ['replications', 'factors'], '$.experiment', out);
  if ('replications' in e && !int(e.replications, 1, L.replications))
    bad('replications', '$.experiment.replications', `1 to ${L.replications} replications`);
  if (!('factors' in e)) return;
  if (!Array.isArray(e.factors))
    return bad('experiment', '$.experiment.factors', 'expected a list');
  if (e.factors.length > L.experimentFactors)
    return bad('limit-exceeded', '$.experiment.factors', `at most ${L.experimentFactors} factors`);
  const list = (v: unknown) => (Array.isArray(v) ? (v as unknown[]).filter(record) : []);
  const objects = new Map(list(doc.objects).map((o) => [o.id, o.kind]));
  const fleets = new Set(list(doc.fleets).map((f) => f.id));
  const pools = new Set(list(doc.workerPools).map((p) => p.id));
  const seen = new Set<string>();
  let combinations = 1;
  e.factors.forEach((f: unknown, i: number) => {
    const at = `$.experiment.factors.${i}`;
    if (!record(f)) return bad('factor', at, 'expected a factor');
    onlyKeys(f, ['kind', 'targetId', 'values'], at, out);
    need(f, ['kind', 'targetId', 'values'], at, out);
    const kind = f.kind as keyof typeof factorMax;
    if (!factoryFactorKinds.includes(kind)) return bad('factor', `${at}.kind`, 'unknown factor');
    const id = f.targetId;
    const kindOf = typeof id === 'string' ? objects.get(id) : undefined;
    const fits =
      typeof id === 'string' &&
      (kind === 'buffer-capacity'
        ? kindOf === 'buffer'
        : kind === 'parallel-count'
          ? kindOf === 'parallel'
          : kind === 'time-scale'
            ? kindOf === 'station' || kindOf === 'parallel' || kindOf === 'assembly'
            : kind === 'fleet-count'
              ? fleets.has(id)
              : pools.has(id));
    if (!fits) bad('factor-target', `${at}.targetId`, `no fitting target for ${kind}`);
    if (typeof id === 'string') {
      const key = `${kind}\u0000${id}`;
      if (seen.has(key)) bad('duplicate', at, 'the same factor twice');
      seen.add(key);
    }
    if (!Array.isArray(f.values) || f.values.length < 1 || f.values.length > L.factorValues)
      return bad('factor-values', `${at}.values`, `1 to ${L.factorValues} values`);
    const values = new Set<number>();
    f.values.forEach((v: unknown, j: number) => {
      if (!int(v, 1, factorMax[kind]))
        bad('factor-values', `${at}.values.${j}`, `whole numbers 1 to ${factorMax[kind]}`);
      else if (values.has(v)) bad('duplicate', `${at}.values.${j}`, 'a value twice');
      else values.add(v);
    });
    combinations *= f.values.length;
  });
  if (combinations > L.experimentCombinations)
    bad(
      'limit-exceeded',
      '$.experiment.factors',
      `${combinations} combinations (at most ${L.experimentCombinations})`,
    );
}

/**
 * Problems that do not make the model invalid but leave parts stuck or objects idle: an object
 * without the links it needs, or an assembly whose main part or a component no source can
 * bring (through the link filters and the assemblies on the way).
 */
export function factoryWarnings(doc: FactoryDocument): FactoryDiagnostic[] {
  const out: FactoryDiagnostic[] = [];
  // Where can a part of each product get to? Parts start at sources; an assembly lets only its
  // main part through, renamed to its output product.
  const reach = new Map<string, Set<string>>();
  const byId = new Map(doc.objects.map((o) => [o.id, o]));
  const visit = (productId: string, from: string) => {
    for (const l of doc.links) {
      if (l.from !== from || (l.productIds && !l.productIds.includes(productId))) continue;
      const seen = reach.get(productId) ?? new Set<string>();
      reach.set(productId, seen);
      if (seen.has(l.to)) continue;
      seen.add(l.to);
      const to = byId.get(l.to);
      if (to?.kind === 'assembly') {
        if (to.mainProductId === productId) visit(to.outputProductId ?? productId, to.id);
      } else visit(productId, l.to);
    }
  };
  for (const o of doc.objects)
    if (o.kind === 'source') for (const m of o.mix) if (m.weight > 0) visit(m.productId, o.id);
  const reaches = (productId: string, id: string) => reach.get(productId)?.has(id) ?? false;
  doc.objects.forEach((o, i) => {
    const label = o.name || o.id;
    const ins = doc.links.some((l) => l.to === o.id);
    const outs = doc.links.some((l) => l.from === o.id);
    if (o.kind !== 'source' && !ins)
      out.push({ code: 'no-entry', path: `$.objects.${i}`, message: `${label}: no link in` });
    if (o.kind !== 'drain' && !outs)
      out.push({ code: 'no-exit', path: `$.objects.${i}`, message: `${label}: no link out` });
    if ((o.kind === 'station' || o.kind === 'parallel' || o.kind === 'assembly') && o.workers) {
      const need = o.workers;
      const have = (doc.workerPools ?? [])
        .filter((p) => need.skill === undefined || p.skills.includes(need.skill))
        .reduce((n, p) => n + p.count, 0);
      if (have < need.count)
        out.push({
          code: 'workers-short',
          path: `$.objects.${i}.workers.count`,
          message: `${label}: needs ${need.count} workers, the pools have ${have}`,
        });
    }
    if (o.kind === 'assembly') {
      if (ins && !reaches(o.mainProductId, o.id))
        out.push({
          code: 'part-unreachable',
          path: `$.objects.${i}.mainProductId`,
          message: `${label}: no ${o.mainProductId} can get here`,
        });
      o.components.forEach((c, j) => {
        if (ins && !reaches(c.productId, o.id))
          out.push({
            code: 'part-unreachable',
            path: `$.objects.${i}.components.${j}`,
            message: `${label}: no ${c.productId} can get here`,
          });
      });
    }
  });
  // FT3c: every carried link must be drivable: home → pickup → drop → pickup.
  if (doc.paths && doc.fleets) {
    const next = new Map<string, string[]>();
    for (const g of doc.paths.segments) {
      next.set(g.from, [...(next.get(g.from) ?? []), g.to]);
      if (g.twoWay) next.set(g.to, [...(next.get(g.to) ?? []), g.from]);
    }
    const reachable = (a: string, b: string) => {
      const seen = new Set([a]);
      const todo = [a];
      while (todo.length) {
        const n = todo.pop()!;
        if (n === b) return true;
        for (const m of next.get(n) ?? [])
          if (!seen.has(m)) {
            seen.add(m);
            todo.push(m);
          }
      }
      return false;
    };
    doc.links.forEach((l, i) => {
      const f = doc.fleets!.find((x) => x.id === l.transport?.fleetId);
      const pick = byId.get(l.from)?.pathNodeId;
      const drop = byId.get(l.to)?.pathNodeId;
      if (!f || !pick || !drop) return;
      const stops = [f.homeNodeId, pick, drop, pick];
      for (let k = 0; k + 1 < stops.length; k++)
        if (!reachable(stops[k]!, stops[k + 1]!)) {
          out.push({
            code: 'path-unreachable',
            path: `$.links.${i}.transport`,
            message: `${f.name || f.id}: no path from ${stops[k]} to ${stops[k + 1]}`,
          });
          break;
        }
    });
  }
  return out;
}

/** A valid factory document (no diagnostics). */
export function isFactoryDocument(input: unknown): input is FactoryDocument {
  return validateFactory(input).length === 0;
}
