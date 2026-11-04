import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { clone, MemoryStorage, type Artifact } from '@editor-platform/artifact-core';
import { documentTextEditCommand } from '@editor-platform/document/text';
import { updateElement, updateComponentPart, insertElement } from '@editor-platform/design/model';
import { insertDesignPage, insertDesignPanel } from '@editor-platform/design/pagination';
import { CreativeHost } from '../host';
import type { DocumentContent } from '@editor-platform/document/model';
import { createHarborWorkspace } from './fixture';
import { CreativeWorkspace, readWorkspaceLinks, type CreativeWorkspaceStorage } from './model';

async function fixture() {
  const artifacts = new MemoryStorage<Artifact<unknown>>();
  let links: unknown;
  const maps: Record<string, unknown> = {};
  const access = { write: true, blocked: '' };
  let fail = false;
  const io: CreativeWorkspaceStorage = {
    artifacts,
    creative: (mode) => ({
      artifacts,
      readMapping: async () => clone(maps[mode]),
      writeMapping: async (value) => {
        maps[mode] = clone(value);
      },
    }),
    readLinks: async () => clone(links),
    writeLinks: async (value) => {
      if (fail) throw Error('write failure');
      links = clone(value);
    },
  };
  const w = await createHarborWorkspace(io, () => access.write);
  return {
    w,
    io,
    artifacts,
    access,
    maps,
    setFail: (v: boolean) => {
      fail = v;
    },
    open: () =>
      CreativeWorkspace.open(
        io,
        () => access.write,
        (id) => id !== access.blocked,
      ),
  };
}
const bangs = {
  instanceId: 'instance-candidate-1',
  componentId: 'component-character',
  elementId: 'hair-front',
};
describe('Creative D3a reference contract', () => {
  it('creates one native source per role, shared references across scenes and idempotent retained artifacts', async () => {
    const { w, io, artifacts, open } = await fixture();
    expect((await artifacts.list()).filter((a) => a.kind === 'data')).toHaveLength(1);
    expect(w.mapping.scenes).toHaveLength(3);
    expect(w.item('SC-01', 'character', 'CH-01')).toEqual(w.item('SC-02', 'character', 'CH-01'));
    expect(w.item('SC-01', 'setting', 'LO-02')).toEqual(w.item('SC-03', 'setting', 'LO-02'));
    const before = await artifacts.list();
    await createHarborWorkspace(io);
    expect(await artifacts.list()).toEqual(before);
    expect((await open()).mapping).toEqual(w.mapping);
    expect(JSON.stringify(w.mapping)).not.toContain('美緒');
    expect(JSON.stringify(w.mapping)).not.toContain('潮見');
  });
  it('keeps exact pins after editing/saving; explicit update changes only the requested scene reference', async () => {
    const { w, open } = await fixture();
    const old = w.item('SC-01', 'character', 'CH-01');
    const original = await w.readReference('SC-01', 'character', 'CH-01');
    const p = w.characters,
      c = p.cards[0],
      e = p.editor(c)!;
    p.execute(c, updateComponentPart('component-character', 'hair-front', { fill: '#123456' }));
    e.undo();
    e.redo();
    await p.save();
    expect((await w.readReference('SC-01', 'character', 'CH-01')).state).toBe('stale');
    expect((await w.readReference('SC-01', 'character', 'CH-01')).artworkContent).toEqual(
      original.artworkContent,
    );
    await w.refreshReference('SC-01', 'character', 'CH-01', old);
    expect((await w.readReference('SC-01', 'character', 'CH-01')).state).toBe('current');
    expect(w.item('SC-02', 'character', 'CH-01')).toEqual(old);
    const loaded = await open();
    expect(loaded.mapping).toEqual(w.mapping);
    expect((await loaded.readReference('SC-02', 'character', 'CH-01')).state).toBe('stale');
  });
  it('retains original source identity and source data after crossing Novel/Comic into a location', async () => {
    const { w, artifacts } = await fixture();
    const p = w.settings,
      c = p.cards.find((c) => c.id === 'LO-02')!,
      before = p.source.content;
    await w.openScene('SC-03');
    await w.captureReturn('SC-03');
    const target = await w.editTarget('SC-03', 'setting', 'LO-02');
    expect(target.source.id).toBe(p.source.id);
    target
      .editor(c)!
      .execute(updateComponentPart('component-setting', 'roof', { fill: '#59687d' }));
    await target.save();
    expect(target.source.content).toEqual(before);
    expect((await w.returnToScene()).scene.id).toBe('SC-03');
    expect((await artifacts.list()).filter((a) => a.name === '世界の覚え書き')).toHaveLength(1);
  });
  it('restores exact selection and rejects changed/deleted return elements and missing versions without guessing', async () => {
    const { w, artifacts } = await fixture();
    const scene = w.scene('SC-01'),
      e = await w.openScene('SC-01');
    const address = {
      artifactId: e.id,
      elementId: 'port-text',
      region: { type: 'text' as const, start: 1, end: 3 },
    };
    e.select({ addresses: [address] });
    await w.captureReturn('SC-01');
    expect((await w.returnToScene()).address).toEqual(address);
    e.execute(
      documentTextEditCommand(e.content as DocumentContent, [
        { segmentId: 'port-text', start: 0, end: 0, expected: '', text: '編集' },
      ]) as never,
    );
    await expect(w.returnToScene()).rejects.toThrow(/変わって/);
    e.undo();
    expect((await w.returnToScene()).address).toEqual(address);
    const a = (await artifacts.get(scene.origin.artifactId))!;
    a.versions = a.versions.filter((v) => v.versionId !== scene.origin.versionId);
    await artifacts.put(a);
    await expect(w.returnToScene()).rejects.toThrow(/exact version/);
  });
  it('does not navigate away from unsaved manuscript buffers or silently restore removed scenes', async () => {
    const { w, artifacts } = await fixture();
    const e = await w.openScene('SC-03');
    e.execute(updateElement('comic-dialogue', { text: '編集中' }) as never);
    await expect(w.captureReturn('SC-03')).rejects.toThrow(/保存/);
    e.undo();
    await w.captureReturn('SC-03');
    const a = (await artifacts.get(e.id))!;
    const d = a.draft.content as { elements: { id: string }[] };
    d.elements = d.elements.filter((x) => x.id !== 'page-port');
    await artifacts.put(a);
    await expect(w.returnToScene()).rejects.toThrow();
    expect(w.mapping.returnTo?.address.elementId).toBe('page-port');
  });
  it('reports missing, forbidden, corrupted and wrong-version references with no canonical writes', async () => {
    const f = await fixture();
    const w = await f.open(),
      ref = w.item('SC-01', 'character', 'CH-01');
    f.access.blocked = ref.artwork.artifactId;
    expect((await w.readReference('SC-01', 'character', 'CH-01')).state).toBe('forbidden');
    f.access.blocked = '';
    const original = (await f.artifacts.get(ref.artwork.artifactId))!;
    await f.artifacts.remove(original.id);
    expect((await w.readReference('SC-01', 'character', 'CH-01')).state).toBe('missing');
    await expect(w.editTarget('SC-01', 'character', 'CH-01')).rejects.toThrow(/欠落/);
    await f.artifacts.put(original);
    const corrupt = clone(original);
    (corrupt.versions[0].content as { schemaVersion: number }).schemaVersion = 999;
    await f.artifacts.put(corrupt);
    expect((await w.readReference('SC-01', 'character', 'CH-01')).state).toBe('invalid');
    expect(w.item('SC-01', 'character', 'CH-01')).toEqual(ref);
  });
  it('uses qualified AI preview/apply/reject; rejects outside scopes, locks, stale, permission and unauthorized shared edits', async () => {
    const { w, access } = await fixture();
    const p = w.characters,
      e = p.editor(p.cards[0])!,
      before = e.content;
    const proposal = await w.proposePart(
      'SC-01',
      'character',
      'CH-01',
      [{ address: bangs, patch: { opacity: 0.4 } }],
      [bangs],
      { baseLocalRevision: w.characters.editor(w.characters.cards[0])!.revision },
    );
    expect(e.content).toEqual(before);
    proposal.reject();
    expect(e.content).toEqual(before);
    const apply = await w.proposePart(
      'SC-01',
      'character',
      'CH-01',
      [{ address: bangs, patch: { opacity: 0.4 } }],
      [bangs],
      { baseLocalRevision: w.characters.editor(w.characters.cards[0])!.revision },
    );
    await apply.apply();
    expect(e.content).not.toEqual(before);
    e.undo();
    expect(e.content).toEqual(before);
    e.redo();
    e.undo();
    const stale = await w.proposePart(
      'SC-01',
      'character',
      'CH-01',
      [{ address: bangs, patch: { opacity: 0.3 } }],
      [bangs],
      { baseLocalRevision: w.characters.editor(w.characters.cards[0])!.revision },
    );
    e.execute(updateComponentPart('component-character', 'eyes', { fill: '#345678' }));
    await expect(stale.apply()).rejects.toThrow();
    e.undo();
    await expect(
      w.proposePart(
        'SC-01',
        'character',
        'CH-01',
        [
          {
            address: { componentId: 'component-character', elementId: 'eyes' },
            patch: { fill: '#123456' },
          },
        ],
        [bangs],
        { baseLocalRevision: w.characters.editor(w.characters.cards[0])!.revision },
      ),
    ).rejects.toThrow(/明示的/);
    await expect(
      w.proposePart(
        'SC-01',
        'character',
        'CH-01',
        [{ address: { ...bangs, elementId: 'eyes' }, patch: { fill: '#123456' } }],
        [bangs],
        { baseLocalRevision: w.characters.editor(w.characters.cards[0])!.revision },
      ),
    ).rejects.toThrow();
    e.execute(updateComponentPart('component-character', 'hair-front', { locked: true }));
    await expect(
      w.proposePart(
        'SC-01',
        'character',
        'CH-01',
        [{ address: bangs, patch: { opacity: 0.2 } }],
        [bangs],
        { baseLocalRevision: w.characters.editor(w.characters.cards[0])!.revision },
      ),
    ).rejects.toThrow();
    e.undo();
    const revoked = await w.proposePart(
      'SC-01',
      'character',
      'CH-01',
      [{ address: bangs, patch: { opacity: 0.3 } }],
      [bangs],
      { baseLocalRevision: w.characters.editor(w.characters.cards[0])!.revision },
    );
    access.write = false;
    await expect(revoked.apply()).rejects.toThrow();
    expect(e.content).toEqual(before);
  });
  it('keeps source and manuscript unchanged through AI and refuses source changes between preview and apply', async () => {
    const { w } = await fixture();
    const original = w.characters.source.content;
    const story = (await w.openScene('SC-01')).content;
    const proposal = await w.proposePart(
      'SC-01',
      'character',
      'CH-01',
      [{ address: bangs, patch: { opacity: 0.2 } }],
      [bangs],
      { baseLocalRevision: w.characters.editor(w.characters.cards[0])!.revision },
    );
    const card = w.characters.cards[0];
    const field = card.fields.find((f) => f.label === '名前')!;
    w.characters.source.execute(characterEdit(w, card.id, field.id, '澪'));
    await expect(proposal.apply()).rejects.toThrow();
    expect((await w.openScene('SC-01')).content).toEqual(story);
    w.characters.source.undo();
    expect(w.characters.source.content).toEqual(original);
  });
  it('keeps failed mapping writes retryable and rejects invalid metadata or copied prose', async () => {
    const f = await fixture();
    await f.w.characters.save({ reuseSavedVersions: false });
    const old = f.w.item('SC-01', 'character', 'CH-01');
    f.setFail(true);
    await expect(f.w.refreshReference('SC-01', 'character', 'CH-01', old)).rejects.toThrow(
      /write failure/,
    );
    expect(f.w.item('SC-01', 'character', 'CH-01')).toEqual(old);
    f.setFail(false);
    await f.w.refreshReference('SC-01', 'character', 'CH-01', old);
    expect(() => readWorkspaceLinks({ ...f.w.mapping, body: 'duplicate source' })).toThrow();
    expect(() => readWorkspaceLinks({ ...f.w.mapping, scenes: [null] })).toThrow();
    const raw = f.w.mapping;
    raw.scenes[0].items[0].source.versionId = 'absent';
    const bad = new CreativeWorkspace(f.io, raw, f.w.characters, f.w.settings);
    expect((await bad.readReference('SC-01', 'character', 'CH-01')).state).toBe('missing');
  });
  it('does not create missing role mappings and keeps readonly navigation non-mutating', async () => {
    const f = await fixture();
    const before = await f.artifacts.list();
    f.access.write = false;
    const w = await f.open();
    const links = w.mapping;
    await w.captureReturn('SC-01');
    expect(await f.io.readLinks()).toEqual(links);
    await expect(
      w.refreshReference('SC-01', 'character', 'CH-01', w.item('SC-01', 'character', 'CH-01')),
    ).rejects.toThrow(/閲覧/);
    await expect(w.saveScene('SC-01')).rejects.toThrow();
    expect(await f.artifacts.list()).toEqual(before);
    f.maps.character = undefined;
    const unavailable = await f.open();
    await expect(unavailable.editTarget('SC-01', 'character', 'CH-01')).rejects.toThrow(
      /正本の対応表/,
    );
    expect(await f.artifacts.list()).toEqual(before);
  });
  it('reloads clean external Creative saves only on explicit access and never retargets a pin silently', async () => {
    const f = await fixture();
    const remote = await f.open();
    const e = remote.settings.editor(remote.settings.cards[1])!;
    e.execute(updateComponentPart('component-setting', 'roof', { fill: '#778899' }));
    await remote.settings.save();
    const old = f.w.item('SC-01', 'setting', 'LO-02');
    expect((await f.w.readReference('SC-01', 'setting', 'LO-02')).state).toBe('stale');
    await f.w.refreshReference('SC-01', 'setting', 'LO-02', old);
    expect((await f.w.readReference('SC-01', 'setting', 'LO-02')).state).toBe('current');
    expect(f.w.item('SC-03', 'setting', 'LO-02')).toEqual(old);
  });
});
function characterEdit(w: CreativeWorkspace, id: string, field: string, value: string) {
  const p = w.characters;
  const c = p.cards.find((c) => c.id === id)!;
  return p.mode.edit(p.source.content, c, field, value);
}

