/**
 * Data-only reading for the optional `items@0-draft` and `items@1-draft` add-ons. A package declares where the
 * identified items of its content are and which properties link one item to another; a Host
 * lists the items and links with these functions without loading or running package code.
 * Patterns are never taken from the package: for a `leading-token` ID the Host finds the ID at
 * the head of the text with its own ID forms.
 */
import {
  ITEMS_ADDON,
  ITEMS_ADDON_V1,
  ITEMS_ADDON_VERSIONS,
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
  /** Conditions of one `where`. */
  where: 8,
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
  /**
   * `items@1-draft` only: keys of all elements that hold this ID in this content (one for an
   * ordinary item, one or more for a merged one), in content order. For navigation and display;
   * an item's identity is its ID, not these keys.
   */
  elements?: readonly string[];
}
/** `items@1-draft` only: an ID that more than one item claims. Hosts resolve it to none of them. */
export interface ItemDuplicate {
  id: string;
  /** `same-id`: two elements (or collections) without a merge; `merge-mismatch`: merged elements differ. */
  reason: 'same-id' | 'merge-mismatch';
  /** Elements that hold the ID, in content order. */
  elements: readonly { collection: number; key: string }[];
  /** For `merge-mismatch`: the `equal` or `refs` paths whose values differ. */
  paths?: readonly string[];
}
export interface ReadItems {
  items: ReadItem[];
  problems: string[];
  /** `items@1-draft` only. */
  duplicates?: ItemDuplicate[];
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

const primitive = (v: unknown) =>
  typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));
const V0_KEYS = ['at', 'id', 'title', 'refs', 'layout'];
const V1_KEYS = [...V0_KEYS, 'where', 'rootRefs', 'merge'];

/** Problems with an `items` add-on declaration (empty when it is valid). */
export function itemsDeclarationProblems(addon: unknown): string[] {
  if (!plain(addon) || Object.keys(addon).some((k) => k !== 'version' && k !== 'collections'))
    return ['items add-on must be { version, collections }'];
  if (addon.version !== ITEMS_ADDON && addon.version !== ITEMS_ADDON_V1)
    return [`unsupported items add-on version ${String(addon.version)}`];
  const v1 = addon.version === ITEMS_ADDON_V1;
  const list = addon.collections;
  if (!Array.isArray(list) || !list.length || list.length > ITEMS_LIMITS.collections)
    return [`collections must list 1-${ITEMS_LIMITS.collections} collections`];
  const out: string[] = [];
  list.forEach((c, i) => {
    const at = `items[${i}]`;
    const keys = v1 ? V1_KEYS : V0_KEYS;
    if (!plain(c) || Object.keys(c).some((k) => !keys.includes(k)))
      return void out.push(
        v1
          ? `${at}: must be { at, id, title?, refs?, layout?, where?, rootRefs?, merge? }`
          : `${at}: must be { at, id, title?, refs?, layout? }`,
      );
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
    if (!v1) return;
    if (c.where !== undefined) {
      const w = c.where;
      const entries = plain(w) ? Object.entries(w) : [];
      if (
        !entries.length ||
        entries.length > ITEMS_LIMITS.where ||
        !entries.every(([k, v]) => pathOk(k) && primitive(v))
      )
        out.push(
          `${at}.where: must map 1-${ITEMS_LIMITS.where} paths to a string, number or boolean`,
        );
    }
    if (c.rootRefs !== undefined && !paths(c.rootRefs, false))
      out.push(`${at}.rootRefs: invalid paths`);
    if (c.merge !== undefined) {
      const m = c.merge;
      if (!plain(m) || Object.keys(m).some((k) => k !== 'equal') || !paths(m.equal, true))
        out.push(`${at}.merge: must be { equal: paths }`);
      // 見た目の欄は比べる前に除くので、比べる道筋（equal・refs）と重ねない
      // 形を確かめた道筋どうしだけを比べる（形の違う refs・layout は上で問題にしてある）
      else if (paths(c.layout, false) && (c.refs === undefined || paths(c.refs, false))) {
        const overlap = (a: string, b: string) =>
          a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
        const compared = [...(m.equal as string[]), ...((c.refs as string[] | undefined) ?? [])];
        if ((c.layout as string[]).some((l) => compared.some((p) => overlap(l, p))))
          out.push(`${at}.layout: must not overlap merge.equal or refs paths`);
      }
    }
  });
  return out;
}

/**
 * The declaration to hand to a Host that reads the given items add-on versions, or undefined when
 * it cannot read this declaration's version (never a down-converted part of it).
 */
export function itemsDeclarationFor<A extends { version: string }>(
  declaration: A,
  hostVersions: readonly string[] | undefined,
): A | undefined {
  return hostVersions?.includes(declaration.version) ? declaration : undefined;
}
/** Items add-on versions this OEP reads. */
export const READABLE_ITEMS_VERSIONS: readonly string[] = ITEMS_ADDON_VERSIONS;

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

/** Copy of the given paths of `v` (the shape of a merged item: only what the merge compares). */
const pick = (v: unknown, list: readonly string[]): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const p of list) {
    const x = dig(v, p);
    // 比べるときと同じく、null と欠けは同じ（どちらも中身に入れない）
    if (x === undefined || x === null) continue;
    // 写してから入れる（祖先と子孫の道筋が両方あるとき、元の中身に書き込まない）
    const segs = p.split('.');
    let o = out;
    // 自分の欄だけをたどる（toString などの受け継いだ欄に書き込まない）
    for (const k of segs.slice(0, -1)) {
      if (!Object.hasOwn(o, k) || !plain(o[k])) o[k] = {};
      o = o[k] as Record<string, unknown>;
    }
    o[segs[segs.length - 1]!] = structuredClone(x);
  }
  return out;
};
/** Order-sensitive comparison key for JSON data (property order does not matter). */
const keyOf = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) =>
    plain(x) ? Object.fromEntries(Object.entries(x).sort(([p], [q]) => (p < q ? -1 : 1))) : x,
  ) ?? 'undefined';

