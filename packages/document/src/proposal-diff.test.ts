import { describe, expect, it } from 'vitest';
import {
  EditorSession,
  command,
  reviewProposedCommands,
  withCommandReads,
} from '@editor-platform/editor-core';
import { deleteBlock, updateBlock, type DocumentContent } from './model';
import { documentProposalDiff } from './proposal-diff';

const content = (): DocumentContent => ({
  schemaVersion: 2,
  blocks: [
    { id: 'title', type: 'heading', level: 1, text: 'Launch plan' },
    { id: 'body', type: 'paragraph', text: 'Ship on Friday.\nThen review.' },
    {
      id: 'list',
      type: 'bulleted-list',
      text: 'One\nTwo',
      items: [
        { id: 'item-1', rich: [{ text: 'One' }] },
        { id: 'item-2', rich: [{ text: 'Two' }] },
      ],
    },
  ],
});
const edit = () =>
  withCommandReads(updateBlock('body', { text: 'Ship on Monday.\nThen review.' }), {
    content: ['body'],
  });
const review = (d: DocumentContent, commands = [edit()]) =>
  reviewProposedCommands(
    { content: d, base: { artifactId: 'doc', versionId: 'v1' } },
    { id: 'p', summary: 'Fixed all dates', commands },
    documentProposalDiff,
  );

