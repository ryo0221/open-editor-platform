import {
  FactoryValidationError,
  type FactoryDiagnostic,
  type FactoryDistribution,
  type FactoryDocument,
  type FactoryObject,
} from './model';
import type { FactoryOperation } from './operations';

/** RFC 4180 rows: quoted fields may hold commas, quotes ("") and line breaks. */
export function parseFactoryCsvRows(text: string): string[][] | { error: string; line: number } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let closed = false;
  let line = 1;
  let opened = 1;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else {
        if (ch === '\n') line++;
        field += ch;
      }
      continue;
    }
    if (closed && ch !== ',' && ch !== '\n' && ch !== '\r')
      return { error: 'characters after a quoted field', line };
    closed = false;
    if (ch === '"') {
      if (field !== '') return { error: 'a quote inside an unquoted field', line };
      quoted = true;
      opened = line;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      line++;
    } else field += ch;
  }
  if (quoted) return { error: 'a quoted field is not closed', line: opened };
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0]!.trim() === ''));
}

/**
 * FT2: the times of a model as a table, in seconds. One row per object time: the processing time
 * of a station, parallel station or assembly, the interval of a source, or (with `product`) a
 * station's time for one product. `object` and `type` are required; the other columns are the
 * distribution's values. Empirical distributions are not written or read.
 */
export const factoryTimesCsvColumns = [
  'object',
  'product',
  'type',
  'value',
  'min',
  'mode',
  'max',
  'mean',
  'sd',
] as const;
const params: Record<string, string[]> = {
  const: ['value'],
  uniform: ['min', 'max'],
  triangular: ['min', 'mode', 'max'],
  normal: ['mean', 'sd'],
  lognormal: ['mean', 'sd'],
  exponential: ['mean'],
};
/** Values a type may leave empty (the bounds of a normal distribution). */
const optional: Record<string, string[]> = { normal: ['min', 'max'] };
const allowed = (type: string) => [...(params[type] ?? []), ...(optional[type] ?? [])];

const csvField = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
/** Seconds with up to three decimals (whole milliseconds), no trailing zeros. */
const seconds = (ms: number) => String(Math.round(ms) / 1000);

/** Writes every non-empirical time of the model, in object order. */
export function writeFactoryTimesCsv(doc: FactoryDocument): string {
  const lines = [factoryTimesCsvColumns.join(',')];
  const row = (object: string, product: string, d: FactoryDistribution) => {
    if (d.type === 'empirical') return;
    const values = d as unknown as Record<string, number | undefined>;
    lines.push(
      [
        object,
        product,
        d.type,
        ...factoryTimesCsvColumns
          .slice(3)
          .map((k) =>
            allowed(d.type).includes(k) && values[k] !== undefined ? seconds(values[k]) : '',
          ),
      ]
        .map(csvField)
        .join(','),
    );
  };
  for (const o of doc.objects) {
    if (o.kind === 'source') row(o.id, '', o.interval);
    if (o.kind === 'station' || o.kind === 'parallel' || o.kind === 'assembly')
      row(o.id, '', o.processTime);
    if (o.kind === 'station' || o.kind === 'parallel')
      for (const t of o.productTimes ?? []) row(o.id, t.productId, t.time);
  }
  return lines.join('\r\n') + '\r\n';
}

/**
 * Reads a times CSV into one `putObject` operation per changed object (apply them as one
 * command). Columns in any order, names without case. A row naming an unknown object, a product
 * time on a source or assembly, a duplicate row, an unknown type, a missing or extra value or a
 * value that is not a number of seconds refuses the whole file with its line.
 */
export function readFactoryTimesCsv(doc: FactoryDocument, text: string): FactoryOperation[] {
  const fail = (message: string, line: number): never => {
    const d: FactoryDiagnostic = { code: 'csv', path: `line ${line}`, message };
    throw new FactoryValidationError('csv', `line ${line}: ${message}`, [d]);
  };
  const rows = parseFactoryCsvRows(text);
  if (!Array.isArray(rows)) return fail(rows.error, rows.line);
  if (!rows.length) return fail('no header', 1);
  const header = rows[0]!.map((h) => h.trim().toLowerCase());
  header.forEach((h) => {
    if (!(factoryTimesCsvColumns as readonly string[]).includes(h)) fail(`unknown column ${h}`, 1);
  });
  if (new Set(header).size !== header.length) fail('a column twice', 1);
  for (const need of ['object', 'type']) if (!header.includes(need)) fail(`no ${need} column`, 1);
  const objects = new Map<string, FactoryObject>(
    doc.objects.map((o) => [o.id, structuredClone(o)]),
  );
  const changed = new Set<string>();
  const seen = new Set<string>();
  rows.slice(1).forEach((r, i) => {
    const line = i + 2;
    if (r.length > header.length) fail('more fields than columns', line);
    const get = (k: string) => (r[header.indexOf(k)] ?? '').trim();
    const id = get('object');
    const product = header.includes('product') ? get('product') : '';
    const o = objects.get(id) ?? fail(`no object ${id}`, line);
    const key = `${id}\u0000${product}`;
    if (seen.has(key)) fail('the same time twice', line);
    seen.add(key);
    const type = get('type');
    const names = params[type] ?? fail(`unknown type ${type}`, line);
    const d: Record<string, unknown> = { type };
    for (const k of factoryTimesCsvColumns.slice(3)) {
      const v = header.includes(k) ? get(k) : '';
      if (!allowed(type).includes(k)) {
        if (v !== '') fail(`${k} is not a value of ${type}`, line);
        continue;
      }
      if (v === '' && !names.includes(k)) continue;
      if (v === '') fail(`${k} is required for ${type}`, line);
      const n = Number(v);
      if (!/^[0-9]+(\.[0-9]+)?$/.test(v) || !Number.isFinite(n)) fail(`${k} is not seconds`, line);
      d[k] = Math.round(n * 1000);
    }
    const dist = d as unknown as FactoryDistribution;
    if (product) {
      if (o.kind !== 'station' && o.kind !== 'parallel') fail(`${id} has no product times`, line);
      const s = o as Extract<FactoryObject, { kind: 'station' | 'parallel' }>;
      const list = (s.productTimes ??= []);
      const at = list.findIndex((t) => t.productId === product);
      if (at >= 0) list[at] = { productId: product, time: dist };
      else list.push({ productId: product, time: dist });
    } else if (o.kind === 'source') o.interval = dist;
    else if (o.kind === 'station' || o.kind === 'parallel' || o.kind === 'assembly')
      o.processTime = dist;
    else fail(`${id} has no time`, line);
    changed.add(id);
  });
  return doc.objects
    .filter((o) => changed.has(o.id))
    .map((o) => ({ type: 'putObject' as const, object: objects.get(o.id)! }));
}
