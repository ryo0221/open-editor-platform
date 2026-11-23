/**
 * Data-only reading for the optional `items@0-draft` add-on. A package declares where the
 * identified items of its content are and which properties link one item to another; a Host
 * lists the items and links with these functions without loading or running package code.
 * Patterns are never taken from the package: for a `leading-token` ID the Host finds the ID at
 * the head of the text with its own ID forms.
 */
import {
  ITEMS_ADDON,
  type ItemIdSource,
  type ItemsCollection,
  type ManifestAddons,
} from '@editor-platform/extension-contract';

export const ITEMS_LIMITS = Object.freeze({
  /** Collections one package may declare. */
  collections: 16,
  /** Ref and layout paths of one collection. */
  paths: 32,
  /** Segments of one dotted path. */
  depth: 8,
  /** Items read from one content. Beyond it the reader stops with a problem. */
  items: 5000,
  /** IDs read from one ref path of one element. */
  refs: 500,
  /** Code points of an ID. */
  id: 128,
});

export type ItemsAddon = NonNullable<ManifestAddons['items']>;
/** One item read from content. `body` is the element without its layout properties. */
export interface ReadItem {
  id: string;
  title: string;
  refs: readonly string[];
  body: unknown;
  /** Index of the collection in the declaration and the element's key (array index or property). */
  collection: number;
  key: string;
}
export interface ReadItems {
  items: ReadItem[];
  problems: string[];
}

const SEGMENT = /^[A-Za-z_$][A-Za-z0-9_$-]{0,63}$/;
const plain = (v: unknown): v is Record<string, unknown> =>
  !!v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;
const pathOk = (p: unknown): p is string =>
  typeof p === 'string' &&
  p.split('.').length <= ITEMS_LIMITS.depth &&
  p
    .split('.')
    .every((s) => SEGMENT.test(s) && s !== '__proto__' && s !== 'constructor' && s !== 'prototype');
const paths = (v: unknown, empty: boolean): v is readonly string[] =>
  Array.isArray(v) &&
  v.length <= ITEMS_LIMITS.paths &&
  (empty || v.length > 0) &&
  v.every(pathOk) &&
  new Set(v).size === v.length;

/** Problems with an `items` add-on declaration (empty when it is valid). */
export function itemsDeclarationProblems(addon: unknown): string[] {
  if (!plain(addon) || Object.keys(addon).some((k) => k !== 'version' && k !== 'collections'))
    return ['items add-on must be { version, collections }'];
  if (addon.version !== ITEMS_ADDON)
    return [`unsupported items add-on version ${String(addon.version)}`];
  const list = addon.collections;
  if (!Array.isArray(list) || !list.length || list.length > ITEMS_LIMITS.collections)
    return [`collections must list 1-${ITEMS_LIMITS.collections} collections`];
  const out: string[] = [];
  list.forEach((c, i) => {
    const at = `items[${i}]`;
    if (
      !plain(c) ||
      Object.keys(c).some((k) => !['at', 'id', 'title', 'refs', 'layout'].includes(k))
    )
      return void out.push(`${at}: must be { at, id, title?, refs?, layout? }`);
    if (c.at !== '' && !pathOk(c.at)) out.push(`${at}.at: invalid path`);
    const id = c.id;
    const idOk =
      pathOk(id) ||
      (plain(id) &&
        Object.keys(id).length === 2 &&
        pathOk(id.field) &&
        id.from === 'leading-token');
    if (!idOk) out.push(`${at}.id: must be a path or { field, from: 'leading-token' }`);
    if (c.title !== undefined && !pathOk(c.title)) out.push(`${at}.title: invalid path`);
    if (c.title === undefined && !plain(id))
      out.push(`${at}.title: required when the ID is a whole property`);
    if (c.refs !== undefined && !paths(c.refs, false)) out.push(`${at}.refs: invalid paths`);
    if (c.layout !== undefined && !paths(c.layout, false)) out.push(`${at}.layout: invalid paths`);
  });
  return out;
}