describe('Document proposal diff', () => {
  it('gives the changed text range by stable block ID and matches the native command', () => {
    const d = content();
    const result = review(d);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.changes).toEqual([
      {
        domain: 'document',
        kind: 'text',
        elementId: 'body',
        elementLabel: 'Ship on Friday.\nThen review.',
        property: 'text',
        before: 'Ship on Friday.\nThen review.',
        after: 'Ship on Monday.\nThen review.',
        units: 'utf16',
        range: { start: 8, beforeEnd: 11, afterEnd: 11 },
      },
    ]);
    const session = new EditorSession(d);
    session.execute(edit());
    expect(session.content).toEqual(result.preview.content);
    expect(d).toEqual(content());
  });
  it('addresses list items by their own IDs, and block structure separately', () => {
    const d = content();
    const items = updateBlock('list', {
      items: [
        { id: 'item-1', rich: [{ text: 'One' }] },
        { id: 'item-2', rich: [{ text: 'Two', bold: true }] },
        { id: 'item-3', rich: [{ text: 'Three' }] },
      ],
      text: 'One\nTwo\nThree',
    });
    const result = review(d, [items, updateBlock('title', { level: 2 }), deleteBlock('body')]);
    expect(
      result.status === 'ready' && result.changes.map((c) => [c.kind, c.elementId, c.property]),
    ).toEqual([
      ['removed', 'body', 'paragraph'],
      ['property', 'title', 'level'],
      ['property', 'item-2', 'formatting'],
      ['added', 'item-3', 'text'],
    ]);
  });
  it('reports checked items, moved items and moved formatting boundaries', () => {
    const d = content();
    const list = d.blocks[2];
    const kinds = (patch: Parameters<typeof updateBlock>[1]) => {
      const r = review(d, [updateBlock('list', patch)]);
      return r.status === 'ready' ? r.changes.map((c) => [c.kind, c.elementId, c.property]) : r;
    };
    expect(
      kinds({ items: [{ ...list.items![0], checked: true }, list.items![1]], text: list.text }),
    ).toEqual([['property', 'item-1', 'item']]);
    expect(kinds({ items: [list.items![1], list.items![0]], text: 'Two\nOne' })).toEqual([
      ['order', 'list', 'items'],
    ]);
    expect(
      kinds({
        items: [
          { id: 'item-1', rich: [{ text: 'O', bold: true }, { text: 'ne' }] },
          list.items![1],
        ],
        text: list.text,
      }),
    ).toEqual([['property', 'item-1', 'formatting']]);
    expect(
      kinds({
        items: [{ ...list.items![0], childrenType: 'bullet_list', children: [list.items![1]] }],
        text: list.text,
      }),
    ).toEqual([
      ['property', 'item-1', 'item'],
      ['order', 'list', 'items'],
    ]);
    // Same text and the same sequence of marks, but the bold run grows by one character.
    const formatted = content();
    formatted.blocks[2].items![0] = {
      id: 'item-1',
      rich: [{ text: 'O', bold: true }, { text: 'ne' }],
    };
    const grown = review(formatted, [
      updateBlock('list', {
        items: [
          { id: 'item-1', rich: [{ text: 'On', bold: true }, { text: 'e' }] },
          list.items![1],
        ],
      }),
    ]);
    expect(grown.status === 'ready' && grown.changes.map((c) => c.property)).toEqual([
      'formatting',
    ]);
  });
  it('reports formatting that changes with the text, and the content of added blocks', () => {
    const d = content();
    d.blocks[0] = { ...d.blocks[0], rich: [{ text: 'Launch plan' }] };
    const bold = review(d, [
      updateBlock('title', { text: 'Launch plans', rich: [{ text: 'Launch plans', bold: true }] }),
    ]);
    expect(bold.status === 'ready' && bold.changes.map((c) => c.property)).toEqual([
      'text',
      'formatting',
    ]);
    const typed = review(d, [
      updateBlock('title', { text: 'Launch plans', rich: [{ text: 'Launch plans' }] }),
    ]);
    expect(typed.status === 'ready' && typed.changes.map((c) => c.property)).toEqual(['text']);
    const table = {
      id: 'grid',
      type: 'table' as const,
      text: '',
      cells: [['Owner', 'Due']],
    };
    const added = review(d, [
      command<DocumentContent>('document.insert', 'Add table', (c) => ({
        ...c,
        blocks: [...c.blocks, table],
      })),
    ]);
    expect(added).toMatchObject({
      status: 'ready',
      changes: [{ kind: 'added', elementId: 'grid', after: table }],
    });
  });
  it('keeps the state and formatting of added items, and table paragraph positions', () => {
    const d = content();
    const add = updateBlock('list', {
      items: [
        { id: 'item-1', rich: [{ text: 'One' }] },
        { id: 'item-2', rich: [{ text: 'Two' }] },
        { id: 'new', checked: true, rich: [{ text: 'Done', bold: true }] },
      ],
      text: 'One\nTwo\nDone',
    });
    expect(review(d, [add])).toMatchObject({
      status: 'ready',
      changes: [
        {
          kind: 'added',
          elementId: 'new',
          after: { text: 'Done', marks: [{ bold: true, length: 4 }], attrs: { checked: true } },
        },
      ],
    });
    const p = (id: string, text: string) => ({ id, rich: [{ text }] });
    const table: DocumentContent = {
      ...d,
      blocks: [
        {
          id: 'table',
          type: 'table',
          text: '',
          cells: [['A', 'B']],
          cellParagraphs: [[[p('pa', 'A')], [p('pb', 'B')]]],
        },
      ],
    };
    const swap = updateBlock('table', {
      cellParagraphs: [[[p('pb', 'B')], [p('pa', 'A')]]],
      cells: [['B', 'A']],
    });
    const result = review(table, [swap]);
    expect(
      result.status === 'ready' && result.changes.find((c) => c.kind === 'order'),
    ).toMatchObject({
      property: 'items',
      before: [
        ['pa', '0:0'],
        ['pb', '0:1'],
      ],
      after: [
        ['pb', '0:0'],
        ['pa', '0:1'],
      ],
    });
  });
  it('keeps heading levels, block formatting and table cell formatting', () => {
    const d = content();
    const heading = {
      id: 'h',
      type: 'heading' as const,
      level: 3,
      text: 'Hello',
      rich: [{ text: 'Hello', bold: true }],
    };
    const add = command<DocumentContent>('document.insert', 'Insert', (c) => ({
      ...c,
      blocks: [...c.blocks, heading],
    }));
    expect(review(d, [add])).toMatchObject({
      status: 'ready',
      changes: [{ kind: 'added', elementId: 'h', after: heading }],
    });
    const table: DocumentContent = {
      ...d,
      blocks: [{ id: 't', type: 'table', text: '', cells: [['a']], cellRich: [[[{ text: 'a' }]]] }],
    };
    const bold = updateBlock('t', { cells: [['ab']], cellRich: [[[{ text: 'ab', bold: true }]]] });
    const result = review(table, [bold]);
    expect(result.status === 'ready' && result.changes.map((c) => [c.kind, c.property])).toEqual([
      ['text', 'text'],
      ['property', 'formatting'],
    ]);
  });
  it('reports nested list settings with a text edit, and uses stored cell paragraph IDs', () => {
    const d = content();
    const nested = (type: 'bullet_list' | 'ordered_list', start?: number, text = 'One') =>
      updateBlock('list', {
        items: [
          {
            id: 'item-1',
            rich: [{ text }],
            childLists: [
              {
                id: 'sub',
                type,
                ...(start ? { start } : {}),
                items: [{ id: 'c', rich: [{ text: 'x' }] }],
              },
            ],
          },
          { id: 'item-2', rich: [{ text: 'Two' }] },
        ],
        text: `${text}\nx\nTwo`,
      });
    const base = new EditorSession(d);
    base.execute(nested('bullet_list'));
    const result = review(base.content, [nested('ordered_list', 5, 'ONE')]);
    expect(
      result.status === 'ready' && result.changes.map((c) => [c.elementId, c.property]),
    ).toEqual([
      ['item-1', 'text'],
      ['item-1', 'item'],
    ]);
    const table: DocumentContent = {
      ...d,
      blocks: [
        { id: 't', type: 'table', text: '', cells: [['a']], cellParagraphIds: [['para-a']] },
      ],
    };
    expect(review(table, [updateBlock('t', { cells: [['b']] })])).toMatchObject({
      status: 'ready',
      elementIds: ['para-a'],
    });
  });
  it('reports an item moved between two nested lists of the same parent', () => {
    const d = content();
    const item = (id: string) => ({ id, rich: [{ text: id }] });
    const lists = (first: string[], second: string[], text = 'One') =>
      updateBlock('list', {
        items: [
          {
            id: 'item-1',
            rich: [{ text }],
            childLists: [
              { id: 'bullets', type: 'bullet_list' as const, items: first.map(item) },
              { id: 'numbers', type: 'ordered_list' as const, items: second.map(item) },
            ],
          },
        ],
        text,
      });
    const base = new EditorSession(d);
    base.execute(lists(['a', 'b'], ['c']));
    const result = review(base.content, [lists(['a'], ['b', 'c'], 'ONE')]);
    expect(result.status === 'ready' && result.changes.map((c) => [c.kind, c.property])).toEqual([
      ['text', 'text'],
      ['order', 'items'],
    ]);
  });
  it('resolves each table cell on its own when only some cells have paragraphs', () => {
    const d = content();
    const table: DocumentContent = {
      ...d,
      blocks: [
        {
          id: 't',
          type: 'table',
          text: '',
          cells: [['a', 'b']],
          cellParagraphs: [[[{ id: 'pa', rich: [{ text: 'a' }] }]]],
        },
      ],
    };
    const both = updateBlock('t', {
      cells: [['A', 'B']],
      cellParagraphs: [[[{ id: 'pa', rich: [{ text: 'A' }] }]]],
    });
    const result = review(table, [both]);
    expect(result.status === 'ready' && result.changes.map((c) => [c.elementId, c.after])).toEqual([
      ['pa', 'A'],
      ['t:cell:0:1', 'B'],
    ]);
  });
  it('reads the text a reader sees from rich spans', () => {
    const d = content();
    const base = {
      ...d,
      blocks: [{ id: 'p', type: 'paragraph' as const, text: 'a', rich: [{ text: 'a' }] }],
    };
    const result = review(base, [
      updateBlock('p', { rich: [{ text: 'Secret replacement', bold: true }] }),
    ]);
    expect(result.status === 'ready' && result.changes[0]).toMatchObject({
      kind: 'text',
      before: 'a',
      after: 'Secret replacement',
    });
  });
  it('refuses a proposal for a deleted block', () => {
    const d = content();
    d.blocks = d.blocks.filter((b) => b.id !== 'body');
    expect(review(d)).toMatchObject({
      status: 'refused',
      reason: 'missing-target',
      elementIds: ['body'],
    });
  });
});
