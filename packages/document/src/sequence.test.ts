import { describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import {
  createArtifact,
  commitVersion,
  serializeArtifact,
  canonicalJson,
  clone,
} from '@editor-platform/artifact-core';
import {
  ArtifactEditor,
  loadHostArtifact,
  type EditorHostAdapter,
} from '@editor-platform/editor-host';
import { contentToNode, nodeToContent } from '@editor-platform/document/engine';
import {
  documentProposalDiff,
  isDocument,
  resolveDocumentAddress,
  type DocumentContent,
} from '@editor-platform/document';
import {
  documentTextEditCommand,
  documentTextAccess,
  findDocumentText,
} from '@editor-platform/document/text';
import { composeDocumentSequence } from '@editor-platform/document/sequence';

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
const chapter = (n: number): DocumentContent => {
  const d: DocumentContent = {
    schemaVersion: 2,
    blocks: [
      { id: 'heading', type: 'heading', level: 1, text: `Chapter ${n}` },
      { id: 'scene-1', type: 'paragraph', text: `Morning ${n}.` },
      { id: 'scene-2', type: 'paragraph', text: `Night ${n}.` },
    ],
  };
  return nodeToContent(contentToNode(d), d);
};
async function source(n: number) {
  const artifact = await commitVersion(
    createArtifact('document', `Chapter ${n}`, chapter(n)),
    null,
    'fixture',
  );
  return { artifact: clone(artifact), versionId: artifact.versions[0].versionId };
}
describe('Document chapter sources', () => {
  it('creates three chapters, edits through native engine, previews/rejects/accepts, saves/reloads and reorders immutable sources', async () => {
    const sources = await Promise.all([1, 2, 3].map(source));
    const original = canonicalJson(sources);
    let stored = serializeArtifact(sources[1].artifact);
    const host = new ArtifactEditor(sources[1].artifact, adapter, {
      put: async (a) => {
        stored = serializeArtifact(a);
      },
    });
    const address = {
      artifactId: host.id,
      elementId: 'scene-2',
      region: { type: 'text' as const, start: 0, end: 5, sourceText: 'Night 2.' },
    };
    host.select({ addresses: [address] });
    const propose = (id: string) =>
      host.propose({
        id,
        summary: 'Revise scene',
        baseLocalRevision: host.revision,
        commands: [
          documentTextEditCommand(host.content, [
            { ...findDocumentText(host.content, 'Night'), text: 'Evening' },
          ]),
        ],
      });
    const review = propose('first');
    expect(
      documentProposalDiff.diff(review.preview.baseContent, review.preview.content).changes,
    ).toContainEqual(expect.objectContaining({ elementId: 'scene-2', kind: 'text' }));
    expect(host.content).toEqual(chapter(2));
    host.rejectProposal('first');
    expect(host.content).toEqual(chapter(2));
    propose('accepted');
    host.acceptProposal('accepted');
    expect(host.content.blocks[2].text).toBe('Evening 2.');
    host.undo();
    expect(host.content).toEqual(chapter(2));
    host.redo();
    expect(resolveDocumentAddress(host.content, address).state).toBe('Orphan');
    await host.save({ commitVersion: true });
    const reloaded = await loadHostArtifact(stored, adapter);
    expect(reloaded.versions[0]).toEqual(sources[1].artifact.versions[0]);
    const combined = await composeDocumentSequence([
      sources[2],
      { artifact: reloaded, versionId: reloaded.versions[1].versionId },
      sources[0],
    ]);
    expect(combined.ok).toBe(true);
    expect(combined.content!.blocks.filter((b) => b.type === 'heading').map((b) => b.text)).toEqual(
      ['Chapter 3', 'Chapter 2', 'Chapter 1'],
    );
    expect(new Set(combined.content!.blocks.map((b) => b.id)).size).toBe(9);
    expect(combined.manifest.sources[1].elements[2]).toEqual({
      sourceId: 'scene-2',
      outputId: 'sequence:1:scene-2',
    });
    expect(canonicalJson(sources)).toBe(original);
  });
  it('refuses stale, revoked permission and composition without partial changes; save failure retains manuscript and old version', async () => {
    const { artifact } = await source(1);
    let edit = true;
    let composing = false;
    const host = new ArtifactEditor(
      artifact,
      adapter,
      {
        put: async () => {
          throw Error('offline');
        },
      },
      () => edit,
    );
    host.registerInputBoundary(() => {
      if (composing) throw Error('IME pending');
    });
    const propose = (id: string) =>
      host.propose({
        id,
        summary: 'Revise',
        baseLocalRevision: host.revision,
        commands: [
          documentTextEditCommand(host.content, [
            { ...findDocumentText(host.content, 'Night'), text: 'Evening' },
          ]),
        ],
      });
    propose('stale');
    host.execute(
      documentTextEditCommand(host.content, [
        { ...findDocumentText(host.content, 'Morning'), text: 'Dawn' },
      ]),
    );
    expect(() => host.acceptProposal('stale')).toThrow(/changed/);
    propose('guarded');
    edit = false;
    expect(() => host.acceptProposal('guarded')).toThrow(/read-only/);
    edit = true;
    composing = true;
    expect(() => host.acceptProposal('guarded')).toThrow(/IME/);
    composing = false;
    host.acceptProposal('guarded');
    const before = host.snapshot;
    await expect(host.save({ commitVersion: true })).rejects.toThrow('offline');
    expect(host.snapshot).toEqual(before);
    expect(host.artifact).toEqual(artifact);
  });
  it('reports missing/corrupt versions, unsupported blocks/reuse and layout differences without partial output', async () => {
    const a = await source(1),
      b = await source(2);
    expect(
      (await composeDocumentSequence([{ ...a, versionId: 'missing' }])).manifest.diagnostics,
    ).toContainEqual(expect.objectContaining({ code: 'missing-version' }));
    expect(
      (await composeDocumentSequence([{ ...a, versionId: 'missing' }])).manifest.requests,
    ).toEqual([{ artifactId: a.artifact.id, versionId: 'missing', order: 0 }]);
    a.artifact.versions[0].content.blocks[0].text = 'corrupt';
    expect((await composeDocumentSequence([a])).ok).toBe(false);
    b.artifact = await commitVersion(
      createArtifact('document', 'Unsupported', {
        schemaVersion: 2,
        blocks: [{ id: 'img', type: 'image', text: '', src: 'data:image/png;base64,AA==' }],
      } as DocumentContent),
      null,
      'fixture',
    );
    b.versionId = b.artifact.versions[0].versionId;
    const result = await composeDocumentSequence([await source(3), b]);
    expect(result.content).toBeUndefined();
    expect(result.manifest.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'unsupported', elementId: 'img' }),
    );
    const layout = await commitVersion(
      createArtifact('document', 'layout', {
        ...chapter(3),
        page: { size: 'Letter' as const, margin: 80 },
      }),
      null,
      'fixture',
    );
    expect(
      (
        await composeDocumentSequence([
          await source(2),
          { artifact: layout, versionId: layout.versions[0].versionId },
        ])
      ).manifest.diagnostics,
    ).toContainEqual(expect.objectContaining({ code: 'page-settings' }));
  });
  it('does not silently flatten unknown ruby or page writing-mode fields', async () => {
    for (const content of [
      { ...chapter(1), page: { size: 'A4' as const, margin: 64, writingMode: 'vertical' } },
      {
        ...chapter(1),
        blocks: [
          {
            id: 'ruby',
            type: 'paragraph' as const,
            text: '字',
            rich: [{ text: '字', ruby: 'じ' }],
          },
        ],
      },
    ]) {
      const artifact = await commitVersion(
        createArtifact('document', 'Unknown publishing feature', content),
        null,
        'fixture',
      );
      const result = await composeDocumentSequence([
        { artifact, versionId: artifact.versions[0].versionId },
      ]);
      expect(result.ok).toBe(false);
      expect(result.content).toBeUndefined();
      expect(result.manifest.diagnostics.some((d) => d.code === 'unsupported')).toBe(true);
    }
  });
  it('captures all source bytes before the first async hash and exposes a DOM-free public API', async () => {
    const s = await source(1);
    const pending = composeDocumentSequence([s]);
    s.artifact.versions[0].content.blocks[1].text = 'later';
    expect((await pending).content!.blocks[1].text).toBe('Morning 1.');
    const bundle = await build({
      stdin: {
        contents: "export * from '@editor-platform/document/sequence'",
        resolveDir: process.cwd(),
      },
      bundle: true,
      platform: 'node',
      write: false,
      metafile: true,
    });
    expect(
      Object.keys(bundle.metafile!.inputs).filter((p) => /react-dom|\.tsx$|\.css$/.test(p)),
    ).toEqual([]);
  });
});