it('retries Scene metadata failure after a native save without overwriting an externally newer manuscript', async () => {
  const f = await fixture(),
    e = await f.w.openScene('SC-01');
  e.execute(
    documentTextEditCommand(e.content as DocumentContent, [
      { segmentId: 'port-text', start: 0, end: 0, expected: '', text: '続き。' },
    ]) as never,
  );
  f.setFail(true);
  await expect(f.w.saveScene('SC-01')).rejects.toThrow(/write failure/);
  f.setFail(false);
  await f.w.saveScene('SC-01');
  expect(await f.w.returnToScene().catch(() => null)).toBeNull();
  expect((await f.open()).scene('SC-01').origin.versionId).toBe(e.artifact.draft.baseVersionId);
});

it('rejects a stale client calculation revision and leaves source/manuscript untouched', async () => {
  const { w } = await fixture();
  const working = await w.readWorkingTarget('SC-01', 'character', 'CH-01');
  const e = w.characters.editor(w.characters.cards[0])!;
  e.execute(updateComponentPart('component-character', 'eyes', { fill: '#456789' }));
  await expect(
    w.proposePart(
      'SC-01',
      'character',
      'CH-01',
      [{ address: bangs, patch: { opacity: 0.5 } }],
      [bangs],
      { baseLocalRevision: working.baseLocalRevision },
    ),
  ).rejects.toThrow(/revision/);
  expect(e.proposals).toHaveLength(0);
  expect(w.characters.source.content).toEqual(working.source);
});
it('keeps the manuscript usable when a creative artifact is missing after reload', async () => {
  const f = await fixture();
  await f.w.characters.save();
  const old = f.w.item('SC-01', 'character', 'CH-01');
  await f.artifacts.remove(old.artwork.artifactId);
  const opened = await f.open();
  expect(opened.modeAvailable('character')).toBe(false);
  expect(opened.modeProblem('character')).toContain('設定画');
  expect((await opened.readReference('SC-01', 'character', 'CH-01')).state).toBe('missing');
  expect((await opened.readReference('SC-01', 'character', 'CH-02')).state).toBe('current');
  expect(await opened.openScene('SC-01')).toBeDefined();
});