const dig = (v: unknown, path: string): unknown =>
  path === ''
    ? v
    : path
        .split('.')
        .reduce<unknown>((o, k) => (plain(o) && Object.hasOwn(o, k) ? o[k] : undefined), v);
const drop = (v: unknown, path: string): unknown => {
  if (!plain(v)) return v;
  const [head, ...rest] = path.split('.');
  if (!Object.hasOwn(v, head!)) return v;
  if (!rest.length) {
    const { [head!]: _gone, ...keep } = v;
    return keep;
  }
  return { ...v, [head!]: drop(v[head!], rest.join('.')) };
};
const codePoints = (s: string) => [...s].length;

/**
 * Lists the items of `value` by the declaration. For `leading-token` IDs, `leadingId(text)` returns
 * the ID written at the head of the text (by the Host's own ID forms), or undefined. Elements
 * without an ID are skipped; wrong shapes (a collection that is not an array or object, a ref
 * that is not a string) are problems.
 */
export function readItems(
  addon: ItemsAddon,
  value: unknown,
  leadingId: (text: string) => string | undefined,
): ReadItems {
  const out: ReadItems = { items: [], problems: [] };
  const declared = itemsDeclarationProblems(addon);
  if (declared.length) return { items: [], problems: declared };
  let full = false;
  addon.collections.forEach((c: ItemsCollection, ci) => {
    const where = c.at || '(whole content)';
    const box = dig(value, c.at);
    if (box === undefined) return;
    const entries: [string, unknown][] = Array.isArray(box)
      ? box.map((e, i) => [String(i), e])
      : plain(box)
        ? Object.entries(box)
        : (out.problems.push(`${where}: is not an array or object`), []);
    for (const [key, e] of entries) {
      if (full) return;
      if (!plain(e)) continue;
      const head = idOf(c.id, e, leadingId);
      if (!head) continue;
      // 上限は、もう 1 つ項目が増えるときにだけ問題にする（ID の無い要素は数えない）
      if (out.items.length >= ITEMS_LIMITS.items) {
        out.problems.push(`more than ${ITEMS_LIMITS.items} items`);
        full = true;
        return;
      }
      if (codePoints(head.id) > ITEMS_LIMITS.id) {
        out.problems.push(`${where}[${key}]: ID is too long`);
        continue;
      }
      const titleValue = c.title !== undefined ? dig(e, c.title) : head.rest;
      const refs: string[] = [];
      for (const p of c.refs ?? []) {
        const r = dig(e, p);
        if (r === undefined || r === null) continue;
        const list = typeof r === 'string' ? [r] : Array.isArray(r) ? r : undefined;
        if (!list || !list.every((x) => typeof x === 'string') || list.length > ITEMS_LIMITS.refs) {
          out.problems.push(`${where}[${key}].${p}: must be an ID or a list of IDs`);
          continue;
        }
        for (const x of list as string[]) if (x && x !== head.id && !refs.includes(x)) refs.push(x);
      }
      const body = (c.layout ?? []).reduce<unknown>((b, p) => drop(b, p), e);
      out.items.push({
        id: head.id,
        title: typeof titleValue === 'string' ? titleValue : head.id,
        refs,
        body,
        collection: ci,
        key,
      });
    }
  });
  return out;
}

function idOf(
  source: ItemIdSource,
  e: Record<string, unknown>,
  leadingId: (text: string) => string | undefined,
): { id: string; rest?: string } | undefined {
  if (typeof source === 'string') {
    const v = dig(e, source);
    return typeof v === 'string' && v ? { id: v } : undefined;
  }
  const text = dig(e, source.field);
  if (typeof text !== 'string') return undefined;
  const lead = text.trimStart();
  const id = leadingId(lead);
  // The ID must be the head of the text and end at a separator (or the end), not inside a word.
  if (!id || !lead.startsWith(id)) return undefined;
  const after = lead.slice(id.length);
  if (after && !/^[\s:：・、,，.。)）\]]/u.test(after)) return undefined;
  return { id, rest: after.replace(/^[\s:：・、,，.。]+/u, '').trim() };
}
