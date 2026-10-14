import { expect, it } from 'vitest';
import { canonicalJson } from '@editor-platform/artifact-core';
import { contentToNode, documentSchema } from './engine';
import { createEngineJsonWriter } from './engine-json';
import type { DocumentContent } from './model';

const write = createEngineJsonWriter(documentSchema);

it('preserves exact existing engine fingerprints for native text, marks, lists, tables and embeds', () => {
  const content: DocumentContent = {
    schemaVersion: 2,
    blocks: [
      {
        id: 'title',
        type: 'heading',
        level: 2,
        text: '引用 " 日本語\n改行',
        hidden: true,
        style: { color: '#ff0000', fontSize: 22 },
      },
      {
        id: 'body',
        type: 'paragraph',
        text: '本文',
        rich: [{ text: '本文', bold: true, italic: true, link: 'https://example.com/?a=1&b=2' }],
      },
      { id: 'code', type: 'code', text: 'a\tb\n', language: 'ts' },
      {
        id: 'list',
        type: 'numbered-list',
        text: 'item',
        start: 3,
        items: [
          {
            id: 'item',
            rich: [{ text: 'item', underline: true }],
            children: [{ id: 'child', rich: [{ text: 'child' }] }],
          },
        ],
      },
      {
        id: 'table',
        type: 'table',
        text: '',
        cells: [
          ['氏名\n部署', '備考'],
          ['結合', ''],
        ],
        merges: [{ row: 1, col: 0, rows: 1, cols: 2 }],
      },
      { id: 'diagram', type: 'mermaid', text: 'graph TD\nA-->B' },
    ],
  };
  const doc = contentToNode(content);
  expect(write(doc)).toBe(canonicalJson(doc.toJSON()));
  doc.descendants((node) => {
    expect(write(node)).toBe(canonicalJson(node.toJSON()));
  });
  expect(write(documentSchema.node('doc', null, [documentSchema.node('paragraph')]))).toBe(
    canonicalJson(documentSchema.node('doc', null, [documentSchema.node('paragraph')]).toJSON()),
  );
});

it('recomputes mutable attributes, escapes, omitted values and numeric keys exactly', () => {
  const style: Record<string, unknown> = {
    '2': 'two',
    '10': 'ten',
    missing: undefined,
    text: '\ud800\t"\\',
  };
  const node = documentSchema.node('paragraph', { id: 'body', style }, [
    documentSchema.text('本文'),
  ]);
  expect(write(node)).toBe(canonicalJson(node.toJSON()));
  style.text = '更新';
  expect(write(node)).toBe(canonicalJson(node.toJSON()));
  const inherited = Object.create({ inherited: true }) as Record<string, unknown>;
  Object.assign(inherited, { id: 'inherited', style: { n: -0 } });
  const current = documentSchema.node('paragraph', inherited);
  expect(write(current)).toBe(canonicalJson(current.toJSON()));
});

it('honors custom serialization without retaining earlier mutable outputs', () => {
  const node = documentSchema.node('paragraph', { id: 'body' }, [documentSchema.text('body')]);
  const json = node.toJSON();
  node.toJSON = () => ({ ...json, extension: { value: 1 } });
  expect(write(node)).toBe(canonicalJson(node.toJSON()));
  node.toJSON = () => ({ ...json, extension: { value: 2 } });
  expect(write(documentSchema.node('doc', null, [node]))).toBe(
    canonicalJson(documentSchema.node('doc', null, [node]).toJSON()),
  );
  const mark = documentSchema.marks.bold.create();
  mark.toJSON = () => ({ type: 'bold', extension: true });
  const text = documentSchema.text('marked', [mark]);
  expect(write(text)).toBe(canonicalJson(text.toJSON()));
});
