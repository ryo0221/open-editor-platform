import 'fake-indexeddb/auto';
import { expect, it, vi } from 'vitest';
import { clone, commitVersion, serializeArtifact } from '@editor-platform/artifact-core';
import { ReferenceResolver } from '@editor-platform/artifact-references';
import { nativeReferenceAdapters } from '@editor-platform/reference-adapters';
import { designDivisionCommand } from '@editor-platform/design/division';
import { insertDesignPagePath } from '@editor-platform/design/page-artwork';
import {
  designPageProposalCommand,
  prepareDesignPageProposal,
  type DesignPageProposalRequest,
} from '@editor-platform/design/page-proposals';
import type { DesignContent } from '@editor-platform/design/model';
import type { EditorCommand } from '@editor-platform/editor-core';
import { anchorState, createLocalSession, type Content } from '../model';
import { makeMangaArtifact, saveNewManga } from './manga-workspace';
import { storage, openStoredRecord } from './records';
import { readImportFiles } from './import-artifact';

const references = () =>
  new ReferenceResolver(
    {
      list: async () => [],
      subscribe: () => () => {},
      read: async () => {
        throw Error('No external references');
      },
    },
    nativeReferenceAdapters,
  );
const linked = (d: DesignContent) =>
  designDivisionCommand({
    type: 'startDivision',
    pageId: d.pagination!.pages[0].frameId,
    region: { x: 30, y: 30, width: 540, height: 740 },
    root: { panelId: 'panel' },
  }).apply(d);

it('creates atomically, retries the same request and refuses same-ID different options', async () => {
  const a = makeMangaArtifact({ landscape: false, direction: 'rtl' });
  expect(a.kind).toBe('design');
  expect((a.draft.content as DesignContent).schemaVersion).toBe(2);
  const fail = vi.spyOn(storage, 'putIfAbsent').mockRejectedValueOnce(Error('storage unavailable'));
  await expect(saveNewManga(a)).rejects.toThrow('storage unavailable');
  fail.mockRestore();
  const [first, second] = await Promise.all([saveNewManga(a), saveNewManga(a)]);
  expect(first).toEqual(a);
  expect(second).toEqual(a);
  await expect(saveNewManga({ ...a, name: 'different request' })).rejects.toThrow(
    /different input/,
  );
  expect(await storage.get(a.id)).toEqual(a);
});

it('round-trips linked panels and immutable old versions, rejecting malformed or tampered retained versions', async () => {
  const a = makeMangaArtifact({ landscape: false, direction: 'rtl' });
  const first = await commitVersion(a, null, 'rectangles');
  const content = linked(first.draft.content as DesignContent);
  const saved = {
    ...(await commitVersion({ ...first, draft: { ...first.draft, content } }, null, 'linked')),
    annotations: [],
  };
  const [imported] = await readImportFiles(
    [new File([serializeArtifact(saved)], 'comic.json', { type: 'application/json' })],
    { exists: () => false, references: references() },
  );
  expect(imported.draft.content).toEqual(content);
  expect(imported.id).not.toBe(saved.id);
  expect(imported.versions).toEqual(saved.versions.map((v) => ({ ...v, artifactId: imported.id })));
  expect((await openStoredRecord(saved, references())).content).toEqual(content);
  const bad = clone(saved);
  (bad.versions[0].content as DesignContent).elements[0].name = 'tampered';
  await expect(openStoredRecord(bad, references())).rejects.toThrow(/hash mismatch/);
  await expect(
    readImportFiles(
      [new File([serializeArtifact(bad)], 'tampered.json', { type: 'application/json' })],
      { exists: () => false, references: references() },
    ),
  ).rejects.toThrow();
  const invalid = clone(saved);
  (invalid.versions[1].content as DesignContent).elements.find((e) => e.id === 'panel')!.bounds.x +=
    1;
  await expect(openStoredRecord(invalid, references())).rejects.toThrow(/Invalid stored version/);
});

it('normal Host adopts only prepared page transactions with paths and checks current authority', () => {
  const a = makeMangaArtifact({ landscape: false, direction: 'rtl' }),
    content = insertDesignPagePath('panel', 'cubic', {
      x: 40,
      y: 60,
      width: 100,
      height: 80,
    }).apply(linked(a.draft.content as DesignContent));
  const session = createLocalSession(content);
  let readOnly = false;
  const current = () => ({
    artifactId: a.id,
    versionId: null,
    revision: session.revision,
    content: session.content as DesignContent,
    readOnly,
  });
  const request: DesignPageProposalRequest = {
    id: 'proposal',
    artifactId: a.id,
    summary: 'Split the opening panel',
    baseLocalRevision: session.revision,
    reads: { target: { artifactId: a.id, versionId: null }, references: [] },
    units: [
      {
        id: 'split',
        label: 'Split',
        requires: [],
        operations: [
          {
            type: 'splitPanel',
            pageId: content.pagination!.pages[0].frameId,
            panelId: 'panel',
            newPanelId: 'second',
            dividerId: 'cut',
            line: { nx: 0, ny: 1, offset: 300 },
            gap: 16,
            retain: 'a',
            insert: 'after',
          },
        ],
      },
    ],
  };
  const plan = prepareDesignPageProposal(current(), request, ['split'], 'reviewed');
  const cmd = designPageProposalCommand(plan, current) as EditorCommand<Content>;
  expect(() => session.execute({ ...cmd })).toThrow(/not supported/);
  readOnly = true;
  expect(() => session.execute(cmd)).toThrow(/writable/);
  expect(session.content).toEqual(content);
  readOnly = false;
  session.execute(cmd);
  expect(session.content).toEqual(plan.after);
  session.undo();
  expect(session.content).toEqual(content);
  expect(() => session.execute(cmd)).toThrow(/draft changed/);
});

it('tracks stable manga comment anchors through merge, Undo and an immutable saved source', async () => {
  const artifact = makeMangaArtifact({ landscape: false, direction: 'rtl' }),
    content = linked(artifact.draft.content as DesignContent),
    pageId = content.pagination!.pages[0].frameId;
  const split = designDivisionCommand({
    type: 'splitPanel',
    pageId,
    panelId: 'panel',
    newPanelId: 'second',
    dividerId: 'cut',
    line: { nx: 0, ny: 1, offset: 400 },
    gap: 16,
    retain: 'a',
    insert: 'after',
  }).apply(content);
  const saved = await commitVersion(
    { ...artifact, draft: { ...artifact.draft, content: split } },
    null,
    'Two panels',
  );
  const session = createLocalSession(split),
    kept = { artifactId: artifact.id, elementId: 'panel' },
    removed = { artifactId: artifact.id, elementId: 'second' };
  expect(anchorState(session.content, removed)).toBe('Current');
  session.execute(
    designDivisionCommand({
      type: 'mergePanels',
      pageId,
      dividerId: 'cut',
      retainPanelId: 'panel',
    }) as EditorCommand<Content>,
  );
  expect(anchorState(session.content, kept)).toBe('Current');
  expect(anchorState(session.content, removed)).toBe('Orphan');
  expect(anchorState(saved.versions[0].content, removed)).toBe('Current');
  session.undo();
  expect(anchorState(session.content, removed)).toBe('Current');
  session.redo();
  expect(anchorState(session.content, removed)).toBe('Orphan');
});
