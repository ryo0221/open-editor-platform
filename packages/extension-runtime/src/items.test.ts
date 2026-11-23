import { describe, expect, it } from 'vitest';
import { counterExtension } from '@editor-platform/extension-sample';
import { ITEMS_ADDON } from '@editor-platform/extension-contract';
import { parseManifest } from './index';
import { ITEMS_LIMITS, itemsDeclarationProblems, readItems, type ItemsAddon } from './items';

const hash = `sha256:${'4'.repeat(64)}`;
const leading = (text: string) => /^[A-Z]{2}-\d{2}/.exec(text)?.[0];

const model: ItemsAddon = {
  version: ITEMS_ADDON,
  collections: [
    { at: 'assumptions', id: 'id', title: 'name' },
    { at: 'scenarios', id: 'id', title: 'name', refs: ['assumptionIds', 'base'] },
  ],
};
const tree: ItemsAddon = {
  version: ITEMS_ADDON,
  collections: [
    {
      at: 'nodes',
      id: { field: 'text', from: 'leading-token' },
      refs: ['link.id'],
      layout: ['side', 'collapsed'],
    },
  ],
};

describe('items@0-draft manifest', () => {
  it('accepts a data-only declaration and keeps it frozen in the canonical manifest', () => {
    const base = counterExtension(hash).manifest;
    const m = parseManifest({ ...base, addons: { items: model } });
    expect(m.addons?.items).toEqual(model);
    expect(Object.isFrozen(m.addons!.items!.collections[1]!.refs)).toBe(true);
  });

  it('refuses unknown versions, keys, patterns and unsafe paths', () => {
    const base = counterExtension(hash).manifest;
    const bad: unknown[] = [
      { version: 'items@1', collections: model.collections },
      { version: ITEMS_ADDON, collections: [] },
      { version: ITEMS_ADDON, collections: model.collections, extra: 1 },
      {
        version: ITEMS_ADDON,
        collections: [{ at: 'a', id: { field: 'text', pattern: '^(.*)$' } }],
      },
      { version: ITEMS_ADDON, collections: [{ at: 'a', id: { field: 'text', from: 'regex' } }] },
      { version: ITEMS_ADDON, collections: [{ at: '__proto__', id: 'id', title: 'name' }] },
      { version: ITEMS_ADDON, collections: [{ at: 'a', id: 'id' }] },
      {
        version: ITEMS_ADDON,
        collections: [{ at: 'a', id: 'id', title: 'name', refs: ['x', 'x'] }],
      },
      { version: ITEMS_ADDON, collections: [{ at: 'a', id: 'id', title: 'name', code: 'x' }] },
    ];
    for (const items of bad) {
      expect(itemsDeclarationProblems(items).length, JSON.stringify(items)).toBeGreaterThan(0);
      expect(() => parseManifest({ ...base, addons: { items } }), JSON.stringify(items)).toThrow(
        /items add-on/,
      );
    }
  });
});

describe('readItems', () => {
  it('reads array elements by an ID property, with links from string and list properties', () => {
    const r = readItems(
      model,
      {
        assumptions: [
          { id: 'FA-01', name: '単価' },
          { id: 'FA-02', name: '数量' },
          { name: 'ID の無い行' },
        ],
        scenarios: [
          { id: 'SC-01', name: '基本', assumptionIds: ['FA-01', 'FA-02', 'FA-01'], base: 'SC-00' },
        ],
      },
      leading,
    );
    expect(r.problems).toEqual([]);
    expect(r.items.map((i) => [i.id, i.title, i.refs])).toEqual([
      ['FA-01', '単価', []],
      ['FA-02', '数量', []],
      ['SC-01', '基本', ['FA-01', 'FA-02', 'SC-00']],
    ]);
    expect(r.items[2]).toMatchObject({ collection: 1, key: '0' });
  });

  it('reads object values whose text starts with an ID the Host recognises, and drops layout properties from the body', () => {
    const r = readItems(
      tree,
      {
        nodes: {
          'n-1': {
            id: 'n-1',
            text: 'OP-01 現場の手間を減らす',
            side: 'left',
            collapsed: true,
            children: ['n-2'],
          },
          'n-2': {
            id: 'n-2',
            text: 'CP-02：紙の日報',
            children: [],
            link: { namespace: 'x', id: 'OP-01' },
          },
          'n-3': { id: 'n-3', text: 'OP-01x は ID ではない', children: [] },
          'n-4': { id: 'n-4', text: 'メモだけの枝', children: [] },
        },
      },
      leading,
    );
    expect(r.problems).toEqual([]);
    expect(r.items.map((i) => [i.id, i.title, i.refs, i.key])).toEqual([
      ['OP-01', '現場の手間を減らす', [], 'n-1'],
      ['CP-02', '紙の日報', ['OP-01'], 'n-2'],
    ]);
    expect(r.items[0]!.body).toEqual({
      id: 'n-1',
      text: 'OP-01 現場の手間を減らす',
      children: ['n-2'],
    });
  });

  it('reports wrong shapes without throwing, and skips a missing collection', () => {
    const r = readItems(
      model,
      { assumptions: 'x', scenarios: [{ id: 'SC-01', name: 'a', assumptionIds: [1] }] },
      leading,
    );
    expect(r.problems).toEqual([
      'assumptions: is not an array or object',
      'scenarios[0].assumptionIds: must be an ID or a list of IDs',
    ]);
    expect(readItems(model, {}, leading)).toEqual({ items: [], problems: [] });
  });
  it('counts only identified items toward the limit', () => {
    const flat: ItemsAddon = {
      version: ITEMS_ADDON,
      collections: [
        { at: 'a', id: 'id', title: 'id' },
        { at: 'b', id: 'id', title: 'id' },
      ],
    };
    const a = Array.from({ length: ITEMS_LIMITS.items }, (_, i) => ({ id: `X-${i}` }));
    const ok = readItems(flat, { a: [...a, { name: 'no id' }], b: [{ name: 'no id' }] }, leading);
    expect(ok.problems).toEqual([]);
    expect(ok.items).toHaveLength(ITEMS_LIMITS.items);
    const over = readItems(flat, { a, b: [{ id: 'Y-1' }, { id: 'Y-2' }] }, leading);
    expect(over.problems).toEqual([`more than ${ITEMS_LIMITS.items} items`]);
    expect(over.items).toHaveLength(ITEMS_LIMITS.items);
  });
});