/**
 * Reads the IDs at `p` of `e` into `refs` (skipping `self` and repeats). Adds a problem when the
 * value is not an ID or a list of IDs.
 */
function addRefs(
  e: unknown,
  p: string,
  self: string,
  refs: string[],
  where: string,
  problems: string[],
): void {
  const r = dig(e, p);
  if (r === undefined || r === null) return;
  const list = typeof r === 'string' ? [r] : Array.isArray(r) ? r : undefined;
  if (!list || !list.every((x) => typeof x === 'string') || list.length > ITEMS_LIMITS.refs) {
    problems.push(`${where}.${p}: must be an ID or a list of IDs`);
    return;
  }
  for (const x of list as string[]) if (x && x !== self && !refs.includes(x)) refs.push(x);
}

/**
 * Lists the items of `value` by the declaration. For `leading-token` IDs, `leadingId(text)` returns
 * the ID written at the head of the text (by the Host's own ID forms), or undefined. Elements
 * without an ID are skipped; wrong shapes (a collection that is not an array or object, a ref
 * that is not a string) are problems.
 *
 * With `items@1-draft`, `where` filters elements, `rootRefs` adds the IDs at those root paths to
 * every item of the collection, and `merge` makes elements with the same ID one item (its body
 * holds only the `equal` and `refs` paths). An ID that two items claim (two elements without a
 * merge, merged elements that differ, or two collections) is listed in `duplicates` and left out
 * of `items`. Each item lists the keys of its `elements`.
 */
export function readItems(
  addon: ItemsAddon,
  value: unknown,
  leadingId: (text: string) => string | undefined,
): ReadItems {
  const out: ReadItems = { items: [], problems: [] };
  const declared = itemsDeclarationProblems(addon);
  if (declared.length) return { items: [], problems: declared };
  const v1 = addon.version === ITEMS_ADDON_V1;
  let full = false;
  let count = 0;
  /** `items@1-draft`: every element read, by ID, before merging. */
  const read = new Map<string, ReadItem[]>();
  addon.collections.forEach((c: ItemsCollection, ci) => {
    const where = c.at || '(whole content)';
    const box = dig(value, c.at);
    if (box === undefined) return;
    const entries: [string, unknown][] = Array.isArray(box)
      ? box.map((e, i) => [String(i), e])
      : plain(box)
        ? Object.entries(box)
        : (out.problems.push(`${where}: is not an array or object`), []);
    const filter = v1 && c.where ? Object.entries(c.where) : [];
    for (const [key, e] of entries) {
      if (full) return;
      if (!plain(e)) continue;
      if (filter.some(([p, want]) => dig(e, p) !== want)) continue;
      const head = idOf(c.id, e, leadingId);
      if (!head) continue;
      // 上限は、もう 1 つ項目が増えるときにだけ問題にする（ID の無い要素は数えない）
      if (count >= ITEMS_LIMITS.items) {
        out.problems.push(`more than ${ITEMS_LIMITS.items} items`);
        full = true;
        return;
      }
      if (codePoints(head.id) > ITEMS_LIMITS.id) {
        out.problems.push(`${where}[${key}]: ID is too long`);
        continue;
      }
      count++;
      const titleValue = c.title !== undefined ? dig(e, c.title) : head.rest;
      const refs: string[] = [];
      for (const p of c.refs ?? []) addRefs(e, p, head.id, refs, `${where}[${key}]`, out.problems);
      if (v1)
        for (const p of c.rootRefs ?? []) addRefs(value, p, head.id, refs, '(root)', out.problems);
      const body = (c.layout ?? []).reduce<unknown>((b, p) => drop(b, p), e);
      const item: ReadItem = {
        id: head.id,
        title: typeof titleValue === 'string' ? titleValue : head.id,
        refs,
        body,
        collection: ci,
        key,
      };
      if (!v1) out.items.push(item);
      else read.set(head.id, [...(read.get(head.id) ?? []), item]);
    }
  });
  if (!v1) return out;
  // 根の参照の誤りは要素ごとに繰り返さない
  out.problems = [...new Set(out.problems)];
  out.duplicates = [];
  for (const [id, all] of read) {
    const elements = all.map((i) => ({ collection: i.collection, key: i.key }));
    const c = addon.collections[all[0]!.collection]!;
    if (all.some((i) => i.collection !== all[0]!.collection) || (all.length > 1 && !c.merge)) {
      out.duplicates.push({ id, reason: 'same-id', elements });
      continue;
    }
    if (!c.merge) {
      out.items.push({ ...all[0]!, elements: [all[0]!.key] });
      continue;
    }
    const compared = [...new Set([...c.merge.equal, ...(c.refs ?? [])])];
    const differ = compared.filter(
      (p) => new Set(all.map((i) => keyOf(dig(i.body, p) ?? null))).size > 1,
    );
    if (differ.length) {
      out.duplicates.push({ id, reason: 'merge-mismatch', elements, paths: differ });
      continue;
    }
    const first = all[0]!;
    out.items.push({
      ...first,
      body: pick(first.body, compared),
      elements: all.map((i) => i.key),
    });
  }
  // Map は最初に読んだ順なので、項目と重複は内容の順（最初の要素の位置）に並ぶ
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
