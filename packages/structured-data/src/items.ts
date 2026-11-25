/**
 * Data schema 3: which columns of a table hold business item IDs and which hold or point to the
 * IDs an item cites (docs/analysis-references-design.md U1・U2・U6). Declarations name column IDs,
 * never column names, so renaming a column keeps its meaning. A row may carry `refs` (reference
 * field → business IDs) for an item that cites several items; refs are not cells, so cell types,
 * formulas and sorting do not change. OEP does not decide the form of an ID.
 */
import type { Column, DataRow, StructuredData } from './model';

/** One kind of item read from the rows. `refs` entries are column IDs or `refs.<field>`. */
export interface DataItemsDeclaration {
  /** Display name of the item kind, such as `failure-cause`. The Host maps IDs to kinds itself. */
  kind: string;
  /** Column holding the business ID (text). A row with an empty ID is not an item. */
  id: string;
  /** Column holding the title (text). */
  title: string;
  /** Columns (text) or row reference fields (`refs.<field>`) holding cited IDs. */
  refs?: string[];
  /**
   * Display names of row reference fields, keyed by their `refs.<field>` entry (columns show their
   * column name). A field without a name shows its field name.
   */
  labels?: Record<string, string>;
  /**
   * Rows with the same ID are one item when these columns and the `refs` entries hold the same
   * values in every row; otherwise the ID is a duplicate (U6).
   */
  merge?: { equal: string[] };
}

export const DATA_ITEMS_LIMITS = Object.freeze({
  declarations: 16,
  refs: 32,
  /** IDs in one reference field of one row. */
  ids: 500,
  /** Code points of an ID. */
  id: 128,
});

const FIELD = /^[A-Za-z_$][A-Za-z0-9_$-]{0,63}$/;
const plain = (v: unknown): v is Record<string, unknown> =>
  !!v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;
const safe = (s: string) =>
  FIELD.test(s) && s !== '__proto__' && s !== 'constructor' && s !== 'prototype';
export const refField = (entry: string): string | undefined =>
  entry.startsWith('refs.') ? entry.slice(5) : undefined;

/** A row's reference fields: each field name maps to distinct, non-empty IDs. */
export function validRowRefs(refs: unknown): refs is Record<string, string[]> {
  return (
    plain(refs) &&
    Object.entries(refs).every(
      ([k, ids]) =>
        safe(k) &&
        Array.isArray(ids) &&
        ids.length <= DATA_ITEMS_LIMITS.ids &&
        ids.every(
          (x) => typeof x === 'string' && x !== '' && [...x].length <= DATA_ITEMS_LIMITS.id,
        ) &&
        new Set(ids).size === ids.length,
    )
  );
}

/** Problems with a table's `items` declarations against its columns (empty when valid). */
export function dataItemsProblems(items: unknown, columns: readonly Column[]): string[] {
  if (!Array.isArray(items) || !items.length || items.length > DATA_ITEMS_LIMITS.declarations)
    return [`items must list 1-${DATA_ITEMS_LIMITS.declarations} declarations`];
  const byId = new Map(columns.map((c) => [c.id, c]));
  const text = (id: unknown) => typeof id === 'string' && byId.get(id)?.type === 'text';
  const column = (id: unknown) => typeof id === 'string' && byId.has(id) && safe(id);
  const out: string[] = [];
  items.forEach((d, i) => {
    const at = `items[${i}]`;
    if (
      !plain(d) ||
      Object.keys(d).some((k) => !['kind', 'id', 'title', 'refs', 'labels', 'merge'].includes(k))
    )
      return void out.push(`${at}: must be { kind, id, title, refs?, labels?, merge? }`);
    if (typeof d.kind !== 'string' || !d.kind.trim() || d.kind.length > 64)
      out.push(`${at}.kind: must be a name of 1-64 characters`);
    if (!text(d.id) || !safe(d.id as string)) out.push(`${at}.id: must be a text column`);
    if (!text(d.title) || !safe(d.title as string)) out.push(`${at}.title: must be a text column`);
    if (d.refs !== undefined) {
      const refs = d.refs;
      const ok =
        Array.isArray(refs) &&
        refs.length > 0 &&
        refs.length <= DATA_ITEMS_LIMITS.refs &&
        new Set(refs).size === refs.length &&
        refs.every((r) => {
          if (typeof r !== 'string' || r === d.id) return false;
          const field = refField(r);
          return field !== undefined ? safe(field) : text(r) && safe(r);
        });
      if (!ok)
        out.push(`${at}.refs: must list text columns or refs.<field>, without the ID column`);
    }
    if (d.labels !== undefined) {
      const refs = Array.isArray(d.refs) ? d.refs : [];
      const ok =
        plain(d.labels) &&
        Object.entries(d.labels).every(
          ([entry, label]) =>
            refs.includes(entry) &&
            refField(entry) !== undefined &&
            typeof label === 'string' &&
            !!label.trim() &&
            [...label].length <= 64,
        );
      if (!ok)
        out.push(`${at}.labels: must name refs.<field> entries of refs with 1-64 characters`);
    }
    if (d.merge !== undefined) {
      const m = d.merge;
      const ok =
        plain(m) &&
        Object.keys(m).length === 1 &&
        Array.isArray(m.equal) &&
        m.equal.length <= DATA_ITEMS_LIMITS.refs &&
        new Set(m.equal).size === m.equal.length &&
        // 式の列は保存したセルに値が無いので比べられない
        m.equal.every((c) => column(c) && c !== d.id && byId.get(c as string)?.type !== 'formula');
      if (!ok) out.push(`${at}.merge: must be { equal: column IDs }`);
    }
  });
  return out;
}

