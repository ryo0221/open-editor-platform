import { describe, expect, it } from 'vitest';
import { counterExtension } from '@editor-platform/extension-sample';
import { ITEMS_ADDON, ITEMS_ADDON_V1 } from '@editor-platform/extension-contract';
import { parseManifest } from './index';
import {
  READABLE_ITEMS_VERSIONS,
  itemsDeclarationFor,
  itemsDeclarationProblems,
  readItems,
  type ItemsAddon,
} from './items';

const hash = `sha256:${'4'.repeat(64)}`;
const none = () => undefined;

/** FMEA の表（docs/analysis-references-design.md U1・U2・U6）：1 行 = 故障原因、故障モードは行から多対一。 */
const fmea: ItemsAddon = {
  version: ITEMS_ADDON_V1,
  collections: [
    {
      at: 'rows',
      id: 'cells.fcId',
      title: 'cells.cause',
      refs: ['cells.fmId', 'refs.causeCandidates'],
    },
    {
      at: 'rows',
      id: 'cells.fmId',
      title: 'cells.failure',
      refs: ['cells.functionRef'],
      merge: { equal: ['cells.failure', 'cells.effect', 'cells.s'] },
    },
  ],
};
type Row = { id: string; cells: Record<string, string | number>; refs?: Record<string, string[]> };
const row = (
  id: string,
  fc: string,
  fm: string,
  more: Partial<Row['cells']> = {},
  cc?: string[],
): Row => ({
  id,
  cells: {
    fcId: fc,
    cause: `${fc} の原因`,
    fmId: fm,
    failure: `${fm} 止まらない`,
    effect: '空焚き',
    s: 9,
    o: 3,
    d: 4,
    functionRef: 'FN-01',
    ...more,
  },
  ...(cc ? { refs: { causeCandidates: cc } } : {}),
});
const rows = () => [
  row('row-1', 'FC-01', 'FM-01', {}, ['CC-01', 'CC-02']),
  row('row-2', 'FC-02', 'FM-01', { o: 5 }),
  row('row-3', 'FC-03', 'FM-02', { failure: '早く切れる', effect: '沸かない', s: 4 }),
];
const view = (r: ReturnType<typeof readItems>) =>
  r.items.map((i) => [i.id, i.title, i.refs, i.elements]);

describe('items@1-draft declaration', () => {
  it('accepts where, rootRefs and merge only in 1-draft, and the manifest keeps them', () => {
    const graph: ItemsAddon = {
      version: ITEMS_ADDON_V1,
      collections: [
        {
          at: 'nodes',
          where: { type: 'cause' },
          id: 'attributes.itemId',
          title: 'attributes.name',
          rootRefs: ['attributes.problemRef'],
        },
      ],
    };
    expect(itemsDeclarationProblems(graph)).toEqual([]);
    expect(itemsDeclarationProblems(fmea)).toEqual([]);
    const m = parseManifest({ ...counterExtension(hash).manifest, addons: { items: fmea } });
    expect(m.addons?.items).toEqual(fmea);
    // 0-draft の意味は変えない：新しい欄は断る
    for (const c of graph.collections) {
      expect(itemsDeclarationProblems({ version: ITEMS_ADDON, collections: [c] })).toEqual([
        'items[0]: must be { at, id, title?, refs?, layout? }',
      ]);
    }
  });

  it('refuses malformed where, rootRefs and merge', () => {
    const base = { at: 'rows', id: 'id', title: 'name' };
    const bad: unknown[] = [
      { ...base, where: {} },
      { ...base, where: { type: { eq: 'x' } } },
      { ...base, where: { __proto__: 'x' } },
      { ...base, where: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, 1])) },
      { ...base, rootRefs: [] },
      { ...base, rootRefs: ['a', 'a'] },
      { ...base, merge: { equal: ['x'], by: 'id' } },
      { ...base, merge: ['x'] },
      { ...base, merge: { equal: ['x', 'x'] } },
    ];
    for (const c of bad)
      expect(
        itemsDeclarationProblems({ version: ITEMS_ADDON_V1, collections: [c] }).length,
        JSON.stringify(c),
      ).toBeGreaterThan(0);
    expect(itemsDeclarationProblems({ version: 'items@2-draft', collections: [base] })).toEqual([
      'unsupported items add-on version items@2-draft',
    ]);
  });

  it('hands a declaration only to a Host that reads its version, never a part of it', () => {
    expect(itemsDeclarationFor(fmea, READABLE_ITEMS_VERSIONS)).toBe(fmea);
    expect(itemsDeclarationFor(fmea, [ITEMS_ADDON])).toBeUndefined();
    expect(itemsDeclarationFor(fmea, undefined)).toBeUndefined();
  });
});

