import { canonicalJson } from '@editor-platform/artifact-core';
import {
  arcOf,
  distance,
  loopBounds,
  loopDistance,
  loopEdges,
  loopEdgesSimple,
  loopsTouch,
  loopWithin,
  pointInLoop,
  type LoopEdge,
} from './geometry';
import { padLoop } from './placement';
import {
  pcbCopperCounts,
  pcbCopperLayerNames,
  pcbPadShapes,
  pcbPadTypes,
  pcbSides,
  pcbFinishes,
  pcbPadConnections,
  pcbLimits,
  pcbMaskColors,
  pcbSilkColors,
  pcbTolerance,
  type PcbDiagnostic,
  type PcbDocument,
  type PcbCopperCount,
  type PcbLoop,
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
export const pcbId = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.length > 0 &&
  codePoints(v) <= pcbLimits.idCodePoints &&
  v.trim() === v &&
  !/\p{Cc}/u.test(v) &&
  !reservedKeys.includes(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const tuple = (v: unknown, n: number): v is unknown[] =>
  Array.isArray(v) && v.length === n && [...Array(n).keys()].every((i) => Object.hasOwn(v, i));

/** Plain JSON data only, depth-limited before any domain traversal. */
export function pcbJsonShape(value: unknown): { code: string; path: string } | undefined {
  const seen = new Set<object>();
  function visit(v: unknown, depth: number, path: string): { code: string; path: string } | void {
    if (depth > pcbLimits.jsonDepth) return { code: 'json-depth', path };
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
export const pcbContentBytes = (value: unknown) =>
  new TextEncoder().encode(canonicalJson(value)).length;

class Check {
  d: PcbDiagnostic[] = [];
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
    if (!pcbId(v)) return this.error('id', path);
    const first = this.ids.get(v);
    if (first !== undefined) {
      this.d.push({ code: 'duplicate-id', path, severity: 'error', id: v, firstPath: first });
      return false;
    }
    this.ids.set(v, path);
    return true;
  }
  name(v: unknown, path: string) {
    return (
      (typeof v === 'string' && codePoints(v) <= pcbLimits.nameCodePoints && !/\p{Cc}/u.test(v)) ||
      this.error('name', path)
    );
  }
  coordinate(v: unknown, path: string) {
    return (finite(v) && Math.abs(v) <= pcbLimits.coordinateMm) || this.error('coordinate', path);
  }
  vec2(v: unknown, path: string) {
    if (!tuple(v, 2)) return this.error('vec2', path);
    return this.coordinate(v[0], `${path}[0]`) && this.coordinate(v[1], `${path}[1]`);
  }
  range(v: unknown, min: number, max: number, path: string, code = 'dimension') {
    return (finite(v) && v >= min && v <= max) || this.error(code, path);
  }
  oneOf(v: unknown, values: readonly unknown[], path: string) {
    return values.includes(v) || this.error('enum', path);
  }
  /** A loop's shape: 3..limit vertices, bulges in (0, 1], no repeated adjacent vertex. */
  loop(v: unknown, path: string): v is PcbLoop {
    if (!Array.isArray(v) || v.length < 3) return this.error('loop-vertices', path);
    if (v.length > pcbLimits.loopVertices) return this.error('limit-count', path);
    let ok = true;
    v.forEach((p, i) => {
      const at = `${path}[${i}]`;
      if (!Array.isArray(p) || (p.length !== 2 && p.length !== 3)) {
        ok = this.error('loop-vertex', at);
        return;
      }
      if (!this.coordinate(p[0], `${at}[0]`) || !this.coordinate(p[1], `${at}[1]`)) ok = false;
      if (p.length === 3 && !(finite(p[2]) && p[2] !== 0 && Math.abs(p[2]) <= 1))
        ok = this.error('loop-bulge', `${at}[2]`);
    });
    if (!ok) return false;
    const loop = v as PcbLoop;
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i];
      const b = loop[(i + 1) % loop.length];
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) <= pcbTolerance)
        return this.error('loop-duplicate-vertex', `${path}[${i}]`);
      // A bulge so small (a subnormal) that the arc's radius overflows cannot be drawn.
      if (a.length === 3 && !Number.isFinite(arcOf([a[0], a[1]], [b[0], b[1]], a[2]).radius))
        return this.error('loop-bulge', `${path}[${i}][2]`);
    }
    return true;
  }
}

