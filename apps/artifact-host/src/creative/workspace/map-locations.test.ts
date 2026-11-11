import { describe, it, expect, vi } from 'vitest';
import {
  MemoryStorage,
  clone,
  canonicalJson,
  contentHash,
  createArtifact,
  commitVersion,
  type Artifact,
} from '@editor-platform/artifact-core';
import { adoptFictionMapBase } from '@editor-platform/fiction-map/host';
import type { HostSaveContext } from '@editor-platform/editor-host';
import {
  prepareFictionMapChange,
  commitFictionMapChange,
  undoFictionMap,
  redoFictionMap,
  type FictionMapContent,
} from '@editor-platform/fiction-map/model';
import { createHarborWorkspace } from './fixture';
import { createHarborMapFixture } from './map-fixture';
import { CreativeWorkspace, readWorkspaceLinks, type CreativeWorkspaceStorage } from './model';
import {
  readCreativeMapLinks,
  projectCreativeMapLocation,
  type CreativeMapLocation,
} from './map-links';

async function fixture() {
  const store = new MemoryStorage<Artifact<unknown>>();
  const mappings: Record<string, unknown> = {};
  let links: unknown;
  const access = { write: true };
  const denied = new Set<string>();
  const faults = { links: '', native: '', puts: 0, writes: 0 };
  const contexts: HostSaveContext[] = [];
  let hold: (() => Promise<void>) | undefined;
  const io: CreativeWorkspaceStorage = {
    artifacts: {
      get: store.get.bind(store),
      list: store.list.bind(store),
      remove: store.remove.bind(store),
      putIfAbsent: store.putIfAbsent.bind(store),
      put: async (a, context) => {
        if (context) contexts.push(context);
        faults.puts++;
        if (faults.native === 'fail') {
          faults.native = '';
          throw Error('disk full');
        }
        await hold?.();
        await store.put(a);
        if (faults.native === 'lost') {
          faults.native = '';
          throw Error('lost ack');
        }
      },
    },
    creative: (mode) => ({
      artifacts: store,
      readMapping: async () => clone(mappings[mode]),
      writeMapping: async (v) => {
        mappings[mode] = clone(v);
      },
    }),
    readLinks: async () => clone(links),
    writeLinks: async (v, expected) => {
      faults.writes++;
      if (faults.links === 'fail') {
        faults.links = '';
        throw Error('links disk full');
      }
      if (expected && canonicalJson(links) !== canonicalJson(expected)) throw Error('CAS conflict');
      links = clone(v);
      if (faults.links === 'lost') {
        faults.links = '';
        throw Error('links lost ack');
      }
    },
  };
  const open = () =>
    CreativeWorkspace.open(
      io,
      () => access.write,
      (id) => !denied.has(id),
    );
  await createHarborWorkspace(io);
  const w = await open();
  await createHarborMapFixture(w);
  const reference = w.maps.mapping.locations.find((r) => r.id === 'harbor-map:SC-01:LO-02')!;
  const map = (await store.get(reference.map.artifactId))!;
  faults.puts = 0;
  faults.writes = 0;
  contexts.length = 0;
  return {
    store,
    io,
    w,
    reference,
    map,
    open,
    access,
    denied,
    faults,
    contexts,
    setHold: (value?: () => Promise<void>) => {
      hold = value;
    },
    stored: () => clone(links) as ReturnType<typeof readWorkspaceLinks>,
    replace: (value: unknown) => {
      links = clone(value);
    },
  };
}
function nextVersion(f: Awaited<ReturnType<typeof fixture>>, r = f.reference) {
  const latest = f.map.versions.at(-1)!;
  return {
    ...clone(r),
    map: { ...clone(r.map), versionId: latest.versionId, contentHash: latest.contentHash },
  };
}
function edit(
  editor: Awaited<ReturnType<CreativeWorkspace['maps']['open']>>,
  name = '手で修正した街',
) {
  const base = adoptFictionMapBase(editor);
  const feature = base.content.features.find((f) => f.id === 'town')!;
  const p = prepareFictionMapChange(base, { update: [{ ...feature, name }] });
  if (!p.ok) throw Error(p.diagnostic.code);
  const committed = commitFictionMapChange(editor, p.value, () => !editor.readOnly);
  if (!committed.ok) throw Error(committed.diagnostic.code);
}
describe('CW3 fixed semantic maps', () => {
  it('opens a work-wide LO outside Scene membership through the current Setting without changing the Scene or return ticket', async () => {
    const f = await fixture();
    const r = f.w.maps.mapping.locations.find((r) => r.itemId === 'LO-01' && !r.sceneId)!;
    expect(f.w.scene('SC-01').items.some((i) => i.itemId === r.itemId)).toBe(false);
    await f.w.openScene('SC-01');
    await f.w.captureReturn('SC-01');
    const before = clone(f.w.mapping);
    const target = await f.w.maps.editLocation(r);
    expect(target).toEqual(await f.w.currentItem('setting', r.itemId));
    expect(target.source.elementId).toBe(r.source.elementId);
    expect(f.w.mapping).toEqual(before);
    expect((await f.w.returnToScene()).scene.id).toBe('SC-01');
  });
  it('allows a viewer to open work-wide Setting targets but rechecks map and LO grants on each visit', async () => {
    const f = await fixture();
    const r = f.w.maps.mapping.locations.find((r) => r.itemId === 'LO-01' && !r.sceneId)!;
    f.access.write = false;
    const target = await f.w.maps.editLocation(r);
    expect(
      f.w.settings.editor(f.w.settings.cards.find((c) => c.id === target.itemId)!)?.readOnly,
    ).toBe(true);
    f.denied.add(r.map.artifactId);
    await expect(f.w.maps.editLocation(r)).rejects.toThrow();
    f.denied.clear();
    f.denied.add(r.source.artifactId);
    await expect(f.w.maps.editLocation(r)).rejects.toThrow();
    expect(f.faults.puts).toBe(0);
  });
  it('existing same-name LO and same feature IDs in another work cannot substitute for this source', async () => {
    const f = await fixture();
    const otherSource = await commitVersion(
      {
        ...createArtifact('document', '世界の覚え書き（別作品）', f.w.settings.source.content),
        id: 'other-work:locations',
      },
      null,
      'other work',
    );
    const content = f.map.draft.content as FictionMapContent;
    const otherMap = await commitVersion(
      {
        ...createArtifact('fiction-map', '港町の固定地図（別作品）', {
          ...content,
          features: content.features.map((feature) => ({
            ...feature,
            ...(feature.worldEntityRef
              ? { worldEntityRef: { ...feature.worldEntityRef, namespace: 'other-work' } }
              : {}),
          })),
        }),
        id: 'other-work:map',
      },
      null,
      'other work',
    );
    await f.store.put(otherSource);
    await f.store.put(otherMap);
    const source = clone(f.reference);
    delete source.sceneId;
    source.source = {
      ...source.source,
      artifactId: otherSource.id,
      versionId: otherSource.versions[0].versionId,
      contentHash: otherSource.versions[0].contentHash,
    };
    const wrongSource = await f.w.maps.read(source);
    expect(wrongSource.state).toBe('invalid');
    expect(wrongSource.reason).toContain('LO正本');
    expect(wrongSource.name).toBeUndefined();
    expect(wrongSource.svg).toBeUndefined();
    const map = clone(f.reference);
    map.map = {
      ...map.map,
      artifactId: otherMap.id,
      versionId: otherMap.versions[0].versionId,
      contentHash: otherMap.versions[0].contentHash,
    };
    const wrongMap = await f.w.maps.read(map);
    expect(wrongMap.state).toBe('invalid');
    expect(wrongMap.reason).toContain('意味参照');
    expect(wrongMap.svg).toBeUndefined();
    expect(wrongMap.overviewSvg).toBeUndefined();
  });
  it('map image and LO subset are distinct projections of the same exact Scene version', async () => {
    const f = await fixture();
    const before = await f.w.maps.read(f.reference);
    const after = await f.w.maps.read(
      f.w.maps.mapping.locations.find((r) => r.sceneId === 'SC-02')!,
    );
    expect(before.svg).not.toContain('data-feature-id="bridge"');
    expect(before.overviewSvg).toContain('data-feature-id="bridge"');
    expect(after.overviewSvg).not.toContain('data-feature-id="bridge"');
    f.denied.add(f.reference.map.artifactId);
    const masked = await f.w.maps.read(f.reference);
    expect(masked.svg).toBeUndefined();
    expect(masked.overviewSvg).toBeUndefined();
  });
  it('closed arrays refuse holes, getter entries and unknown array fields before access', async () => {
    const f = await fixture();
    const holes = clone(f.reference);
    holes.map.featureIds = new Array(1);
    expect(() => readCreativeMapLinks({ revision: 0, locations: [holes] })).toThrow();
    const getter = vi.fn(() => f.reference);
    const values: CreativeMapLocation[] = [];
    Object.defineProperty(values, '0', { get: getter, enumerable: true });
    expect(() => readCreativeMapLinks({ revision: 0, locations: values })).toThrow();
    expect(getter).not.toHaveBeenCalled();
    const extra = [f.reference];
    Object.defineProperty(extra, 'unknown', { value: 1 });
    expect(() => readCreativeMapLinks({ revision: 0, locations: extra })).toThrow();
  });
  it('late open cannot replace a newer map selection, even inside one retained native Session', async () => {
    const f = await fixture();
    const get = f.io.artifacts.get.bind(f.io.artifacts);
    let entered!: () => void,
      release!: () => void,
      first = true;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    const held = new Promise<void>((r) => {
      release = r;
    });
    vi.spyOn(f.io.artifacts, 'get').mockImplementation(async (id) => {
      const value = await get(id);
      if (id === f.map.id && first) {
        first = false;
        entered();
        await held;
      }
      return value;
    });
    const old = f.w.maps.open(f.reference);
    await started;
    const other = f.w.maps.mapping.locations.find((r) => r.itemId === 'LO-01')!;
    const editor = await f.w.maps.open(other);
    const selection = editor.snapshot.selection;
    release();
    await expect(old).rejects.toThrow('新しい地図移動');
    expect(editor.snapshot.selection).toEqual(selection);
    expect(selection.addresses.map((a) => a.elementId)).toEqual(['house']);
  });
  it('open owns a caller reference before awaited reads', async () => {
    const f = await fixture(),
      r = clone(f.reference);
    const pending = f.w.maps.open(r);
    r.map.featureIds = ['house'];
    const editor = await pending;
    expect(editor.snapshot.selection.addresses.map((a) => a.elementId)).toEqual([
      'town',
      'port-area',
    ]);
  });
  it('association save rechecks revoked write authority after delayed store reads', async () => {
    const f = await fixture(),
      previous = f.stored();
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    const held = new Promise<void>((r) => {
      release = r;
    });
    vi.spyOn(f.io, 'readLinks').mockImplementation(async () => {
      entered();
      await held;
      return previous;
    });
    const pending = f.w.maps.save(nextVersion(f), f.w.maps.mapping.revision);
    await started;
    f.access.write = false;
    release();
    await expect(pending).rejects.toThrow('権限');
    expect(f.faults.writes).toBe(0);
    expect(f.w.mapping).toEqual(previous);
  });
  it('a deleted current edit destination never retargets a still-readable old map pin', async () => {
    const f = await fixture(),
      editor = await f.w.maps.open(f.reference);
    const p = prepareFictionMapChange(adoptFictionMapBase(editor), { delete: ['town'] });
    if (!p.ok) throw Error(p.diagnostic.code);
    expect(commitFictionMapChange(editor, p.value, () => true).ok).toBe(true);
    await f.w.maps.saveSource(editor);
    const selection = editor.snapshot.selection;
    expect((await f.w.maps.read(f.reference)).svg).toBeDefined();
    await expect(f.w.maps.open(f.reference)).rejects.toThrow('地物が欠落');
    expect(editor.snapshot.selection).toEqual(selection);
  });
  it('one-to-many read is an exact saved projection; newer draft and other Scene pins stay separate', async () => {
    const f = await fixture(),
      before = await f.store.list();
    const v = await f.w.maps.read(f.reference);
    expect(v.state).toBe('stale');
    expect(v.features?.map((v) => v.id)).toEqual(['town', 'port-area']);
    expect(v.svg).toContain('data-feature-id="town"');
    const old = f.w.maps.mapping;
    await f.w.maps.save(nextVersion(f), old.revision);
    expect(f.w.maps.mapping.locations.filter((r) => r.id !== f.reference.id)).toEqual(
      old.locations.filter((r) => r.id !== f.reference.id),
    );
    const reopened = await f.open();
    expect(reopened.maps.mapping).toEqual(f.w.maps.mapping);
    expect(await f.store.list()).toEqual(before);
  });
  for (const mutate of [
    (r: CreativeMapLocation) => ({ ...r, unknown: true }),
    (r: CreativeMapLocation) => ({ ...r, namespace: 'another-work' }),
    (r: CreativeMapLocation) => ({
      ...r,
      source: { ...r.source, artifactId: 'same-name-another-work' },
    }),
    (r: CreativeMapLocation) => ({
      ...r,
      map: { ...r.map, view: { kind: 'json-path', path: '*' } },
    }),
    (r: CreativeMapLocation) => ({ ...r, map: { ...r.map, featureIds: ['town', 'town'] } }),
    (r: CreativeMapLocation) => ({ ...r, map: { ...r.map, unknown: 1 } }),
  ])
    it(
      'closed input refuses unknown fields/selectors, duplicates and cross-work identities atomically: ' +
        mutate.toString(),
      async () => {
        const f = await fixture(),
          before = f.w.mapping;
        await expect(
          f.w.maps.save(
            mutate(clone(f.reference)) as CreativeMapLocation,
            f.w.maps.mapping.revision,
          ),
        ).rejects.toThrow();
        expect(f.w.mapping).toEqual(before);
        expect(f.faults.writes).toBe(0);
      },
    );
  for (const kind of [
    'artifact',
    'version',
    'feature',
    'view',
    'hash',
    'source-hash',
    'source-element',
    'ref',
    'domain',
  ] as const)
    it('diagnoses ' + kind + ' without a replacement projection', async () => {
      const f = await fixture(),
        r = clone(f.reference);
      if (kind === 'artifact') await f.store.remove(r.map.artifactId);
      if (kind === 'version') r.map.versionId = 'missing';
      if (kind === 'feature') r.map.featureIds = ['gone'];
      if (kind === 'view') r.map.view = { kind: 'named', id: 'gone' };
      if (kind === 'hash') r.map.contentHash = '0'.repeat(64);
      if (kind === 'source-hash') r.source.contentHash = '0'.repeat(64);
      if (kind === 'source-element') r.source.elementId = 'gone';
      if (kind === 'ref') r.map.featureIds = ['house'];
      if (kind === 'domain') r.map.artifactId = r.source.artifactId;
      const v = await f.w.maps.read(r);
      expect(['missing', 'invalid']).toContain(v.state);
      expect(v.svg).toBeUndefined();
      expect(v.name).toBeUndefined();
      await expect(f.w.maps.save(r, f.w.maps.mapping.revision)).rejects.toThrow();
      expect(f.faults.writes).toBe(0);
    });
  it('ref missing is explicit native metadata + one Undo, then save and separate adoption', async () => {
    const f = await fixture(),
      editor = await f.w.maps.open(f.reference),
      before = editor.content;
    const pins = f.w.maps.mapping;
    f.w.maps.assign(editor, ['unassigned'], 'LO-01');
    expect(editor.content.features.find((f) => f.id === 'unassigned')?.worldEntityRef).toEqual({
      namespace: 'harbor',
      entityId: 'LO-01',
    });
    expect(undoFictionMap(editor, () => true).ok).toBe(true);
    expect(editor.content).toEqual(before);
    expect(redoFictionMap(editor, () => true).ok).toBe(true);
    await f.w.maps.saveSource(editor);
    expect(f.w.maps.mapping).toEqual(pins);
    const latest = editor.artifact.versions.at(-1)!;
    const r = {
      id: 'warehouse',
      ...(await f.w.maps.location('LO-01')),
      map: {
        artifactId: editor.id,
        versionId: latest.versionId,
        contentHash: latest.contentHash,
        view: { kind: 'document' as const },
        featureIds: ['unassigned'],
      },
    };
    // The work LO-01 association is updated explicitly, rather than creating an ambiguous duplicate.
    r.id = f.w.maps.mapping.locations.find((r) => r.itemId === 'LO-01' && !r.sceneId)!.id;
    await f.w.maps.save(r, pins.revision);
    expect((await f.w.maps.read(r)).state).toBe('current');
    expect(editor.artifact.versions.slice(0, 2)).toEqual(f.map.versions);
  });
  it('conflicting World ref is never overwritten, even for a same-named feature', async () => {
    const f = await fixture(),
      editor = await f.w.maps.open(f.reference),
      before = editor.snapshot;
    expect(() => f.w.maps.assign(editor, ['town'], 'LO-01')).toThrow('衝突');
    expect(editor.snapshot).toEqual(before);
  });
  for (const id of ['map', 'source'] as const)
    it('read revocation of ' + id + ' masks cached input and recovers independently', async () => {
      const f = await fixture();
      const target = id === 'map' ? f.reference.map.artifactId : f.reference.source.artifactId;
      expect((await f.w.maps.read(f.reference)).svg).toBeDefined();
      f.denied.add(target);
      for (let n = 0; n < 2; n++) {
        const v = await f.w.maps.read(f.reference);
        expect(v.state).toBe('forbidden');
        expect(v.svg).toBeUndefined();
        expect(v.name).toBeUndefined();
      }
      f.denied.delete(target);
      expect((await f.w.maps.read(f.reference)).svg).toBeDefined();
    });
  it('delayed read rechecks authorization after native I/O', async () => {
    const f = await fixture();
    const original = f.io.artifacts.get.bind(f.io.artifacts);
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    const held = new Promise<void>((r) => {
      release = r;
    });
    vi.spyOn(f.io.artifacts, 'get').mockImplementation(async (id) => {
      const a = await original(id);
      if (id === f.reference.map.artifactId) {
        entered();
        await held;
      }
      return a;
    });
    const pending = f.w.maps.read(f.reference);
    await started;
    f.denied.add(f.reference.source.artifactId);
    release();
    const v = await pending;
    expect(v.state).toBe('forbidden');
    expect(v.svg).toBeUndefined();
    expect(v.name).toBeUndefined();
  });
  it('viewer reads and selects but both native edit and pin adoption refuse', async () => {
    const f = await fixture();
    f.access.write = false;
    expect((await f.w.maps.read(f.reference)).svg).toBeDefined();
    const editor = await f.w.maps.open(f.reference);
    expect(editor.snapshot.selection.addresses.map((a) => a.elementId)).toEqual([
      'town',
      'port-area',
    ]);
    expect(() => edit(editor)).toThrow();
    await expect(f.w.maps.save(nextVersion(f), f.w.maps.mapping.revision)).rejects.toThrow(
      '閲覧のみ',
    );
    expect(f.faults.writes).toBe(0);
    expect(f.faults.puts).toBe(0);
  });
  for (const kind of ['fail', 'lost'] as const)
    it('association ' + kind + ' protects old pins and retries exactly once', async () => {
      const f = await fixture(),
        before = f.w.maps.mapping,
        next = nextVersion(f);
      f.faults.links = kind;
      await expect(f.w.maps.save(next, before.revision)).rejects.toThrow();
      expect(f.w.maps.mapping).toEqual(before);
      const writes = f.faults.writes;
      await f.w.maps.save(next, before.revision);
      expect(f.w.maps.mapping.revision).toBe(before.revision + 1);
      expect(f.w.maps.mapping.locations.find((r) => r.id === next.id)).toEqual(next);
      expect(f.faults.writes).toBe(writes + (kind === 'lost' ? 0 : 1));
      expect(f.faults.puts).toBe(0);
    });
  it('external CAS and old expected revision refuse without erasing independent updates', async () => {
    const f = await fixture(),
      before = f.w.maps.mapping;
    await expect(f.w.maps.save(nextVersion(f), before.revision - 1)).rejects.toThrow('revision');
    const concurrent = f.stored();
    concurrent.world!.contexts[0].revision++;
    f.replace(concurrent);
    await expect(f.w.maps.save(nextVersion(f), before.revision)).rejects.toThrow('外部');
    expect(f.stored()).toEqual(concurrent);
    expect(f.w.maps.mapping).toEqual(before);
  });
  for (const kind of ['fail', 'lost'] as const)
    it(
      'native ' + kind + ' retains unsaved edits, old map pin and immutable versions on retry',
      async () => {
        const f = await fixture(),
          editor = await f.w.maps.open(f.reference),
          pins = f.w.maps.mapping;
        edit(editor);
        f.faults.native = kind;
        await expect(f.w.maps.saveSource(editor)).rejects.toThrow();
        expect(editor.snapshot.dirty).toBe(true);
        await f.w.maps.saveSource(editor);
        const saved = (await f.store.get(editor.id))!;
        expect(editor.snapshot.dirty).toBe(false);
        expect(saved.versions).toHaveLength(f.map.versions.length + 1);
        expect(saved.versions.slice(0, 2)).toEqual(f.map.versions);
        expect(f.w.maps.mapping).toEqual(pins);
        expect(f.faults.puts).toBe(kind === 'lost' ? 1 : 2);
        expect(f.contexts).toHaveLength(f.faults.puts);
        expect(f.contexts[0]).toMatchObject({
          artifactId: editor.id,
          kind: 'fiction-map',
          committed: true,
          versionId: saved.versions.at(-1)!.versionId,
          contentHash: saved.versions.at(-1)!.contentHash,
          proposalTransactions: [],
        });
        expect(Object.isFrozen(f.contexts[0])).toBe(true);
        for (const context of f.contexts) expect(context).toBe(f.contexts[0]);
      },
    );
  it('late native save never replaces further input or a different Scene map pin', async () => {
    const f = await fixture(),
      editor = await f.w.maps.open(f.reference),
      pins = f.w.maps.mapping;
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    const held = new Promise<void>((r) => {
      release = r;
    });
    f.setHold(async () => {
      entered();
      await held;
    });
    edit(editor, '保存開始時');
    const pending = f.w.maps.saveSource(editor);
    await started;
    edit(editor, '保存中の追加入力');
    release();
    await pending;
    expect(editor.content.features.find((f) => f.id === 'town')?.name).toBe('保存中の追加入力');
    expect(editor.snapshot.dirty).toBe(true);
    expect(f.w.maps.mapping).toEqual(pins);
    const saved = await f.w.maps.readMapVersion(editor.id, editor.artifact.draft.baseVersionId!);
    expect(saved.version.content.features.find((f) => f.id === 'town')?.name).toBe('保存開始時');
  });
  it('native external conflict is enforced even through the returned Editor save entrance', async () => {
    const f = await fixture(),
      editor = await f.w.maps.open(f.reference);
    edit(editor);
    const external = clone(f.map);
    external.name = '外部で保存';
    await f.store.put(external);
    await expect(editor.save({ commitVersion: true })).rejects.toThrow('競合');
    expect(await f.store.get(editor.id)).toEqual(external);
    expect(editor.snapshot.dirty).toBe(true);
  });
  it('64 valid associations are admitted, the 65th is rejected before reads/writes', async () => {
    const f = await fixture(),
      links = f.stored(),
      scene = f.w.scene('SC-01');
    links.scenes = Array.from({ length: 64 }, (_, n) => ({ ...clone(scene), id: 'test-' + n }));
    links.mapLocations = readCreativeMapLinks({
      revision: 0,
      locations: links.scenes.map((s, n) => ({
        ...clone(f.reference),
        id: 'ref-' + n,
        sceneId: s.id,
      })),
    });
    f.replace(links);
    const w = new CreativeWorkspace(f.io, links, f.w.characters, f.w.settings);
    expect(w.maps.mapping.locations).toHaveLength(64);
    const get = vi.spyOn(f.io.artifacts, 'get');
    await expect(
      w.maps.save({ ...clone(f.reference), id: '65th', sceneId: undefined }, 0),
    ).rejects.toThrow('64');
    expect(get).not.toHaveBeenCalled();
    expect(f.faults.writes).toBe(0);
    expect(w.mapping).toEqual(links);
  });
  it('pins do not infer chronology and old geometry/hash stays immutable after later edits', async () => {
    const f = await fixture();
    const [v1, v2] = f.map.versions;
    expect((v1.content as FictionMapContent).features.some((f) => f.id === 'bridge')).toBe(true);
    expect((v2.content as FictionMapContent).features.some((f) => f.id === 'bridge')).toBe(false);
    const second = f.w.maps.mapping.locations.find((r) => r.sceneId === 'SC-02')!;
    expect(second.map.versionId).toBe(v2.versionId);
    await f.w.maps.save({ ...second, map: clone(f.reference.map) }, f.w.maps.mapping.revision);
    expect(f.w.maps.mapping.locations.find((r) => r.id === f.reference.id)).toEqual(f.reference);
    for (const v of (await f.store.get(f.map.id))!.versions)
      expect(await contentHash(v.content)).toBe(v.contentHash);
    expect(projectCreativeMapLocation(f.reference, v1.content).features).toHaveLength(2);
  });
});
