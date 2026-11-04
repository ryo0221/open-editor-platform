import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  canonicalJson,
  clone,
  commitVersion,
  createArtifact,
  MemoryStorage,
  type Artifact,
} from '@editor-platform/artifact-core';
import { createDocument, updateBlock } from '@editor-platform/document/model';
import { createDesign, insertElement, updateElement } from '@editor-platform/design/model';
import { generatedPng } from '../../../../../tests/fixtures/creative-host/generated-png';
import { serializeCreativeWorldInput } from './generation-context';
import type { HostProposalApplied } from '@editor-platform/editor-host';
import type { DesignContent } from '@editor-platform/design/model';
import { creativeDesignAddressKey } from '@editor-platform/design/creative-proposal-diff';
import {
  addCreativeGenerationLayer,
  assertWorldGenerationAvailable,
  prepareCreativeLayerGeneration,
} from '@editor-platform/reference-artifact-host/creative';
import {
  CreativeWorkspace,
  createHarborWorkspace,
  creativeWorldInputLimits,
  prepareCreativeWorldInput,
  readCreativeWorldContext,
  readWorkspaceLinks,
  type CreativeWorldInputOptions,
  type CreativeWorkspaceStorage,
  type WorldReference,
} from '@editor-platform/reference-artifact-host/creative/workspace';

async function fixture(
  mode: 'character' | 'setting' = 'character',
  connectCandidate = true,
  refreshScene = true,
) {
  const artifacts = new MemoryStorage<Artifact<unknown>>();
  let links: unknown;
  const maps: Record<string, unknown> = {};
  const access = {
    edit: true,
    read: true,
    send: true,
    sendEditor: true,
    active: true,
    blockedId: '',
  };
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
  const w = await CreativeWorkspace.open(
    io,
    () => access.edit,
    (id) => access.read && access.blockedId !== id,
  );
  const p = w.project(mode),
    card = p.cards[0],
    editor = p.editor(card)!;
  await p.save({ rough: { itemId: card.id, frameId: 'candidate-1' } });
  const layer = addCreativeGenerationLayer<typeof p.source.content>(
    p,
    card,
    'candidate-1',
    'part',
    {
      x: 1,
      y: 1,
      width: 2,
      height: 2,
    },
  );
  await p.save();
  const native = await prepareCreativeLayerGeneration<typeof p.source.content>(
    p,
    card,
    'candidate-1',
    { elementId: layer },
    { instructions: '対象部位だけ清書', styleGuide: '今回の共通編集指示' },
  );
  if (connectCandidate) await w.connectWorldContext(w.itemContextId(mode, card.id)!);
  const sceneId = mode === 'character' ? 'SC-01' : 'SC-02';
  const alignScene = () =>
    w.refreshReference(sceneId, mode, card.id, w.item(sceneId, mode, card.id));
  if (refreshScene) await alignScene();
  const options: CreativeWorldInputOptions = {
    mode,
    itemId: card.id,
    sceneId,
    assertActive() {
      if (!access.active) throw Error('inactive Host');
    },
    maySendEditorRequest: () => access.sendEditor,
    maySendReference: () => access.send,
  };
  const prepare = (extra: Partial<CreativeWorldInputOptions> = {}) =>
    prepareCreativeWorldInput(w, native, { ...options, ...extra });
  const replace = async (references: WorldReference[]) => {
    const c = w.worldContext('work');
    await w.saveWorldContext({ ...c, references }, c.revision);
  };
  const material = async (text: string, count = 1) => {
    const doc = createDocument();
    doc.blocks = Array.from({ length: count }, (_, i) => ({
      id: `block-${i}`,
      type: 'paragraph',
      text,
    }));
    const a = await commitVersion(
      { ...createArtifact('document', 'same name', doc), id: 'harbor:test-facts' },
      null,
      'fixture',
    );
    await artifacts.put(a);
    return Array.from(
      { length: count },
      (_, i): WorldReference => ({
        id: `ref-${i}`,
        role: 'facts',
        namespace: 'harbor',
        artifactId: a.id,
        versionId: a.versions[0].versionId,
        contentHash: a.versions[0].contentHash,
        selector: { type: 'document-blocks', blockIds: [`block-${i}`] },
        required: true,
      }),
    );
  };
  return {
    w,
    p,
    card,
    editor,
    layer,
    native,
    options,
    prepare,
    artifacts,
    access,
    replace,
    material,
    io,
    alignScene,
  };
}

