import { describe, expect, it } from 'vitest';
import { canonicalJson, contentHash } from '@editor-platform/artifact-core';
import { EditorSession } from '@editor-platform/editor-core';
import {
  createLiveReference,
  liveSnapshotKey,
  type LiveReference,
  type LiveReferenceProvider,
  type ReferenceSnapshot,
} from '@editor-platform/artifact-references';
import { insertDocumentCitation } from './citation-command';
import { contentToNode, nodeToContent } from './engine';
import {
  createDocument,
  documentLiveReferences,
  documentRetainedLiveReferences,
  isDocument,
  type DocumentContent,
} from './model';

const source = {
  artifactId: 'plan',
  domain: 'finance',
  target: { kind: 'value' as const, targetId: 'base', metricId: 'npv' },
};
const figureSource = { ...source, target: { kind: 'figure' as const, figureId: 'chart' } };
const provider: LiveReferenceProvider = {
  checkAccess() {},
  checkSnapshot() {},
  list: () => [
    { ...source.target, label: 'NPV' },
    { kind: 'figure', figureId: 'chart', label: '収支' },
  ],
  resolve: (s, t) =>
    t.kind === 'value'
      ? { kind: 'value', value: (s.content as { value: number }).value }
      : { kind: 'figure', label: '収支', src: 'data:image/png;base64,YQ==' },
};
async function snapshot(revision: number): Promise<ReferenceSnapshot> {
  const content = { value: revision * 1000, model: 'x'.repeat(17_000) };
  return {
    artifactId: source.artifactId,
    domain: source.domain,
    versionId: `v${revision}`,
    revision,
    content,
    contentHash: await contentHash(content),
    dependencies: [],
  };
}
const format = { style: 'decimal' as const, digits: 0, unit: '円' };
const bytes = (v: unknown) => new TextEncoder().encode(canonicalJson(v)).length;
const rows = (d: DocumentContent) => Object.keys(d.liveSnapshots ?? {});

describe('document citations keep one copy per version (finding 79)', () => {
  it('two values and a figure of one version add the version once, headless, and Undo removes the row', async () => {
    const v1 = await snapshot(1);
    const value = await createLiveReference(source, v1, provider, format);
    const figure = await createLiveReference(figureSource, v1, provider);
    const doc = createDocument();
    const [heading, paragraph] = doc.blocks;
    doc.blocks[1].text = '売上 と 利益';
    const session = new EditorSession(doc);
    session.execute(
      insertDocumentCitation({ kind: 'text', blockId: paragraph.id, offset: 3 }, value, 'q1'),
    );
    session.execute(
      insertDocumentCitation({ kind: 'text', blockId: paragraph.id, offset: 0 }, value, 'q2'),
    );
    session.execute(insertDocumentCitation({ kind: 'after', blockId: heading.id }, figure, 'f1'));
    const three = session.content;
    expect(isDocument(three)).toBe(true);
    expect(rows(three)).toEqual([liveSnapshotKey(v1)]);
    // About 17 KB once, not three times (the 52 KB of finding 79).
    expect(bytes(three) - bytes(doc)).toBeLessThan(bytes(v1) + 4_000);
    expect(documentLiveReferences(three.blocks).every((r) => !('content' in r.snapshot))).toBe(
      true,
    );
    expect(documentRetainedLiveReferences(three)).toEqual([figure, value, value]);
    expect(three.blocks.find((b) => b.id === paragraph.id)?.text).toBe('1000円売上 1000円と 利益');

    // The editor's own projection round-trips the stored form.
    expect(nodeToContent(contentToNode(three), three)).toEqual(three);
    session.undo();
    session.undo();
    session.undo();
    expect(session.content.liveSnapshots).toBeUndefined();
    expect(isDocument(session.content)).toBe(true);
    session.redo();
    expect(rows(session.content)).toEqual([liveSnapshotKey(v1)]);
  });

  it('a schema 2 document reads and saves back unchanged; a new citation of its version moves it into the table', async () => {
    const v1 = await snapshot(1);
    const v2 = await snapshot(2);
    const legacy = (r: LiveReference): LiveReference => ({ ...r, schemaVersion: 2 });
    const old1 = legacy(await createLiveReference(source, v1, provider, format));
    const old2 = legacy(await createLiveReference(source, v2, provider, format));
    const doc = createDocument();
    doc.blocks[1] = {
      ...doc.blocks[1],
      text: '1000円 2000円',
      rich: [
        { text: '1000円', liveQuote: { id: 'o1', reference: old1 } },
        { text: ' ' },
        { text: '2000円', liveQuote: { id: 'o2', reference: old2 } },
      ],
    };
    expect(isDocument(doc)).toBe(true);
    const resaved = nodeToContent(contentToNode(doc), doc);
    expect(resaved).toEqual(doc);
    const session = new EditorSession(doc);
    session.execute(
      insertDocumentCitation(
        { kind: 'text', blockId: doc.blocks[1].id, offset: 0 },
        await createLiveReference(source, v1, provider, format),
        'n1',
      ),
    );
    const mixed = session.content;
    expect(isDocument(mixed)).toBe(true);
    expect(rows(mixed)).toEqual([liveSnapshotKey(v1)]);
    const stored = documentLiveReferences(mixed.blocks);
    expect(stored.map((r) => r.schemaVersion)).toEqual([3, 3, 2]);
    expect(stored[2]).toEqual(old2);
    session.undo();
    expect(session.content).toEqual(doc);
  });

  it('refuses a stored document whose packed citation lacks its row', async () => {
    const v1 = await snapshot(1);
    const doc = createDocument();
    const next = insertDocumentCitation(
      { kind: 'text', blockId: doc.blocks[1].id, offset: 0 },
      await createLiveReference(source, v1, provider, format),
    ).apply(doc);
    expect(isDocument(next)).toBe(true);
    expect(isDocument({ ...next, liveSnapshots: undefined })).toBe(false);
    expect(() =>
      insertDocumentCitation(
        { kind: 'after', blockId: 'missing' },
        { ...(documentRetainedLiveReferences(next)[0] as LiveReference), schemaVersion: 2 },
      ).apply(next),
    ).toThrow('引用が不正です。');
  });
});
