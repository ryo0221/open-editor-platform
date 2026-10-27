import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  commitVersion,
  createArtifact,
  MemoryStorage,
  serializeArtifact,
  type Artifact,
} from '@editor-platform/artifact-core';
import { command } from '@editor-platform/editor-core';
import { ArtifactEditor, loadHostArtifact, type EditorHostAdapter } from './index';
type Content = { schemaVersion: 1; text: string };
const valid = (v: unknown): v is Content =>
  !!v &&
  typeof v === 'object' &&
  'schemaVersion' in v &&
  v.schemaVersion === 1 &&
  'text' in v &&
  typeof v.text === 'string';
const adapter: EditorHostAdapter<Content> = {
  kind: 'example',
  validate: valid,
  capabilities: { undo: true, nativeJson: true, formats: ['text'], preview: 'none', shared: false },
  async export(_format, c) {
    return c.text;
  },
};
const artifact = () =>
  createArtifact('example', 'Example', { schemaVersion: 1 as const, text: 'initial' });
const edit = (text: string) => command<Content>('edit', 'Edit text', (c) => ({ ...c, text }));
describe('Artifact Host lifecycle using existing EditorSession', () => {
  it('rejects empty/invalid/missing version IDs and parents, including empty self cycles', async () => {
    const original = await commitVersion(artifact(), 'fixture', 'version');
    for (const version of [
      { ...original.versions[0], versionId: '', parentVersionId: '' },
      { ...original.versions[0], versionId: '   ' },
      { ...original.versions[0], parentVersionId: undefined },
      { ...original.versions[0], parentVersionId: 0 },
      { ...original.versions[0], parentVersionId: original.versions[0].versionId },
    ]) {
      const bad = {
        ...original,
        draft: { ...original.draft, baseVersionId: null },
        versions: [version],
      };
      expect(
        () => new ArtifactEditor(bad as Artifact<Content>, adapter, new MemoryStorage()),
      ).toThrow();
      await expect(loadHostArtifact(JSON.stringify(bad), adapter)).rejects.toBeDefined();
    }
  });
  it('validates long ancestry and disconnected cycles without recursive or repeated ancestry scans', async () => {
    const original = await commitVersion(artifact(), 'fixture', 'version');
    const versions = Array.from({ length: 3000 }, (_, i) => ({
      ...original.versions[0],
      versionId: 'v' + i,
      parentVersionId: i ? 'v' + (i - 1) : null,
    }));
    const data = { ...original, draft: { ...original.draft, baseVersionId: 'v2999' }, versions };
    expect(new ArtifactEditor(data, adapter, new MemoryStorage()).artifact.versions).toHaveLength(
      3000,
    );
    versions[0].parentVersionId = 'v2';
    expect(() => new ArtifactEditor(data, adapter, new MemoryStorage())).toThrow(/cycle/);
  });
  it('retains revision, Undo, Redo and private state through repeated attach/detach and save', async () => {
    const storage = new MemoryStorage<Artifact<Content>>(),
      host = new ArtifactEditor(artifact(), adapter, storage);
    let changes = 0;
    const detach = host.attach(() => changes++);
    host.execute(edit('edited'));
    host.undo();
    const before = host.snapshot.revision;
    detach();
    host.viewState.set('camera', { zoom: 2 });
    for (let i = 0; i < 4; i++) {
      const release = host.attach(() => changes++);
      release();
    }
    expect(host.snapshot.revision).toEqual(before);
    // Direct accessors match the snapshot without building it.
    expect(host.revision).toEqual(before);
    expect(host.content).toEqual(host.snapshot.content);
    expect([host.canUndo, host.canRedo]).toEqual([false, true]);
    host.redo();
    expect(host.snapshot.content.text).toBe('edited');
    const result = await host.save({ commitVersion: true, author: 'fixture' });
    expect(result.artifactId).toBe(host.id);
    expect(result.kind).toBe('example');
    expect(result.artifact.versions[0].createdBy).toBe('fixture');
    expect(result.artifact.versions[0].content.text).toBe('edited');
    expect(host.snapshot.canUndo).toBe(true);
    expect(host.snapshot.dirty).toBe(false);
    expect(host.viewState.get('camera')).toEqual({ zoom: 2 });
    expect(changes).toBe(2);
    host.undo();
    expect(host.snapshot.content.text).toBe('initial');
    expect(host.snapshot.dirty).toBe(true);
  });
  it('separates two artifacts of the same kind and restarts history on explicit close/reload', async () => {
    const storage = new MemoryStorage<Artifact<Content>>();
    const a = new ArtifactEditor(artifact(), adapter, storage),
      b = new ArtifactEditor(artifact(), adapter, storage);
    a.execute(edit('A'));
    b.execute(edit('B'));
    a.undo();
    expect(b.snapshot.content.text).toBe('B');
    expect(b.snapshot.revision.sequence).toBe(1);
    a.redo();
    await a.save();
    a.close();
    expect(() => a.execute(edit('closed'))).toThrowError(/closed/);
    const reopened = new ArtifactEditor((await storage.get(a.id))!, adapter, storage);
    expect(reopened.snapshot.content.text).toBe('A');
    expect(reopened.snapshot.canUndo).toBe(false);
    expect(reopened.snapshot.revision.sessionId).not.toBe(a.snapshot.revision.sessionId);
  });
  it('rejects a mutating invalid command atomically with Undo/Redo/revision unchanged', () => {
    const host = new ArtifactEditor(artifact(), adapter, new MemoryStorage());
    host.execute(edit('keep'));
    host.undo();
    const before = host.snapshot;
    expect(() =>
      host.execute(
        command('invalid', 'Invalid', (c) => {
          c.text = 'mutated';
          return { ...c, schemaVersion: 2 } as unknown as Content;
        }),
      ),
    ).toThrowError(/invalid native/);
    expect(host.snapshot).toEqual(before);
    host.redo();
    expect(host.snapshot.content.text).toBe('keep');
  });
  it('checks current permission at UI/headless execution, history and save boundaries', async () => {
    let permission = true;
    const host = new ArtifactEditor(artifact(), adapter, new MemoryStorage(), () => permission);
    host.execute(edit('keep'));
    permission = false;
    const before = host.snapshot;
    expect(() => host.execute(edit('forbidden'))).toThrowError(/read-only/);
    expect(() => host.undo()).toThrowError(/read-only/);
    expect(() => host.redo()).toThrowError(/read-only/);
    await expect(host.save()).rejects.toMatchObject({ code: 'read-only' });
    expect(host.snapshot).toEqual(before);
    expect(await host.export('text')).toBe('keep');
  });
  it('retains a failed save draft/history and retries without false saved state', async () => {
    let fail = true,
      stored: Artifact<Content> | undefined;
    const host = new ArtifactEditor(artifact(), adapter, {
      async put(a) {
        if (fail) throw Error('quota');
        stored = a;
      },
    });
    host.execute(edit('retry'));
    await expect(host.save({ commitVersion: true })).rejects.toMatchObject({ code: 'save-failed' });
    expect(host.snapshot.dirty).toBe(true);
    expect(host.artifact.versions).toHaveLength(0);
    expect(host.snapshot.canUndo).toBe(true);
    expect(host.snapshot.saving).toBe(false);
    fail = false;
    await host.save({ commitVersion: true });
    expect(stored?.draft.content.text).toBe('retry');
    expect(host.artifact.versions).toHaveLength(1);
  });
  it('does not overwrite newer edits on delayed save and blocks duplicate save/close', async () => {
    let finish: () => void = () => {};
    const waiting = new Promise<void>((r) => {
      finish = r;
    });
    const storage = new MemoryStorage<Artifact<Content>>();
    const host = new ArtifactEditor(artifact(), adapter, {
      async put(a) {
        await waiting;
        await storage.put(a);
      },
    });
    host.execute(edit('captured'));
    const save = host.save();
    host.execute(edit('newer'));
    await expect(host.save()).rejects.toMatchObject({ code: 'save-busy' });
    expect(() => host.close('discard')).toThrowError(/pending save/);
    finish();
    const result = await save;
    expect(result.artifact.draft.content.text).toBe('captured');
    expect(result.dirty).toBe(true);
    expect(host.snapshot.content.text).toBe('newer');
    expect((await storage.get(host.id))!.draft.content.text).toBe('captured');
  });
  it('requires explicit discard and releases listener/buffer/private state on close', () => {
    const host = new ArtifactEditor(artifact(), adapter, new MemoryStorage());
    host.execute(edit('draft'));
    host.viewState.set('private', 1);
    expect(() => host.close()).toThrowError(/Save, retain/);
    host.close('discard');
    expect(host.viewState.size).toBe(0);
    expect(() => host.attach(() => {})).toThrowError(/closed/);
    expect(() => host.flushInputs()).toThrowError(/closed/);
  });
  it('flushes input before save and refuses unresolved input without losing draft', async () => {
    const host = new ArtifactEditor(artifact(), adapter, new MemoryStorage());
    const pending = host.registerInputBoundary(() => {
      throw Error('composition pending');
    });
    await expect(host.save()).rejects.toThrowError(/composition pending/);
    expect(host.snapshot.revision.sequence).toBe(0);
    pending();
    const flush = host.registerInputBoundary(() => {
      host.execute(edit('flushed'));
    });
    const result = await host.save();
    expect(result.artifact.draft.content.text).toBe('flushed');
    flush();
  });
  it('keeps selection and camera outside version content/history and rejects cross-artifact selection', async () => {
    const host = new ArtifactEditor(artifact(), adapter, new MemoryStorage());
    host.select({ addresses: [{ artifactId: host.id, elementId: 'file' }] });
    host.viewState.set('zoom', 2);
    expect(host.snapshot.revision.sequence).toBe(0);
    expect(host.snapshot.canUndo).toBe(false);
    expect(() =>
      host.select({ addresses: [{ artifactId: 'other', elementId: 'file' }] }),
    ).toThrowError(/another artifact/);
    const saved = await host.save({ commitVersion: true });
    expect(saved.artifact.versions[0].content).toEqual({ schemaVersion: 1, text: 'initial' });
  });
  it('returns addressed unsupported formats and validates imports before a single undoable edit', async () => {
    const host = new ArtifactEditor(artifact(), adapter, new MemoryStorage());
    const before = host.snapshot;
    await expect(host.export('pptx')).rejects.toMatchObject({
      code: 'unsupported',
      artifactId: host.id,
    });
    expect(() => host.importContent({ schemaVersion: 99 })).toThrowError(/invalid native/);
    expect(host.snapshot).toEqual(before);
    host.importContent({ schemaVersion: 1, text: 'imported' });
    expect(host.snapshot.revision.sequence).toBe(1);
    host.undo();
    expect(host.snapshot.content.text).toBe('initial');
  });
  it('roundtrips native draft and immutable retained versions, rejects historical corruption/kind/hash', async () => {
    const a = await commitVersion(artifact(), 'fixture', 'version');
    const host = new ArtifactEditor(a, adapter, new MemoryStorage());
    host.execute(edit('draft'));
    const json = (await host.export('native-json')) as string;
    const loaded = await loadHostArtifact(json, adapter);
    expect(loaded.draft.content.text).toBe('draft');
    expect(loaded.versions).toEqual(a.versions);
    for (const bad of [
      { ...loaded, kind: 'other' },
      {
        ...loaded,
        versions: [{ ...loaded.versions[0], content: { schemaVersion: 2, text: 'old' } }],
      },
      { ...loaded, versions: [{ ...loaded.versions[0], contentHash: '0'.repeat(64) }] },
    ])
      await expect(loadHostArtifact(serializeArtifact(bad), adapter)).rejects.toBeDefined();
    expect(canonicalJson(host.artifact.versions)).toBe(canonicalJson(a.versions));
  });
});