describe('readItems with items@1-draft', () => {
  it('reads one failure cause per row and projects failure modes many-to-one, with their row keys', () => {
    const r = readItems(fmea, { rows: rows() }, none);
    expect(r.problems).toEqual([]);
    expect(r.duplicates).toEqual([]);
    expect(view(r)).toEqual([
      ['FC-01', 'FC-01 の原因', ['FM-01', 'CC-01', 'CC-02'], ['0']],
      ['FC-02', 'FC-02 の原因', ['FM-01'], ['1']],
      ['FC-03', 'FC-03 の原因', ['FM-02'], ['2']],
      ['FM-01', 'FM-01 止まらない', ['FN-01'], ['0', '1']],
      ['FM-02', '早く切れる', ['FN-01'], ['2']],
    ]);
    // FM の中身は一致を求めた欄と参照の欄だけ（行ごとの O・D は入らない）
    expect(r.items[3]!.body).toEqual({
      cells: { failure: 'FM-01 止まらない', effect: '空焚き', s: 9, functionRef: 'FN-01' },
    });
  });

  it('keeps the same failure mode when rows are deleted, reordered or added, and its body changes only with compared fields', () => {
    const fm = (list: Row[]) =>
      readItems(fmea, { rows: list }, none).items.find((i) => i.id === 'FM-01')!;
    const before = fm(rows());
    const [r1, r2, r3] = rows();
    const deleted = fm([r2!, r3!]);
    const reordered = fm([r3!, r2!, r1!]);
    const added = fm([...rows(), row('row-4', 'FC-04', 'FM-01', { o: 1, d: 9 })]);
    for (const after of [deleted, reordered, added]) expect(after.body).toEqual(before.body);
    expect(deleted.elements).toEqual(['0']);
    expect(reordered.elements).toEqual(['1', '2']);
    expect(added.elements).toEqual(['0', '1', '3']);
    // 一致を求めた欄を全行で変えると中身が変わる（同じ ID のまま）
    const changed = fm(
      rows().map((x) => (x.cells.fmId === 'FM-01' ? { ...x, cells: { ...x.cells, s: 10 } } : x)),
    );
    expect(changed.id).toBe('FM-01');
    expect(changed.body).not.toEqual(before.body);
  });

  it('treats a merged ID whose compared fields or refs differ as a duplicate, naming the paths', () => {
    const list = rows();
    list[1] = row('row-2', 'FC-02', 'FM-01', { effect: '焦げる', functionRef: 'FN-02' });
    const r = readItems(fmea, { rows: list }, none);
    expect(r.items.map((i) => i.id)).toEqual(['FC-01', 'FC-02', 'FC-03', 'FM-02']);
    expect(r.duplicates).toEqual([
      {
        id: 'FM-01',
        reason: 'merge-mismatch',
        elements: [
          { collection: 1, key: '0' },
          { collection: 1, key: '1' },
        ],
        paths: ['cells.effect', 'cells.functionRef'],
      },
    ]);
  });

  it('treats the same ID on two elements without a merge, or in two collections, as a duplicate', () => {
    const list = [...rows(), row('row-4', 'FC-01', 'FM-03')];
    list.push(row('row-5', 'FM-02', 'FM-04'));
    const r = readItems(fmea, { rows: list }, none);
    expect(
      r.duplicates!.map((d) => [d.id, d.reason, d.elements.map((e) => `${e.collection}:${e.key}`)]),
    ).toEqual([
      ['FC-01', 'same-id', ['0:0', '0:3']],
      ['FM-02', 'same-id', ['0:4', '1:2']],
    ]);
    expect(r.items.map((i) => i.id)).not.toContain('FC-01');
    expect(r.items.map((i) => i.id)).not.toContain('FM-02');
  });

  it('filters nodes by where and adds root refs to every item of the collection', () => {
    const tree: ItemsAddon = {
      version: ITEMS_ADDON_V1,
      collections: [
        {
          at: 'nodes',
          where: { type: 'cause' },
          id: 'attributes.itemId',
          title: 'attributes.name',
          rootRefs: ['attributes.problemRef'],
        },
      ],
    };
    const doc = {
      attributes: { problemRef: 'PB-01' },
      nodes: [
        { id: 'n1', type: 'problem', attributes: { itemId: 'PB-99', name: '問題' } },
        { id: 'n2', type: 'cause', attributes: { itemId: 'CC-01', name: '接点の溶着' } },
        { id: 'n3', type: 'cause', attributes: { name: 'ID の無い候補' } },
        { id: 'n4', type: 'category', attributes: { itemId: 'CC-09', name: '分類' } },
      ],
    };
    const r = readItems(tree, doc, none);
    expect(r.problems).toEqual([]);
    expect(view(r)).toEqual([['CC-01', '接点の溶着', ['PB-01'], ['1']]]);
    const bad = readItems(tree, { ...doc, attributes: { problemRef: 3 } }, none);
    expect(bad.problems).toEqual(['(root).attributes.problemRef: must be an ID or a list of IDs']);
  });

  it('leaves 0-draft output unchanged (no elements, no duplicates)', () => {
    const v0: ItemsAddon = {
      version: ITEMS_ADDON,
      collections: [{ at: 'rows', id: 'cells.fcId', title: 'cells.cause' }],
    };
    const r = readItems(v0, { rows: [...rows(), row('row-4', 'FC-01', 'FM-03')] }, none);
    expect(r.duplicates).toBeUndefined();
    expect(r.items.map((i) => [i.id, i.elements])).toEqual([
      ['FC-01', undefined],
      ['FC-02', undefined],
      ['FC-03', undefined],
      ['FC-01', undefined],
    ]);
  });

  it('does not write into frozen content when merge paths overlap', () => {
    const nested: ItemsAddon = {
      version: ITEMS_ADDON_V1,
      collections: [
        { at: 'rows', id: 'id', title: 'name', merge: { equal: ['details', 'details.s'] } },
      ],
    };
    const doc = Object.freeze({
      rows: Object.freeze([
        Object.freeze({ id: 'FM-01', name: 'a', details: Object.freeze({ s: 9, effect: 'x' }) }),
      ]),
    });
    const r = readItems(nested, doc, none);
    expect(r.items[0]!.body).toEqual({ details: { s: 9, effect: 'x' } });
  });

  it('builds merged bodies from own properties only, never through inherited ones', () => {
    const decl: ItemsAddon = {
      version: ITEMS_ADDON_V1,
      collections: [{ at: 'rows', id: 'id', title: 'id', merge: { equal: ['toString.call'] } }],
    };
    const call = Object.prototype.toString.call;
    const r = readItems(decl, { rows: [{ id: 'FM-01', toString: { call: 'x' } }] }, none);
    expect(Object.prototype.toString.call).toBe(call);
    expect(r.items[0]!.body).toEqual({ toString: { call: 'x' } });
  });

  it('treats null and missing compared values alike, so row order does not change a merged body', () => {
    const decl: ItemsAddon = {
      version: ITEMS_ADDON_V1,
      collections: [
        { at: 'rows', id: 'id', title: 'name', refs: ['fn'], merge: { equal: ['name'] } },
      ],
    };
    const a = { id: 'FM-01', name: 'x', fn: null };
    const b = { id: 'FM-01', name: 'x' };
    const one = readItems(decl, { rows: [a, b] }, none).items[0]!;
    const two = readItems(decl, { rows: [b, a] }, none).items[0]!;
    expect(one.body).toEqual({ name: 'x' });
    expect(two.body).toEqual(one.body);
  });

  it('refuses layout paths that overlap the compared paths of a merge', () => {
    for (const layout of [['target'], ['name'], ['details'], ['details.s.x']]) {
      const c = {
        at: 'rows',
        id: 'id',
        title: 'name',
        refs: ['target'],
        layout,
        merge: { equal: ['name', 'details.s'] },
      };
      expect(
        itemsDeclarationProblems({ version: ITEMS_ADDON_V1, collections: [c] }),
        JSON.stringify(layout),
      ).toEqual(['items[0].layout: must not overlap merge.equal or refs paths']);
    }
    const ok = {
      at: 'rows',
      id: 'id',
      title: 'name',
      refs: ['target'],
      layout: ['color'],
      merge: { equal: ['name'] },
    };
    expect(itemsDeclarationProblems({ version: ITEMS_ADDON_V1, collections: [ok] })).toEqual([]);
  });
});
