import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { toggleMark } from 'prosemirror-commands';
import { createArtifact } from '@editor-platform/artifact-core';
import { ArtifactEditor, type EditorHostAdapter } from '@editor-platform/editor-host';
import { contentToNode, documentSchema, nodeToContent } from './engine';
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
const authored = (): DocumentContent => ({
  schemaVersion: 2,
  blocks: [
    {
      id: 'p',
      type: 'paragraph',
      text: 'それは本当に嘘だった。',
      rich: [
        { text: 'それは' },
        { text: '本当', emphasisDots: true },
        { text: 'に', emphasisDots: true, bold: true },
        { text: '嘘だった。' },
      ],
    },
  ],
});
const roundTrip = (doc: DocumentContent) => nodeToContent(contentToNode(doc), doc);

describe('傍点 as an inline mark', () => {
  it('round-trips, is validated and exports to HTML; Markdown keeps the text only', () => {
    const doc = roundTrip(authored());
    expect(doc.blocks[0].rich).toEqual(authored().blocks[0].rich);
    expect(
      isDocument({
        schemaVersion: 2,
        blocks: [
          { id: 'p', type: 'paragraph', text: '字', rich: [{ text: '字', emphasisDots: 'yes' }] },
        ],
      }),
    ).toBe(false);
    expect(spansHtml(doc.blocks[0].rich!)).toBe(
      'それは<span style="text-emphasis:filled sesame">本当</span>' +
        '<span style="text-emphasis:filled sesame"><strong>に</strong></span>嘘だった。',
    );
    // Under a ruby the dots move to the other side, away from the reading.
    expect(
      spansHtml([{ text: '東京', emphasisDots: true, ruby: { text: 'とうきょう', base: '東京' } }]),
    ).toBe(
      '<ruby><span style="text-emphasis:filled sesame;text-emphasis-position:under left">東京</span><rt>とうきょう</rt></ruby>',
    );
    expect(spansMarkdown(doc.blocks[0].rich!)).toBe('それは本当**に**嘘だった。');
  });

  it('toggles on the selection', () => {
    const doc: DocumentContent = {
      schemaVersion: 2,
      blocks: [{ id: 'p', type: 'paragraph', text: '本当に' }],
    };
    let state = EditorState.create({ doc: contentToNode(doc) });
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1, 3)));
    const toggle = () =>
      toggleMark(documentSchema.marks.emphasisDots)(state, (tr) => {
        state = state.apply(tr);
      });
    toggle();
    expect(nodeToContent(state.doc, doc).blocks[0].rich).toEqual([
      { text: '本当', emphasisDots: true },
      { text: 'に' },
    ]);
    toggle();
    expect(nodeToContent(state.doc, doc).blocks[0].rich?.some((s) => s.emphasisDots)).toBeFalsy();
  });

  it('keeps 傍点 through a text proposal, shows the change and undoes it in one step', () => {
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
          { segmentId: 'p', start: 6, end: 11, expected: '嘘だった。', text: '本当だった。' },
        ]),
      ],
    });
    expect(
      documentProposalDiff.diff(review.preview.baseContent, review.preview.content).changes,
    ).toContainEqual(expect.objectContaining({ elementId: 'p', kind: 'text' }));
    host.acceptProposal('rewrite');
    expect(host.content.blocks[0].text).toBe('それは本当に本当だった。');
    expect(
      host.content.blocks[0].rich
        ?.filter((s) => s.emphasisDots)
        .map((s) => s.text)
        .join(''),
    ).toBe('本当に');
    host.undo();
    expect(host.content).toEqual(original);
  });
});
