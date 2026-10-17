import {
  SCHEMA,
  SCHEMA_V1,
  TICKS_PER_SECOND_V1,
  requireAnimation as check,
  type AnimationContent,
  type SourceRef,
} from './model';
import { JsonBudget } from './json-budget';

// A bounded copy rejects accessors/prototypes before reading values (no toJSON hooks).
export function ownJson(input: unknown, budget = new JsonBudget()): unknown {
  let chars = 0;
  const visit = (v: unknown, depth: number): unknown => {
    budget.node();
    check(depth <= 64, 'input-limit', '$');
    if (v === null || typeof v === 'boolean') {
      budget.bytes(v === false ? 5 : 4);
      return v;
    }
    if (typeof v === 'number') {
      check(Number.isFinite(v), 'number', '$');
      budget.bytes(JSON.stringify(v).length);
      return v;
    }
    if (typeof v === 'string') {
      chars += v.length;
      check(chars <= 8000000, 'input-limit', '$');
      budget.string(v);
      return v;
    }
    check(typeof v === 'object' && v !== null, 'json', '$');
    const array = Array.isArray(v);
    check(
      Object.getPrototypeOf(v) === (array ? Array.prototype : Object.prototype) ||
        (!array && Object.getPrototypeOf(v) === null),
      'prototype',
      '$',
    );
    const names = Reflect.ownKeys(v);
    check(names.length <= 100000, 'input-limit', '$');
    budget.bytes(2);
    let entries = 0;
    const result: Record<string, unknown> = Object.create(null);
    for (const name of names) {
      if (array && name === 'length') continue;
      check(typeof name === 'string', 'json-key', '$');
      const d = Object.getOwnPropertyDescriptor(v, name)!;
      check('value' in d && d.enumerable, 'json-descriptor', name);
      check(!['__proto__', 'constructor', 'prototype'].includes(name), 'json-key', name);
      if (entries++ > 0) budget.bytes(1);
      if (!array) {
        budget.string(name);
        budget.bytes(1);
      }
      result[name] = visit(d.value, depth + 1);
    }
    if (array) {
      check(
        Object.keys(result).length === v.length &&
          Object.keys(result).every((k, i) => k === String(i)),
        'array',
        '$',
      );
      return Object.values(result);
    }
    return result;
  };
  return visit(input, 0);
}
function obj(v: unknown, fields: string[], p: string): Record<string, unknown> {
  check(v && typeof v === 'object' && !Array.isArray(v), 'object', p);
  check(
    Object.keys(v).length === fields.length && fields.every((k) => Object.hasOwn(v, k)),
    'fields',
    p,
  );
  return v as Record<string, unknown>;
}
function num(v: unknown, min: number, max: number, p: string): asserts v is number {
  check(typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max, 'range', p);
}
export function tick(v: unknown, p = 'tick'): asserts v is number {
  num(v, 0, Number.MAX_SAFE_INTEGER, p);
  check(Number.isSafeInteger(v), 'integer', p);
}
function id(v: unknown, p: string): asserts v is string {
  check(typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v), 'id', p);
}
export function sourceRef(v: unknown, p = 'ref'): asserts v is SourceRef {
  const r = obj(v, ['artifactId', 'versionId', 'contentHash', 'compositionId'], p);
  id(r.artifactId, p);
  id(r.versionId, p);
  id(r.compositionId, p);
  check(typeof r.contentHash === 'string' && /^[0-9a-f]{64}$/.test(r.contentHash), 'hash', p);
}
function rational(v: unknown, p: string) {
  const r = obj(v, ['numerator', 'denominator'], p);
  for (const n of Object.values(r)) {
    num(n, 1, 1000000, p);
    check(Number.isSafeInteger(n), 'integer', p);
  }
  return r as { numerator: number; denominator: number };
}
function list(v: unknown, max: number, p: string): unknown[] {
  check(Array.isArray(v) && v.length <= max, 'list-limit', p);
  return v;
}
const properties = ['x', 'y', 'anchorX', 'anchorY', 'scaleX', 'scaleY', 'rotation', 'opacity'];
function propertyValue(v: unknown, property: string, p: string) {
  num(v, property === 'opacity' ? 0 : -1000000, property === 'opacity' ? 1 : 1000000, p);
}

