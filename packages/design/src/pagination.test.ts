import { describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import {
  canonicalJson,
  commitVersion,
  createArtifact,
  serializeArtifact,
} from '@editor-platform/artifact-core';
import {
  ArtifactEditor,
  loadHostArtifact,
  type EditorHostAdapter,
} from '@editor-platform/editor-host';
import { EditorSession } from '@editor-platform/editor-core';
import {
  createDesign,
  insertElement,
  updateElement,
  deleteElements,
  isDesign,
  isDesignWithPaths,
  reparentElement,
  type DesignContent,
} from '@editor-platform/design/model';
import {
  captureDesignPages,
  insertDesignPage,
  insertDesignPanel,
  setDesignPagination,
  designPageEditCommand,
} from '@editor-platform/design/pagination';
import { designPageProposalDiff } from '@editor-platform/design/page-proposal-diff';

export function fixture() {
  let d = createDesign();
  for (let p = 0; p < 4; p++) {
    const x = p * 650;
    d = insertDesignPage({ x, y: 0, width: 600, height: 800 }, `page-${p}`).apply(d);
    for (let i = 0; i < 2; i++) {
      d = insertDesignPanel(
        `page-${p}`,
        { x: x + 20, y: 20 + i * 380, width: 560, height: 350 },
        `panel-${p}-${i}`,
      ).apply(d);
      d = insertElement('text', {
        id: `dialogue-${p}-${i}`,
        parentId: `panel-${p}-${i}`,
        bounds: { x: x + 40, y: 40 + i * 380, width: 400, height: 80 },
      }).apply(d);
      d = updateElement(`dialogue-${p}-${i}`, { text: `Hello ${p}.${i}` }).apply(d);
    }
  }
  return d;
}
const adapter: EditorHostAdapter<DesignContent> = {
  kind: 'design',
  validate: isDesignWithPaths,
  capabilities: {
    undo: true,
    nativeJson: true,
    formats: [],
    preview: 'none',
    shared: false,
    proposals: true,
  },
};
describe('Design native pagination', () => {
  it('roundtrips four pages, preserves identity and z-order while reordering, edits panels/dialogue through one proposal and Undo', async () => {
    const d = fixture();
    const original = canonicalJson(d);
    const artifact = await commitVersion(createArtifact('design', 'Pages', d), null, 'fixture');
    let stored = '';
    const host = new ArtifactEditor(artifact, adapter, {
      put: async (a) => {
        stored = serializeArtifact(a);
      },
    });
    const order = [...d.pagination!.pages].reverse();
    host.execute(setDesignPagination({ ...d.pagination!, pages: order, direction: 'ltr' }));
    expect(host.content.elements.map((e) => e.id)).toEqual(d.elements.map((e) => e.id));
    host.execute(
      setDesignPagination({
        ...host.content.pagination!,
        pages: order.map((p, i) => (i ? p : { ...p, panelIds: [...p.panelIds].reverse() })),
      }),
    );
    const before = host.content;
    const review = host.propose({
      id: 'review',
      summary: 'Move panel and revise dialogue',
      baseLocalRevision: host.revision,
      commands: [
        designPageEditCommand([
          { type: 'bounds', id: 'panel-0-0', value: { x: 30, y: 30, width: 500, height: 340 } },
          { type: 'text', id: 'dialogue-0-0', value: 'Revised' },
        ]),
      ],
    });
    const diff = designPageProposalDiff.diff(before, review.preview.content);
    expect(diff.fallback).toEqual([]);
    expect(diff.changes.map((c) => c.elementId)).toContain('dialogue-0-0');
    expect(host.content).toEqual(before);
    host.acceptProposal('review');
    const after = host.content;
    host.undo();
    expect(host.content).toEqual(before);
    host.redo();
    expect(host.content).toEqual(after);
    await host.save({ commitVersion: true });
    const reloaded = await loadHostArtifact(stored, adapter);
    expect(reloaded.draft.content).toEqual(after);
    expect(reloaded.versions[0]).toEqual(artifact.versions[0]);
    const capture = await captureDesignPages(reloaded, reloaded.versions[1].versionId);
    expect(capture.ok).toBe(true);
    expect(capture.pages.map((p) => p.frameId)).toEqual(order.map((p) => p.frameId));
    expect(capture.pages[0].panelIds).toEqual(['panel-3-1', 'panel-3-0']);
    expect(capture.pages[3].svg).toContain('Revised');
    expect(canonicalJson(d)).toBe(original);
  });
  it('delete/Undo restores exact IDs; recreation has a new ID; dangling/reparent references fail atomically', () => {
    const d = fixture();
    const session = new EditorSession(d);
    session.execute(deleteElements(['panel-0-0']));
    expect(session.content.pagination!.pages[0].panelIds).toEqual(['panel-0-1']);
    expect(session.content.elements.find((e) => e.id === 'dialogue-0-0')).toBeUndefined();
    session.undo();
    expect(session.content).toEqual(d);
    session.redo();
    const insert = insertDesignPanel('page-0', { x: 20, y: 20, width: 200, height: 200 });
    session.execute(insert);
    expect(insert.elementId).not.toBe('panel-0-0');
    const before = session.content;
    expect(() => session.execute(reparentElement('panel-0-1', 'page-1'))).toThrow();
    expect(session.content).toEqual(before);
    session.execute(deleteElements(['page-1']));
    expect(session.content.pagination!.pages.map((p) => p.frameId)).not.toContain('page-1');
  });
  it('refuses unsupported entrypoints/metadata/edits and late batch failures with no history or content change', () => {
    const d = fixture();
    expect(isDesign(d)).toBe(false);
    expect(isDesignWithPaths(d)).toBe(true);
    for (const pagination of [
      { ...d.pagination, direction: 'auto' },
      { ...d.pagination, pages: [{ frameId: 'missing', panelIds: [] }] },
      { ...d.pagination, pages: [d.pagination!.pages[0], d.pagination!.pages[0]] },
      { ...d.pagination, extra: true },
    ])
      expect(isDesignWithPaths({ ...d, pagination })).toBe(false);
    for (const raw of [
      [{ type: 'script', id: 'dialogue-0-0', value: 'no' }],
      [
        { type: 'text', id: 'dialogue-0-0', value: 'OK' },
        { type: 'text', id: 'missing', value: 'no' },
      ],
      [{ type: 'bounds', id: 'panel-0-0', value: { x: 0, y: 0, width: NaN, height: 3 } }],
    ]) {
      const session = new EditorSession(d);
      expect(() => session.execute(designPageEditCommand(raw))).toThrow();
      expect(session.content).toEqual(d);
      expect(session.canUndo).toBe(false);
    }
  });
  it('rejects stale/permission/composition, Cancel and failed saves without partial changes', async () => {
    const artifact = await commitVersion(
      createArtifact('design', 'Pages', fixture()),
      null,
      'fixture',
    );
    let writable = true,
      composing = false;
    const host = new ArtifactEditor(
      artifact,
      adapter,
      {
        put: async () => {
          throw Error('disk full');
        },
      },
      () => writable,
    );
    host.registerInputBoundary(() => {
      if (composing) throw Error('composition');
    });
    const propose = (id: string) =>
      host.propose({
        id,
        summary: 'dialogue',
        baseLocalRevision: host.revision,
        commands: [designPageEditCommand([{ type: 'text', id: 'dialogue-0-0', value: 'Revised' }])],
      });
    propose('cancel');
    host.rejectProposal('cancel');
    expect(host.content).toEqual(artifact.draft.content);
    propose('stale');
    host.execute(updateElement('dialogue-0-1', { text: 'Other' }));
    expect(() => host.acceptProposal('stale')).toThrow(/changed/);
    propose('guard');
    writable = false;
    expect(() => host.acceptProposal('guard')).toThrow(/read-only/);
    writable = true;
    composing = true;
    expect(() => host.acceptProposal('guard')).toThrow('composition');
    composing = false;
    host.acceptProposal('guard');
    const before = host.snapshot;
    await expect(host.save({ commitVersion: true })).rejects.toThrow('disk full');
    expect(host.snapshot).toEqual(before);
    expect(host.artifact).toEqual(artifact);
  });
  it('reports hidden/outside/unsupported images and validates exact versions without mutating the source', async () => {
    let d = fixture();
    d = insertElement('image', {
      id: 'image',
      parentId: 'panel-0-0',
      src: 'data:image/png;base64,AA==',
    }).apply(d);
    const artifact = await commitVersion(createArtifact('design', 'Pages', d), null, 'fixture');
    const before = canonicalJson(artifact);
    const capture = await captureDesignPages(artifact, artifact.versions[0].versionId);
    expect(capture.ok).toBe(false);
    expect(capture.pages).toEqual([]);
    expect(capture.manifest.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'image-source', elementId: 'image' }),
    );
    expect(canonicalJson(artifact)).toBe(before);
    await expect(captureDesignPages(artifact, 'latest')).rejects.toThrow(/exact/);
    artifact.versions[0] = structuredClone(artifact.versions[0]);
    artifact.versions[0].content.elements[0].name = 'corrupt';
    await expect(captureDesignPages(artifact, artifact.versions[0].versionId)).rejects.toThrow(
      /hash/,
    );
  });
  it('changes an embedded image and its source/license atomically; rejects broken retained pagination', async () => {
    let d = fixture();
    d = insertElement('image', {
      id: 'asset',
      parentId: 'panel-0-0',
      src: 'data:image/png;base64,AA==',
    }).apply(d);
    const cmd = designPageEditCommand([
      {
        type: 'image',
        id: 'asset',
        value: { src: 'data:image/png;base64,AQ==', source: 'Host asset A', license: 'CC0-1.0' },
      },
    ]);
    const session = new EditorSession(d);
    session.execute(cmd);
    expect(session.content.pagination!.images).toEqual([
      { elementId: 'asset', source: 'Host asset A', license: 'CC0-1.0' },
    ]);
    session.undo();
    expect(session.content).toEqual(d);
    session.redo();
    const artifact = await commitVersion(
      createArtifact('design', 'Pages', session.content),
      null,
      'fixture',
    );
    const invalid = JSON.parse(serializeArtifact(artifact));
    invalid.versions[0].content.pagination.pages[0].panelIds = ['missing'];
    await expect(loadHostArtifact(JSON.stringify(invalid), adapter)).rejects.toThrow();
    expect(() => designPageEditCommand([{ type: 'image', id: 'asset', value: null }])).toThrow();
  });
  it('keeps public capture and command APIs headless', async () => {
    const bundle = await build({
      stdin: {
        contents: "export * from '@editor-platform/design/pagination'",
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