/** Every problem of an untrusted value as a board, with JSON paths; empty when it is one. */
export function validatePcb(value: unknown): PcbDiagnostic[] {
  const c = new Check();
  const shape = pcbJsonShape(value);
  if (shape) return [{ code: shape.code, path: shape.path, severity: 'error' }];
  if (!record(value)) return [{ code: 'not-object', path: '$', severity: 'error' }];
  if (value.schemaVersion !== 1)
    return [{ code: 'unsupported-schema', path: '$.schemaVersion', severity: 'error' }];
  if (pcbContentBytes(value) > pcbLimits.contentBytes)
    return [{ code: 'limit-bytes', path: '$', severity: 'error' }];
  if (
    !c.keys(
      value,
      [
        'schemaVersion',
        'units',
        'board',
        'holes',
        'footprints',
        'components',
        'netClasses',
        'nets',
        'tracks',
        'vias',
        'zones',
        'stack',
      ],
      '$',
    )
  )
    return c.d;
  if (value.units !== 'mm') c.error('units', '$.units');

  // Board.
  const board = value.board;
  let outline: LoopEdge[] | undefined;
  const cutouts: { edges: LoopEdge[]; path: string }[] = [];
  if (!record(board)) c.error('object', '$.board');
  else if (
    c.keys(
      board,
      [
        'outline',
        'cutouts',
        'thicknessMm',
        'copperLayers',
        'maskColor',
        'silkColor',
        'finish',
        'edgeClearanceMm',
        'holeClearanceMm',
        'minTrackWidthMm',
        'minDrillMm',
        'minAnnularRingMm',
      ],
      '$.board',
    )
  ) {
    c.range(
      board.edgeClearanceMm,
      pcbLimits.minRuleMm,
      pcbLimits.maxRuleMm,
      '$.board.edgeClearanceMm',
    );
    c.range(
      board.minTrackWidthMm,
      pcbLimits.minRuleMm,
      pcbLimits.maxRuleMm,
      '$.board.minTrackWidthMm',
    );
    c.range(board.minDrillMm, pcbLimits.minDrillMm, pcbLimits.maxRuleMm, '$.board.minDrillMm');
    c.range(
      board.minAnnularRingMm,
      pcbLimits.minRuleMm,
      pcbLimits.maxRuleMm,
      '$.board.minAnnularRingMm',
    );
    c.range(
      board.holeClearanceMm,
      pcbLimits.minRuleMm,
      pcbLimits.maxRuleMm,
      '$.board.holeClearanceMm',
    );
    c.range(
      board.thicknessMm,
      pcbLimits.minThicknessMm,
      pcbLimits.maxThicknessMm,
      '$.board.thicknessMm',
    );
    c.oneOf(board.copperLayers, pcbCopperCounts, '$.board.copperLayers');
    c.oneOf(board.maskColor, pcbMaskColors, '$.board.maskColor');
    c.oneOf(board.silkColor, pcbSilkColors, '$.board.silkColor');
    c.oneOf(board.finish, pcbFinishes, '$.board.finish');
    if (c.loop(board.outline, '$.board.outline')) {
      const edges = loopEdges(board.outline);
      const [x0, y0, x1, y1] = loopBounds(board.outline);
      if (!loopEdgesSimple(edges)) c.error('loop-not-simple', '$.board.outline');
      else if (x1 - x0 > pcbLimits.boardSideMm || y1 - y0 > pcbLimits.boardSideMm)
        c.error('limit-board-size', '$.board.outline');
      else outline = edges;
    }
    if (!Array.isArray(board.cutouts)) c.error('array', '$.board.cutouts');
    else if (board.cutouts.length > pcbLimits.cutouts) c.error('limit-count', '$.board.cutouts');
    else
      board.cutouts.forEach((loop, i) => {
        const path = `$.board.cutouts[${i}]`;
        if (!c.loop(loop, path)) return;
        const edges = loopEdges(loop);
        if (!loopEdgesSimple(edges)) return c.error('loop-not-simple', path);
        if (outline && (loopsTouch(edges, outline) || !loopWithin(edges, outline)))
          return c.error('cutout-outside', path);
        for (const other of cutouts)
          if (
            loopsTouch(edges, other.edges) ||
            loopWithin(edges, other.edges) ||
            loopWithin(other.edges, edges)
          )
            return c.error('cutouts-touch', path);
        cutouts.push({ edges, path });
      });
  }

  // Holes.
  const holes: { at: [number, number]; r: number; path: string }[] = [];
  if (!Array.isArray(value.holes)) c.error('array', '$.holes');
  else if (value.holes.length > pcbLimits.holes) c.error('limit-count', '$.holes');
  else
    value.holes.forEach((h, i) => {
      const path = `$.holes[${i}]`;
      if (!record(h)) return c.error('object', path);
      if (!c.keys(h, ['id', 'name', 'at', 'drillMm', 'plated', 'keepoutMm'], path)) return;
      const ok = [
        c.id(h.id, `${path}.id`),
        c.name(h.name, `${path}.name`),
        c.vec2(h.at, `${path}.at`),
        c.range(h.drillMm, pcbLimits.minDrillMm, pcbLimits.maxDrillMm, `${path}.drillMm`),
        typeof h.plated === 'boolean' || c.error('boolean', `${path}.plated`),
        c.range(h.keepoutMm, 0, pcbLimits.boardSideMm, `${path}.keepoutMm`),
      ].every(Boolean);
      if (!ok) return;
      const drill = h.drillMm as number;
      const keepout = h.keepoutMm as number;
      if (keepout !== 0 && keepout <= drill)
        return c.error('hole-keepout', `${path}.keepoutMm`, h.id as string);
      const at = h.at as [number, number];
      const r = drill / 2;
      // The drill must lie wholly in the board's material.
      if (outline && (!pointInLoop(at, outline) || loopDistance(at, outline) < r - pcbTolerance))
        return c.error('hole-outside', path, h.id as string);
      if (
        cutouts.some(
          (k) => pointInLoop(at, k.edges) || loopDistance(at, k.edges) < r - pcbTolerance,
        )
      )
        return c.error('hole-in-cutout', path, h.id as string);
      if (holes.some((o) => distance(o.at, at) < o.r + r - pcbTolerance))
        return c.error('holes-overlap', path, h.id as string);
      holes.push({ at, r, path });
    });

  // Footprints.
  const footprints = new Set<string>();
  let padTotal = 0;
  if (!Array.isArray(value.footprints)) c.error('array', '$.footprints');
  else if (value.footprints.length > pcbLimits.footprints) c.error('limit-count', '$.footprints');
  else
    value.footprints.forEach((f, i) => {
      const path = `$.footprints[${i}]`;
      if (!record(f)) return c.error('object', path);
      if (!c.keys(f, ['id', 'name', 'pads', 'silk', 'courtyard', 'heightMm'], path, ['generator']))
        return;
      if (c.id(f.id, `${path}.id`)) footprints.add(f.id as string);
      c.name(f.name, `${path}.name`);
      c.range(f.heightMm, 0, 100, `${path}.heightMm`);
      if (c.loop(f.courtyard, `${path}.courtyard`) && !loopEdgesSimple(loopEdges(f.courtyard)))
        c.error('loop-not-simple', `${path}.courtyard`);
      if (f.generator !== undefined) footprintGenerator(c, f.generator, `${path}.generator`);
      if (!Array.isArray(f.silk)) c.error('array', `${path}.silk`);
      else if (f.silk.length > pcbLimits.silkPerFootprint) c.error('limit-count', `${path}.silk`);
      else f.silk.forEach((g, k) => silk(c, g, `${path}.silk[${k}]`));
      if (!Array.isArray(f.pads)) return c.error('array', `${path}.pads`);
      if (f.pads.length > pcbLimits.padsPerFootprint) return c.error('limit-count', `${path}.pads`);
      padTotal += f.pads.length;
      const numbers = new Set<string>();
      const loops: { number: string; edges: LoopEdge[] }[] = [];
      f.pads.forEach((pad, k) => {
        const at = `${path}.pads[${k}]`;
        if (!padShape(c, pad, at)) return;
        const pd = pad as unknown as import('./model').PcbPad;
        if (numbers.has(pd.number)) return c.error('pad-number-duplicate', `${at}.number`);
        numbers.add(pd.number);
        const edges = loopEdges(padLoop(pd));
        if (
          loops.some(
            (o) =>
              loopsTouch(edges, o.edges) ||
              loopWithin(edges, o.edges) ||
              loopWithin(o.edges, edges),
          )
        )
          return c.error('pad-overlap', at);
        loops.push({ number: pd.number, edges });
      });
    });
  // The board-wide pad limit counts every placed part's pads (PB2).
  const padsOf = new Map<string, number>();
  if (Array.isArray(value.footprints))
    for (const f of value.footprints)
      if (record(f) && typeof f.id === 'string' && Array.isArray(f.pads))
        padsOf.set(f.id, f.pads.length);
  if (Array.isArray(value.components))
    for (const p of value.components)
      if (record(p) && typeof p.footprint === 'string') padTotal += padsOf.get(p.footprint) ?? 0;
  if (padTotal > pcbLimits.pads) c.error('limit-count', '$.footprints');

  // Components.
  const refs = new Map<string, string>();
  if (!Array.isArray(value.components)) c.error('array', '$.components');
  else if (value.components.length > pcbLimits.components) c.error('limit-count', '$.components');
  else
    value.components.forEach((p, i) => {
      const path = `$.components[${i}]`;
      if (!record(p)) return c.error('object', path);
      if (
        !c.keys(p, ['id', 'ref', 'value', 'footprint', 'at', 'rotationDeg', 'side', 'locked'], path)
      )
        return;
      c.id(p.id, `${path}.id`);
      if (
        typeof p.ref !== 'string' ||
        !/^[A-Za-z][A-Za-z0-9_.+-]*$/.test(p.ref) ||
        codePoints(p.ref) > pcbLimits.refCodePoints
      )
        c.error('ref', `${path}.ref`);
      else if (refs.has(p.ref)) c.error('ref-duplicate', `${path}.ref`, p.id as string);
      else refs.set(p.ref, path);
      c.name(p.value, `${path}.value`);
      if (!pcbId(p.footprint) || !footprints.has(p.footprint))
        c.error('reference-missing', `${path}.footprint`, p.id as string);
      c.vec2(p.at, `${path}.at`);
      c.range(p.rotationDeg, 0, 360 - 1e-9, `${path}.rotationDeg`, 'rotation');
      c.oneOf(p.side, pcbSides, `${path}.side`);
      if (typeof p.locked !== 'boolean') c.error('boolean', `${path}.locked`);
    });

  // Net classes and nets (PB3).
  const classes = new Set<string>();
  const classNames = new Set<string>();
  if (!Array.isArray(value.netClasses)) c.error('array', '$.netClasses');
  else if (value.netClasses.length === 0) c.error('net-class-none', '$.netClasses');
  else if (value.netClasses.length > pcbLimits.netClasses) c.error('limit-count', '$.netClasses');
  else
    value.netClasses.forEach((k, i) => {
      const path = `$.netClasses[${i}]`;
      if (!record(k)) return c.error('object', path);
      const keys = ['id', 'name', 'trackWidthMm', 'clearanceMm', 'viaDiameterMm', 'viaDrillMm'];
      if (!c.keys(k, keys, path)) return;
      if (c.id(k.id, `${path}.id`)) classes.add(k.id as string);
      if (c.name(k.name, `${path}.name`)) {
        // Net lists name classes, so a name picks one class only.
        if (classNames.has(k.name as string))
          c.error('net-class-name-duplicate', `${path}.name`, k.id as string);
        classNames.add(k.name as string);
      }
      // A class's via drill obeys the same limit as a via's (PB4).
      for (const f of keys.slice(2))
        c.range(
          k[f],
          f === 'viaDrillMm' ? pcbLimits.minDrillMm : pcbLimits.minRuleMm,
          pcbLimits.maxRuleMm,
          `${path}.${f}`,
        );
      if (finite(k.viaDiameterMm) && finite(k.viaDrillMm) && k.viaDrillMm >= k.viaDiameterMm)
        c.error('via-drill', `${path}.viaDrillMm`, k.id as string);
    });
  const pads = new Map<string, Set<string>>();
  if (Array.isArray(value.components) && Array.isArray(value.footprints))
    for (const p of value.components) {
      if (!record(p)) continue;
      const fp = value.footprints.find((f) => record(f) && f.id === p.footprint);
      if (record(fp) && Array.isArray(fp.pads))
        pads.set(
          p.id as string,
          new Set(
            fp.pads.flatMap((d) =>
              record(d) && typeof d.number === 'string' && d.type !== 'npth' ? [d.number] : [],
            ),
          ),
        );
    }
  const netNames = new Map<string, string>();
  const pinNet = new Map<string, string>();
  if (!Array.isArray(value.nets)) c.error('array', '$.nets');
  else if (value.nets.length > pcbLimits.nets) c.error('limit-count', '$.nets');
  else
    value.nets.forEach((n, i) => {
      const path = `$.nets[${i}]`;
      if (!record(n)) return c.error('object', path);
      if (!c.keys(n, ['id', 'name', 'class', 'pins'], path)) return;
      const id = n.id as string;
      c.id(n.id, `${path}.id`);
      if (typeof n.name !== 'string' || n.name.trim() === '' || n.name !== n.name.trim())
        c.error('name', `${path}.name`);
      else if (c.name(n.name, `${path}.name`)) {
        if (netNames.has(n.name)) c.error('net-name-duplicate', `${path}.name`, id);
        else netNames.set(n.name, path);
      }
      if (!pcbId(n.class) || !classes.has(n.class))
        c.error('reference-missing', `${path}.class`, id);
      if (!Array.isArray(n.pins)) return c.error('array', `${path}.pins`);
      if (n.pins.length > pcbLimits.pinsPerNet) return c.error('limit-count', `${path}.pins`);
      n.pins.forEach((pin, k) => {
        const at = `${path}.pins[${k}]`;
        if (!tuple(pin, 2) || !pcbId(pin[0]) || typeof pin[1] !== 'string')
          return c.error('net-pin', at);
        const padsOf = pads.get(pin[0]);
        if (!padsOf || !padsOf.has(pin[1])) return c.error('net-pin-missing', at, id);
        const key = `${pin[0]}\u0000${pin[1]}`;
        if (pinNet.has(key)) return c.error('net-pin-duplicate', at, id);
        pinNet.set(key, id);
      });
    });

  // Tracks and vias (PB4).
  const netIds = new Set<string>(
    Array.isArray(value.nets)
      ? value.nets.flatMap((n) => (record(n) && typeof n.id === 'string' ? [n.id] : []))
      : [],
  );
  const copper =
    record(value.board) && pcbCopperCounts.includes(value.board.copperLayers as 2)
      ? pcbCopperLayerNames(value.board.copperLayers as PcbCopperCount)
      : [];
  if (!Array.isArray(value.tracks)) c.error('array', '$.tracks');
  else if (value.tracks.length > pcbLimits.tracks) c.error('limit-count', '$.tracks');
  else
    value.tracks.forEach((t, i) => {
      const path = `$.tracks[${i}]`;
      if (!record(t)) return c.error('object', path);
      if (!c.keys(t, ['id', 'net', 'layer', 'widthMm', 'from', 'to'], path)) return;
      c.id(t.id, `${path}.id`);
      if (!pcbId(t.net) || !netIds.has(t.net))
        c.error('reference-missing', `${path}.net`, t.id as string);
      if (!copper.includes(t.layer as string)) c.error('layer', `${path}.layer`, t.id as string);
      c.range(t.widthMm, pcbLimits.minRuleMm, pcbLimits.maxRuleMm, `${path}.widthMm`);
      if (c.vec2(t.from, `${path}.from`) && c.vec2(t.to, `${path}.to`)) {
        const [a, b] = [t.from as Vec2, t.to as Vec2];
        if (Math.hypot(a[0] - b[0], a[1] - b[1]) <= pcbTolerance)
          c.error('track-zero-length', path, t.id as string);
      }
    });
  if (!Array.isArray(value.vias)) c.error('array', '$.vias');
  else if (value.vias.length > pcbLimits.vias) c.error('limit-count', '$.vias');
  else
    value.vias.forEach((v, i) => {
      const path = `$.vias[${i}]`;
      if (!record(v)) return c.error('object', path);
      if (!c.keys(v, ['id', 'net', 'at', 'diameterMm', 'drillMm'], path)) return;
      c.id(v.id, `${path}.id`);
      if (!pcbId(v.net) || !netIds.has(v.net))
        c.error('reference-missing', `${path}.net`, v.id as string);
      c.vec2(v.at, `${path}.at`);
      const okD = c.range(
        v.diameterMm,
        pcbLimits.minRuleMm,
        pcbLimits.maxRuleMm,
        `${path}.diameterMm`,
      );
      const okH = c.range(v.drillMm, pcbLimits.minDrillMm, pcbLimits.maxRuleMm, `${path}.drillMm`);
      if (okD && okH && (v.drillMm as number) >= (v.diameterMm as number))
        c.error('via-drill', `${path}.drillMm`, v.id as string);
    });
  // Zones (PB4b).
  if (!Array.isArray(value.zones)) c.error('array', '$.zones');
  else if (value.zones.length > pcbLimits.zones) c.error('limit-count', '$.zones');
  else
    value.zones.forEach((z, i) => {
      const path = `$.zones[${i}]`;
      if (!record(z)) return c.error('object', path);
      if (
        !c.keys(
          z,
          [
            'id',
            'net',
            'layer',
            'outline',
            'priority',
            'clearanceMm',
            'padConnection',
            'thermalGapMm',
            'spokeWidthMm',
          ],
          path,
        )
      )
        return;
      c.id(z.id, `${path}.id`);
      if (!pcbId(z.net) || !netIds.has(z.net))
        c.error('reference-missing', `${path}.net`, z.id as string);
      if (!copper.includes(z.layer as string)) c.error('layer', `${path}.layer`, z.id as string);
      if (c.loop(z.outline, `${path}.outline`) && !loopEdgesSimple(loopEdges(z.outline as PcbLoop)))
        c.error('loop-not-simple', `${path}.outline`, z.id as string);
      if (
        !Number.isInteger(z.priority) ||
        (z.priority as number) < 0 ||
        (z.priority as number) > pcbLimits.zonePriority
      )
        c.error('priority', `${path}.priority`, z.id as string);
      c.range(z.clearanceMm, pcbLimits.minRuleMm, pcbLimits.maxRuleMm, `${path}.clearanceMm`);
      c.oneOf(z.padConnection, pcbPadConnections, `${path}.padConnection`);
      c.range(z.thermalGapMm, pcbLimits.minRuleMm, pcbLimits.maxRuleMm, `${path}.thermalGapMm`);
      c.range(z.spokeWidthMm, pcbLimits.minRuleMm, pcbLimits.maxRuleMm, `${path}.spokeWidthMm`);
    });
  if (!Array.isArray(value.stack)) c.error('array', '$.stack');
  else if (value.stack.length > pcbLimits.stack) c.error('limit-count', '$.stack');
  else
    value.stack.forEach((b, i) => {
      const path = `$.stack[${i}]`;
      if (!record(b)) return c.error('object', path);
      if (!c.keys(b, ['id', 'name', 'source', 'at', 'rotationDeg', 'gapMm'], path)) return;
      c.id(b.id, `${path}.id`);
      c.name(b.name, `${path}.name`);
      const s = b.source;
      if (!record(s)) c.error('object', `${path}.source`);
      else if (c.keys(s, ['artifactId', 'versionId', 'contentHash'], `${path}.source`)) {
        if (!pcbId(s.artifactId)) c.error('id', `${path}.source.artifactId`);
        if (!pcbId(s.versionId)) c.error('id', `${path}.source.versionId`);
        if (typeof s.contentHash !== 'string' || !/^[0-9a-f]{64}$/.test(s.contentHash))
          c.error('content-hash', `${path}.source.contentHash`);
      }
      c.vec2(b.at, `${path}.at`);
      if (!(finite(b.rotationDeg) && b.rotationDeg >= 0 && b.rotationDeg < 360))
        c.error('rotation', `${path}.rotationDeg`);
      c.range(b.gapMm, 0, pcbLimits.stackGapMm, `${path}.gapMm`);
    });
  return c.d;
}