it('requires trusted shared permission in addition to an AI request and rechecks it on apply', async () => {
  const f = await fixture();
  let allowed = false;
  const w = new CreativeWorkspace(
    f.io,
    f.w.mapping,
    f.w.characters,
    f.w.settings,
    () => true,
    () => true,
    () => allowed,
  );
  const e = w.characters.editor(w.characters.cards[0])!,
    a = { componentId: 'component-character', elementId: 'eyes' },
    before = e.content;
  await expect(
    w.proposePart(
      'SC-01',
      'character',
      'CH-01',
      [{ address: a, patch: { fill: '#123456' } }],
      [a],
      { baseLocalRevision: e.revision, allowShared: true },
    ),
  ).rejects.toThrow(/明示的/);
  allowed = true;
  const p = await w.proposePart(
    'SC-01',
    'character',
    'CH-01',
    [{ address: a, patch: { fill: '#123456' } }],
    [a],
    { baseLocalRevision: e.revision, allowShared: true },
  );
  allowed = false;
  await expect(p.apply()).rejects.toThrow(/権限/);
  expect(e.content).toEqual(before);
});
it('rejects a saved draft changed externally and rejects invalid captured selection without fallback', async () => {
  const f = await fixture(),
    e = await f.w.openScene('SC-01');
  e.select({ addresses: [{ artifactId: e.id, elementId: 'deleted-selection' }] });
  await expect(f.w.captureReturn('SC-01')).rejects.toThrow(/推測/);
  expect(f.w.mapping.returnTo).toBeUndefined();
  const a = (await f.artifacts.get(e.id))!;
  const d = a.draft.content as DocumentContent;
  d.blocks[1].text += '外部変更';
  await f.artifacts.put(a);
  await expect(f.w.openScene('SC-01')).rejects.toThrow(/外部/);
  await expect(f.w.saveScene('SC-01')).rejects.toThrow(/外部/);
  expect((await f.artifacts.get(e.id))!.draft.content).toEqual(d);
});