describe('native persistence size boundary', () => {
  it('rejects retained snapshot growth before storage and keeps the last reloadable save', async () => {
    const storage = new MemoryStorage<Artifact<Content>>();
    const host = new ArtifactEditor(artifact(), adapter, storage);
    host.execute(edit('あ'.repeat(2 * 1024 * 1024)));
    const first = await host.save({ commitVersion: true });
    host.execute(edit('い'.repeat(2 * 1024 * 1024)));
    await expect(host.save({ commitVersion: true })).rejects.toMatchObject({
      code: 'invalid-artifact',
    });
    expect(host.snapshot.saving).toBe(false);
    expect(host.snapshot.dirty).toBe(true);
    expect(host.artifact.versions).toEqual(first.artifact.versions);
    const persisted = await storage.get(host.id);
    expect(persisted).toEqual(first.artifact);
    await expect(loadHostArtifact(serializeArtifact(persisted!), adapter)).resolves.toEqual(
      first.artifact,
    );
    // Correct only the draft; keep all saved versions and the existing Undo stack.
    host.execute(edit('corrected'));
    const retry = await host.save({ commitVersion: true });
    expect(retry.artifact.versions.slice(0, 1)).toEqual(first.artifact.versions);
    expect(host.snapshot.dirty).toBe(false);
    expect(host.canUndo).toBe(true);
  });
  it('rejects an oversized draft at save and native export without marking it saved', async () => {
    const storage = new MemoryStorage<Artifact<Content>>();
    const host = new ArtifactEditor(artifact(), adapter, storage);
    host.execute(edit('x'.repeat(16 * 1024 * 1024)));
    await expect(host.save()).rejects.toMatchObject({ code: 'invalid-artifact' });
    await expect(host.export('native-json')).rejects.toMatchObject({ code: 'invalid-artifact' });
    expect(host.snapshot.dirty).toBe(true);
    expect(await storage.get(host.id)).toBeUndefined();
  });
});

