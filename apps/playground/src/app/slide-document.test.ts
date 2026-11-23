import { expect, it, vi } from 'vitest';
import { commitVersion, createArtifact, MemoryStorage } from '@editor-platform/artifact-core';
import { EditorSession } from '@editor-platform/editor-core';
import type { DocumentContent } from '@editor-platform/document/model';
import { addSlide, createDeck } from '@editor-platform/slide/model';
import type { StoredArtifact } from '../model';
import {
  prepareSlideDocumentImport,
  prepareSlideDocumentProposal,
  type SlideDocumentAccess,
} from './slide-document';

async function setup() {
  const doc: DocumentContent = {
    schemaVersion: 2,
    blocks: [{ id: 'title', type: 'heading', text: 'Saved title' }],
  };
  const saved = await commitVersion(createArtifact('document', 'Source', doc), null, 'saved');
  let source: StoredArtifact | undefined = { ...saved, annotations: [] };
  let canCreate = true;
  let canEdit = true;
  const deck = createDeck();
  const record = { ...createArtifact('slide', 'Destination', deck), annotations: [] };
  const session = new EditorSession(deck);
  const storage = new MemoryStorage<StoredArtifact>();
  const append = vi.fn<SlideDocumentAccess['append']>(async (cmd, _page, beforeWrite) => {
    beforeWrite();
    session.execute(cmd);
  });
  const created = vi.fn();
  const access: SlideDocumentAccess = {
    readDocument: () => source,
    readTarget: () => {
      if (!canEdit) throw Error('Read only');
      return { record, content: session.content, revision: session.revision };
    },
    assertCanCreate: () => {
      if (!canCreate) throw Error('Creation forbidden');
    },
    provider: { checkAccess: vi.fn(), checkSnapshot: vi.fn(), list: () => [], resolve: vi.fn() },
    storage,
    created,
    append,
  };
  const version = saved.versions[0];
  return {
    access,
    append,
    created,
    deck,
    record,
    session,
    storage,
    signal: new AbortController().signal,
    source: {
      kind: 'saved' as const,
      artifactId: saved.id,
      versionId: version.versionId,
      hash: version.contentHash,
    },
    removeSource: () => {
      source = undefined;
    },
    forbidCreate: () => {
      canCreate = false;
    },
    forbidEdit: () => {
      canEdit = false;
    },
  };
}

it('pins the source, target version and local revision and refuses stale or read-only append', async () => {
  const f = await setup();
  const proposal = {
    type: 'slide.document.append',
    artifactId: f.source.artifactId,
    versionId: f.source.versionId,
    contentHash: f.source.hash,
    targetId: f.record.id,
    baseVersionId: null,
    revision: f.session.revision,
  };
  const preview = await prepareSlideDocumentProposal(proposal, f.signal, f.access);
  expect(preview.pages.map((page) => page.title)).toEqual(['Saved title']);
  expect(f.session.content).toEqual(f.deck);
  f.session.execute(addSlide());
  f.session.undo();
  await expect(preview.commit(f.signal, { proposalId: 'old' })).rejects.toThrow(
    '追加先のデッキが変わりました',
  );
  expect(f.session.canRedo).toBe(true);
  const next = await prepareSlideDocumentImport(f.source, 'append', '', f.signal, f.access);
  f.forbidEdit();
  await expect(next.commit(f.signal)).rejects.toThrow('Read only');
  expect(f.append).not.toHaveBeenCalled();
  expect(f.session.content).toEqual(f.deck);
});

it('rechecks source access and creation rights and commits the same new request once', async () => {
  const f = await setup();
  const preview = await prepareSlideDocumentImport(f.source, 'new', 'Result', f.signal, f.access);
  expect(await f.storage.list()).toEqual([]);
  await preview.commit(f.signal);
  await preview.commit(f.signal);
  expect(f.created).toHaveBeenCalledTimes(1);
  expect(await f.storage.list()).toMatchObject([
    { name: 'Result', draft: { content: { slides: preview.pages } } },
  ]);

  const inaccessible = await setup();
  const blocked = await prepareSlideDocumentImport(
    inaccessible.source,
    'new',
    'Result',
    inaccessible.signal,
    inaccessible.access,
  );
  inaccessible.removeSource();
  await expect(blocked.commit(inaccessible.signal)).rejects.toThrow('元の文書が見つかりません');
  inaccessible.forbidCreate();
  await expect(blocked.commit(inaccessible.signal)).rejects.toThrow('Creation forbidden');
  expect(await inaccessible.storage.list()).toEqual([]);
  expect(inaccessible.created).not.toHaveBeenCalled();
});
