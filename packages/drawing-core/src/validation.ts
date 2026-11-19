import { canonicalJson } from '@editor-platform/artifact-core';
import {
  drawingDatumPattern,
  drawingDimensionTypes,
  drawingGdtCharacteristics,
  drawingGdtForms,
  drawingGdtNeedsDatum,
  drawingWeldTypes,
  drawingDirections,
  drawingLimits,
  drawingRefPoints,
  drawingMarkPattern,
  drawingOrientations,
  drawingProjections,
  drawingBimScales,
  drawingElevationSides,
  drawingIsBuildingView,
  drawingScales,
  drawingSheetSizeNames,
  drawingTextHeights,
  drawingTitleFields,
  drawingViewKinds,
  type DrawingDiagnostic,
  type DrawingDocument,
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
export const drawingId = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.length > 0 &&
  codePoints(v) <= drawingLimits.idCodePoints &&
  v.trim() === v &&
  !/\p{Cc}/u.test(v) &&
  !reservedKeys.includes(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
/** A one-line text field: at most `max` code points, no control characters. */
const line = (v: unknown, max: number = drawingLimits.textCodePoints, empty = true) =>
  typeof v === 'string' && (empty || v.length > 0) && codePoints(v) <= max && !/\p{Cc}/u.test(v);
/** A note's text: lines joined by `\n`, no other control characters. */
const multiline = (v: unknown) =>
  typeof v === 'string' &&
  v.length > 0 &&
  codePoints(v) <= drawingLimits.noteCodePoints &&
  v.split('\n').every((l) => !/\p{Cc}/u.test(l));
const date = (v: unknown) =>
  v === '' ||
  (typeof v === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(v) &&
    !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) &&
    new Date(`${v}T00:00:00Z`).toISOString().startsWith(v));
const vec2 = (v: unknown) =>
  Array.isArray(v) &&
  v.length === 2 &&
  finite(v[0]) &&
  finite(v[1]) &&
  Math.abs(v[0]) <= 10_000 &&
  Math.abs(v[1]) <= 10_000;
/** A point in a view's plane (model mm): up to 10 km from the model's origin. */
const model2 = (v: unknown) =>
  Array.isArray(v) &&
  v.length === 2 &&
  finite(v[0]) &&
  finite(v[1]) &&
  Math.abs(v[0]) <= 1e7 &&
  Math.abs(v[1]) <= 1e7;
const oneOf = <T>(list: readonly T[], v: unknown): v is T => list.includes(v as T);

/** Plain JSON data only, depth-limited before any domain traversal. */
export function drawingJsonShape(value: unknown): { code: string; path: string } | undefined {
  const seen = new Set<object>();
  function visit(v: unknown, depth: number, path: string): { code: string; path: string } | void {
    if (depth > drawingLimits.jsonDepth) return { code: 'json-depth', path };
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

/**
 * Strict validation of drawing content (DW1): plain JSON, exact keys, enums, limits, IDs unique
 * across the document, every reference resolved (a view's sheet and source, a note's sheet),
 * revision marks unique on their sheet. Returns every problem with its JSON path.
 */
export function validateDrawing(input: unknown): DrawingDiagnostic[] {
  const shape = drawingJsonShape(input);
  if (shape) return [{ code: shape.code, path: shape.path }];
  const out: DrawingDiagnostic[] = [];
  const err = (code: string, path: string, id?: string) =>
    out.push({ code, path, ...(id ? { id } : {}) });
  const keys = (o: Rec, path: string, required: readonly string[], optional: string[] = []) => {
    let ok = true;
    for (const k of required)
      if (!Object.hasOwn(o, k)) {
        err('shape', `${path}.${k}`);
        ok = false;
      }
    for (const k of Object.keys(o))
      if (!required.includes(k) && !optional.includes(k)) {
        err('shape', `${path}.${k}`);
        ok = false;
      }
    return ok;
  };
  if (!record(input)) return [{ code: 'shape', path: '$' }];
  if (
    !keys(input, '$', [
      'schemaVersion',
      'name',
      'projection',
      'sources',
      'sheets',
      'views',
      'annotations',
    ])
  )
    return out;
  if (input.schemaVersion !== 1) return [{ code: 'schema-version', path: '$.schemaVersion' }];
  if (!line(input.name)) err('shape', '$.name');
  if (!oneOf(drawingProjections, input.projection)) err('projection', '$.projection');
  const lists = ['sources', 'sheets', 'views', 'annotations'] as const;
  for (const k of lists) if (!Array.isArray(input[k])) err('shape', `$.${k}`);
  if (out.length) return out;
  const doc = input as unknown as DrawingDocument;
  for (const k of lists)
    if ((doc[k] as unknown[]).length > drawingLimits[k]) err(`limit-${k}`, `$.${k}`);
  // A drawing always has a sheet to show (deleting the last one is refused too).
  if (!doc.sheets.length) err('sheet-last', '$.sheets');
  if (out.length) return out;

  const ids = new Map<string, string>();
  const id = (o: Rec, path: string) => {
    if (!drawingId(o.id)) return err('id', `${path}.id`);
    if (ids.has(o.id)) err('id-duplicate', `${path}.id`, o.id);
    else ids.set(o.id, path);
  };
  const sources = new Map<string, string>();
  doc.sources.forEach((s: unknown, i) => {
    const p = `$.sources[${i}]`;
    if (!record(s)) return err('shape', p);
    if (!keys(s, p, ['id', 'kind', 'artifactId', 'versionId', 'contentHash', 'name'])) return;
    id(s, p);
    if (s.kind !== 'cad' && s.kind !== 'bim') err('source-kind', `${p}.kind`);
    for (const k of ['artifactId', 'versionId', 'contentHash'] as const)
      if (!drawingId(s[k])) err('source', `${p}.${k}`);
    if (!line(s.name)) err('shape', `${p}.name`);
    if (drawingId(s.id)) sources.set(s.id, s.kind as string);
  });
  const sheets = new Set<string>();
  doc.sheets.forEach((s: unknown, i) => {
    const p = `$.sheets[${i}]`;
    if (!record(s)) return err('shape', p);
    if (!keys(s, p, ['id', 'name', 'size', 'orientation', 'filing', 'title', 'revisions'])) return;
    id(s, p);
    if (drawingId(s.id)) sheets.add(s.id);
    if (!line(s.name, drawingLimits.textCodePoints, false)) err('shape', `${p}.name`);
    if (!oneOf(drawingSheetSizeNames, s.size)) err('sheet-size', `${p}.size`);
    if (!oneOf(drawingOrientations, s.orientation)) err('sheet-orientation', `${p}.orientation`);
    if (typeof s.filing !== 'boolean') err('shape', `${p}.filing`);
    const t = s.title;
    if (!record(t)) err('shape', `${p}.title`);
    else if (keys(t, `${p}.title`, drawingTitleFields))
      for (const k of drawingTitleFields) {
        if (k === 'date' ? !date(t[k]) : !line(t[k]))
          err(k === 'date' ? 'date' : 'shape', `${p}.title.${k}`);
      }
    if (!Array.isArray(s.revisions)) return err('shape', `${p}.revisions`);
    if (s.revisions.length > drawingLimits.revisions) err('limit-revisions', `${p}.revisions`);
    const marks = new Set<string>();
    s.revisions.forEach((r: unknown, j) => {
      const rp = `${p}.revisions[${j}]`;
      if (!record(r)) return err('shape', rp);
      if (!keys(r, rp, ['id', 'mark', 'date', 'description', 'by'])) return;
      id(r, rp);
      if (!line(r.mark, 8, false)) err('shape', `${rp}.mark`);
      else if (marks.has(r.mark as string)) err('revision-duplicate', `${rp}.mark`);
      else marks.add(r.mark as string);
      if (!date(r.date)) err('date', `${rp}.date`);
      if (!line(r.description)) err('shape', `${rp}.description`);
      if (!line(r.by)) err('shape', `${rp}.by`);
    });
  });
  const ref = (o: Rec, k: string, set: { has(k: string): boolean }, path: string, code: string) => {
    if (!drawingId(o[k])) err('shape', `${path}.${k}`);
    else if (!set.has(o[k] as string)) err(code, `${path}.${k}`, o[k] as string);
  };
  const viewKinds = new Map<string, Rec>();
  doc.views.forEach((v: unknown) => {
    if (record(v) && drawingId(v.id) && !viewKinds.has(v.id)) viewKinds.set(v.id, v);
  });
  const marks = new Set<string>();
  doc.views.forEach((v: unknown, i) => {
    const p = `$.views[${i}]`;
    if (!record(v)) return err('shape', p);
    if (!oneOf(drawingViewKinds, v.kind)) return err('view-kind', `${p}.kind`);
    const base = ['id', 'kind', 'sheetId', 'sourceId', 'name', 'at', 'scale', 'label'];
    const own =
      v.kind === 'cad-projection'
        ? ['direction', 'only', 'hiddenLines', 'centerLines']
        : v.kind === 'cad-section'
          ? ['parentId', 'line', 'mark', 'hiddenLines', 'centerLines']
          : v.kind === 'bim-view'
            ? ['bimViewId']
            : v.kind === 'bim-elevation'
              ? ['side']
              : v.kind === 'bim-framing'
                ? ['levelId']
                : v.kind === 'bim-frame'
                  ? ['gridId', 'bandMm']
                  : ['parentId', 'center', 'radius', 'mark'];
    if (!keys(v, p, [...base, ...own])) return;
    id(v, p);
    ref(v, 'sheetId', sheets, p, 'sheet-missing');
    ref(v, 'sourceId', sources, p, 'source-missing');
    // A building's views see a building version; the CAD views a CAD version (DW5a).
    const sourceKind = sources.get(v.sourceId as string);
    const building = drawingIsBuildingView(v as { kind: string });
    if (sourceKind && (sourceKind === 'bim') !== building) err('source-kind', `${p}.sourceId`);
    if (!line(v.name)) err('shape', `${p}.name`);
    if (!vec2(v.at)) err('point', `${p}.at`);
    if (!oneOf(building ? drawingBimScales : drawingScales, v.scale)) err('scale', `${p}.scale`);
    if (typeof v.label !== 'boolean') err('shape', `${p}.label`);
    if (v.kind === 'bim-view') {
      if (!line(v.bimViewId, 200, false)) err('shape', `${p}.bimViewId`);
      return;
    }
    if (v.kind === 'bim-elevation') {
      if (!oneOf(drawingElevationSides, v.side)) err('shape', `${p}.side`);
      return;
    }
    if (v.kind === 'bim-framing') {
      if (!line(v.levelId, 200, false)) err('shape', `${p}.levelId`);
      return;
    }
    if (v.kind === 'bim-frame') {
      if (!line(v.gridId, 200, false)) err('shape', `${p}.gridId`);
      if (!finite(v.bandMm) || v.bandMm < 0 || v.bandMm > 1e7) err('shape', `${p}.bandMm`);
      return;
    }
    if (v.kind !== 'cad-detail') {
      if (typeof v.hiddenLines !== 'boolean') err('shape', `${p}.hiddenLines`);
      if (typeof v.centerLines !== 'boolean') err('shape', `${p}.centerLines`);
    }
    if (v.kind === 'cad-projection') {
      if (!oneOf(drawingDirections, v.direction)) err('direction', `${p}.direction`);
      if (
        !Array.isArray(v.only) ||
        v.only.length > 10_000 ||
        !v.only.every(drawingId) ||
        new Set(v.only).size !== v.only.length
      )
        err('shape', `${p}.only`);
      return;
    }
    // A section cuts a projection seen square (not the isometric one); a detail enlarges a
    // projection or a section. Either sees its parent's source and carries a unique mark.
    if (typeof v.mark !== 'string' || !drawingMarkPattern.test(v.mark)) err('mark', `${p}.mark`);
    else if (marks.has(v.mark)) err('mark-duplicate', `${p}.mark`);
    else marks.add(v.mark);
    const parent = drawingId(v.parentId) ? viewKinds.get(v.parentId) : undefined;
    if (!drawingId(v.parentId)) err('shape', `${p}.parentId`);
    else if (!parent || parent === v) err('view-parent', `${p}.parentId`, v.parentId);
    else if (
      v.kind === 'cad-section'
        ? parent.kind !== 'cad-projection' || parent.direction === 'iso'
        : !(
            (parent.kind === 'cad-projection' && parent.direction !== 'iso') ||
            parent.kind === 'cad-section'
          )
    )
      err('view-parent-kind', `${p}.parentId`, v.parentId);
    else if (parent.sourceId !== v.sourceId) err('view-parent-source', `${p}.sourceId`);
    if (v.kind === 'cad-section') {
      const l = v.line;
      if (!Array.isArray(l) || l.length !== 2 || !model2(l[0]) || !model2(l[1]))
        return err('point', `${p}.line`);
      const [a, b] = l as [number[], number[]];
      if (Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!) < 1e-6) err('section-line', `${p}.line`);
    } else {
      if (!model2(v.center)) err('point', `${p}.center`);
      if (!finite(v.radius) || v.radius <= 0 || v.radius > 1e7) err('shape', `${p}.radius`);
    }
  });
  const viewIds = new Map<string, Rec>();
  for (const v of doc.views as unknown[]) if (record(v) && drawingId(v.id)) viewIds.set(v.id, v);
  const refOk = (r: unknown, path: string) => {
    if (!record(r)) return err('shape', path);
    if (!keys(r, path, ['path', 'bodyId', 'edge', 'point', 'model'], ['name'])) return;
    if (r.name !== undefined && !line(r.name, 4096, false)) err('shape', `${path}.name`);
    if (!Array.isArray(r.path) || r.path.length > 32 || !r.path.every(drawingId))
      err('shape', `${path}.path`);
    if (!drawingId(r.bodyId)) err('shape', `${path}.bodyId`);
    if (!Number.isInteger(r.edge) || (r.edge as number) < 0) err('shape', `${path}.edge`);
    if (!oneOf(drawingRefPoints, r.point)) err('ref-point', `${path}.point`);
    const m = r.model;
    if (!Array.isArray(m) || m.length !== 3 || !m.every((x) => finite(x) && Math.abs(x) <= 1e8))
      err('point', `${path}.model`);
  };
  /** A view an annotation is in: on the same sheet, a CAD view. */
  const inView = (a: Rec, p: string) => {
    if (!drawingId(a.viewId)) return err('shape', `${p}.viewId`);
    const v = viewIds.get(a.viewId);
    if (!v) err('view-missing', `${p}.viewId`, a.viewId);
    else if (v.sheetId !== a.sheetId) err('view-sheet', `${p}.viewId`, a.viewId);
  };
  /** A symbol's own fields (DW3b): each type's keys and values. */
  const datums = new Map<string, string>();
  const symbolOk = (sym: unknown, sp: string, owner: unknown) => {
    if (!record(sym)) return err('shape', sp);
    if (sym.type === 'gdt') {
      const k = ['type', 'characteristic', 'tolerance', 'diameter', 'modifier', 'datums'];
      if (!keys(sym, sp, k)) return;
      if (!oneOf(drawingGdtCharacteristics, sym.characteristic))
        return err('gdt-characteristic', `${sp}.characteristic`);
      if (!line(sym.tolerance, 16, false)) err('shape', `${sp}.tolerance`);
      if (typeof sym.diameter !== 'boolean') err('shape', `${sp}.diameter`);
      if (!oneOf(['', 'M', 'L'], sym.modifier)) err('shape', `${sp}.modifier`);
      const list = sym.datums;
      if (
        !Array.isArray(list) ||
        list.length > 3 ||
        !list.every((d) => typeof d === 'string' && drawingDatumPattern.test(d)) ||
        new Set(list).size !== list.length
      )
        return err('datum-letter', `${sp}.datums`);
      if (drawingGdtForms.includes(sym.characteristic) && list.length)
        err('gdt-datum-form', `${sp}.datums`);
      if (drawingGdtNeedsDatum.includes(sym.characteristic) && !list.length)
        err('gdt-datum-needed', `${sp}.datums`);
    } else if (sym.type === 'datum') {
      if (!keys(sym, sp, ['type', 'letter'])) return;
      if (typeof sym.letter !== 'string' || !drawingDatumPattern.test(sym.letter))
        return err('datum-letter', `${sp}.letter`);
      if (datums.has(sym.letter)) err('datum-duplicate', `${sp}.letter`, sym.letter);
      else datums.set(sym.letter, typeof owner === 'string' ? owner : '');
    } else if (sym.type === 'surface') {
      if (!keys(sym, sp, ['type', 'process', 'text'])) return;
      if (!oneOf(['any', 'removal', 'no-removal'], sym.process)) err('shape', `${sp}.process`);
      if (!line(sym.text, 32)) err('shape', `${sp}.text`);
    } else if (sym.type === 'weld') {
      const k = ['type', 'weld', 'side', 'size', 'length', 'allAround', 'field'];
      if (!keys(sym, sp, k)) return;
      if (!oneOf(drawingWeldTypes, sym.weld)) err('weld-type', `${sp}.weld`);
      if (!oneOf(['arrow', 'other', 'both'], sym.side)) err('shape', `${sp}.side`);
      if (!line(sym.size, 16)) err('shape', `${sp}.size`);
      if (!line(sym.length, 24)) err('shape', `${sp}.length`);
      if (typeof sym.allAround !== 'boolean') err('shape', `${sp}.allAround`);
      if (typeof sym.field !== 'boolean') err('shape', `${sp}.field`);
    } else err('symbol-type', `${sp}.type`);
  };
  /** An imported PMI item's content (DW3c-2b): its kind's keys, finite values, short names. */
  const pmiItemOk = (item: unknown, ip: string) => {
    if (!record(item)) return err('shape', ip);
    const word = (v: unknown) => line(v, 64, false);
    const value = (v: unknown) => finite(v) && Math.abs(v as number) <= 1e8;
    if (item.kind === 'dimension') {
      if (!keys(item, ip, ['kind', 'type', 'values'], ['deviation', 'qualifier'])) return;
      if (!word(item.type)) err('shape', `${ip}.type`);
      if (
        !Array.isArray(item.values) ||
        item.values.length < 1 ||
        item.values.length > 2 ||
        !item.values.every(value)
      )
        err('shape', `${ip}.values`);
      const d = item.deviation;
      if (
        d !== undefined &&
        (!record(d) ||
          !keys(d, `${ip}.deviation`, ['lower', 'upper']) ||
          !value(d.lower) ||
          !value(d.upper))
      )
        err('shape', `${ip}.deviation`);
      if (item.qualifier !== undefined && !oneOf(['min', 'max', 'avg'] as const, item.qualifier))
        err('shape', `${ip}.qualifier`);
    } else if (item.kind === 'geometric-tolerance') {
      if (
        !keys(
          item,
          ip,
          ['kind', 'type', 'value', 'modifiers', 'datums'],
          ['zone', 'maxValue', 'datumModifiers'],
        )
      )
        return;
      if (!word(item.type)) err('shape', `${ip}.type`);
      if (!value(item.value) || (item.value as number) < 0) err('shape', `${ip}.value`);
      if (item.zone !== undefined && !oneOf(['D', 'SD'] as const, item.zone))
        err('shape', `${ip}.zone`);
      for (const f of ['modifiers', 'datums'] as const) {
        const list = item[f];
        if (!Array.isArray(list) || list.length > 16 || !list.every(word))
          err('shape', `${ip}.${f}`);
      }
      if (item.maxValue !== undefined && (!value(item.maxValue) || (item.maxValue as number) <= 0))
        err('shape', `${ip}.maxValue`);
      const dm = item.datumModifiers as unknown;
      if (
        dm !== undefined &&
        (!Array.isArray(dm) ||
          !Array.isArray(item.datums) ||
          dm.length !== item.datums.length ||
          !dm.every((m) => Array.isArray(m) && m.length <= 16 && m.every(word)))
      )
        err('shape', `${ip}.datumModifiers`);
    } else if (item.kind === 'datum') {
      if (!keys(item, ip, ['kind', 'name'])) return;
      if (!line(item.name, 16, false)) err('shape', `${ip}.name`);
    } else if (item.kind === 'datum-target') {
      if (!keys(item, ip, ['kind', 'datum', 'number', 'type'])) return;
      if (!line(item.datum, 16, false)) err('shape', `${ip}.datum`);
      if (!Number.isInteger(item.number) || (item.number as number) < 0)
        err('shape', `${ip}.number`);
      if (!word(item.type)) err('shape', `${ip}.type`);
    } else err('pmi-kind', `${ip}.kind`);
  };
  doc.annotations.forEach((a: unknown, i) => {
    const p = `$.annotations[${i}]`;
    if (!record(a)) return err('shape', p);
    if (a.kind === 'note') {
      if (!keys(a, p, ['id', 'sheetId', 'kind', 'at', 'text', 'heightMm'])) return;
      if (!multiline(a.text)) err('shape', `${p}.text`);
    } else if (a.kind === 'dimension') {
      const k = ['id', 'sheetId', 'kind', 'viewId', 'type', 'refs', 'at', 'text', 'tolerance'];
      if (!keys(a, p, [...k, 'heightMm'])) return;
      inView(a, p);
      if (!oneOf(drawingDimensionTypes, a.type)) err('dimension-type', `${p}.type`);
      const n = a.type === 'diameter' || a.type === 'radius' ? 1 : 2;
      if (!Array.isArray(a.refs) || a.refs.length !== n) err('dimension-refs', `${p}.refs`);
      else
        a.refs.forEach((r: unknown, j) => {
          refOk(r, `${p}.refs[${j}]`);
          const point = record(r) ? r.point : undefined;
          const want =
            a.type === 'diameter' || a.type === 'radius' || a.type === 'angle'
              ? point === 'edge'
              : point !== 'edge';
          if (!want) err('ref-point', `${p}.refs[${j}].point`);
        });
      if (!line(a.text, 64)) err('shape', `${p}.text`);
      if (!line(a.tolerance, 32)) err('shape', `${p}.tolerance`);
    } else if (a.kind === 'leader') {
      const k = ['id', 'sheetId', 'kind', 'viewId', 'ref', 'target', 'at', 'text', 'heightMm'];
      if (!keys(a, p, k)) return;
      if (a.ref !== null) {
        inView(a, p);
        refOk(a.ref, `${p}.ref`);
      } else if (a.viewId !== '') err('shape', `${p}.viewId`);
      if (!vec2(a.target)) err('point', `${p}.target`);
      if (!multiline(a.text)) err('shape', `${p}.text`);
    } else if (a.kind === 'symbol') {
      const k = ['id', 'sheetId', 'kind', 'viewId', 'ref', 'target', 'at', 'symbol', 'heightMm'];
      if (!keys(a, p, k)) return;
      if (a.ref !== null) {
        inView(a, p);
        refOk(a.ref, `${p}.ref`);
      } else if (a.viewId !== '') err('shape', `${p}.viewId`);
      if (!vec2(a.target)) err('point', `${p}.target`);
      symbolOk(a.symbol, `${p}.symbol`, a.id);
    } else if (a.kind === 'pmi') {
      const k = ['id', 'sheetId', 'kind', 'viewId', 'source', 'item', 'at', 'heightMm'];
      if (!keys(a, p, k)) return;
      inView(a, p);
      const src = a.source;
      if (!record(src)) err('shape', `${p}.source`);
      else if (keys(src, `${p}.source`, ['path', 'bodyId', 'itemId', 'assetSha256'])) {
        if (!Array.isArray(src.path) || src.path.length > 32 || !src.path.every(drawingId))
          err('shape', `${p}.source.path`);
        if (!drawingId(src.bodyId)) err('shape', `${p}.source.bodyId`);
        if (!line(src.itemId, 64, false)) err('shape', `${p}.source.itemId`);
        if (typeof src.assetSha256 !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(src.assetSha256))
          err('shape', `${p}.source.assetSha256`);
      }
      pmiItemOk(a.item, `${p}.item`);
    } else if (a.kind === 'balloon') {
      if (!keys(a, p, ['id', 'sheetId', 'kind', 'viewId', 'ref', 'at', 'heightMm'])) return;
      inView(a, p);
      refOk(a.ref, `${p}.ref`);
    } else if (a.kind === 'parts-list') {
      if (!keys(a, p, ['id', 'sheetId', 'kind', 'viewId', 'at', 'heightMm'])) return;
      inView(a, p);
    } else return err('annotation-kind', `${p}.kind`);
    id(a, p);
    ref(a, 'sheetId', sheets, p, 'sheet-missing');
    if (!vec2(a.at)) err('point', `${p}.at`);
    if (!oneOf(drawingTextHeights, a.heightMm)) err('text-height', `${p}.heightMm`);
  });
  if (!out.length && drawingContentBytes(doc) > drawingLimits.contentBytes)
    err('limit-content', '$');
  return out;
}

export class DrawingValidationError extends Error {
  constructor(readonly diagnostics: DrawingDiagnostic[]) {
    super(diagnostics.map((d) => `${d.code}@${d.path}`).join(', '));
  }
}
export function assertDrawing(input: unknown): asserts input is DrawingDocument {
  const d = validateDrawing(input);
  if (d.length) throw new DrawingValidationError(d);
}
export const isDrawingDocument = (input: unknown): input is DrawingDocument =>
  validateDrawing(input).length === 0;
export const drawingContentBytes = (doc: unknown) =>
  new TextEncoder().encode(canonicalJson(doc)).length;