it('rejects missing or mistyped Artifact draft/version/provenance metadata', async () => {
  const original = await commitVersion(artifact(), 'actor', 'reason');
  const patches: ((a: Record<string, unknown>) => void)[] = [
    (a) => {
      delete a.provenance;
    },
    (a) => {
      a.provenance = { source: 'unknown' };
    },
    (a) => {
      a.provenance = { source: 'created', template: { id: 't' } };
    },
    (a) => {
      a.provenance = { source: 'imported', officeImport: { requestId: 'r' } };
    },
    (a) => {
      (a.draft as Record<string, unknown>).updatedAt = 123;
    },
    ...['createdAt', 'createdBy', 'reason'].flatMap((key) => [
      (a: Record<string, unknown>) => {
        delete (a.versions as Record<string, unknown>[])[0][key];
      },
      (a: Record<string, unknown>) => {
        (a.versions as Record<string, unknown>[])[0][key] = 12;
      },
    ]),
  ];
  for (const patch of patches) {
    const bad = structuredClone(original) as unknown as Record<string, unknown>;
    patch(bad);
    await expect(loadHostArtifact(JSON.stringify(bad), adapter)).rejects.toBeDefined();
  }
  await expect(loadHostArtifact(serializeArtifact(original), adapter)).resolves.toEqual(original);
});
