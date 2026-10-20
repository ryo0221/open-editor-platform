import { describe, expect, it } from 'vitest';
import { contentToNode } from './engine';
import {
  exportMarkdown,
  importMarkdown,
  isDocument,
  spansMarkdown,
  type DocumentContent,
} from './model';

describe('Markdown in-block breaks', () => {
  for (const type of [
    'heading',
    'paragraph',
    'bulleted-list',
    'numbered-list',
    'check-list',
  ] as const)
    it(`round-trips leading, consecutive and trailing breaks within ${type}`, () => {
      const text = '\nfirst\n\n# second\n- third\n';
      const list = type.endsWith('list');
      const content: DocumentContent = {
        schemaVersion: 2,
        blocks: [
          {
            id: 'block',
            type,
            text,
            ...(type === 'heading' ? { level: 3 } : {}),
            ...(type === 'numbered-list' ? { start: 4 } : {}),
            ...(list
              ? {
                  items: [
                    {
                      id: 'item1',
                      rich: [{ text }],
                      ...(type === 'check-list' ? { checked: true } : {}),
                    },
                    {
                      id: 'item2',
                      rich: [{ text: 'next item' }],
                      ...(type === 'check-list' ? { checked: false } : {}),
                    },
                  ],
                }
              : {}),
          },
        ],
      };
      const markdown = exportMarkdown(content);
      expect(markdown).toContain('<br/>first<br/><br/># second<br/>- third<br/>');
      const imported = importMarkdown(markdown);
      expect(isDocument(imported)).toBe(true);
      expect(imported.blocks).toHaveLength(1);
      expect(imported.blocks[0].type).toBe(type);
      if (list) {
        expect(imported.blocks[0].items).toHaveLength(2);
        expect(imported.blocks[0].items?.[0].rich).toEqual([{ text }]);
        if (type === 'numbered-list') expect(imported.blocks[0].start).toBe(4);
        if (type === 'check-list')
          expect(imported.blocks[0].items?.map((item) => item.checked)).toEqual([true, false]);
      } else expect(imported.blocks[0].text).toBe(text);
      expect(exportMarkdown(imported)).toBe(markdown);
      expect(contentToNode(imported).textContent).toContain('first');
    });

  it('keeps literal HTML/entity text separate from generated hard breaks', () => {
    const text = '<br/> &lt;br/> &amp;\nlast';
    const content: DocumentContent = {
      schemaVersion: 2,
      blocks: [{ id: 'p', type: 'paragraph', text }],
    };
    const markdown = exportMarkdown(content);
    expect(markdown).toBe('&lt;br/> &amp;lt;br/> &amp;amp;<br/>last\n');
    expect(importMarkdown(markdown).blocks[0].text).toBe(text);
  });
  for (const type of [
    'heading',
    'paragraph',
    'bulleted-list',
    'numbered-list',
    'check-list',
  ] as const)
    for (const text of ['`<br/>`', '`a & b &lt;`', '``<br/> &amp;``\nnext'])
      it(`round-trips literal backticks and entities in ${type}: ${JSON.stringify(text)}`, () => {
        const list = type.endsWith('list');
        const content: DocumentContent = {
          schemaVersion: 2,
          blocks: [
            {
              id: 'literal',
              type,
              text,
              ...(type === 'heading' ? { level: 2 } : {}),
              ...(list
                ? {
                    items: [
                      {
                        id: 'item',
                        rich: [{ text }],
                        ...(type === 'check-list' ? { checked: true } : {}),
                      },
                    ],
                  }
                : {}),
            },
          ],
        };
        const markdown = exportMarkdown(content);
        const imported = importMarkdown(markdown);
        expect(imported.blocks).toHaveLength(1);
        expect(imported.blocks[0].type).toBe(type);
        if (list) expect(imported.blocks[0].items?.[0].rich).toEqual([{ text }]);
        else expect(imported.blocks[0].text).toBe(text);
        expect(exportMarkdown(imported)).toBe(markdown);
      });

  it('preserves backslashes adjacent to literal backticks and generated breaks', () => {
    const text = 'C:\\path\\file \\`<br/>` &amp;\nnext';
    const content: DocumentContent = {
      schemaVersion: 2,
      blocks: [{ id: 'path', type: 'paragraph', text }],
    };
    expect(importMarkdown(exportMarkdown(content)).blocks[0].text).toBe(text);
  });

  it('keeps HTML and entity text literal inside externally supplied Markdown code spans', () => {
    const text = '`<br/> &amp;` and ``<br/> &lt;``';
    expect(importMarkdown(text).blocks[0].text).toBe(text);
    expect(spansMarkdown([{ text: '<br/> &amp;', code: true }])).toBe('`<br/> &amp;`');
  });
  it('splits formatted runs around breaks and leaves code-block newlines untouched', () => {
    expect(spansMarkdown([{ text: 'a\nb', code: true }])).toBe('`a`<br/>`b`');
    expect(spansMarkdown([{ text: 'a\nb', bold: true }])).toBe('**a**<br/>**b**');
    const content: DocumentContent = {
      schemaVersion: 2,
      blocks: [{ id: 'code', type: 'code', text: '<br/>\nlast', language: 'text' }],
    };
    expect(importMarkdown(exportMarkdown(content)).blocks[0].text).toBe('<br/>\nlast');
    expect(importMarkdown('`literal<br/>code`').blocks[0].text).toBe('`literal<br/>code`');
  });

  for (const [text, encoded] of [
    ['a`b\nc', '``a`b``<br/>`c`'],
    ['a``b\nc', '```a``b```<br/>`c`'],
    ['`a\n`b`', '`` `a ``<br/>`` `b` ``'],
    ['a\\`b\n<br/> &amp;', '``a\\`b``<br/>`<br/> &amp;`'],
    [' a \nb', '`  a  `<br/>`b`'],
  ])
    it(`uses unambiguous inline-code delimiters around a break: ${JSON.stringify(text)}`, () => {
      const content: DocumentContent = {
        schemaVersion: 2,
        blocks: [{ id: 'p', type: 'paragraph', text, rich: [{ text, code: true }] }],
      };
      expect(spansMarkdown([{ text, code: true }])).toBe(encoded);
      // The bounded importer retains inline-code syntax as text, but must restore
      // the generated break without treating HTML inside actual code as a break.
      expect(importMarkdown(exportMarkdown(content)).blocks[0].text).toBe(
        encoded.replace('<br/>', '\n'),
      );
    });
});