/** Path of a declaration entry in a saved row. */
const rowPath = (entry: string) => (refField(entry) !== undefined ? entry : `values.${entry}`);

/**
 * The `items@1-draft` declaration for a table, or undefined when it declares no items. Paths
 * address the saved table (`rows[].values`, `rows[].refs`). Element keys in what `readItems`
 * returns are row indexes in `rows`.
 */
export function dataItemsDeclaration(data: Pick<StructuredData, 'items'>):
  | {
      version: 'items@1-draft';
      collections: {
        at: 'rows';
        id: string;
        title: string;
        refs?: string[];
        merge?: { equal: string[] };
      }[];
    }
  | undefined {
  if (!data.items?.length) return undefined;
  return {
    version: 'items@1-draft',
    collections: data.items.map((d) => ({
      at: 'rows' as const,
      id: rowPath(d.id),
      title: rowPath(d.title),
      ...(d.refs ? { refs: d.refs.map(rowPath) } : {}),
      ...(d.merge ? { merge: { equal: d.merge.equal.map(rowPath) } } : {}),
    })),
  };
}

/**
 * Declarations without a deleted column (U5): a declaration whose ID column is gone is removed
 * (its items are gone), a deleted title falls back to the ID column, and refs and merge entries
 * drop it. Undefined when nothing is left.
 */
export function itemsWithoutColumn(
  items: readonly DataItemsDeclaration[] | undefined,
  columnId: string,
): DataItemsDeclaration[] | undefined {
  if (!items) return undefined;
  const out = items
    .filter((d) => d.id !== columnId)
    .map((d) => {
      const refs = d.refs?.filter((r) => r !== columnId);
      const equal = d.merge?.equal.filter((c) => c !== columnId);
      return {
        kind: d.kind,
        id: d.id,
        title: d.title === columnId ? d.id : d.title,
        ...(refs?.length ? { refs } : {}),
        ...(refs?.length && d.labels ? { labels: d.labels } : {}),
        ...(equal ? { merge: { equal } } : {}),
      };
    });
  return out.length ? out : undefined;
}

/** Whether a column is the ID, title or a cited column of a declaration (it must stay text). */
export const itemsTextColumn = (data: Pick<StructuredData, 'items'>, columnId: string) =>
  !!data.items?.some(
    (d) => d.id === columnId || d.title === columnId || !!d.refs?.includes(columnId),
  );
/** Whether a column is compared by a merge (it must not become a formula). */
export const itemsMergeColumn = (data: Pick<StructuredData, 'items'>, columnId: string) =>
  !!data.items?.some((d) => !!d.merge?.equal.includes(columnId));

/** Reference fields declared by any declaration, in declaration order. */
export function declaredRefFields(data: Pick<StructuredData, 'items'>): string[] {
  const out: string[] = [];
  for (const d of data.items ?? [])
    for (const r of d.refs ?? []) {
      const f = refField(r);
      if (f !== undefined && !out.includes(f)) out.push(f);
    }
  return out;
}

/** The display name of a row reference field (`refs.<field>`): its declared name, else the field name. */
export function refFieldLabel(data: Pick<StructuredData, 'items'>, field: string): string {
  const entry = `refs.${field}`;
  for (const d of data.items ?? []) {
    const label = d.labels?.[entry];
    if (label) return label;
  }
  return field;
}

/** A row's IDs in one reference field, for CSV and display (`;` between IDs). */
export const rowRefsText = (row: DataRow, field: string) =>
  (Object.hasOwn(row.refs ?? {}, field) ? row.refs![field]! : []).join(';');

/** Reference entries (column IDs or `refs.<field>`) of the declarations this row is an item of. */
export function rowReferenceEntries(data: StructuredData, row: DataRow): string[] {
  const out: string[] = [];
  for (const d of data.items ?? []) {
    const id = row.values[d.id];
    if (typeof id !== 'string' || !id) continue;
    for (const r of d.refs ?? []) if (!out.includes(r)) out.push(r);
  }
  return out;
}
/** A row's cited IDs in one reference entry (one per column, several per reference field). */
export function rowReferenceIds(row: DataRow, entry: string): string[] {
  const f = refField(entry);
  if (f !== undefined) return Object.hasOwn(row.refs ?? {}, f) ? [...row.refs![f]!] : [];
  const v = row.values[entry];
  return typeof v === 'string' && v ? [v] : [];
}
