import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { createArtifact } from '@editor-platform/artifact-core';
import { ArtifactEditor, type EditorHostAdapter } from '@editor-platform/editor-host';
import { activeDocumentRuby, contentToNode, nodeToContent, setDocumentRuby } from './engine';
import { checkDocumentRuby, documentCharacterCount } from './manuscript';
import { isDocument, spansHtml, spansMarkdown, type DocumentContent } from './model';
import { documentProposalDiff } from './proposal-diff';
import { documentTextAccess, documentTextEditCommand } from './text-access';

const adapter: EditorHostAdapter<DocumentContent> = {
  kind: 'document',
  validate: isDocument,
  text: documentTextAccess,
  capabilities: {
    undo: true,
    nativeJson: true,
    formats: [],
    preview: 'none',
    shared: false,
    proposals: true,
  },
};
const tokyo = { text: 'とうきょう', base: '東京' };
const authored = (): DocumentContent => ({
  schemaVersion: 2,
  blocks: [
    {
      id: 'p',
      type: 'paragraph',
      text: '朝の東京は静かだ。',
      rich: [
        { text: '朝の' },
        { text: '東', ruby: tokyo, bold: true },
        { text: '京', ruby: tokyo },
        { text: 'は静かだ。' },
      ],
    },
    { id: 'q', type: 'paragraph', text: '夜\n明け' },
  ],
});
const roundTrip = (doc: DocumentContent) => nodeToContent(contentToNode(doc), doc);
function editing(doc: DocumentContent, from: number, to: number) {
  let state = EditorState.create({ doc: contentToNode(doc) });
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, to)));
  const apply = (reading: string | null) =>
    setDocumentRuby(reading)(state, (tr) => {
      state = state.apply(tr);
    });
  return { apply, get: () => state, content: () => nodeToContent(state.doc, doc) };
}