function padShape(c: Check, pad: unknown, at: string): boolean {
  if (!record(pad)) return c.error('object', at);
  if (
    !c.keys(pad, ['number', 'type', 'shape', 'at', 'size', 'rotationDeg'], at, [
      'drillMm',
      'roundness',
    ])
  )
    return false;
  const ok = [
    (typeof pad.number === 'string' &&
      pad.number.length > 0 &&
      codePoints(pad.number) <= 16 &&
      // No spaces or commas: pins are written `REF.PAD, REF.PAD` in net lists and the inspector.
      !/[\s,\p{Cc}]/u.test(pad.number)) ||
      c.error('pad-number', `${at}.number`),
    c.oneOf(pad.type, pcbPadTypes, `${at}.type`),
    c.oneOf(pad.shape, pcbPadShapes, `${at}.shape`),
    c.vec2(pad.at, `${at}.at`),
    tuple(pad.size, 2) &&
      c.range(pad.size[0], pcbLimits.minPadMm, pcbLimits.maxPadMm, `${at}.size[0]`) &&
      c.range(pad.size[1], pcbLimits.minPadMm, pcbLimits.maxPadMm, `${at}.size[1]`),
    (finite(pad.rotationDeg) &&
      pad.rotationDeg >= 0 &&
      pad.rotationDeg < 360 &&
      pad.rotationDeg % 90 === 0) ||
      c.error('pad-rotation', `${at}.rotationDeg`),
  ].every(Boolean);
  if (!tuple(pad.size, 2)) return c.error('vec2', `${at}.size`);
  if (!ok) return false;
  const size = pad.size as number[];
  if (pad.shape === 'circle' && Math.abs(size[0] - size[1]) > pcbTolerance)
    return c.error('pad-circle', `${at}.size`);
  if (pad.shape === 'roundrect') {
    if (!(finite(pad.roundness) && pad.roundness > 0 && pad.roundness <= 0.5))
      return c.error('pad-roundness', `${at}.roundness`);
  } else if (pad.roundness !== undefined) return c.error('unknown-key', `${at}.roundness`);
  if (pad.type === 'smd') {
    if (pad.drillMm !== undefined) return c.error('pad-drill', `${at}.drillMm`);
  } else {
    if (!c.range(pad.drillMm, pcbLimits.minDrillMm, pcbLimits.maxDrillMm, `${at}.drillMm`))
      return false;
    const drill = pad.drillMm as number;
    const room = Math.min(size[0], size[1]);
    // A plated pad keeps a ring of copper; an unplated hole may fill its pad.
    if (pad.type === 'thru' ? drill >= room - pcbTolerance : drill > room + pcbTolerance)
      return c.error('pad-drill', `${at}.drillMm`);
  }
  return true;
}