it('rejects external Creative draft writes both before proposal and between preview/apply', async () => {
  const f = await fixture(),
    w = f.w;
  const working = await w.readWorkingTarget('SC-01', 'character', 'CH-01');
  const e = w.characters.editor(w.characters.cards[0])!,
    before = e.content;
  const proposal = await w.proposePart(
    'SC-01',
    'character',
    'CH-01',
    [{ address: bangs, patch: { opacity: 0.5 } }],
    [bangs],
    { baseLocalRevision: working.baseLocalRevision },
  );
  const artifact = (await f.artifacts.get(e.id))!;
  artifact.draft.content = updateComponentPart('component-character', 'eyes', {
    fill: '#abcdef',
  }).apply(e.content);
  await f.artifacts.put(artifact);
  await expect(proposal.apply()).rejects.toThrow(/外部/);
  await expect(w.readWorkingTarget('SC-01', 'character', 'CH-01')).rejects.toThrow(/外部/);
  await expect(
    w.proposePart(
      'SC-01',
      'character',
      'CH-01',
      [{ address: bangs, patch: { opacity: 0.5 } }],
      [bangs],
      { baseLocalRevision: e.revision },
    ),
  ).rejects.toThrow(/外部/);
  expect(e.content).toEqual(before);
  expect((await f.artifacts.get(e.id))!.draft.content).toEqual(artifact.draft.content);
});

