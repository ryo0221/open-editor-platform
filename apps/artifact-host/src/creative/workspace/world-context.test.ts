import * as worldReferenceApi from './world-context';
import { describe, it, expect, vi } from 'vitest';
import {
  clone,
  canonicalJson,
  MemoryStorage,
  createArtifact,
  commitVersion,
  type Artifact,
} from '@editor-platform/artifact-core';
import { prepareCreativeLayerGeneration } from '../generation';
import { updateElement, deleteElements } from '@editor-platform/design/model';
import { createDocument, deleteBlock, updateBlock } from '@editor-platform/document/model';
import { documentTextEditCommand } from '@editor-platform/document/text';
import { createHarborWorkspace } from './fixture';
import { CreativeWorkspace, readWorkspaceLinks, type CreativeWorkspaceStorage } from './model';
import {
  readWorldContexts,
  assertWorldGenerationAvailable,
  type WorldReference,
} from './world-context';
async function fixture() {
  const artifacts = new MemoryStorage<Artifact<unknown>>();
  let links: unknown;
  const maps: Record<string, unknown> = {};
  const access = { write: true, read: true };
  const io: CreativeWorkspaceStorage = {
    artifacts,
    creative: (mode) => ({
      artifacts,
      readMapping: async () => clone(maps[mode]),
      writeMapping: async (v) => {
        maps[mode] = clone(v);
      },
    }),
    readLinks: async () => clone(links),
    writeLinks: async (v, expected) => {
      if (expected && canonicalJson(expected) !== canonicalJson(links)) throw Error('conflict');
      links = clone(v);
    },
  };
  await createHarborWorkspace(io);
  const doc = createDocument();
  doc.blocks = [{ id: 'facts', type: 'paragraph', text: 'same name CH-01 / LO-01' }];
  const a = await commitVersion(
    { ...createArtifact('document', 'world', doc), id: 'work-a:facts' },
    null,
    'fixture',
  );
  await artifacts.put(a);
  const r: WorldReference = {
    id: 'facts',
    role: 'facts',
    namespace: 'work-a',
    artifactId: a.id,
    versionId: a.versions[0].versionId,
    contentHash: a.versions[0].contentHash,
    selector: { type: 'document-blocks', blockIds: ['facts'] },
    required: true,
  };
  const next = readWorkspaceLinks(links);
  next.world = {
    namespace: 'work-a',
    contexts: [
      { id: 'work', revision: 0, references: [r] },
      { id: 'SC-02', revision: 0, references: [clone(r)] },
    ],
  };
  await io.writeLinks(next);
  const open = () =>
    CreativeWorkspace.open(
      io,
      () => access.write,
      () => access.read,
    );
  return { io, a, r, access, artifacts, open, w: await open() };
}
async function manuscriptFixture() {
  const f = await fixture(),
    scene = f.w.scene('SC-01');
  const a = (await f.artifacts.get(scene.origin.artifactId))!;
  const v = a.versions.find((v) => v.versionId === scene.origin.versionId)!;
  const ref: WorldReference = {
    ...f.r,
    artifactId: a.id,
    versionId: v.versionId,
    contentHash: v.contentHash,
    selector: { type: 'document-blocks', blockIds: ['port-text'] },
  };
  await f.w.saveWorldContext({ id: 'work', revision: 0, references: [ref] }, 0);
  const e = await f.w.openScene(scene.id);
  e.select({ addresses: [{ artifactId: e.id, elementId: 'port-text' }] });
  await f.w.captureReturn(scene.id);
  expect(await f.w.openWorldSource(ref)).toBe(e);
  const edit = () =>
    e.execute(
      documentTextEditCommand(e.content as never, [
        { segmentId: 'port-text', start: 0, end: 0, expected: '', text: '朝。' },
      ]) as never,
    );
  return { ...f, e, ref, edit };
}
describe('CW1 adopted world references', () => {
  for (const mode of ['character', 'setting'] as const)
    it(`rejects a ${mode} sample save that deletes its chosen candidate before any native write`, async () => {
      const { w, artifacts, r, open } = await fixture(),
        p = w.project(mode);
      const b = p.binding(p.cards[0])!,
        a = (await artifacts.get(b.design.artifactId))!;
      const v = a.versions.find((v) => v.versionId === b.design.versionId)!;
      const e = await w.openWorldSource({
        ...r,
        role: 'sample',
        artifactId: a.id,
        versionId: v.versionId,
        contentHash: v.contentHash,
        selector: { type: 'design-frame', frameId: b.chosenFrameId },
      });
      const world = w.mapping.world;
      e.execute(deleteElements([b.chosenFrameId]) as never);
      await expect(w.saveWorldSource(e.id)).rejects.toThrow('正本または選択候補');
      expect(e.snapshot.dirty).toBe(true);
      expect(await artifacts.get(a.id)).toEqual(a);
      expect((await open()).modeAvailable(mode)).toBe(true);
      expect(w.mapping.world).toEqual(world);
    });
  it('rejects a project-owned material save that deletes a bound LO before any native write', async () => {
    const { w, artifacts, r, open } = await fixture(),
      p = w.settings;
    const a = (await artifacts.get(p.source.id))!,
      v = a.versions.at(-1)!;
    const heading = p.cards[0].elementId;
    const ref: WorldReference = {
      ...r,
      artifactId: a.id,
      versionId: v.versionId,
      contentHash: v.contentHash,
      selector: { type: 'document-blocks', blockIds: [heading] },
    };
    const e = await w.openWorldSource(ref),
      world = w.mapping.world;
    e.execute(deleteBlock(heading) as never);
    await expect(w.saveWorldSource(e.id)).rejects.toThrow('正本または選択候補');
    expect(e.snapshot.dirty).toBe(true);
    expect(await artifacts.get(a.id)).toEqual(a);
    expect((await open()).modeAvailable('setting')).toBe(true);
    expect(w.mapping.world).toEqual(world);
    e.undo();
    e.execute(
      updateBlock(heading, {
        text: p.source.content.blocks.find((b) => b.id === heading)!.text + '（修正）',
      }) as never,
    );
    await w.saveWorldSource(e.id);
    expect((await open()).modeAvailable('setting')).toBe(true);
    expect(w.mapping.world).toEqual(world);
  });
  it('projects the adopted rich spans readers see, retaining old exact content until explicit adoption', async () => {
    const { w, a, r, artifacts, open } = await fixture();
    const e = await w.openWorldSource(r);
    e.execute(updateBlock('facts', { rich: [{ text: '読者が見る新事実', bold: true }] }) as never);
    await w.saveWorldSource(e.id);
    const saved = (await artifacts.get(a.id))!,
      version = saved.versions.at(-1)!;
    const old = (await w.readWorld('work'))[0];
    expect(old.text).toBe('same name CH-01 / LO-01');
    expect(old.state).toBe('stale');
    await w.saveWorldContext(
      {
        id: 'work',
        revision: 0,
        references: [{ ...r, versionId: version.versionId, contentHash: version.contentHash }],
      },
      0,
    );
    expect((await w.readWorld('work'))[0].text).toBe('読者が見る新事実');
    expect((await (await open()).readWorld('work'))[0].text).toBe('読者が見る新事実');
    expect(saved.versions[0]).toEqual(a.versions[0]);
  });
  it('does not restore an old return selection after a newer selection during delayed reading', async () => {
    const { w, io } = await fixture(),
      e = await w.openScene('SC-01');
    await w.captureReturn('SC-01');
    const get = io.artifacts.get.bind(io.artifacts);
    let release!: () => void, started!: () => void;
    const begun = new Promise<void>((r) => {
      started = r;
    });
    let first = true;
    io.artifacts.get = async (id) => {
      if (first) {
        first = false;
        started();
        await new Promise<void>((r) => {
          release = r;
        });
      }
      return get(id);
    };
    const pending = w.returnToScene();
    await begun;
    e.select({ addresses: [{ artifactId: e.id, elementId: 'port-text' }] });
    const selection = e.snapshot.selection;
    release();
    await expect(pending).rejects.toThrow('選択');
    expect(e.snapshot.selection).toEqual(selection);
  });
  it('replaces the viewer return only after an author capture succeeds, including failure and retry', async () => {
    const { w, io, access } = await fixture();
    access.write = false;
    await w.captureReturn('SC-01');
    const old = w.mapping.returnTo;
    expect(readWorkspaceLinks(await io.readLinks()).returnTo).toBeUndefined();
    access.write = true;
    const e = await w.openScene('SC-02');
    e.select({ addresses: [{ artifactId: e.id, elementId: 'house-text' }] });
    const write = io.writeLinks;
    io.writeLinks = async () => {
      throw Error('ticket failure');
    };
    await expect(w.captureReturn('SC-02')).rejects.toThrow('ticket failure');
    expect(w.mapping.returnTo).toEqual(old);
    io.writeLinks = write;
    await w.captureReturn('SC-02');
    expect(w.mapping.returnTo).toEqual(readWorkspaceLinks(await io.readLinks()).returnTo);
    expect((await w.returnToScene()).address.elementId).toBe('house-text');
  });
  it('does not let an older author completion erase newer viewer navigation or selection', async () => {
    const { w, io, access } = await fixture();
    access.write = false;
    await w.captureReturn('SC-01');
    access.write = true;
    const e = await w.openScene('SC-02');
    e.select({ addresses: [{ artifactId: e.id, elementId: 'house-text' }] });
    const write = io.writeLinks;
    let release!: () => void, started!: () => void;
    const begun = new Promise<void>((r) => {
      started = r;
    });
    io.writeLinks = async (...args) => {
      started();
      await new Promise<void>((r) => {
        release = r;
      });
      await write(...args);
    };
    const pending = w.captureReturn('SC-02');
    await begun;
    access.write = false;
    const newer = await w.captureReturn('SC-03');
    const comic = await w.openScene('SC-03'),
      selection = comic.snapshot.selection;
    access.write = true;
    release();
    await expect(pending).rejects.toThrow('移動');
    expect(w.mapping.returnTo).toEqual(newer);
    expect(comic.snapshot.selection).toEqual(selection);
    expect((await w.returnToScene()).scene.id).toBe('SC-03');
    io.writeLinks = write;
    await w.captureReturn('SC-03');
    expect(w.mapping.returnTo).toEqual(readWorkspaceLinks(await io.readLinks()).returnTo);
  });
  it('rejects an older delayed capture before it persists over a newer navigation', async () => {
    const { w, io, access } = await fixture(),
      get = io.artifacts.get.bind(io.artifacts);
    access.write = false;
    let release!: () => void, started!: () => void;
    const begun = new Promise<void>((r) => {
      started = r;
    });
    let first = true;
    io.artifacts.get = async (id) => {
      if (first) {
        first = false;
        started();
        await new Promise<void>((r) => {
          release = r;
        });
      }
      return get(id);
    };
    const pending = w.captureReturn('SC-01');
    await begun;
    const newer = await w.captureReturn('SC-03');
    release();
    await expect(pending).rejects.toThrow('移動');
    expect(w.mapping.returnTo).toEqual(newer);
    expect(readWorkspaceLinks(await io.readLinks()).returnTo).toBeUndefined();
  });
  it('saves shared manuscript material and returns to the exact Scene without adopting world pins', async () => {
    const { w, e, edit, open } = await manuscriptFixture(),
      before = w.mapping;
    edit();
    await w.saveWorldSource(e.id);
    expect((await w.returnToScene()).address.elementId).toBe('port-text');
    const reloaded = await open();
    expect((await reloaded.returnToScene()).scene.id).toBe('SC-01');
    expect(w.mapping.world).toEqual(before.world);
    expect(w.scene('SC-03')).toEqual(before.scenes.find((s) => s.id === 'SC-03'));
    expect(w.scene('SC-02').items).toEqual(before.scenes.find((s) => s.id === 'SC-02')!.items);
    expect((await w.readWorld('work'))[0].state).toBe('stale');
  });
  it('retries only the links after manuscript material was saved, including a lost acknowledgment', async () => {
    for (const acknowledged of [false, true]) {
      const { w, io, e, edit, artifacts } = await manuscriptFixture(),
        before = w.mapping;
      edit();
      const write = io.writeLinks;
      io.writeLinks = async (...args) => {
        if (acknowledged) await write(...args);
        throw Error('links failure');
      };
      await expect(w.saveWorldSource(e.id)).rejects.toThrow('links failure');
      const saved = (await artifacts.get(e.id))!;
      expect(e.snapshot.dirty).toBe(false);
      expect(w.mapping).toEqual(before);
      io.writeLinks = write;
      await w.saveWorldSource(e.id);
      expect((await artifacts.get(e.id))!.versions).toEqual(saved.versions);
      expect((await w.returnToScene()).address.elementId).toBe('port-text');
      expect(w.mapping.world).toEqual(before.world);
    }
  });
  it('does not replace a deleted material return with another selected block', async () => {
    const { w, e } = await manuscriptFixture();
    e.execute(deleteBlock('port-text') as never);
    e.select({ addresses: [{ artifactId: e.id, elementId: 'scene-port' }] });
    await w.saveWorldSource(e.id);
    expect(w.mapping.returnTo).toBeUndefined();
    await expect(w.returnToScene()).rejects.toThrow('戻り先');
  });
  it('keeps newer manuscript input and old links when a native save finishes late', async () => {
    const { w, e, edit, artifacts } = await manuscriptFixture(),
      before = w.mapping;
    const put = artifacts.put.bind(artifacts);
    let release!: () => void, started!: () => void;
    const begun = new Promise<void>((r) => {
      started = r;
    });
    artifacts.put = async (a) => {
      started();
      await new Promise<void>((r) => {
        release = r;
      });
      await put(a);
    };
    edit();
    const pending = w.saveWorldSource(e.id);
    await begun;
    edit();
    release();
    await expect(pending).rejects.toThrow('保存中');
    expect(e.snapshot.dirty).toBe(true);
    expect(w.mapping).toEqual(before);
    artifacts.put = put;
    await w.saveWorldSource(e.id);
    expect((await w.returnToScene()).address.elementId).toBe('port-text');
  });
  it('rejects unknown fields/selectors, duplicates, namespace and domain mismatch, accepts 64 and rejects 65 without mutation', async () => {
    const { w, r } = await fixture();
    const world = w.mapping.world!;
    for (const ref of [
      { ...r, body: 'secret' },
      { ...r, namespace: 'other' },
      { ...r, selector: { type: 'jsonpath', path: '$' } },
      { ...r, role: 'sample' },
    ]) {
      expect(() =>
        readWorldContexts({ ...world, contexts: [{ id: 'w', revision: 0, references: [ref] }] }),
      ).toThrow();
    }
    expect(() =>
      readWorldContexts({ ...world, contexts: [{ id: 'w', revision: 0, references: [r, r] }] }),
    ).toThrow();
    const refs = Array.from({ length: 64 }, (_, i) => ({ ...r, id: `r${i}`, artifactId: `a${i}` }));
    const valid = { ...world, contexts: [{ id: 'w', revision: 0, references: refs }] };
    expect(readWorldContexts(valid).contexts[0].references).toHaveLength(64);
    const before = clone(w.mapping);
    await expect(
      w.saveWorldContext({ id: 'work', revision: 0, references: [...refs, { ...r, id: '65' }] }, 0),
    ).rejects.toThrow('64');
    expect(w.mapping).toEqual(before);
  });
  it('edits native once, preserves old pin/hash and other context, explicitly adopts with revision and reload', async () => {
    const { w, r, open, artifacts } = await fixture();
    const e = await w.openWorldSource(r);
    e.execute(
      documentTextEditCommand(e.content as never, [
        { segmentId: 'facts', start: 0, end: 0, expected: '', text: 'new ' },
      ]) as never,
    );
    expect(e.canUndo).toBe(true);
    await w.saveWorldSource(e.id);
    const view = (await w.readWorld('work'))[0];
    expect(view.state).toBe('stale');
    expect(view.text).toBe('same name CH-01 / LO-01');
    expect(w.worldContext('work').references[0]).toEqual(r);
    const next = { ...r, ...view.latest! };
    await w.saveWorldContext({ id: 'work', revision: 0, references: [next] }, 0);
    expect(w.worldContext('SC-02').references[0]).toEqual(r);
    expect((await open()).worldContext('work').references[0]).toEqual(next);
    expect((await artifacts.get(r.artifactId))!.versions[0].contentHash).toBe(r.contentHash);
    await expect(
      w.saveWorldContext({ id: 'work', revision: 0, references: [r] }, 0),
    ).rejects.toThrow('revision');
  });
  it('diagnoses missing artifact/version/element/hash and never chooses a same-name source in another work', async () => {
    const { w, io, a, r, artifacts } = await fixture();
    const other = { ...clone(a), id: 'work-b:facts' };
    await artifacts.put(other);
    for (const broken of [
      { ...r, artifactId: 'missing' },
      { ...r, versionId: 'missing' },
      { ...r, contentHash: '0'.repeat(64) },
      { ...r, selector: { type: 'document-blocks' as const, blockIds: ['missing'] } },
    ]) {
      const next = w.mapping;
      next.world!.contexts[0].references = [broken];
      const current = new CreativeWorkspace(io, next, w.characters, w.settings);
      const v = (await current.readWorld('work'))[0];
      expect(['missing', 'invalid']).toContain(v.state);
      expect(v.text).toBeUndefined();
      await expect(current.saveWorldContext(current.worldContext('work'), 0)).rejects.toThrow();
    }
    await artifacts.remove(r.artifactId);
    expect((await w.readWorld('work'))[0].state).toBe('missing');
  });
  it('rejects viewer writes while permitting navigation, hides delayed reads on revocation', async () => {
    const { w, io, access, r, open } = await fixture();
    access.write = false;
    const viewer = await open();
    expect((await viewer.openWorldSource(r)).readOnly).toBe(true);
    await expect(viewer.saveWorldContext(viewer.worldContext('work'), 0)).rejects.toThrow('閲覧');
    const get = io.artifacts.get.bind(io.artifacts);
    let release!: () => void;
    io.artifacts.get = vi.fn(async (id) => {
      await new Promise<void>((r) => {
        release = r;
      });
      return get(id);
    });
    const pending = w.readWorld('work');
    access.read = false;
    release();
    const v = (await pending)[0];
    expect(v.state).toBe('forbidden');
    expect(v.text).toBeUndefined();
    io.artifacts.get = get;
    expect((await w.readWorld('work'))[0].text).toBeUndefined();
  });
  it('protects old pins and work on failed/conflicting/delayed saves and retries once', async () => {
    const { w, io, r, open } = await fixture();
    const original = io.writeLinks;
    const context = w.worldContext('work');
    context.references[0].required = false;
    io.writeLinks = vi.fn(async () => {
      throw Error('disk full');
    });
    await expect(w.saveWorldContext(context, 0)).rejects.toThrow('disk full');
    expect(w.worldContext('work').references[0]).toEqual(r);
    io.writeLinks = original;
    await w.saveWorldContext(context, 0);
    expect((await open()).worldContext('work').revision).toBe(1);
    const stale = await open();
    const newContext = w.worldContext('work');
    newContext.references[0].required = true;
    await w.saveWorldContext(newContext, 1);
    await expect(stale.saveWorldContext(stale.worldContext('work'), 1)).rejects.toThrow('外部');
    expect((await open()).worldContext('work').revision).toBe(2);
  });
  it('retains Design Frame source, native undo, committed hash and old reference until explicit adoption', async () => {
    const { io, artifacts } = await fixture();
    // The harbor fixture has two native guide Frames and two Document guides.
    const raw = await io.readLinks();
    const links = readWorkspaceLinks(raw);
    const a = (await artifacts.get('cw1:harbor:samples'))!;
    const r: WorldReference = {
      id: 'sample',
      namespace: 'work-a',
      role: 'sample',
      artifactId: a.id,
      versionId: a.draft.baseVersionId!,
      contentHash: a.versions[0].contentHash,
      selector: { type: 'design-frame', frameId: 'sample-anime' },
      required: true,
    };
    links.world!.contexts[0].references = [r];
    await io.writeLinks(links);
    const w = await CreativeWorkspace.open(io);
    const e = await w.openWorldSource(r);
    e.execute(updateElement('sample-anime-title', { text: '手で修正した見本' }) as never);
    e.undo();
    e.redo();
    await w.saveWorldSource(e.id);
    const v = (await w.readWorld('work'))[0];
    expect(v.state).toBe('stale');
    expect(v.svg).not.toContain('手で修正');
    expect((await artifacts.get(a.id))!.versions[0]).toEqual(a.versions[0]);
  });
  it('reconciles an acknowledged-but-rejected mapping write without a second update', async () => {
    const { w, io } = await fixture();
    const write = io.writeLinks;
    const context = w.worldContext('work');
    context.references[0].required = false;
    io.writeLinks = vi.fn(async (v, expected) => {
      await write(v, expected);
      throw Error('lost acknowledgement');
    });
    await expect(w.saveWorldContext(context, 0)).rejects.toThrow('lost acknowledgement');
    expect(w.worldContext('work').revision).toBe(0);
    await w.saveWorldContext(context, 0);
    expect(io.writeLinks).toHaveBeenCalledTimes(1);
    expect(w.worldContext('work').revision).toBe(1);
  });
  it('delayed save blocks a second write and rejects permission loss without replacing the adopted state', async () => {
    const { w, io, access } = await fixture();
    const write = io.writeLinks;
    let release!: () => void;
    let started!: () => void;
    const begun = new Promise<void>((r) => {
      started = r;
    });
    io.writeLinks = async (v, e) => {
      started();
      await new Promise<void>((r) => {
        release = r;
      });
      await write(v, e);
    };
    const c = w.worldContext('work');
    c.references[0].required = false;
    const pending = w.saveWorldContext(c, 0);
    await begun;
    await expect(w.saveWorldContext(c, 0)).rejects.toThrow('保存中');
    access.write = false;
    release();
    await expect(pending).rejects.toThrow('権限');
    expect(w.worldContext('work').revision).toBe(0);
    // The trusted remote store may have committed: UI must not claim full success.
    expect(readWorkspaceLinks(await io.readLinks()).world!.contexts[0].revision).toBe(1);
  });
  it('delayed native save retains newer dirty input and retry does not rewrite the earlier version', async () => {
    const { w, io, r, artifacts } = await fixture();
    const e = await w.openWorldSource(r);
    const edit = (text: string) =>
      documentTextEditCommand(e.content as never, [
        { segmentId: 'facts', start: 0, end: 0, expected: '', text },
      ]);
    e.execute(edit('first ') as never);
    const put = io.artifacts.put.bind(io.artifacts);
    let release!: () => void, started!: () => void;
    const begun = new Promise<void>((r) => {
      started = r;
    });
    io.artifacts.put = async (a) => {
      started();
      await new Promise<void>((r) => {
        release = r;
      });
      await put(a);
    };
    const save = w.saveWorldSource(e.id);
    await begun;
    e.execute(edit('second ') as never);
    release();
    await save;
    expect(e.snapshot.dirty).toBe(true);
    const saved = (await artifacts.get(e.id))!;
    expect(JSON.stringify(saved.versions.at(-1)!.content)).toContain('first ');
    expect(JSON.stringify(saved.versions.at(-1)!.content)).not.toContain('second ');
    io.artifacts.put = put;
    await w.saveWorldSource(e.id);
    expect(e.snapshot.dirty).toBe(false);
    expect((await artifacts.get(e.id))!.versions).toHaveLength(saved.versions.length + 1);
    expect(w.worldContext('work').references[0]).toEqual(r);
  });
  it('keeps candidate contexts independent and never resolves another work by shared item IDs/names', async () => {
    const a = await fixture(),
      b = await fixture();
    expect(a.w.characters.cards.map((c) => [c.id, c.name])).toEqual(
      b.w.characters.cards.map((c) => [c.id, c.name]),
    );
    expect(a.w.settings.cards.map((c) => [c.id, c.name])).toEqual(
      b.w.settings.cards.map((c) => [c.id, c.name]),
    );
    const c1 = a.w.itemContextId('character', 'CH-01')!,
      c2 = a.w.itemContextId('setting', 'LO-01')!;
    expect(c1).not.toBe(c2);
    await a.w.connectWorldContext(c1);
    await a.w.connectWorldContext(c2);
    const c = a.w.worldContext(c1);
    c.references = [a.r];
    await a.w.saveWorldContext(c, 0);
    expect(a.w.worldContext(c2)).toEqual({ id: c2, revision: 0, references: [] });
    const wrong = a.w.mapping;
    wrong.world!.contexts[0].references[0] = { ...b.r, namespace: 'work-a' };
    const w = new CreativeWorkspace(a.io, wrong, a.w.characters, a.w.settings);
    expect((await w.readWorld('work'))[0].state).toBe('missing');
    expect((await b.w.readWorld('work'))[0].state).toBe('current');
  });
  for (const mode of ['character', 'setting'] as const) {
    it(`shares ${mode} artwork session/history across sample opens and retains every saved version`, async () => {
      const { w, artifacts, r } = await fixture();
      const p = w.project(mode),
        card = p.cards[0],
        owner = p.editor(card)!;
      const frameId = p.binding(card)!.chosenFrameId;
      const a = owner.artifact,
        version = a.versions.find((v) => v.versionId === a.draft.baseVersionId)!;
      const ref: WorldReference = {
        ...r,
        role: 'sample',
        artifactId: a.id,
        versionId: version.versionId,
        contentHash: version.contentHash,
        selector: { type: 'design-frame', frameId },
      };
      const [first, second] = await Promise.all([w.openWorldSource(ref), w.openWorldSource(ref)]);
      expect(first).toBe(owner);
      expect(second).toBe(owner);
      first.execute(updateElement(frameId, { fill: '#123456' }) as never);
      expect(owner.canUndo).toBe(true);
      owner.undo();
      owner.redo();
      await w.saveWorldSource(a.id);
      const saved = (await artifacts.get(a.id))!;
      await p.save();
      const after = (await artifacts.get(a.id))!;
      expect(after.versions.slice(0, saved.versions.length)).toEqual(saved.versions);
      expect(after.draft.content).toEqual(saved.draft.content);
      expect(after.versions.slice(0, a.versions.length)).toEqual(a.versions);
    });
  }
  it('shares a manuscript session through concurrent Scene and world entrances', async () => {
    const { w, artifacts, r } = await fixture(),
      scene = w.scene('SC-01');
    const a = (await artifacts.get(scene.origin.artifactId))!,
      v = a.versions.find((v) => v.versionId === scene.origin.versionId)!;
    const ref: WorldReference = {
      ...r,
      artifactId: a.id,
      versionId: v.versionId,
      contentHash: v.contentHash,
      selector: { type: 'document-blocks', blockIds: [scene.origin.elementId] },
    };
    const [sceneEditor, source1, source2] = await Promise.all([
      w.openScene(scene.id),
      w.openWorldSource(ref),
      w.openWorldSource(ref),
    ]);
    expect(source1).toBe(sceneEditor);
    expect(source2).toBe(sceneEditor);
  });
  it('retains context B when context A reference validation completes later', async () => {
    const { w, io, open } = await fixture(),
      get = io.artifacts.get.bind(io.artifacts);
    let release!: () => void, started!: () => void;
    const begun = new Promise<void>((r) => {
      started = r;
    });
    let hold = true;
    io.artifacts.get = async (id) => {
      if (hold) {
        hold = false;
        started();
        await new Promise<void>((r) => {
          release = r;
        });
      }
      return get(id);
    };
    const a = w.worldContext('work');
    a.references[0].required = false;
    const b = w.worldContext('SC-02');
    b.references[0].required = false;
    const pending = w.saveWorldContext(a, 0);
    await begun;
    await w.saveWorldContext(b, 0);
    release();
    await pending;
    expect(w.worldContext('SC-02')).toEqual({ ...b, revision: 1 });
    expect((await open()).worldContext('SC-02')).toEqual({ ...b, revision: 1 });
    expect(w.worldContext('work').revision).toBe(1);
  });
  it('flushes uncommitted input and refuses composing/settling at the public save boundary', async () => {
    const { w, r, artifacts } = await fixture(),
      e = await w.openWorldSource(r);
    expect(e.snapshot.dirty).toBe(false);
    let buffered = true;
    const stop = e.registerInputBoundary(() => {
      if (buffered) {
        buffered = false;
        e.execute(
          documentTextEditCommand(e.content as never, [
            { segmentId: 'facts', start: 0, end: 0, expected: '', text: 'buffered ' },
          ]) as never,
        );
      }
    });
    await w.saveWorldSource(e.id);
    stop();
    expect(JSON.stringify((await artifacts.get(e.id))!.draft.content)).toContain('buffered ');
    expect(e.snapshot.dirty).toBe(false);
    for (const state of ['composing', 'settling']) {
      const before = await artifacts.get(e.id);
      const stop = e.registerInputBoundary(() => {
        throw Error(state);
      });
      await expect(w.saveWorldSource(e.id)).rejects.toThrow(state);
      stop();
      expect(await artifacts.get(e.id)).toEqual(before);
    }
  });
  it('removes completed projections and latest metadata revoked while another reference is pending', async () => {
    const { w, io, r } = await fixture();
    const links = w.mapping;
    links.world!.contexts[0].references.push({ ...r, id: 'second', role: 'instructions' });
    let allowed = true;
    const current = new CreativeWorkspace(
      io,
      links,
      w.characters,
      w.settings,
      () => true,
      () => allowed,
    );
    const get = io.artifacts.get.bind(io.artifacts);
    let calls = 0;
    let release!: () => void, started!: () => void;
    const begun = new Promise<void>((r) => {
      started = r;
    });
    io.artifacts.get = async (id) => {
      if (++calls === 2) {
        started();
        await new Promise<void>((r) => {
          release = r;
        });
      }
      return get(id);
    };
    let firstFinished!: () => void;
    const finished = new Promise<void>((resolve) => {
      firstFinished = resolve;
    });
    const originalRead = worldReferenceApi.readWorldReference;
    const spy = vi
      .spyOn(worldReferenceApi, 'readWorldReference')
      .mockImplementation(async (...args) => {
        const view = await originalRead(...args);
        if (args[1].id === r.id) firstFinished();
        return view;
      });
    const pending = current.readWorld('work');
    await Promise.all([begun, finished]);
    allowed = false;
    release();
    for (const view of await pending) {
      expect(view.state).toBe('forbidden');
      expect(view.text).toBeUndefined();
      expect(view.svg).toBeUndefined();
      expect(view.latest).toBeUndefined();
    }
    spy.mockRestore();
  });
  it('rejects the context limit without mutating any saved or working reference', async () => {
    const { w, io, open } = await fixture();
    const links = w.mapping;
    while (links.world!.contexts.length < 64)
      links.world!.contexts.push({
        id: `empty-${links.world!.contexts.length}`,
        revision: 0,
        references: [],
      });
    await io.writeLinks(links);
    const current = await open(),
      before = current.mapping;
    await expect(current.connectWorldContext('over-limit')).rejects.toThrow();
    expect(current.mapping).toEqual(before);
    expect(await io.readLinks()).toEqual(before);
  });
  it('rejects world-aware generation headlessly with a reason', () => {
    expect(assertWorldGenerationAvailable).toThrow('CW2未接続');
  });
  it('rejects before a headless world-aware preparation touches native or provider', async () => {
    await expect(
      prepareCreativeLayerGeneration(
        undefined as never,
        undefined as never,
        'frame',
        { elementId: 'x' },
        { context: 'world', instructions: 'test' },
      ),
    ).rejects.toThrow('CW2未接続');
  });
});