describe('Ruby as an inline mark with its base text', () => {
  it('round-trips across formatting runs and is validated', () => {
    const doc = roundTrip(authored());
    expect(doc.blocks[0].rich?.filter((s) => s.ruby)).toEqual([
      { text: '東', ruby: tokyo, bold: true },
      { text: '京', ruby: tokyo },
    ]);
    for (const ruby of [{ text: '', base: '東' }, { text: 'a\nb', base: '東' }, 'とう'])
      expect(
        isDocument({
          schemaVersion: 2,
          blocks: [{ id: 'p', type: 'paragraph', text: '東', rich: [{ text: '東', ruby }] }],
        }),
      ).toBe(false);
    // Readings are not counted: the default rule counts the base characters only.
    expect(documentCharacterCount(doc).total).toBe(9 + 3);
  });

  it('exports one ruby per run in HTML and Aozora notation in Markdown', () => {
    const rich = authored().blocks[0].rich!;
    expect(spansHtml(rich)).toBe(
      '朝の<ruby><strong>東</strong>京<rt>とうきょう</rt></ruby>は静かだ。',
    );
    expect(spansMarkdown(rich)).toBe('朝の｜**東**京《とうきょう》は静かだ。');
    expect(spansHtml([{ text: '<a>', ruby: { text: '"<x>"', base: '<a>' } }])).toBe(
      '<ruby>&lt;a&gt;<rt>&quot;&lt;x&gt;&quot;</rt></ruby>',
    );
    // Readings are literal text in Markdown too, and cannot contain the Aozora delimiters.
    expect(spansMarkdown([{ text: '字', ruby: { text: '<br/>&`', base: '字' } }])).toBe(
      '｜字《&lt;br/>&amp;\\`》',
    );
    expect(
      isDocument({
        schemaVersion: 2,
        blocks: [
          {
            id: 'p',
            type: 'paragraph',
            text: '字',
            rich: [{ text: '字', ruby: { text: 'じ》', base: '字' } }],
          },
        ],
      }),
    ).toBe(false);
  });

  it('sets, edits and removes a reading on the selection, recording its base', () => {
    const doc: DocumentContent = {
      schemaVersion: 2,
      blocks: [{ id: 'p', type: 'paragraph', text: '朝の東京は静かだ。' }],
    };
    const edit = editing(doc, 3, 5);
    expect(edit.apply('  とうきょう ')).toBe(true);
    expect(edit.content().blocks[0].rich).toEqual([
      { text: '朝の' },
      { text: '東京', ruby: { ...tokyo, id: expect.stringMatching(/^ruby/) } },
      { text: 'は静かだ。' },
    ]);
    // With a caret inside, the whole run is the target.
    const caret = edit.get();
    const inside = caret.apply(caret.tr.setSelection(TextSelection.create(caret.doc, 4)));
    expect(activeDocumentRuby(inside)).toEqual({
      from: 3,
      to: 5,
      ruby: { ...tokyo, id: expect.any(String) },
    });
    expect(
      setDocumentRuby(null)(inside, (tr) => expect(tr.doc.textContent).toBe('朝の東京は静かだ。')),
    ).toBe(true);
    expect(edit.apply('')).toBe(false);
  });

  it('keeps adjacent rubies with the same reading apart', () => {
    const doc: DocumentContent = {
      schemaVersion: 2,
      blocks: [{ id: 'p', type: 'paragraph', text: '人人' }],
    };
    const first = editing(doc, 1, 2);
    first.apply('ひと');
    const second = editing(first.content(), 2, 3);
    second.apply('ひと');
    const rich = second.content().blocks[0].rich!;
    expect(rich.map((s) => s.ruby?.base)).toEqual(['人', '人']);
    expect(spansHtml(rich)).toBe('<ruby>人<rt>ひと</rt></ruby><ruby>人<rt>ひと</rt></ruby>');
    expect(checkDocumentRuby(second.content())).toEqual([]);
  });

  it('refuses a ruby across blocks or a line break', () => {
    const doc = authored();
    const across = editing(doc, 3, 15);
    expect(across.apply('よみ')).toBe(false);
    const lineBreak = editing(doc, 12, 16);
    expect(lineBreak.apply('よあけ')).toBe(false);
    expect(lineBreak.content()).toEqual(roundTrip(doc));
  });

  it('reports a ruby whose base was partly deleted, and nothing for intact ones', () => {
    const doc = roundTrip(authored());
    expect(checkDocumentRuby(doc)).toEqual([]);
    let state = EditorState.create({ doc: contentToNode(doc) });
    state = state.apply(state.tr.delete(4, 5));
    const edited = nodeToContent(state.doc, doc);
    expect(checkDocumentRuby(edited)).toEqual([
      { segmentId: 'p', blockId: 'p', start: 2, end: 3, found: '東', ruby: tokyo },
    ]);
    expect(
      checkDocumentRuby({ ...edited, blocks: [{ ...edited.blocks[0], hidden: true }] }),
    ).toEqual([]);
  });

  it('keeps rubies through a text proposal, shows the change and undoes it in one step', () => {
    const host = new ArtifactEditor(
      createArtifact('document', 'Chapter 1', roundTrip(authored())),
      adapter,
      { put: async () => {} },
    );
    const original = host.content;
    const review = host.propose({
      id: 'rewrite',
      summary: 'Rewrite the ending',
      baseLocalRevision: host.revision,
      commands: [
        documentTextEditCommand(host.content, [
          { segmentId: 'p', start: 5, end: 9, expected: '静かだ。', text: 'まだ眠っている。' },
        ]),
      ],
    });
    expect(
      documentProposalDiff.diff(review.preview.baseContent, review.preview.content).changes,
    ).toContainEqual(expect.objectContaining({ elementId: 'p', kind: 'text' }));
    expect(host.content).toEqual(original);
    host.acceptProposal('rewrite');
    expect(host.content.blocks[0].text).toBe('朝の東京はまだ眠っている。');
    expect(host.content.blocks[0].rich?.filter((s) => s.ruby).map((s) => s.text)).toEqual([
      '東',
      '京',
    ]);
    expect(checkDocumentRuby(host.content)).toEqual([]);
    host.undo();
    expect(host.content).toEqual(original);
  });
});