function silk(c: Check, g: unknown, at: string) {
  if (!record(g)) return c.error('object', at);
  if (g.kind === 'line') {
    if (!c.keys(g, ['kind', 'from', 'to', 'widthMm'], at)) return;
    c.vec2(g.from, `${at}.from`);
    c.vec2(g.to, `${at}.to`);
    c.range(g.widthMm, 0.01, 5, `${at}.widthMm`);
  } else if (g.kind === 'circle') {
    if (!c.keys(g, ['kind', 'center', 'radiusMm', 'widthMm', 'filled'], at)) return;
    c.vec2(g.center, `${at}.center`);
    c.range(g.radiusMm, 0.01, pcbLimits.boardSideMm, `${at}.radiusMm`);
    c.range(g.widthMm, 0.01, 5, `${at}.widthMm`);
    if (typeof g.filled !== 'boolean') c.error('boolean', `${at}.filled`);
  } else c.error('enum', `${at}.kind`);
}

function footprintGenerator(c: Check, g: unknown, at: string) {
  if (!record(g)) return c.error('object', at);
  if (!c.keys(g, ['kind', 'params'], at)) return;
  if (typeof g.kind !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(g.kind))
    c.error('generator-kind', `${at}.kind`);
  if (!record(g.params)) return c.error('object', `${at}.params`);
  const entries = Object.entries(g.params);
  if (entries.length > 32) return c.error('limit-count', `${at}.params`);
  for (const [k, v] of entries)
    if (
      !/^[a-zA-Z][a-zA-Z0-9]{0,31}$/.test(k) ||
      !(typeof v === 'boolean' || finite(v) || (typeof v === 'string' && codePoints(v) <= 64))
    )
      c.error('generator-param', `${at}.params.${k}`);
}

export class PcbValidationError extends Error {
  constructor(readonly diagnostics: PcbDiagnostic[]) {
    const first = diagnostics[0];
    super(`pcb-invalid:${first?.code}@${first?.path}`);
  }
  get code() {
    return this.diagnostics[0]?.code ?? 'invalid';
  }
}
export function assertPcb(value: unknown): asserts value is PcbDocument {
  const d = validatePcb(value);
  if (d.length) throw new PcbValidationError(d);
}
export const isPcbDocument = (value: unknown): value is PcbDocument =>
  validatePcb(value).length === 0;