describe('CW2a Host input preparation (no execution enablement)', () => {
  it('connects World assertions and an exact native apply observation without enabling World dispatch', async () => {
    const f = await fixture(),
      input = await f.prepare(),
      before = clone(f.editor.content),
      revision = f.editor.revision;
    const metadata = {
      requestId: input.snapshot.editorRequest.id,
      fingerprint: input.snapshot.context.fingerprint,
      payloadHash: input.payloadHash,
    };
    let permit = false;
    const receipts: { metadata: typeof metadata; applied: HostProposalApplied<DesignContent> }[] =
      [];
    const result = {
      requestId: f.native.request.id,
      src: generatedPng(),
      source: 'fixed fixture',
      license: 'test grant',
    };
    const review = f.native.preview(result, {
      assertCurrent: input.assertCurrent,
      beforeApply() {
        if (!permit) throw Error('Host final preflight required');
      },
      onApplied(applied) {
        receipts.push({ metadata: clone(metadata), applied });
      },
    });
    expect(f.editor.content).toEqual(before);
    expect(receipts).toEqual([]);
    expect(() => f.editor.acceptProposal(review.id)).toThrow('final preflight');
    expect(() => f.editor.execute(review.preview.proposal.commands[0])).toThrow('final preflight');
    expect(f.editor.revision).toEqual(revision);
    await input.preflight();
    permit = true;
    f.editor.acceptProposal(review.id);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].metadata).toEqual(metadata);
    expect(receipts[0].applied).toMatchObject({
      artifactId: f.editor.id,
      proposalId: review.id,
      beforeRevision: revision,
      revision: f.editor.revision,
      content: f.editor.content,
      changedElementIds: [creativeDesignAddressKey({ elementId: f.layer })],
    });
    expect(receipts[0].applied.transactionId).toMatch(/^transaction_/);
    expect(f.editor.snapshot.dirty).toBe(true);
    const applied = clone(f.editor.content);
    f.editor.undo();
    expect(f.editor.content).toEqual(before);
    f.editor.redo();
    expect(f.editor.content).toEqual(applied);
    expect(receipts).toHaveLength(1);
    expect(() => assertWorldGenerationAvailable()).toThrow('CW2未接続');
  });
  for (const change of ['adoption', 'permission'] as const)
    it(`retains World ${change} checks in the owned native commands through final accept`, async () => {
      const f = await fixture(),
        input = await f.prepare(),
        before = clone(f.editor.content);
      const revision = f.editor.revision,
        history = f.editor.peekHistory('undo'),
        canUndo = f.editor.canUndo;
      const receipts: HostProposalApplied<DesignContent>[] = [];
      const hooks = {
        assertCurrent: input.assertCurrent,
        beforeApply() {},
        onApplied(event: HostProposalApplied<DesignContent>) {
          receipts.push(event);
        },
      };
      const review = f.native.preview(
        { requestId: f.native.request.id, src: generatedPng(), source: 'fixture', license: 'test' },
        hooks,
      );
      hooks.assertCurrent = () => {};
      if (change === 'adoption') {
        const c = f.w.worldContext('work');
        await f.w.saveWorldContext(c, c.revision);
      } else f.access.send = false;
      expect(() => f.editor.acceptProposal(review.id)).toThrow(
        change === 'adoption' ? '採用前提' : '外部送信',
      );
      expect(f.editor.content).toEqual(before);
      expect(f.editor.revision).toEqual(revision);
      expect(f.editor.canUndo).toBe(canUndo);
      expect(f.editor.peekHistory('undo')).toEqual(history);
      expect(receipts).toEqual([]);
    });
  it('refuses asynchronous World assertions before publishing a preview', async () => {
    const f = await fixture(),
      before = clone(f.editor.content);
    expect(() =>
      f.native.preview(
        { requestId: f.native.request.id, src: generatedPng(), source: 'fixture', license: 'test' },
        { assertCurrent: async () => {} },
      ),
    ).toThrow('同期処理');
    expect(f.editor.proposals).toEqual([]);
    expect(f.editor.content).toEqual(before);
  });
  for (const mode of ['character', 'setting'] as const)
    it(`prepares ${mode} input on adopted WorkspaceLinks v2 without changing Story owners or occurrence links`, async () => {
      const f = await fixture(mode),
        initial = f.w.mapping,
        scene = f.w.scene(f.options.sceneId!);
      // Explicit fixture setup, not a runtime migration/writer. These owners are outside this input's scope.
      const story = {
        id: 'story-fixture',
        namespace: 'harbor',
        composition: 'story:composition',
        worldSettings: 'story:world-notes',
        ledgers: [{ world: 'W-1', artifactId: 'story:ledger' }],
        sceneCards: [],
      };
      const occurrenceLinks = [
        {
          id: 'OL-1',
          occurrence: {
            artifactId: story.composition,
            versionId: 'composition-version',
            contentHash: 'a'.repeat(64),
            itemId: 'O-1',
          },
          regions: [
            { sceneId: scene.id, address: { ...scene.origin, elementId: scene.members[0] } },
          ],
        },
      ];
      const v2 = readWorkspaceLinks({ ...initial, schemaVersion: 2, story, occurrenceLinks });
      await f.io.writeLinks(v2, initial);
      const w = await CreativeWorkspace.open(
        f.io,
        () => f.access.edit,
        (id) => f.access.read && f.access.blockedId !== id,
      );
      const p = w.project(mode),
        card = p.cards[0];
      const native = await prepareCreativeLayerGeneration<typeof p.source.content>(
        p,
        card,
        'candidate-1',
        { elementId: f.layer },
        { instructions: f.native.request.instructions, styleGuide: f.native.request.styleGuide },
      );
      const reads = vi.spyOn(f.artifacts, 'get');
      const prepare = () => prepareCreativeWorldInput(w, native, f.options);
      const input = await prepare();
      expect(await input.preflight()).toEqual(input.snapshot);
      expect(w.mapping).toEqual(v2);
      const context = w.worldContext('work');
      await w.saveWorldContext(context, context.revision);
      expect(() => input.serialize()).toThrow('採用前提');
      expect((await prepare()).snapshot.context.adoptions[0].revision).toBe(context.revision + 1);
      const saved = readWorkspaceLinks(await f.io.readLinks());
      expect(saved.schemaVersion).toBe(2);
      if (saved.schemaVersion !== 2) throw Error('v2 fixture changed schema');
      expect(saved.story).toEqual(story);
      expect(saved.occurrenceLinks).toEqual(occurrenceLinks);
      expect((await CreativeWorkspace.open(f.io)).mapping).toEqual(saved);
      for (const id of [story.composition, story.worldSettings, story.ledgers[0].artifactId])
        expect(reads.mock.calls.map(([id]) => id)).not.toContain(id);
    });
  for (const mode of ['character', 'setting'] as const)
    it(`requires an explicit Scene pin update after saving a new ${mode} artwork version`, async () => {
      const f = await fixture(mode, true, false),
        before = f.w.mapping;
      await expect(f.prepare()).rejects.toThrow('Scene');
      expect(f.w.mapping).toEqual(before);
      await f.alignScene();
      expect((await f.prepare()).snapshot.editorRequest).toEqual(f.native.request);
      expect(f.w.mapping.scenes.filter((s) => s.id !== f.options.sceneId)).toEqual(
        before.scenes.filter((s) => s.id !== f.options.sceneId),
      );
    });
  for (const role of ['source', 'rough', 'currentReference'] as const)
    for (const fault of ['missing-version', 'hash'] as const)
      it(`rechecks retained ${role} ${fault} at preflight instead of trusting the local Editor`, async () => {
        const f = await fixture(),
          input = await f.prepare(),
          reference = f.native.request[role];
        const a = (await f.artifacts.get(reference.artifactId))!;
        if (fault === 'missing-version')
          a.versions = a.versions.filter((v) => v.versionId !== reference.versionId);
        else
          a.versions.find((v) => v.versionId === reference.versionId)!.contentHash = '0'.repeat(64);
        await f.artifacts.put(a);
        const local = clone(f.editor.artifact);
        await expect(input.preflight()).rejects.toThrow();
        expect(f.editor.artifact).toEqual(local);
        expect(f.editor.snapshot.dirty).toBe(false);
      });
  for (const change of ['rough-version', 'rough-svg', 'current-svg'] as const)
    it(`rejects a changed public v1 ${change} copy while retaining the original preparation`, async () => {
      const f = await fixture();
      if (change === 'rough-version') f.native.request.rough.versionId = 'other-version';
      if (change === 'rough-svg') f.native.request.rough.svg = '<svg/>';
      if (change === 'current-svg') f.native.request.currentSvg = '<svg/>';
      await expect(f.prepare()).rejects.toThrow('対応');
      expect(f.editor.snapshot.dirty).toBe(false);
    });
  it('rejects a structural preparation copy with a substituted guard', async () => {
    const f = await fixture();
    await expect(
      prepareCreativeWorldInput(f.w, { ...f.native, assertCurrent() {} }, f.options),
    ).rejects.toThrow('対応');
  });
  for (const role of ['source', 'rough', 'currentReference'] as const) {
    it(`refuses a missing ${role} Artifact without changing native work`, async () => {
      const f = await fixture(),
        input = await f.prepare(),
        before = clone(f.editor.artifact);
      await f.artifacts.remove(f.native.request[role].artifactId);
      await expect(input.preflight()).rejects.toThrow('参照Artifact');
      expect(f.editor.artifact).toEqual(before);
    });
    it(`continues with the retained ${role} pin after an unrelated valid publication`, async () => {
      const f = await fixture(),
        input = await f.prepare(),
        before = input.snapshot;
      const reference = f.native.request[role],
        a = (await f.artifacts.get(reference.artifactId))!;
      await f.artifacts.put(
        await commitVersion(a, a.draft.baseVersionId, 'unrelated new saved version'),
      );
      expect(await input.preflight()).toEqual(before);
    });
  }
  for (const fault of ['missing-version', 'hash', 'new-version', 'deleted-origin'] as const)
    it(`refuses a Scene manuscript ${fault} using D3a retained-origin rules`, async () => {
      const f = await fixture(),
        input = await f.prepare(),
        origin = f.w.scene(f.options.sceneId!).origin;
      const a = (await f.artifacts.get(origin.artifactId))!;
      if (fault === 'missing-version')
        a.versions = a.versions.filter((v) => v.versionId !== origin.versionId);
      if (fault === 'hash')
        a.versions.find((v) => v.versionId === origin.versionId)!.contentHash = '0'.repeat(64);
      if (fault === 'deleted-origin')
        (a.draft.content as ReturnType<typeof createDocument>).blocks = (
          a.draft.content as ReturnType<typeof createDocument>
        ).blocks.filter((b) => b.id !== origin.elementId);
      await f.artifacts.put(
        fault === 'new-version'
          ? await commitVersion(a, a.draft.baseVersionId, 'manuscript publication')
          : a,
      );
      await expect(input.preflight()).rejects.toThrow();
      expect(f.editor.snapshot.dirty).toBe(false);
    });
  it('protects unsaved Scene manuscript work during input preflight', async () => {
    const f = await fixture(),
      input = await f.prepare(),
      scene = await f.w.openScene(f.options.sceneId!);
    scene.execute(updateBlock('port-text', { text: 'unsaved manuscript' }) as never);
    const before = clone(scene.content);
    expect(() => input.serialize()).toThrow('未保存');
    await expect(input.preflight()).rejects.toThrow('未保存');
    expect(scene.content).toEqual(before);
    expect(scene.snapshot.dirty).toBe(true);
  });
  it('preserves the native stale guard when a Project-wide save advances the shared source version', async () => {
    const f = await fixture(),
      input = await f.prepare(),
      before = input.snapshot,
      other = f.p.cards[1];
    f.p.choose(other, 'candidate-2');
    await f.p.save({ reuseSavedVersions: false });
    await f.w.refreshReference(
      f.options.sceneId!,
      'character',
      other.id,
      f.w.item(f.options.sceneId!, 'character', other.id),
    );
    expect(f.p.mapping.source.versionId).not.toBe(before.editorRequest.source.versionId);
    await expect(input.preflight()).rejects.toThrow('基準版・設定・レイヤー');
  });
  it('keeps independent candidate World adoptions separate from the selected input', async () => {
    const f = await fixture(),
      input = await f.prepare(),
      before = input.snapshot;
    const binding = f.p.binding(f.card)!;
    const ids = [
      f.w.itemContextId('character', f.p.cards[1].id)!,
      'item:' +
        canonicalJson([
          'character',
          f.p.source.id,
          f.card.id,
          binding.design.artifactId,
          'candidate-2',
        ]),
    ];
    expect(f.editor.content.elements.some((e) => e.id === 'candidate-2')).toBe(true);
    for (const id of ids) {
      await f.w.connectWorldContext(id);
      const c = f.w.worldContext(id);
      await f.w.saveWorldContext(c, c.revision);
      expect(await input.preflight()).toEqual(before);
    }
  });
  it('stops retained-source reads when editor send permission is revoked during the first await', async () => {
    const f = await fixture(),
      input = await f.prepare();
    let release!: () => void, reached!: () => void;
    const gate = new Promise<void>((r) => {
        release = r;
      }),
      started = new Promise<void>((r) => {
        reached = r;
      });
    const get = f.artifacts.get.bind(f.artifacts);
    const calls = vi.spyOn(f.artifacts, 'get').mockImplementationOnce(async (id) => {
      reached();
      await gate;
      return get(id);
    });
    const pending = input.preflight();
    await started;
    f.access.sendEditor = false;
    release();
    await expect(pending).rejects.toThrow('外部送信');
    expect(calls).toHaveBeenCalledTimes(1);
    expect(f.editor.snapshot.dirty).toBe(false);
  });
  it('refuses an image sample even when a Frame-level grant covers mixed image licenses', async () => {
    const f = await fixture(),
      src = generatedPng();
    let design = insertElement('frame', {
      id: 'mixed',
      bounds: { x: 0, y: 0, width: 100, height: 100 },
    }).apply(createDesign());
    for (const [id, license] of [
      ['allowed', 'external-send allowed'],
      ['private', 'no external send'],
    ]) {
      design = insertElement('image', {
        id,
        parentId: 'mixed',
        bounds: { x: 0, y: 0, width: 2, height: 2 },
      }).apply(design);
      design = updateElement(id, { src, provenance: { src, source: id, license } }).apply(design);
    }
    const a = await commitVersion(
      { ...createArtifact('design', 'mixed samples', design), id: 'mixed-sample' },
      null,
      'fixture',
    );
    await f.artifacts.put(a);
    await f.replace([
      {
        id: 'mixed',
        role: 'sample',
        namespace: 'harbor',
        artifactId: a.id,
        versionId: a.versions[0].versionId,
        contentHash: a.versions[0].contentHash,
        selector: { type: 'design-frame', frameId: 'mixed' },
        required: true,
      },
    ]);
    expect((await f.w.readWorld('work'))[0].svg).toContain('<image');
    const before = await f.artifacts.list();
    await expect(f.prepare({ maySendReference: () => true })).rejects.toThrow('見本');
    expect(await f.artifacts.list()).toEqual(before);
    let withoutPrivate = updateElement('private', { hidden: true }).apply(design);
    withoutPrivate = updateElement('allowed', { hidden: true }).apply(withoutPrivate);
    const hidden = await commitVersion(
      { ...a, draft: { ...a.draft, content: withoutPrivate } },
      a.draft.baseVersionId,
      'hide images',
    );
    await f.artifacts.put(hidden);
    const c = f.w.worldContext('work');
    c.references[0].versionId = hidden.draft.baseVersionId!;
    c.references[0].contentHash = hidden.versions.at(-1)!.contentHash;
    await f.w.saveWorldContext(c, c.revision);
    expect((await f.prepare()).snapshot.context.references[0].projection.value).not.toContain(
      '<image',
    );
  });
  it('does not allow consumers to relax the exported admission limits', () => {
    expect(Object.isFrozen(creativeWorldInputLimits)).toBe(true);
    expect(Reflect.set(creativeWorldInputLimits, 'envelopeBytes', Infinity)).toBe(false);
    expect(creativeWorldInputLimits.envelopeBytes).toBe(12 * 1024 * 1024);
  });
  for (const mode of ['character', 'setting'] as const)
    it(`projects the selected ${mode} context through the public API without native writes`, async () => {
      const f = await fixture(mode),
        before = await f.artifacts.list(),
        mapping = f.w.mapping;
      const input = await f.prepare(),
        snapshot = input.snapshot;
      expect(snapshot.editorRequest).toEqual(f.native.request);
      expect(snapshot.editorRequest.schemaVersion).toBe(1);
      expect(snapshot.editorRequest.styleGuide).toBe('今回の共通編集指示');
      expect(
        snapshot.context.references.find((r) => r.reference.role === 'facts')?.projection.value,
      ).toContain('潮見の街');
      expect(snapshot.context.scope.candidateContextId).toBe(f.w.itemContextId(mode, f.card.id));
      expect(snapshot.context.adoptions.map((a) => a.id)).toEqual([
        'work',
        f.options.sceneId,
        f.w.itemContextId(mode, f.card.id),
      ]);
      expect(await readCreativeWorldContext(snapshot.context)).toEqual(snapshot.context);
      expect(await input.preflight()).toEqual(snapshot);
      expect(JSON.parse(input.serialize())).toEqual(snapshot);
      expect(createHash('sha256').update(input.serialize()).digest('hex')).toBe(input.payloadHash);
      snapshot.context.references[0].projection.value = 'provider mutation';
      snapshot.editorRequest.target.address.elementId = 'another target';
      expect(input.snapshot).not.toEqual(snapshot);
      expect(await f.artifacts.list()).toEqual(before);
      expect(f.w.mapping).toEqual(mapping);
      expect(f.editor.snapshot.dirty).toBe(false);
    });
  it('requires explicit candidate context and exact request/candidate/Scene correspondence', async () => {
    const f = await fixture('character', false);
    await expect(f.prepare()).rejects.toThrow('採用前提がありません');
    await f.w.connectWorldContext(f.w.itemContextId('character', f.card.id)!);
    await expect(f.prepare({ itemId: f.p.cards[1].id })).rejects.toThrow('対応');
    const native = clone(f.native.request);
    f.native.request.frameId = 'candidate-2';
    await expect(f.prepare()).rejects.toThrow('対応');
    f.native.request.frameId = native.frameId;
    const setting = await fixture('setting');
    await expect(setting.prepare({ sceneId: 'SC-01' })).rejects.toThrow('接続されていません');
  });
  it('does not send same-named references from a different namespace', async () => {
    const f = await fixture(),
      refs = await f.material('one work only');
    const other = clone((await f.artifacts.get(refs[0].artifactId))!);
    other.id = 'other-work:same-name';
    await f.artifacts.put(other);
    await f.replace(refs);
    const input = await f.prepare();
    expect(input.serialize()).toContain('one work only');
    expect(input.serialize()).not.toContain(other.id);
    const invalid = input.snapshot.context;
    invalid.references[0].reference.namespace = 'other-work';
    await expect(readCreativeWorldContext(invalid)).rejects.toThrow('namespace');
  });
  it('keeps old adopted versions when a new native version is published', async () => {
    const f = await fixture(),
      input = await f.prepare(),
      snapshot = input.snapshot;
    const r = snapshot.context.references[0].reference,
      a = (await f.artifacts.get(r.artifactId))!;
    const next = clone(a);
    (next.draft.content as ReturnType<typeof createDocument>).blocks[0].text =
      'new facts, not adopted';
    await f.artifacts.put(await commitVersion(next, r.versionId, 'new version'));
    expect(await input.preflight()).toEqual(snapshot);
    expect(input.serialize()).not.toContain('new facts, not adopted');
    expect(input.snapshot.context.references[0].reference.versionId).toBe(r.versionId);
  });
  it('rejects explicit adoption revision changes even when the fingerprint stays identical', async () => {
    const f = await fixture(),
      old = await f.prepare(),
      before = old.snapshot;
    const c = f.w.worldContext('work');
    await f.w.saveWorldContext(c, c.revision);
    expect(() => old.snapshot).toThrow('採用前提');
    await expect(old.preflight()).rejects.toThrow('採用前提');
    const current = await f.prepare();
    expect(current.snapshot.context.fingerprint).toBe(before.context.fingerprint);
    expect(current.snapshot.context.adoptions).not.toEqual(before.context.adoptions);
  });
  it('ignores another Scene context revision while preserving own Scene checks', async () => {
    const f = await fixture(),
      input = await f.prepare(),
      before = input.snapshot;
    const other = f.w.worldContext('SC-02');
    await f.w.saveWorldContext(other, other.revision);
    expect(await input.preflight()).toEqual(before);
    const own = f.w.worldContext('SC-01');
    await f.w.saveWorldContext(own, own.revision);
    expect(() => input.serialize()).toThrow('採用前提');
  });
  it('does not invalidate own input while an unrelated Scene association save is pending', async () => {
    const f = await fixture(),
      input = await f.prepare(),
      before = input.serialize();
    let release!: () => void, reached!: () => void;
    const gate = new Promise<void>((r) => {
        release = r;
      }),
      started = new Promise<void>((r) => {
        reached = r;
      });
    const write = f.io.writeLinks.bind(f.io);
    vi.spyOn(f.io, 'writeLinks').mockImplementationOnce(async (...args) => {
      reached();
      await gate;
      await write(...args);
    });
    const other = f.w.worldContext('SC-02');
    const pending = f.w.saveWorldContext(other, other.revision);
    await started;
    expect(f.w.canEditWorld).toBe(false);
    expect(f.w.canPrepareWorldInput).toBe(true);
    expect(input.serialize()).toBe(before);
    expect(await input.preflight()).toEqual(input.snapshot);
    release();
    await pending;
    expect(input.serialize()).toBe(before);
  });
  for (const permission of ['send', 'sendEditor', 'read', 'edit', 'active'] as const)
    it(`refuses revoked ${permission} before any context fetch and on every access`, async () => {
      const f = await fixture(),
        input = await f.prepare(),
        get = vi.spyOn(f.artifacts, 'get');
      f.access[permission] = false;
      await expect(f.prepare()).rejects.toThrow();
      expect(get).not.toHaveBeenCalled();
      expect(() => input.snapshot).toThrow();
      expect(() => input.serialize()).toThrow();
      expect(() => input.payloadHash).toThrow();
      await expect(input.preflight()).rejects.toThrow();
      expect(get).not.toHaveBeenCalled();
    });
  it('rejects permission loss during a delayed retained-version read', async () => {
    const f = await fixture();
    let release!: () => void, reached!: () => void;
    const gate = new Promise<void>((r) => {
        release = r;
      }),
      started = new Promise<void>((r) => {
        reached = r;
      });
    const get = f.artifacts.get.bind(f.artifacts);
    vi.spyOn(f.artifacts, 'get').mockImplementation(async (id) => {
      if (id === 'cw1:harbor:facts') {
        reached();
        await gate;
      }
      return get(id);
    });
    const pending = f.prepare();
    await started;
    f.access.send = false;
    release();
    await expect(pending).rejects.toThrow('外部送信');
  });
  it('rejects a switched Host after a delayed preflight and protects the newer preparation', async () => {
    const f = await fixture(),
      old = await f.prepare();
    let activeEpoch = 0,
      release!: () => void,
      reached!: () => void;
    const scoped = await f.prepare({
      assertActive() {
        if (activeEpoch !== 0) throw Error('switched Host');
      },
    });
    const gate = new Promise<void>((r) => {
        release = r;
      }),
      started = new Promise<void>((r) => {
        reached = r;
      });
    const get = f.artifacts.get.bind(f.artifacts);
    vi.spyOn(f.artifacts, 'get').mockImplementationOnce(async (id) => {
      reached();
      await gate;
      return get(id);
    });
    const pending = scoped.preflight();
    await started;
    activeEpoch++;
    const current = await f.prepare();
    const before = current.serialize();
    release();
    await expect(pending).rejects.toThrow('switched Host');
    expect(current.serialize()).toBe(before);
    expect(old.snapshot).toEqual(current.snapshot);
    expect(f.editor.snapshot.dirty).toBe(false);
  });
  it('checks current read permission for CH/LO and native images independently of world materials', async () => {
    const f = await fixture(),
      input = await f.prepare();
    f.access.blockedId = f.native.request.source.artifactId;
    expect(() => input.snapshot).toThrow('閲覧権限');
    const get = vi.spyOn(f.artifacts, 'get');
    await expect(input.preflight()).rejects.toThrow('閲覧権限');
    expect(get).not.toHaveBeenCalled();
  });
  it('rejects adoption switching during a delayed read without changing native state', async () => {
    const f = await fixture(),
      before = clone(f.editor.artifact);
    let release!: () => void, reached!: () => void;
    const gate = new Promise<void>((r) => {
        release = r;
      }),
      started = new Promise<void>((r) => {
        reached = r;
      });
    const get = f.artifacts.get.bind(f.artifacts);
    vi.spyOn(f.artifacts, 'get').mockImplementationOnce(async (id) => {
      reached();
      await gate;
      return get(id);
    });
    const pending = f.prepare();
    await started;
    const c = f.w.worldContext('work');
    await f.w.saveWorldContext({ ...c, references: [] }, c.revision);
    release();
    await expect(pending).rejects.toThrow('採用前提');
    expect(f.editor.artifact).toEqual(before);
  });
  for (const fault of ['artifact', 'version', 'element', 'hash', 'optional'] as const)
    it(`rejects missing/invalid ${fault} on preflight, never substitutes latest`, async () => {
      const f = await fixture(),
        input = await f.prepare();
      const ref = input.snapshot.context.references.find((r) =>
        fault === 'optional' ? !r.reference.required : r.reference.role === 'facts',
      )!.reference;
      const a = (await f.artifacts.get(ref.artifactId))!;
      if (fault === 'artifact' || fault === 'optional') await f.artifacts.remove(a.id);
      else {
        if (fault === 'version') a.versions = [];
        else if (fault === 'hash') a.versions[0].contentHash = '0'.repeat(64);
        else (a.versions[0].content as ReturnType<typeof createDocument>).blocks = [];
        await f.artifacts.put(a);
      }
      await expect(input.preflight()).rejects.toThrow('採用資料');
      expect(f.editor.snapshot.dirty).toBe(false);
    });
  it('retains native revision/lock guards and the current CW1 world execution refusal', async () => {
    const f = await fixture(),
      input = await f.prepare();
    f.p.execute(f.card, updateElement(f.layer, { locked: true }));
    expect(() => input.serialize()).toThrow();
    await expect(input.preflight()).rejects.toThrow();
    expect(() => assertWorldGenerationAvailable()).toThrow('CW2未接続');
    await expect(
      prepareCreativeLayerGeneration<typeof f.p.source.content>(
        f.p,
        f.card,
        'candidate-1',
        { elementId: f.layer },
        { context: 'world', instructions: 'test' },
      ),
    ).rejects.toThrow('CW2未接続');
  });
  it('accepts 64 qualified references and rejects a 65th without changes', async () => {
    const f = await fixture(),
      scene = f.w.worldContext('SC-01');
    await f.w.saveWorldContext({ ...scene, references: [] }, scene.revision);
    await f.replace(await f.material('small projection', 64));
    const input = await f.prepare();
    expect(input.snapshot.context.references).toHaveLength(64);
    const bad = input.snapshot.context;
    bad.references.push(clone(bad.references[0]));
    await expect(readCreativeWorldContext(bad)).rejects.toThrow();
    expect(input.snapshot.context.references).toHaveLength(64);
  });
  it('counts UTF-8 text bytes and never truncates a 64KiB overflow', async () => {
    const f = await fixture(),
      scene = f.w.worldContext('SC-01');
    await f.w.saveWorldContext({ ...scene, references: [] }, scene.revision);
    await f.replace(await f.material('あ'.repeat(21845) + 'a'));
    const input = await f.prepare();
    expect(Buffer.byteLength(input.snapshot.context.references[0].projection.value)).toBe(65536);
    await f.replace(await f.material('あ'.repeat(21845) + 'ab'));
    const before = await f.artifacts.list();
    await expect(f.prepare()).rejects.toThrow('64KiB');
    expect(await f.artifacts.list()).toEqual(before);
  });
  it('accepts eight selected sample Frames and refuses a ninth before reading any native', async () => {
    const f = await fixture();
    let design = createDesign();
    for (let i = 0; i < 9; i++)
      design = insertElement('frame', {
        id: `frame-${i}`,
        bounds: { x: i * 20, y: 0, width: 10, height: 10 },
      }).apply(design);
    const a = await commitVersion(
      { ...createArtifact('design', 'samples', design), id: 'harbor:nine-samples' },
      null,
      'fixture',
    );
    await f.artifacts.put(a);
    const refs = Array.from(
      { length: 9 },
      (_, i): WorldReference => ({
        id: `sample-${i}`,
        role: 'sample',
        namespace: 'harbor',
        artifactId: a.id,
        versionId: a.versions[0].versionId,
        contentHash: a.versions[0].contentHash,
        required: true,
        selector: { type: 'design-frame', frameId: `frame-${i}` },
      }),
    );
    await f.replace(refs.slice(0, 8));
    expect(
      (await f.prepare()).snapshot.context.references.filter((r) => r.reference.role === 'sample'),
    ).toHaveLength(8);
    await f.replace(refs);
    const get = vi.spyOn(f.artifacts, 'get');
    await expect(f.prepare()).rejects.toThrow('8件');
    expect(get).not.toHaveBeenCalled();
  });
  it('bounds the entire canonical envelope at exactly 12MiB including context', async () => {
    const f = await fixture(),
      baseline = (await f.prepare()).snapshot;
    baseline.editorRequest.currentSvg = '';
    const padding =
      creativeWorldInputLimits.envelopeBytes - Buffer.byteLength(canonicalJson(baseline));
    baseline.editorRequest.currentSvg = 'x'.repeat(padding);
    const serialized = serializeCreativeWorldInput(baseline);
    expect(Buffer.byteLength(serialized)).toBe(creativeWorldInputLimits.envelopeBytes);
    baseline.editorRequest.currentSvg += 'x';
    expect(() => serializeCreativeWorldInput(baseline)).toThrow('12MiB');
    expect(Buffer.byteLength(serialized)).toBe(creativeWorldInputLimits.envelopeBytes);
    expect(f.editor.snapshot.dirty).toBe(false);
  });
  for (const change of [
    'unknown',
    'selector',
    'duplicate',
    'domain',
    'projection',
    'fingerprint',
    'revision',
  ] as const)
    it(`validates a closed snapshot and rejects ${change}`, async () => {
      const f = await fixture(),
        input = await f.prepare(),
        bad = input.snapshot.context;
      if (change === 'unknown') Object.assign(bad.scope, { world: true });
      if (change === 'selector')
        Object.assign(bad.references[0].reference.selector, { type: 'jsonpath' });
      if (change === 'duplicate') bad.references.push(clone(bad.references[0]));
      if (change === 'domain') bad.references[0].projection.kind = 'svg';
      if (change === 'projection') bad.references[0].projection.value = 'changed';
      if (change === 'fingerprint') bad.fingerprint = '0'.repeat(64);
      if (change === 'revision') bad.adoptions[0].revision = -1;
      await expect(readCreativeWorldContext(bad)).rejects.toThrow();
      expect(await input.preflight()).toEqual(input.snapshot);
    });
});