export function validateAnimation(input: unknown): AnimationContent {
  return validateWithBudget(input, new JsonBudget());
}
/** Internal: one budget shared by root and all retained native snapshots. */
export function validateWithBudget(input: unknown, budget: JsonBudget): AnimationContent {
  const value = ownJson(input, budget);
  const root = obj(
    value,
    ['schemaVersion', 'ticksPerSecond', 'rootCompositionId', 'compositions', 'assets'],
    '$',
  );
  check(root.schemaVersion === SCHEMA || root.schemaVersion === SCHEMA_V1, 'schema', '$');
  if (root.schemaVersion === SCHEMA_V1)
    check(root.ticksPerSecond === TICKS_PER_SECOND_V1, 'v1-timebase', '$');
  num(root.ticksPerSecond, 1, 1000000000, 'timebase');
  tick(root.ticksPerSecond);
  id(root.rootCompositionId, 'root');
  const ids = new Set<string>();
  const unique = (v: unknown) => {
    id(v, 'id');
    check(!ids.has(v), 'duplicate-id', v);
    ids.add(v);
  };
  let keyCount = 0;
  for (const entry of list(root.compositions, 100, 'compositions')) {
    const c = obj(
      entry,
      ['id', 'width', 'height', 'duration', 'frameRate', 'layers', 'tracks'],
      'composition',
    );
    unique(c.id);
    num(c.width, 1, 16384, 'width');
    num(c.height, 1, 16384, 'height');
    tick(c.duration);
    check(c.duration > 0, 'duration', 'composition');
    const fps = rational(c.frameRate, 'frameRate');
    const frame = BigInt(root.ticksPerSecond as number) * BigInt(fps.denominator);
    check(
      frame % BigInt(fps.numerator) === 0n &&
        frame / BigInt(fps.numerator) <= BigInt(Number.MAX_SAFE_INTEGER),
      'frame-grid',
      'frameRate',
    );
    const layers = new Map<string, Record<string, unknown>>();
    for (const entry of list(c.layers, 1000, 'layers')) {
      check(entry && typeof entry === 'object', 'layer', 'layer');
      const type = (entry as Record<string, unknown>).type;
      check(
        typeof type === 'string' && ['rect', 'group', 'composition'].includes(type),
        'unsupported-layer',
        'layer',
      );
      const l = obj(
        entry,
        [
          'id',
          'parentId',
          'start',
          'end',
          'transform',
          'type',
          ...(type === 'rect'
            ? ['width', 'height', 'fill']
            : type === 'composition'
              ? ['source', 'time']
              : []),
        ],
        'layer',
      );
      unique(l.id);
      if (l.parentId !== null) id(l.parentId, 'parentId');
      tick(l.start);
      tick(l.end);
      check(l.start < l.end && l.end <= c.duration, 'layer-range', String(l.id));
      const t = obj(l.transform, properties, 'transform');
      for (const k of properties) propertyValue(t[k], k, k);
      if (type === 'rect') {
        num(l.width, 0, 16384, 'width');
        num(l.height, 0, 16384, 'height');
        check(typeof l.fill === 'string' && /^#[0-9a-fA-F]{6}$/.test(l.fill), 'color', 'fill');
      }
      if (type === 'composition') {
        check(root.schemaVersion !== SCHEMA_V1, 'v1-nesting-pending', 'layer');
        check(l.source && typeof l.source === 'object', 'source', 'source');
        const kind = (l.source as Record<string, unknown>).type;
        const s = obj(
          l.source,
          kind === 'local' ? ['type', 'compositionId'] : ['type', 'ref'],
          'source',
        );
        check(kind === 'local' || kind === 'exact', 'source', 'source');
        if (kind === 'local') id(s.compositionId, 'source');
        else sourceRef(s.ref);
        const time = obj(l.time, ['sourceIn', 'sourceOut', 'rate', 'after'], 'time');
        tick(time.sourceIn);
        tick(time.sourceOut);
        check(time.sourceIn < time.sourceOut, 'trim', 'time');
        rational(time.rate, 'rate');
        check(
          typeof time.after === 'string' && ['hold', 'loop', 'hide'].includes(time.after),
          'after',
          'time',
        );
      }
      layers.set(l.id as string, l);
    }
    for (const l of layers.values()) {
      const seen = new Set<string>();
      let parent = l.parentId;
      while (parent !== null) {
        check(typeof parent === 'string' && layers.has(parent), 'missing-parent', String(l.id));
        check(!seen.has(parent) && parent !== l.id, 'parent-cycle', String(l.id));
        seen.add(parent);
        check(seen.size <= 16, 'depth', String(l.id));
        const p = layers.get(parent)!;
        check(p.type === 'group', 'parent-type', parent);
        parent = p.parentId;
      }
    }
    const targets = new Set<string>();
    for (const entry of list(c.tracks, 20000, 'tracks')) {
      const t = obj(entry, ['id', 'layerId', 'property', 'keys'], 'track');
      unique(t.id);
      check(typeof t.layerId === 'string' && layers.has(t.layerId), 'target', 'track');
      check(typeof t.property === 'string' && properties.includes(t.property), 'property', 'track');
      const target = `${t.layerId}/${t.property}`;
      check(!targets.has(target), 'duplicate-target', target);
      targets.add(target);
      let previous = -1;
      const keys = list(t.keys, 20000, 'keys');
      check(keys.length > 0, 'empty-track', String(t.id));
      keyCount += keys.length;
      check(keyCount <= 20000, 'key-limit', 'content');
      for (const entry of keys) {
        const k = obj(entry, ['id', 'tick', 'value', 'easing'], 'key');
        unique(k.id);
        tick(k.tick);
        check(k.tick > previous && k.tick <= c.duration, 'key-time', String(k.id));
        previous = k.tick;
        propertyValue(k.value, t.property as string, String(k.id));
        check(k.easing && typeof k.easing === 'object', 'easing', 'key');
        const type = (k.easing as Record<string, unknown>).type;
        check(
          typeof type === 'string' && ['hold', 'linear', 'bezier'].includes(type),
          'easing',
          'key',
        );
        const e = obj(
          k.easing,
          type === 'bezier' ? ['type', 'x1', 'y1', 'x2', 'y2'] : ['type'],
          'easing',
        );
        if (type === 'bezier')
          for (const name of ['x1', 'y1', 'x2', 'y2']) num(e[name], 0, 1, name);
      }
    }
  }
  const content = value as AnimationContent;
  check(
    content.compositions.some((c) => c.id === content.rootCompositionId),
    'root',
    'content',
  );
  for (const c of content.compositions)
    for (const l of c.layers)
      if (l.type === 'composition' && l.source.type === 'local') {
        const sourceId = l.source.compositionId;
        const child = content.compositions.find((c) => c.id === sourceId);
        check(child && l.time.sourceOut <= child.duration, 'local-source', l.id);
      }
  // Local cycles and expansion are checked here, not only at prepare time.
  const walk = (id: string, stack: string[]): number => {
    check(stack.length < 16 && !stack.includes(id), 'composition-cycle-depth', id);
    const c = content.compositions.find((c) => c.id === id)!;
    let count = c.layers.length;
    for (const l of c.layers)
      if (l.type === 'composition' && l.source.type === 'local') {
        count += walk(l.source.compositionId, [...stack, id]);
        check(count <= 20000, 'expansion', id);
      }
    return count;
  };
  for (const c of content.compositions) walk(c.id, []);
  if (root.schemaVersion === SCHEMA_V1)
    check(
      Array.isArray(root.assets) && root.assets.length === 0,
      'v1-assets-unsupported',
      'assets',
    );
  for (const entry of list(root.assets, 100, 'assets')) {
    const a = obj(entry, ['id', 'contentHash', 'byteLength', 'mediaType'], 'asset');
    unique(a.id);
    check(
      typeof a.contentHash === 'string' && /^[0-9a-f]{64}$/.test(a.contentHash),
      'hash',
      'asset',
    );
    num(a.byteLength, 1, 16 * 1024 * 1024, 'asset-bytes');
    tick(a.byteLength);
    check(a.mediaType === 'image/png' || a.mediaType === 'image/jpeg', 'media-type', 'asset');
  }
  return content;
}