it('rejects explicit malformed optional return tickets', async () => {
  const { w } = await fixture();
  for (const value of [null, false, '', 0])
    expect(() => readWorkspaceLinks({ ...w.mapping, returnTo: value })).toThrow(/戻り先/);
});

it('reconciles completed return tickets with the current saved selection and drops invalid ones', async () => {
  const f = await fixture(),
    e = await f.w.openScene('SC-01');
  e.select({
    addresses: [
      { artifactId: e.id, elementId: 'port-text', region: { type: 'text', start: 0, end: 1 } },
    ],
  });
  await f.w.captureReturn('SC-01');
  await f.w.returnToScene();
  const old = f.w.mapping.returnTo!;
  e.execute(
    documentTextEditCommand(e.content as DocumentContent, [
      { segmentId: 'port-text', start: 0, end: 0, expected: '', text: '朝。' },
    ]) as never,
  );
  const address = {
    artifactId: e.id,
    elementId: 'port-text',
    region: { type: 'text' as const, start: 2, end: 3 },
  };
  e.select({ addresses: [address] });
  await f.w.saveScene('SC-01');
  expect(f.w.mapping.returnTo!.versionId).not.toBe(old.versionId);
  expect((await (await f.open()).returnToScene()).address).toEqual(address);
  e.select({ addresses: [{ artifactId: e.id, elementId: 'removed' }] });
  await f.w.saveScene('SC-01');
  expect(f.w.mapping.returnTo).toBeUndefined();
});

