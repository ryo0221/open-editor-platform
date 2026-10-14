import { describe, expect, it } from 'vitest';
import { EditorSession } from '@editor-platform/editor-core';
import {
  createDocument,
  deleteBlock,
  documentDiff,
  exportHtml,
  exportMarkdown,
  importMarkdown,
  insertBlock,
  isDocument,
  makeBlock,
  moveBlock,
  safeAssetUrl,
  updateBlock,
  anchorDocumentSelection,
  resolveDocumentAddress,
} from './model';
describe('document model', () => {
  it('validates rich merged table payloads without rewriting sparse covered cells', () => {
    const table = {
      ...makeBlock('table'),
      cells: [
        ['見出し', '値'],
        ['本文', ''],
      ],
      columnWidths: [150, 300],
      cellRich: [
        [[{ text: '見出し', bold: true }], null],
        [null, null],
      ],
    };
    const doc = { schemaVersion: 2, blocks: [table] };
    expect(isDocument(doc)).toBe(true);
    expect(isDocument({ ...doc, blocks: [{ ...table, cells: [['uneven'], ['a', 'b']] }] })).toBe(
      false,
    );
    expect(isDocument({ ...doc, blocks: [{ ...table, columnWidths: [100] }] })).toBe(false);
    expect(
      isDocument({
        ...doc,
        blocks: [{ ...table, cellParagraphs: [[[{ id: 'p', rich: [{ text: 12 }] }]]] }],
      }),
    ).toBe(false);
  });
  it('explains a mark-only and paragraph-layout change in the human-readable compare', () => {
    const before = {
      schemaVersion: 2 as const,
      blocks: [
        {
          id: 'paragraph',
          type: 'paragraph' as const,
          text: 'Same words',
          rich: [{ text: 'Same words' }],
        },
      ],
    };
    const after = {
      ...before,
      blocks: [
        {
          ...before.blocks[0],
          align: 'center' as const,
          rich: [
            {
              text: 'Same words',
              bold: true,
              underline: true,
              color: '#2563eb',
              highlight: '#fff000',
            },
          ],
        },
      ],
    };
    const change = documentDiff(before, after).changes[0];
    expect(change.before).toContain('Same words');
    expect(change.after).toContain('**Same words**');
    expect(change.after).toContain('alignment: center');
    expect(change.after).toContain('underline, color #2563eb, highlight #fff000');
    expect(change.after).not.toBe(change.before);
  });
  it('resolves retained text anchors across insertion, reordering, deletion and Undo without changing their origin', () => {
    const paragraph = { ...makeBlock('paragraph'), text: '先頭。比較対象。後続の文章。' };
    const d = { ...createDocument(), blocks: [paragraph] },
      s = new EditorSession(d);
    const anchor = anchorDocumentSelection(d, {
      addresses: [
        { artifactId: 'doc', elementId: paragraph.id, region: { type: 'text', start: 3, end: 7 } },
      ],
    }).addresses[0];
    s.execute(updateBlock(paragraph.id, { text: '追加の文章。' + paragraph.text }));
    expect(resolveDocumentAddress(s.content, anchor).address.region).toMatchObject({
      start: 9,
      end: 13,
    });
    expect(anchor.region).toMatchObject({ start: 3, end: 7 });
    s.execute(updateBlock(paragraph.id, { text: 'この段落の対象は削除済み。' }));
    expect(resolveDocumentAddress(s.content, anchor).state).toBe('Orphan');
    s.undo();
    expect(resolveDocumentAddress(s.content, anchor).state).toBe('Current');
    s.execute(deleteBlock(paragraph.id));
    expect(resolveDocumentAddress(s.content, anchor).state).toBe('Orphan');
    s.undo();
    s.undo();
    expect(resolveDocumentAddress(s.content, anchor).address.region).toMatchObject({
      start: 3,
      end: 7,
    });
  });
  it('keeps stable IDs across insert/update/reorder/delete and undo', () => {
    const s = new EditorSession(createDocument());
    const id = s.content.blocks[0].id;
    s.execute(updateBlock(id, { text: 'Title' }));
    s.execute(moveBlock(id, 1));
    expect(s.content.blocks[1].id).toBe(id);
    s.execute(insertBlock('table'));
    expect(s.content.blocks.at(-1)?.cells).toHaveLength(2);
    s.execute(deleteBlock(id));
    expect(s.content.blocks.some((b) => b.id === id)).toBe(false);
    s.undo();
    expect(s.content.blocks.some((b) => b.id === id)).toBe(true);
  });
  it('exports ordinary markdown with no private IDs and imports supported blocks', () => {
    const d = {
      schemaVersion: 1 as const,
      blocks: [
        { ...makeBlock('heading'), text: 'Title' },
        { ...makeBlock('paragraph'), text: 'Body' },
        { ...makeBlock('bulleted-list'), text: 'one\ntwo' },
        { ...makeBlock('numbered-list'), text: 'first\nsecond' },
        {
          ...makeBlock('table'),
          cells: [
            ['Name', 'Value'],
            ['A', '1'],
          ],
        },
        { ...makeBlock('mermaid'), text: 'graph LR\nA-->B' },
        { ...makeBlock('code'), text: 'const x = 1;', language: 'ts' },
      ],
    };
    const text = exportMarkdown(d);
    expect(text).toContain('# Title');
    expect(text).toContain('```mermaid');
    expect(text).not.toContain(d.blocks[0].id);
    const imported = importMarkdown(text);
    expect(imported.blocks.map((b) => b.type)).toEqual(d.blocks.map((b) => b.type));
    expect(exportMarkdown(imported)).toBe(text);
    expect(isDocument(JSON.parse(JSON.stringify(d)))).toBe(true);
  });
  it('handles empty markdown and rejects malformed domain content', () => {
    expect(importMarkdown('').blocks).toEqual([]);
    expect(isDocument({ schemaVersion: 1, blocks: [{ id: 'a', type: 'evil' }] })).toBe(false);
  });
  it('escapes user HTML exports and rejects active image URLs', () => {
    const d = {
      schemaVersion: 1 as const,
      blocks: [
        { ...makeBlock('paragraph'), text: '<script>alert(1)</script>' },
        { ...makeBlock('html'), text: '<script>evil()</script>' },
      ],
    };
    const html = exportHtml(d);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(safeAssetUrl('javascript:alert(1)')).toBe(false);
    expect(safeAssetUrl('data:image/png;base64,AAAA')).toBe(true);
  });
  it('reports text changes, additions, removals and order changes', () => {
    const a = createDocument();
    const b = moveBlock(a.blocks[0].id, 1).apply(
      updateBlock(a.blocks[0].id, { text: 'changed' }).apply(a),
    );
    expect(documentDiff(a, b).changes.some((c) => c.kind === 'changed')).toBe(true);
    expect(documentDiff(a, b).changes.some((c) => c.kind === 'moved')).toBe(true);
    expect(documentDiff(a, deleteBlock(a.blocks[1].id).apply(a)).changes[0].kind).toBe('removed');
  });
});
