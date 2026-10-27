import { expect, it } from 'vitest';
import { build } from 'esbuild';
import {
  canonicalJson,
  commitVersion,
  createArtifact,
  serializeArtifact,
} from '@editor-platform/artifact-core';
import { EditorSession } from '@editor-platform/editor-core';
import {
  ArtifactEditor,
  loadHostArtifact,
  type EditorHostAdapter,
} from '@editor-platform/editor-host';
import {
  createDesign,
  updateElement,
  isDesign,
  isDesignWithPaths,
  moveDesignPathPoint,
  replaceDesignPath,
  duplicateElements,
  type DesignContent,
} from '@editor-platform/design/model';
import {
  insertDesignPage,
  insertDesignPanel,
  captureDesignPages,
} from '@editor-platform/design/pagination';
import {
  insertDesignPagePath,
  insertDesignSpeechBalloon,
} from '@editor-platform/design/page-artwork';
const bounds = { x: 50, y: 70, width: 300, height: 180 };
function fixture() {
  let d = insertDesignPage({ x: 0, y: 0, width: 600, height: 800 }, 'page').apply(createDesign());
  d = insertDesignPanel('page', { x: 20, y: 20, width: 560, height: 720 }, 'panel').apply(d);
  return d;
}
const adapter: EditorHostAdapter<DesignContent> = {
  kind: 'design',
  validate: isDesignWithPaths,
  capabilities: { undo: true, nativeJson: true, formats: [], preview: 'none', shared: false },
};
it('owns linework inputs, edits native points and restores stable IDs with Undo/Redo', () => {
  const d = fixture();
  const session = new EditorSession(d);
  const mutable = { ...bounds };
  const insert = insertDesignPagePath('panel', 'cubic', mutable);
  mutable.x = 900;
  session.execute(insert);
  const path = session.content.elements.find((e) => e.id === insert.elementId)!;
  expect(path.bounds).toEqual(bounds);
  expect(path.parentId).toBe('panel');
  expect(session.content.schemaVersion).toBe(3);
  const before = session.content;
  const sub = path.path!.subpaths[0];
  session.execute(
    replaceDesignPath(
      before,
      path.id,
      moveDesignPathPoint(
        path.path!,
        { subpathId: sub.id, anchorId: sub.anchors[0].id },
        { x: 10, y: 20 },
      ),
    ),
  );
  expect(
    session.content.elements.find((e) => e.id === path.id)!.path!.subpaths[0].anchors[0],
  ).toMatchObject({ id: sub.anchors[0].id, x: 10, y: 20 });
  session.undo();
  expect(session.content).toEqual(before);
  session.undo();
  expect(session.content).toEqual(d);
  session.redo();
  expect(session.content).toEqual(before);
});
it('creates one native group/path/text transaction and persists immutable versions through capture', async () => {
  const base = fixture();
  const artifact = await commitVersion(createArtifact('design', 'M1', base), null, 'M0');
  let stored = '';
  const host = new ArtifactEditor(artifact, adapter, {
    put: async (a) => {
      stored = serializeArtifact(a);
    },
  });
  const balloon = insertDesignSpeechBalloon('panel', bounds, 'Hello');
  host.execute(balloon);
  const native = host.content;
  const path = native.elements.find((e) => e.id === balloon.pathId)!;
  const text = native.elements.find((e) => e.id === balloon.textId)!;
  expect(native.elements).toHaveLength(base.elements.length + 3);
  expect(text).toMatchObject({ type: 'text', parentId: balloon.elementId, text: 'Hello' });
  expect(path.path!.subpaths[0].closed).toBe(true);
  expect(path.parentId).toBe(balloon.elementId);
  expect(isDesign(native)).toBe(false);
  expect(isDesignWithPaths(native)).toBe(true);
  host.undo();
  expect(host.content).toEqual(base);
  expect(host.canUndo).toBe(false);
  host.redo();
  expect(host.content).toEqual(native);
  await host.save({ commitVersion: true });
  const restored = await loadHostArtifact(stored, adapter);
  expect(restored.versions[0]).toEqual(artifact.versions[0]);
  expect(restored.draft.content).toEqual(native);
  expect((await captureDesignPages(restored, restored.versions[1].versionId)).ok).toBe(false);
  const capture = await captureDesignPages(restored, restored.versions[1].versionId, {
    mode: 'vector',
  });
  expect(capture.ok).toBe(true);
  expect(capture.manifest.capability).toBe('vector');
  expect(capture.manifest.artwork).toEqual([{ elementId: path.id, kind: 'path' }]);
  expect(capture.pages[0].svg).toContain('Hello');
  expect(capture.pages[0].svg).toContain('<path');
});
it('keeps cloned balloon path/anchor/text IDs independent and retains pagination integrity', () => {
  const d = fixture();
  const balloon = insertDesignSpeechBalloon('panel', bounds, 'Hello');
  const session = new EditorSession(d);
  session.execute(balloon);
  const before = session.content;
  session.execute(duplicateElements([balloon.elementId]));
  const copy = session.content.elements.find((e) => e.path && e.id !== balloon.pathId)!;
  const old = before.elements.find((e) => e.id === balloon.pathId)!;
  expect(copy.path!.subpaths[0].anchors.map((a) => a.id)).not.toEqual(
    old.path!.subpaths[0].anchors.map((a) => a.id),
  );
  expect(session.content.pagination).toEqual(before.pagination);
  session.undo();
  expect(session.content).toEqual(before);
});
it('refuses deleted/wrong/locked panels and invalid input without leaving content/history', () => {
  const d = fixture();
  const session = new EditorSession(d);
  for (const panelId of ['missing', 'page']) {
    expect(() => session.execute(insertDesignSpeechBalloon(panelId, bounds, 'No'))).toThrow(
      /panel/,
    );
    expect(session.content).toEqual(d);
    expect(session.canUndo).toBe(false);
  }
  session.execute(updateElement('panel', { locked: true }));
  const locked = session.content;
  expect(() => session.execute(insertDesignPagePath('panel', 'line', bounds))).toThrow(/locked/);
  expect(session.content).toEqual(locked);
  expect(() => insertDesignSpeechBalloon('panel', { ...bounds, width: -1 }, 'No')).toThrow();
  expect(() => insertDesignSpeechBalloon('panel', bounds, 'x'.repeat(20001))).toThrow();
  expect(() => insertDesignPagePath('panel', 'brush' as 'line', bounds)).toThrow();
});
it('refuses late Host revocation and reports native path paint outside the page', async () => {
  let editable = true;
  const artifact = createArtifact('design', 'M1', fixture());
  const host = new ArtifactEditor(artifact, adapter, { put: async () => {} }, () => editable);
  const cmd = insertDesignPagePath('panel', 'cubic', { x: 570, y: 0, width: 300, height: 180 });
  const before = canonicalJson(host.content);
  editable = false;
  expect(() => host.execute(cmd)).toThrow(/read-only/);
  expect(canonicalJson(host.content)).toBe(before);
  editable = true;
  host.execute(cmd);
  await host.save({ commitVersion: true });
  const saved = host.artifact;
  const captured = await captureDesignPages(saved, saved.draft.baseVersionId!, { mode: 'vector' });
  expect(captured.ok).toBe(true);
  expect(captured.manifest.diagnostics).toContainEqual(
    expect.objectContaining({ code: 'page-crop', elementId: cmd.elementId }),
  );
});
it('exports a headless native artwork API without React or CSS', async () => {
  const bundle = await build({
    stdin: {
      contents: "export * from '@editor-platform/design/page-artwork'",
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