it('never loads forbidden artwork into a Creative role and hides cached content after read revocation', async () => {
  const f = await fixture(),
    forbidden = f.w.item('SC-01', 'character', 'CH-02').artwork.artifactId;
  f.access.blocked = forbidden;
  const get = vi.spyOn(f.artifacts, 'get');
  const denied = await f.open();
  expect(denied.modeAvailable('character')).toBe(false);
  expect(denied.modeProblem('character')).toMatch(/権限/);
  expect(get.mock.calls.some(([id]) => id === forbidden)).toBe(false);
  expect((await denied.openScene('SC-01')).id).toBe('d3a:novel');
  f.access.blocked = '';
  const w = await f.open(),
    p = w.characters,
    e = p.editor(p.cards[0])!;
  expect(w.canReadMode('character')).toBe(true);
  f.access.blocked = forbidden;
  expect(w.canReadMode('character')).toBe(false);
  await expect(w.readWorkingTarget('SC-01', 'character', 'CH-01')).rejects.toThrow(/権限/);
  expect(() =>
    e.execute(updateComponentPart('component-character', 'eyes', { fill: '#123456' })),
  ).toThrow();
  const worldContext = vi.fn(() => 'private reference selection');
  const html = renderToStaticMarkup(
    createElement(CreativeHost, {
      project: p,
      canRead: () => w.canReadMode('character'),
      worldContext,
    }),
  );
  expect(html).toContain('参照権限がありません');
  expect(html).not.toContain('creative-canvas');
  expect(html).not.toContain('data:image');
  expect(worldContext).not.toHaveBeenCalled();
});

it('resolves newly created comic descendants to their native page Scene and rejects ambiguous membership', async () => {
  const f = await fixture(),
    e = await f.w.openScene('SC-03');
  e.execute(insertDesignPage({ x: 650, y: 0, width: 600, height: 800 }, 'page-house') as never);
  e.execute(
    insertDesignPanel(
      'page-house',
      { x: 670, y: 20, width: 560, height: 750 },
      'panel-house',
    ) as never,
  );
  await f.w.saveScene('SC-03');
  const links = f.w.mapping;
  links.scenes.push({
    ...f.w.scene('SC-03'),
    id: 'SC-04',
    origin: { ...f.w.scene('SC-03').origin, elementId: 'page-house' },
    members: [],
  });
  await f.io.writeLinks(links);
  const w = await f.open(),
    comic = await w.openScene('SC-03');
  comic.execute(
    insertElement('text', {
      id: 'new-dialogue',
      parentId: 'panel-house',
      bounds: { x: 700, y: 50, width: 200, height: 50 },
    }) as never,
  );
  const address = { artifactId: comic.id, elementId: 'new-dialogue' };
  expect(w.sceneForAddress(address)!.id).toBe('SC-04');
  comic.select({ addresses: [address] });
  await w.saveScene('SC-04');
  await w.captureReturn('SC-04');
  expect((await w.returnToScene()).address).toEqual(address);
  const ambiguous = w.mapping;
  ambiguous.scenes[2].members.push('new-dialogue');
  const other = new CreativeWorkspace(f.io, ambiguous, w.characters, w.settings);
  await other.openScene('SC-03');
  expect(() => other.sceneForAddress(address)).toThrow(/曖昧/);
});
