import { canonicalJson } from '@editor-platform/artifact-core';
import { generateFootprint } from '@editor-platform/pcb-core';
import { onGrid, onWire, onWireInterior, placedPins, toGrid, type GridPoint } from './geometry';
import {
  schematicGridMm,
  schematicLimits,
  schematicOrientations,
  schematicPinSides,
  schematicPinTypes,
  schematicPowerStyles,
  schematicRotations,
  schematicSchemaVersion,
  schematicSheetSize,
  schematicSheetSizes,
  type SchematicDiagnostic,
  type SchematicDocument,
} from './model';
import { schematicModelProblem } from './models';

type Rec = Record<string, unknown>;
const reservedKeys = ['__proto__', 'constructor', 'prototype', 'toJSON'];
export const isRecord = (v: unknown): v is Rec =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;
const codePoints = (s: string) => [...s].length;
/** Artifact-scoped stable ID: 1–128 code points, no controls, whitespace edges or reserved keys. */
export const schematicId = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.length > 0 &&
  codePoints(v) <= schematicLimits.idCodePoints &&
  v.trim() === v &&
  !/\p{Cc}/u.test(v) &&
  !reservedKeys.includes(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const tuple = (v: unknown, n: number): v is unknown[] =>
  Array.isArray(v) && v.length === n && [...Array(n).keys()].every((i) => Object.hasOwn(v, i));
/** A net or power name: 1–64 code points, no whitespace or controls ("GPIO17", "3V3"). */
export const schematicNetName = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && codePoints(v) <= 64 && !/[\s\p{Cc}]/u.test(v);
/** A reference designator: a letter, then letters, digits or `_` ("R1", "U2", "SW1"). */
export const schematicRef = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(v);

/** Plain JSON data only, depth-limited before any domain traversal. */
export function schematicJsonShape(value: unknown): { code: string; path: string } | undefined {
  const seen = new Set<object>();
  function visit(v: unknown, depth: number, path: string): { code: string; path: string } | void {
    if (depth > schematicLimits.jsonDepth) return { code: 'json-depth', path };
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

class Check {
  d: SchematicDiagnostic[] = [];
  ids = new Map<string, string>();
  error(code: string, path: string, id?: string) {
    this.d.push({ code, path, severity: 'error', ...(id ? { id } : {}) });
    return false;
  }
  warning(code: string, path: string, id?: string) {
    this.d.push({ code, path, severity: 'warning', ...(id ? { id } : {}) });
  }
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
    if (!schematicId(v)) return this.error('id', path);
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
      (typeof v === 'string' &&
        codePoints(v) <= schematicLimits.nameCodePoints &&
        !/\p{Cc}/u.test(v)) ||
      this.error('name', path)
    );
  }
  netName(v: unknown, path: string) {
    return schematicNetName(v) || this.error('net-name', path);
  }
  /** A finite point within `extent` of the origin (a symbol's own frame). */
  point(v: unknown, path: string, extent: number) {
    if (!tuple(v, 2)) return this.error('vec2', path);
    const ok = (x: unknown, at: string) =>
      (finite(x) && Math.abs(x) <= extent) || this.error('coordinate', at);
    return ok(v[0], `${path}[0]`) && ok(v[1], `${path}[1]`);
  }
  /** A finite point on the 1.27 mm grid. */
  gridPoint(v: unknown, path: string, extent: number) {
    if (!this.point(v, path, extent)) return false;
    const p = v as [number, number];
    return (onGrid(p[0]) && onGrid(p[1])) || this.error('grid-off', path);
  }
  range(v: unknown, min: number, max: number, path: string, code = 'dimension') {
    return (finite(v) && v >= min && v <= max) || this.error(code, path);
  }
  oneOf(v: unknown, values: readonly unknown[], path: string) {
    return values.includes(v) || this.error('enum', path);
  }
  list(v: unknown, path: string, limit: number): v is unknown[] {
    if (!Array.isArray(v)) return this.error('array', path);
    if (v.length > limit) return this.error('limit-count', path);
    return true;
  }
}

const collections = ['symbols', 'parts', 'wires', 'junctions', 'labels', 'powers'] as const;

/**
 * Strict validation with path diagnostics. Errors make the document unusable; warnings
 * (`wire-touch`, `junction-alone`) describe a drawing that is valid but probably not meant.
 */
export function validateSchematic(value: unknown): SchematicDiagnostic[] {
  const c = new Check();
  const shape = schematicJsonShape(value);
  if (shape) return [{ ...shape, severity: 'error' }];
  if (!isRecord(value)) return [{ code: 'document', path: '$', severity: 'error' }];
  if (value.schemaVersion !== schematicSchemaVersion)
    return [{ code: 'unsupported-schema', path: '$.schemaVersion', severity: 'error' }];
  if (canonicalJson(value).length > schematicLimits.contentBytes)
    return [{ code: 'limit-size', path: '$', severity: 'error' }];
  c.keys(value, ['schemaVersion', 'units', 'sheet', ...collections], '$');
  if (value.units !== 'mm') c.error('units', '$.units');
  // Sheet.
  let sheetSide: [number, number] = [0, 0];
  const sheet = value.sheet;
  if (!isRecord(sheet)) c.error('sheet', '$.sheet');
  else if (c.keys(sheet, ['size', 'orientation', 'title'], '$.sheet')) {
    const a = c.oneOf(sheet.size, schematicSheetSizes, '$.sheet.size');
    const b = c.oneOf(sheet.orientation, schematicOrientations, '$.sheet.orientation');
    c.name(sheet.title, '$.sheet.title');
    if (a && b) sheetSide = schematicSheetSize(sheet as never);
  }
  const lists = Object.fromEntries(
    collections.map((k) => [
      k,
      c.list(value[k], `$.${k}`, schematicLimits[k]) ? (value[k] as unknown[]) : [],
    ]),
  ) as Record<(typeof collections)[number], unknown[]>;
  const ext = schematicLimits.symbolExtentMm;
  /** On the sheet: inside its rectangle and on the grid. */
  const onSheet = (v: unknown, path: string, id?: string) => {
    if (!c.gridPoint(v, path, 10_000)) return false;
    const [x, y] = v as [number, number];
    if (x < 0 || y < 0 || x > sheetSide[0] || y > sheetSide[1])
      return c.error('off-sheet', path, id);
    return true;
  };

  // Symbols.
  const symbolIds = new Set<string>();
  const symbolPins = new Map<string, Set<string>>();
  lists.symbols.forEach((s, i) => {
    const p = `$.symbols[${i}]`;
    if (!isRecord(s)) return c.error('entity', p);
    if (!c.keys(s, ['id', 'name', 'prefix', 'pins', 'graphics'], p, ['generator'])) return;
    if (c.id(s.id, `${p}.id`)) symbolIds.add(s.id as string);
    c.name(s.name, `${p}.name`);
    if (typeof s.prefix !== 'string' || !/^[A-Z]{1,8}$/.test(s.prefix))
      c.error('prefix', `${p}.prefix`);
    if (c.list(s.pins, `${p}.pins`, schematicLimits.pinsPerSymbol)) {
      const numbers = new Set<string>();
      if (typeof s.id === 'string') symbolPins.set(s.id, numbers);
      (s.pins as unknown[]).forEach((pin, j) => {
        const q = `${p}.pins[${j}]`;
        if (!isRecord(pin)) return c.error('entity', q);
        if (!c.keys(pin, ['number', 'name', 'at', 'side', 'lengthMm', 'type'], q)) return;
        if (typeof pin.number !== 'string' || !/^[A-Za-z0-9_+-]{1,16}$/.test(pin.number))
          c.error('pin-number', `${q}.number`);
        else if (numbers.has(pin.number)) c.error('pin-duplicate', `${q}.number`);
        else numbers.add(pin.number);
        c.name(pin.name, `${q}.name`);
        c.gridPoint(pin.at, `${q}.at`, ext);
        c.oneOf(pin.side, schematicPinSides, `${q}.side`);
        c.range(pin.lengthMm, 0, schematicLimits.maxPinLengthMm, `${q}.lengthMm`);
        c.oneOf(pin.type, schematicPinTypes, `${q}.type`);
      });
      if ((s.pins as unknown[]).length === 0) c.error('symbol-no-pins', `${p}.pins`);
    }
    if (c.list(s.graphics, `${p}.graphics`, schematicLimits.graphicsPerSymbol))
      (s.graphics as unknown[]).forEach((g, j) => {
        const q = `${p}.graphics[${j}]`;
        if (!isRecord(g)) return c.error('entity', q);
        const points = (v: unknown, at: string, min: number) => {
          if (!c.list(v, at, schematicLimits.pointsPerGraphic)) return;
          if ((v as unknown[]).length < min) c.error('graphic-points', at);
          (v as unknown[]).forEach((pt, k) => c.point(pt, `${at}[${k}]`, ext));
        };
        switch (g.kind) {
          case 'line':
            if (c.keys(g, ['kind', 'points'], q)) points(g.points, `${q}.points`, 2);
            break;
          case 'polygon':
            if (c.keys(g, ['kind', 'points', 'filled'], q)) {
              points(g.points, `${q}.points`, 3);
              if (typeof g.filled !== 'boolean') c.error('boolean', `${q}.filled`);
            }
            break;
          case 'rect':
            if (c.keys(g, ['kind', 'from', 'to', 'filled'], q)) {
              c.point(g.from, `${q}.from`, ext);
              c.point(g.to, `${q}.to`, ext);
              if (typeof g.filled !== 'boolean') c.error('boolean', `${q}.filled`);
            }
            break;
          case 'circle':
            if (c.keys(g, ['kind', 'center', 'radiusMm', 'filled'], q)) {
              c.point(g.center, `${q}.center`, ext);
              c.range(g.radiusMm, 0.01, ext, `${q}.radiusMm`);
              if (typeof g.filled !== 'boolean') c.error('boolean', `${q}.filled`);
            }
            break;
          case 'text':
            if (c.keys(g, ['kind', 'at', 'text', 'sizeMm'], q)) {
              c.point(g.at, `${q}.at`, ext);
              c.name(g.text, `${q}.text`);
              c.range(g.sizeMm, 0.5, schematicLimits.maxTextMm, `${q}.sizeMm`);
            }
            break;
          default:
            c.error('enum', `${q}.kind`);
        }
      });
    if (s.generator !== undefined) {
      const g = s.generator;
      const q = `${p}.generator`;
      if (!isRecord(g) || !c.keys(g, ['kind', 'params'], q)) c.error('generator', q);
      else {
        c.name(g.kind, `${q}.kind`);
        if (
          !isRecord(g.params) ||
          !Object.values(g.params).every((x) => ['number', 'string', 'boolean'].includes(typeof x))
        )
          c.error('generator', `${q}.params`);
      }
    }
  });

  // Parts.
  const footprintPads = new Map<string, Set<string> | undefined>();
  const refs = new Map<string, string>();
  let partsOk = true;
  lists.parts.forEach((part, i) => {
    const p = `$.parts[${i}]`;
    if (!isRecord(part)) return (partsOk = c.error('entity', p));
    if (
      !c.keys(part, ['id', 'ref', 'value', 'symbol', 'at', 'rotationDeg', 'mirror'], p, [
        'footprint',
        'pinMap',
        'model',
        'noConnect',
      ])
    )
      return (partsOk = false);
    const id = typeof part.id === 'string' ? part.id : undefined;
    if (!c.id(part.id, `${p}.id`)) partsOk = false;
    if (!schematicRef(part.ref)) partsOk = c.error('ref', `${p}.ref`, id);
    else if (refs.has(part.ref)) {
      c.d.push({
        code: 'ref-duplicate',
        path: `${p}.ref`,
        severity: 'error',
        ...(id ? { id } : {}),
        firstPath: refs.get(part.ref),
      });
      partsOk = false;
    } else refs.set(part.ref, `${p}.ref`);
    c.name(part.value, `${p}.value`);
    if (typeof part.symbol !== 'string' || !symbolIds.has(part.symbol))
      partsOk = c.error('symbol-missing', `${p}.symbol`, id);
    if (!onSheet(part.at, `${p}.at`, id)) partsOk = false;
    if (!c.oneOf(part.rotationDeg, schematicRotations, `${p}.rotationDeg`)) partsOk = false;
    if (typeof part.mirror !== 'boolean') partsOk = c.error('boolean', `${p}.mirror`);
    const pins = typeof part.symbol === 'string' ? symbolPins.get(part.symbol) : undefined;
    if (pins) checkPartSchematicData(c, part, p, pins, footprintPads, id);
  });

  // Wires.
  const wires: { id: string; points: GridPoint[] }[] = [];
  lists.wires.forEach((w, i) => {
    const p = `$.wires[${i}]`;
    if (!isRecord(w)) return c.error('entity', p);
    if (!c.keys(w, ['id', 'points'], p)) return;
    const id = typeof w.id === 'string' ? w.id : undefined;
    c.id(w.id, `${p}.id`);
    if (!c.list(w.points, `${p}.points`, schematicLimits.pointsPerWire)) return;
    const pts = w.points as unknown[];
    if (pts.length < 2) return c.error('wire-points', `${p}.points`, id);
    if (!pts.every((pt, k) => onSheet(pt, `${p}.points[${k}]`, id))) return;
    const g = (pts as [number, number][]).map(toGrid);
    for (let k = 1; k < g.length; k++) {
      const [a, b] = [g[k - 1], g[k]];
      if (a[0] === b[0] && a[1] === b[1])
        return c.error('wire-degenerate', `${p}.points[${k}]`, id);
      if (a[0] !== b[0] && a[1] !== b[1]) return c.error('wire-diagonal', `${p}.points[${k}]`, id);
      if (k >= 2) {
        const z = g[k - 2];
        // A wire may turn but not double back over itself.
        const back =
          (z[0] === a[0] && a[0] === b[0] && Math.sign(a[1] - z[1]) !== Math.sign(b[1] - a[1])) ||
          (z[1] === a[1] && a[1] === b[1] && Math.sign(a[0] - z[0]) !== Math.sign(b[0] - a[0]));
        if (back) return c.error('wire-overlap', `${p}.points[${k}]`, id);
      }
    }
    if (id) wires.push({ id, points: g });
  });

  // Junctions, labels, powers.
  const junctions: GridPoint[] = [];
  lists.junctions.forEach((j, i) => {
    const p = `$.junctions[${i}]`;
    if (!isRecord(j)) return c.error('entity', p);
    if (!c.keys(j, ['id', 'at'], p)) return;
    const id = typeof j.id === 'string' ? j.id : undefined;
    c.id(j.id, `${p}.id`);
    if (!onSheet(j.at, `${p}.at`, id)) return;
    const at = toGrid(j.at as [number, number]);
    junctions.push(at);
    if (!wires.some((w) => onWire(at, w.points))) c.warning('junction-alone', `${p}.at`, id);
  });
  const ends: { at: GridPoint; path: string; id?: string }[] = [];
  lists.labels.forEach((l, i) => {
    const p = `$.labels[${i}]`;
    if (!isRecord(l)) return c.error('entity', p);
    if (!c.keys(l, ['id', 'name', 'at', 'rotationDeg'], p)) return;
    const id = typeof l.id === 'string' ? l.id : undefined;
    c.id(l.id, `${p}.id`);
    c.netName(l.name, `${p}.name`);
    c.oneOf(l.rotationDeg, schematicRotations, `${p}.rotationDeg`);
    if (onSheet(l.at, `${p}.at`, id))
      ends.push({ at: toGrid(l.at as [number, number]), path: `${p}.at`, id });
  });
  lists.powers.forEach((w, i) => {
    const p = `$.powers[${i}]`;
    if (!isRecord(w)) return c.error('entity', p);
    if (!c.keys(w, ['id', 'name', 'at', 'rotationDeg', 'style'], p)) return;
    const id = typeof w.id === 'string' ? w.id : undefined;
    c.id(w.id, `${p}.id`);
    c.netName(w.name, `${p}.name`);
    c.oneOf(w.rotationDeg, schematicRotations, `${p}.rotationDeg`);
    c.oneOf(w.style, schematicPowerStyles, `${p}.style`);
    if (onSheet(w.at, `${p}.at`, id))
      ends.push({ at: toGrid(w.at as [number, number]), path: `${p}.at`, id });
  });

  if (c.d.some((d) => d.severity === 'error')) return c.d;
  // Whole-document checks on a well-formed document.
  const doc = value as unknown as SchematicDocument;
  if (partsOk) {
    const [w, h] = sheetSide;
    const byPart = new Map(doc.parts.map((p, i) => [p.id, i]));
    for (const pin of placedPins(doc)) {
      const [x, y] = [pin.end[0] * schematicGridMm, pin.end[1] * schematicGridMm];
      if (x < -1e-6 || y < -1e-6 || x > w + 1e-6 || y > h + 1e-6)
        c.error('off-sheet', `$.parts[${byPart.get(pin.part)}].at`, pin.part);
      else
        ends.push({
          at: pin.end,
          path: `$.parts[${byPart.get(pin.part)}]`,
          id: pin.part,
        });
    }
  }
  wires.forEach((w, i) => {
    ends.push({ at: w.points[0], path: `$.wires[${i}].points[0]`, id: w.id });
    const last = w.points.length - 1;
    ends.push({ at: w.points[last], path: `$.wires[${i}].points[${last}]`, id: w.id });
  });
  // An end that lies inside another wire without a junction there is not joined to it.
  const junctionKeys = new Set(junctions.map((j) => `${j[0]},${j[1]}`));
  for (const e of ends) {
    if (junctionKeys.has(`${e.at[0]},${e.at[1]}`)) continue;
    if (wires.some((w) => w.id !== e.id && onWireInterior(e.at, w.points)))
      c.warning('wire-touch', e.path, e.id);
  }
  return c.d;
}

/**
 * A part's SL2 fields against its symbol's pins: the footprint (a `pcb-core` generator that must
 * make a footprint from its parameters), the pin map (every pin to a pad of that footprint), the
 * model (see `schematicModelProblem`) and the pins marked not connected.
 */
function checkPartSchematicData(
  c: Check,
  part: Rec,
  p: string,
  pins: ReadonlySet<string>,
  footprintPads: Map<string, Set<string> | undefined>,
  id?: string,
) {
  let pads: Set<string> | undefined;
  if (part.footprint !== undefined) {
    const f = part.footprint;
    const q = `${p}.footprint`;
    if (!isRecord(f) || !c.keys(f, ['generator', 'params'], q)) c.error('footprint', q, id);
    else if (
      typeof f.generator !== 'string' ||
      !isRecord(f.params) ||
      !Object.values(f.params).every((v) => typeof v === 'number' || typeof v === 'string')
    )
      c.error('footprint', q, id);
    else {
      const key = canonicalJson(f);
      if (!footprintPads.has(key)) {
        try {
          const made = generateFootprint(
            'check',
            f.generator,
            f.params as Record<string, number | string>,
          );
          footprintPads.set(key, new Set(made.pads.map((d) => d.number)));
        } catch {
          footprintPads.set(key, undefined);
        }
      }
      pads = footprintPads.get(key);
      if (!pads) c.error('footprint', q, id);
    }
  }
  if (part.pinMap !== undefined) {
    const m = part.pinMap;
    const q = `${p}.pinMap`;
    if (part.footprint === undefined) c.error('pinmap-without-footprint', q, id);
    else if (!isRecord(m)) c.error('pinmap', q, id);
    else {
      for (const [pin, pad] of Object.entries(m)) {
        if (!pins.has(pin)) c.error('pinmap-pin', `${q}.${pin}`, id);
        else if (typeof pad !== 'string' || (pads && !pads.has(pad)))
          c.error('pinmap-pad', `${q}.${pin}`, id);
      }
      for (const pin of pins)
        if (!Object.hasOwn(m, pin)) c.error('pinmap-missing', `${q}.${pin}`, id);
    }
  } else if (part.footprint !== undefined) c.error('pinmap-missing', `${p}.pinMap`, id);
  if (part.model !== undefined) {
    const m = part.model;
    const q = `${p}.model`;
    if (!isRecord(m) || !c.keys(m, ['kind', 'terminals', 'params'], q)) c.error('model', q, id);
    else if (
      typeof m.kind !== 'string' ||
      !isRecord(m.terminals) ||
      !isRecord(m.params) ||
      !Object.values(m.params).every((v) => typeof v === 'number' || typeof v === 'string')
    )
      c.error('model', q, id);
    else {
      const problem = schematicModelProblem(m as never, pins);
      if (problem) c.error(problem, q, id);
    }
  }
  if (part.noConnect !== undefined) {
    const q = `${p}.noConnect`;
    if (c.list(part.noConnect, q, schematicLimits.pinsPerSymbol)) {
      const seen = new Set<unknown>();
      (part.noConnect as unknown[]).forEach((pin, i) => {
        if (typeof pin !== 'string' || !pins.has(pin) || seen.has(pin))
          c.error('no-connect-pin', `${q}[${i}]`, id);
        seen.add(pin);
      });
    }
  }
}

export class SchematicValidationError extends Error {
  constructor(readonly diagnostics: SchematicDiagnostic[]) {
    super(diagnostics.map((d) => `${d.code} at ${d.path}`).join('; '));
  }
}
/** Throws on any error (warnings pass). */
export function assertSchematic(value: unknown): asserts value is SchematicDocument {
  const errors = validateSchematic(value).filter((d) => d.severity === 'error');
  if (errors.length) throw new SchematicValidationError(errors);
}
export const isSchematicDocument = (value: unknown): value is SchematicDocument =>
  !validateSchematic(value).some((d) => d.severity === 'error');
