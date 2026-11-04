import { describe, expect, it } from 'vitest';
import { createArtifact } from '@editor-platform/artifact-core';
import { ArtifactEditor, type EditorHostAdapter } from '@editor-platform/editor-host';
import { contentToNode, nodeToContent } from './engine';
import { checkDocumentNotation, notationEditCommand, type NotationRule } from './manuscript';
import { isDocument, type DocumentContent } from './model';
import { documentProposalDiff } from './proposal-diff';
import { documentTextAccess } from './text-access';

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
    { id: 'title', type: 'heading', level: 1, text: '第一章' },
    {
      id: 'p1',
      type: 'paragraph',
      text: '子供たちは出来るだけ早く\n駆け出した。',
      rich: [
        { text: '子供たちは' },
        { text: '出来る', bold: true },
        { text: 'だけ早く\n駆け出した。' },
      ],
    },
    { id: 'p2', type: 'paragraph', text: '子どもの頃、出来事を覚えている。' },
    { id: 'memo', type: 'paragraph', text: '子供', hidden: true },
  ],
});
const content = () => {
  const doc = authored();
  return nodeToContent(contentToNode(doc), doc);
};
const rules: NotationRule[] = [
  { id: 'kodomo', preferred: '子ども', avoid: ['子供'] },
  { id: 'dekiru', preferred: 'できる', avoid: ['出来る', '出来'] },
  { id: 'dekigoto', preferred: '出来事', avoid: ['でき事'] },
];

describe('Notation check against a Host dictionary', () => {
  it('reports avoided forms with segment ranges and leaves the content unchanged', () => {
    const doc = content();
    const before = JSON.stringify(doc);
    const findings = checkDocumentNotation(doc, rules);
    expect(findings).toEqual([
      {
        ruleId: 'kodomo',
        blockId: 'p1',
        found: '子供',
        preferred: '子ども',
        edit: { segmentId: 'p1', start: 0, end: 2, expected: '子供', text: '子ども' },
      },
      {
        ruleId: 'dekiru',
        blockId: 'p1',
        found: '出来る',
        preferred: 'できる',
        edit: { segmentId: 'p1', start: 5, end: 8, expected: '出来る', text: 'できる' },
      },
    ]);
    // "出来" inside "出来事" is not reported: that word is another rule's preferred form.
    expect(JSON.stringify(doc)).toBe(before);
    expect(checkDocumentNotation(doc, rules)).toEqual(findings);
  });

  it('includes hidden blocks only when requested and refuses invalid dictionaries', () => {
    const doc = content();
    expect(checkDocumentNotation(doc, rules, { hidden: true }).map((f) => f.blockId)).toContain(
      'memo',
    );
    expect(() => checkDocumentNotation(doc, [{ id: '', preferred: 'a', avoid: ['b'] }])).toThrow(
      'ids',
    );
    expect(() =>
      checkDocumentNotation(doc, [
        { id: 'x', preferred: 'a', avoid: ['b'] },
        { id: 'x', preferred: 'c', avoid: ['d'] },
      ]),
    ).toThrow('unique');
    expect(() => checkDocumentNotation(doc, [{ id: 'x', preferred: 'a', avoid: ['a'] }])).toThrow(
      'avoided',
    );
    expect(() => checkDocumentNotation(doc, [{ id: 'x', preferred: '', avoid: ['a'] }])).toThrow(
      'preferred',
    );
  });

  it('applies chosen findings only through an accepted proposal, undone in one step', () => {
    const host = new ArtifactEditor(createArtifact('document', 'Chapter 1', content()), adapter, {
      put: async () => {},
    });
    const original = host.content;
    const findings = checkDocumentNotation(host.content, rules);
    const review = host.propose({
      id: 'notation',
      summary: 'Apply notation dictionary',
      baseLocalRevision: host.revision,
      commands: [notationEditCommand(host.content, findings)],
    });
    expect(
      documentProposalDiff.diff(review.preview.baseContent, review.preview.content).changes,
    ).toContainEqual(expect.objectContaining({ elementId: 'p1', kind: 'text' }));
    expect(host.content).toEqual(original);
    host.acceptProposal('notation');
    expect(host.content.blocks[1].text).toBe('子どもたちはできるだけ早く\n駆け出した。');
    expect(host.content.blocks[1].rich?.find((span) => span.bold)?.text).toBe('できる');
    expect(checkDocumentNotation(host.content, rules)).toEqual([]);
    host.undo();
    expect(host.content).toEqual(original);
  });

  it('refuses a stale finding after the author edited the same text', () => {
    const doc = content();
    const [finding] = checkDocumentNotation(doc, rules);
    const edited = nodeToContent(
      contentToNode({
        ...doc,
        blocks: doc.blocks.map((b) =>
          b.id === 'p1' ? { ...b, text: 'こどもたち', rich: undefined } : b,
        ),
      }),
      doc,
    );
    expect(() => notationEditCommand(edited, [finding])).toThrow(/changed/);
  });
});
