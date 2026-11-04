import { it, expect } from 'vitest';
import { ArtifactEditor } from '@editor-platform/editor-host';
import {
  createArtifact,
  MemoryStorage,
  contentHash,
  canonicalJson,
  type Artifact,
} from '@editor-platform/artifact-core';
import {
  createFictionMap,
  prepareFictionMapChange,
  commitFictionMapChange,
  undoFictionMap,
  redoFictionMap,
  type FictionMapContent,
} from '@editor-platform/fiction-map/model';
import {
  adoptFictionMapBase,
  fictionMapHostAdapter,
  parseFictionMapArtifact,
} from '@editor-platform/fiction-map/host';
it('D4: reopens through public codec and composes readSaved/importContent as one atomic restore', async () => {
  const storage = new MemoryStorage<Artifact<FictionMapContent>>(),
    a = createArtifact('fiction-map', 'Independent map', createFictionMap());
  let permitted = true;
  const h = new ArtifactEditor(a, fictionMapHostAdapter, storage, () => permitted);
  const prep = prepareFictionMapChange(adoptFictionMapBase(h), {
    layers: [{ id: 'l', name: 'Places', purpose: 'settlement', visibleByDefault: true }],
    create: [
      {
        id: 'p',
        layerId: 'l',
        name: 'Original',
        featureKind: 'place',
        geometry: { type: 'point', coordinates: [180, 90] },
        worldEntityRef: { namespace: 'world', entityId: 'city' },
      },
    ],
  });
  if (!prep.ok) throw Error(prep.diagnostic.code);
  expect(commitFictionMapChange(h, prep.value, () => permitted).ok).toBe(true);
  await h.save({ commitVersion: true });
  const v1 = h.artifact.versions[0];
  const p = prepareFictionMapChange(adoptFictionMapBase(h), {
    update: [
      {
        ...h.content.features[0],
        name: 'Later',
        geometry: { type: 'point', coordinates: [200, 100] },
      },
    ],
  });
  if (!p.ok) throw Error(p.diagnostic.code);
  expect(commitFictionMapChange(h, p.value, () => permitted).ok).toBe(true);
  await h.save({ commitVersion: true });
  const versions = h.artifact.versions;
  h.close();
  const raw = (await storage.get(a.id))!;
  const admitted = await parseFictionMapArtifact(JSON.stringify(raw));
  const reopened = new ArtifactEditor(admitted, fictionMapHostAdapter, storage, () => permitted);
  expect(reopened.canUndo).toBe(false);
  expect(reopened.content).toEqual(versions[1].content);
  const old = reopened.readSaved(v1.versionId);
  expect(old.source).toBe('version');
  expect(old.contentHash).toBe(await contentHash(old.content));
  const revision = reopened.revision;
  reopened.importContent(old.content);
  expect(reopened.revision.sequence).toBe(revision.sequence + 1);
  expect(reopened.content).toEqual(v1.content);
  expect(reopened.artifact.versions).toEqual(versions);
  expect(undoFictionMap(reopened, () => permitted).ok).toBe(true);
  expect(reopened.content).toEqual(versions[1].content);
  expect(reopened.canUndo).toBe(false);
  expect(redoFictionMap(reopened, () => permitted).ok).toBe(true);
  expect(reopened.content.features[0].worldEntityRef).toEqual({
    namespace: 'world',
    entityId: 'city',
  });
  permitted = false;
  const frozen = {
    native: canonicalJson(reopened.content),
    revision: reopened.revision,
    undo: reopened.canUndo,
    redo: reopened.canRedo,
    versions: reopened.artifact.versions,
  };
  expect(() => reopened.importContent(versions[1].content)).toThrow();
  expect(() => undoFictionMap(reopened, () => permitted)).toThrow('Host permission is read-only');
  permitted = true;
  expect(undoFictionMap(reopened, () => false)).toMatchObject({
    ok: false,
    diagnostic: { code: 'permission-denied' },
  });
  expect({
    native: canonicalJson(reopened.content),
    revision: reopened.revision,
    undo: reopened.canUndo,
    redo: reopened.canRedo,
    versions: reopened.artifact.versions,
  }).toEqual(frozen);
  permitted = true;
  const before = reopened.revision;
  expect(() => reopened.importContent({ ...old.content, schemaVersion: 99 })).toThrow();
  expect(() => reopened.readSaved('missing-version')).toThrow();
  expect(reopened.revision).toEqual(before);
  expect(reopened.artifact.versions).toEqual(versions);
});
