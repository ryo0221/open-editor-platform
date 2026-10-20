import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { activeDocumentLink, contentToNode, nodeToContent, setDocumentLink } from './engine';
import type { DocumentContent } from './model';

const href = 'https://example.com/original';
function fixture(from = 1, to = 7) {
  const content: DocumentContent = {
    schemaVersion: 2,
    blocks: [
      {
        id: 'body',
        type: 'paragraph',
        text: 'linked next',
        rich: [
          { text: 'lin', link: href, bold: true },
          { text: 'ked', link: href, italic: true },
          { text: ' next', link: 'https://example.com/other' },
        ],
      },
    ],
  };
  let state = EditorState.create({ doc: contentToNode(content) });
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, to)));
  return { content, state };
}

describe('explicit Document link application', () => {
  for (const text of ['', 'plain'])
    it(`reports and updates a stored-only link before typing in ${JSON.stringify(text)}`, () => {
      let state = EditorState.create({
        doc: contentToNode({ schemaVersion: 2, blocks: [{ id: 'p', type: 'paragraph', text }] }),
      });
      const original = state.doc;
      const position = state.selection.from;
      const apply = (url: string | null) =>
        setDocumentLink(url)(state, (tr) => {
          state = state.apply(tr);
        });
      apply(href);
      expect(activeDocumentLink(state)).toEqual({ from: position, to: position, href });
      apply(href);
      const updated = 'https://example.com/pending';
      apply(updated);
      expect(activeDocumentLink(state)).toEqual({ from: position, to: position, href: updated });
      expect(state.doc.eq(original)).toBe(true);
      state = state.apply(state.tr.insertText('X'));
      expect(state.doc.firstChild!.firstChild!.marks).toContainEqual(
        state.schema.marks.link.create({ href: updated }),
      );
    });

  it('removes a stored-only link without removing other pending formatting', () => {
    let state = EditorState.create({
      doc: contentToNode({
        schemaVersion: 2,
        blocks: [{ id: 'p', type: 'paragraph', text: 'plain' }],
      }),
    });
    state = state.apply(state.tr.addStoredMark(state.schema.marks.bold.create()));
    const original = state.doc;
    setDocumentLink(href)(state, (tr) => {
      state = state.apply(tr);
    });
    expect(activeDocumentLink(state)).toEqual({ from: 1, to: 1, href });
    setDocumentLink(null)(state, (tr) => {
      state = state.apply(tr);
    });
    expect(activeDocumentLink(state)).toBeUndefined();
    expect(state.doc.eq(original)).toBe(true);
    expect(state.storedMarks).toEqual([state.schema.marks.bold.create()]);
  });

  it('keeps a different stored-only URL separate from the adjacent existing link', () => {
    let { state } = fixture(3, 3);
    const original = state.doc;
    state = state.apply(
      state.tr.addStoredMark(
        state.schema.marks.link.create({ href: 'https://example.com/pending' }),
      ),
    );
    expect(activeDocumentLink(state)).toEqual({
      from: 3,
      to: 3,
      href: 'https://example.com/pending',
    });
    setDocumentLink('https://example.com/updated')(state, (tr) => {
      state = state.apply(tr);
    });
    expect(state.doc.eq(original)).toBe(true);
    expect(activeDocumentLink(state)).toEqual({
      from: 3,
      to: 3,
      href: 'https://example.com/updated',
    });
  });

  for (const [position, edge] of [
    [6, 'start'],
    [12, 'end'],
  ] as const)
    it(`edits and removes a link at its ${edge} beside plain text`, () => {
      const content: DocumentContent = {
        schemaVersion: 2,
        blocks: [
          {
            id: 'p',
            type: 'paragraph',
            text: 'left linked right',
            rich: [
              { text: 'left ' },
              { text: 'lin', bold: true, link: href },
              { text: 'ked', italic: true, link: href },
              { text: ' right' },
            ],
          },
        ],
      };
      let state = EditorState.create({ doc: contentToNode(content) });
      state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, position)));
      expect(state.schema.marks.link.isInSet(state.selection.$from.marks())).toBeUndefined();
      expect(activeDocumentLink(state)).toEqual({ from: 6, to: 12, href });
      setDocumentLink('https://example.com/edge')(state, (tr) => {
        state = state.apply(tr);
      });
      expect(nodeToContent(state.doc, content).blocks[0].rich).toEqual([
        { text: 'left ' },
        { text: 'lin', bold: true, link: 'https://example.com/edge' },
        { text: 'ked', italic: true, link: 'https://example.com/edge' },
        { text: ' right' },
      ]);
      setDocumentLink(null)(state, (tr) => {
        state = state.apply(tr);
      });
      expect(nodeToContent(state.doc, content).blocks[0].rich).toEqual([
        { text: 'left ' },
        { text: 'lin', bold: true },
        { text: 'ked', italic: true },
        { text: ' right' },
      ]);
    });

  for (const [position, from, to, url] of [
    [1, 1, 7, href],
    [7, 7, 12, 'https://example.com/other'],
    [12, 7, 12, 'https://example.com/other'],
  ] as const)
    it(`resolves the adjacent link at paragraph position ${position}`, () => {
      const { content, state } = fixture(position, position);
      // The shared boundary chooses the link starting to the right; paragraph
      // edges choose the available neighbor. Different URLs never merge.
      expect(activeDocumentLink(state)).toEqual({ from, to, href: url });
      let next = state;
      setDocumentLink('https://example.com/edge')(state, (tr) => {
        next = state.apply(tr);
      });
      const spans = nodeToContent(next.doc, content).blocks[0].rich!;
      expect(
        spans
          .slice(0, 2)
          .every((span) => span.link === (from === 1 ? 'https://example.com/edge' : href)),
      ).toBe(true);
      expect(spans[2].link).toBe(
        from === 7 ? 'https://example.com/edge' : 'https://example.com/other',
      );
    });

  it('does not reach past plain text to edit a distant link', () => {
    const content: DocumentContent = {
      schemaVersion: 2,
      blocks: [
        {
          id: 'p',
          type: 'paragraph',
          text: 'plain linked',
          rich: [{ text: 'plain ' }, { text: 'linked', link: href }],
        },
      ],
    };
    let state = EditorState.create({ doc: contentToNode(content) });
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 3)));
    expect(activeDocumentLink(state)).toBeUndefined();
    const before = state.doc;
    setDocumentLink('https://example.com/new')(state, (tr) => {
      state = state.apply(tr);
    });
    expect(state.doc.eq(before)).toBe(true);
    expect(state.schema.marks.link.isInSet(state.storedMarks!)?.attrs.href).toBe(
      'https://example.com/new',
    );
  });

  it('updates href instead of toggling a selected link off and preserves other marks', () => {
    const { content, state } = fixture();
    let next = state;
    expect(
      setDocumentLink('https://example.com/updated')(state, (tr) => {
        next = state.apply(tr);
      }),
    ).toBe(true);
    expect(nodeToContent(next.doc, content).blocks[0].rich).toEqual([
      { text: 'lin', bold: true, link: 'https://example.com/updated' },
      { text: 'ked', italic: true, link: 'https://example.com/updated' },
      { text: ' next', link: 'https://example.com/other' },
    ]);
    expect(activeDocumentLink(next)?.href).toBe('https://example.com/updated');
    setDocumentLink('https://example.com/updated')(next, (tr) => {
      next = next.apply(tr);
    });
    expect(nodeToContent(next.doc, content).blocks[0].rich?.[0].link).toBe(
      'https://example.com/updated',
    );
  });
  it('edits and explicitly removes the contiguous link under a caret across formatting runs', () => {
    const { content, state } = fixture(3, 3);
    expect(activeDocumentLink(state)).toEqual({ from: 1, to: 7, href });
    let next = state;
    setDocumentLink('https://example.com/updated')(state, (tr) => {
      next = state.apply(tr);
    });
    expect(
      nodeToContent(next.doc, content)
        .blocks[0].rich?.slice(0, 2)
        .every((span) => span.link === 'https://example.com/updated'),
    ).toBe(true);
    setDocumentLink(null)(next, (tr) => {
      next = next.apply(tr);
    });
    expect(nodeToContent(next.doc, content).blocks[0].rich).toEqual([
      { text: 'lin', bold: true },
      { text: 'ked', italic: true },
      { text: ' next', link: 'https://example.com/other' },
    ]);
  });
  it('replaces an old stored link too so typing at a caret uses the updated URL', () => {
    const { content, state } = fixture(3, 3);
    let next = state.apply(state.tr.addStoredMark(state.schema.marks.link.create({ href })));
    setDocumentLink('https://example.com/updated')(next, (tr) => {
      next = next.apply(tr);
    });
    next = next.apply(next.tr.insertText('X'));
    expect(
      nodeToContent(next.doc, content)
        .blocks[0].rich?.slice(0, 2)
        .every((span) => span.link === 'https://example.com/updated'),
    ).toBe(true);
    expect(nodeToContent(next.doc, content).blocks[0].text).toBe('liXnked next');
  });
  it('only changes selected text when part of a link is selected', () => {
    const { content, state } = fixture(2, 3);
    let next = state;
    setDocumentLink('https://example.com/partial')(state, (tr) => {
      next = state.apply(tr);
    });
    expect(nodeToContent(next.doc, content).blocks[0].rich?.slice(0, 3)).toEqual([
      { text: 'l', bold: true, link: href },
      { text: 'i', bold: true, link: 'https://example.com/partial' },
      { text: 'n', bold: true, link: href },
    ]);
  });
  it('adds a link to plain selected text and refuses unsafe URLs without dispatch', () => {
    const content: DocumentContent = {
      schemaVersion: 2,
      blocks: [{ id: 'p', type: 'paragraph', text: 'plain' }],
    };
    let state = EditorState.create({ doc: contentToNode(content) });
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1, 6)));
    let dispatched = false;
    expect(
      setDocumentLink('javascript:alert(1)')(state, () => {
        dispatched = true;
      }),
    ).toBe(false);
    expect(dispatched).toBe(false);
    setDocumentLink(href)(state, (tr) => {
      state = state.apply(tr);
    });
    expect(nodeToContent(state.doc, content).blocks[0].rich).toEqual([
      { text: 'plain', link: href },
    ]);
  });
});
