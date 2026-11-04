import { describe, expect, it, vi } from 'vitest';
import {
  canonicalJson,
  clone,
  contentHash,
  MemoryStorage,
  type Artifact,
} from '@editor-platform/artifact-core';
import * as capacity from './generation-capacity';
import { isCreativeWorldLayerProposal } from '../generation';
import { updateBlock } from '@editor-platform/document/model';
import type { CreativeProject } from '../project';
import { updateElement, insertElement, type DesignContent } from '@editor-platform/design/model';
import {
  addCreativeGenerationLayer,
  generateCreativeLayer,
  prepareCreativeLayerGeneration,
} from '@editor-platform/reference-artifact-host/creative';
import {
  CreativeWorkspace,
  createHarborWorkspace,
  CreativeWorldGenerationConnection,
  createCreativeWorldResultManifest,
  readCreativeWorldExecutionRecord,
  createCreativeWorldHttpProvider,
  type CreativeWorkspaceStorage,
  type CreativeWorldRecordStorage,
  type CreativeWorldExecutionRecord,
  type CreativeWorldProvider,
} from '@editor-platform/reference-artifact-host/creative/workspace';
import { generatedPng } from '../../../../../tests/fixtures/creative-host/generated-png';

async function fixture(mode: 'character' | 'setting' = 'character', large = false) {
  const artifacts = new MemoryStorage<Artifact<unknown>>(),
    maps: Record<string, unknown> = {};
  let links: unknown;
  const access = {
    edit: true,
    read: true,
    roughRead: true,
    currentRead: true,
    send: true,
    imageSend: true,
    active: true,
  };
  const deniedReads = new Set<string>();
  const failures = {
    record: '',
    ack: '',
    mapping: false,
    applyingGate: undefined as { entered(): void; wait: Promise<void> } | undefined,
  };
  const rows = new Map<string, CreativeWorldExecutionRecord>();
  const io: CreativeWorkspaceStorage = {
    artifacts,
    creative: (mode) => ({
      artifacts,
      readMapping: async () => clone(maps[mode]),
      writeMapping: async (value) => {
        if (failures.mapping) throw Error('mapping failed');
        maps[mode] = clone(value);
      },
    }),
    readLinks: async () => clone(links),
    writeLinks: async (value, expected) => {
      if (expected && canonicalJson(expected) !== canonicalJson(links)) throw Error('conflict');
      links = clone(value);
    },
  };
  await createHarborWorkspace(io);
  const w = await CreativeWorkspace.open(
      io,
      () => access.edit,
      (id) => access.read && !deniedReads.has(id),
    ),
    p = w.project(mode) as CreativeProject<unknown>,
    card = p.cards[0],
    editor = p.editor(card)!;
  await p.save({ rough: { itemId: card.id, frameId: 'candidate-1' } });
  const layer = addCreativeGenerationLayer(p, card, 'candidate-1', 'part', {
    x: 1,
    y: 1,
    width: 2,
    height: 2,
  });
  if (large) {
    const frame = editor.content.elements.find((e) => e.id === 'candidate-1')!;
    p.execute(
      card,
      updateElement(frame.id, { bounds: { ...frame.bounds, width: 1024, height: 1024 } }),
    );
    p.execute(
      card,
      updateElement(layer, {
        bounds: { x: frame.bounds.x, y: frame.bounds.y, width: 1024, height: 1024 },
      }),
    );
  }
  await p.save();
  await w.connectWorldContext(w.itemContextId(mode, card.id)!);
  const sceneId = mode === 'character' ? 'SC-01' : 'SC-02';
  await w.refreshReference(sceneId, mode, card.id, w.item(sceneId, mode, card.id));
  const records: CreativeWorldRecordStorage = {
    list: async (namespace, id) =>
      [...rows.values()]
        .filter((r) => r.namespace === namespace && r.scope.artifactId === id)
        .map(clone),
    write: async (raw, expected) => {
      const next = readCreativeWorldExecutionRecord(raw),
        current = rows.get(next.operationId);
      if (next.state === 'applying' && failures.applyingGate) {
        failures.applyingGate.entered();
        await failures.applyingGate.wait;
      }
      if (!access.edit) throw Error('record forbidden');
      if (next.state === failures.record) throw Error('record failed');
      if ((current?.revision ?? null) !== expected) throw Error('record conflict');
      rows.set(next.operationId, clone(next));
      if (next.state === failures.ack) {
        failures.ack = '';
        throw Error('record response lost');
      }
    },
  };
  const provider: CreativeWorldProvider = {
    capability: 'creative-world-v1',
    label: 'fixed fixture',
    generate: vi.fn(async (dispatch) => ({
      requestId: dispatch.input.editorRequest.id,
      src: generatedPng(),
      source: 'fixed fixture',
      license: 'test grant',
    })),
  };
  const connection = new CreativeWorldGenerationConnection(w, {
    records,
    provider,
    assertActive() {
      if (!access.active) throw Error('inactive');
    },
    maySendEditorRequest: () => access.send,
    maySendReference: () => access.send,
    maySendSampleImage: () => access.imageSend,
  });
  const native = () =>
    prepareCreativeLayerGeneration(
      p,
      card,
      'candidate-1',
      { elementId: layer },
      {
        instructions: '部位だけ清書',
        scale: large ? 2 : 1,
        styleGuide: '今回の指示',
        mayRead: () => access.roughRead && access.currentRead,
      },
    );
  const prepare = async () => connection.prepare(await native(), { sceneId });
  return {
    w,
    p,
    card,
    editor,
    layer,
    sceneId,
    artifacts,
    io,
    access,
    deniedReads,
    records,
    rows,
    provider,
    failures,
    connection,
    native,
    prepare,
  };
}

describe('CW2 World execution, native acceptance and saved usage', () => {
  it('refuses a native history change during the final asynchronous record write through the existing binding guard without another generation', async () => {
    const f = await fixture(),
      run = await f.prepare();
    await run.generate(new AbortController().signal);
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.failures.applyingGate = {
      entered,
      wait: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };
    const before = clone(f.editor.content),
      revision = f.editor.revision;
    const work = run.accept();
    await waiting;
    await f.editor.save({ commitVersion: true });
    release();
    await expect(work).rejects.toThrow('設定画の保存版が対応表と異なります');
    expect(f.editor.content).toEqual(before);
    expect(f.editor.revision).toEqual(revision);
    expect(f.rows.get(run.operationId)?.applied).toBeUndefined();
    f.failures.applyingGate = undefined;
    expect(f.provider.generate).toHaveBeenCalledTimes(1);
  });
  it('refuses an obviously oversized world generation and export before provider dispatch without changing native state', async () => {
    const f = await fixture('character', true),
      run = await f.prepare();
    const content = clone(f.editor.content),
      artifact = f.editor.artifact,
      revision = f.editor.revision;
    const proposals = f.editor.proposals;
    await expect(run.generate(new AbortController().signal)).rejects.toThrow('容量見積り');
    await expect(run.export()).rejects.toThrow('容量見積り');
    expect(f.provider.generate).not.toHaveBeenCalled();
    expect(f.editor.artifact).toEqual(artifact);
    expect(f.editor.content).toEqual(content);
    expect(f.editor.revision).toEqual(revision);
    expect(f.editor.proposals).toEqual(proposals);
    expect(f.rows.get(run.operationId)?.state).toBe('prepared');
  });
  it('retains a normalized result when native capacity refuses it, without apply, Undo or a second provider call', async ({
    onTestFinished,
  }) => {
    const f = await fixture(),
      run = await f.prepare();
    // The real 64 MiB/exact-next-byte boundary and retained history are tested in
    // generation-capacity.test.ts. Inject only this refusal to exercise the retry
    // lifecycle without repeatedly cloning a near-limit envelope through every step.
    const refusal = vi
      .spyOn(capacity, 'checkWorldResultCapacity')
      .mockRejectedValue(Error('生成結果を含む保存候補がnative容量上限を超えています。'));
    onTestFinished(() => refusal.mockRestore());
    const src = generatedPng();
    vi.mocked(f.provider.generate).mockResolvedValue({
      requestId: run.identity.requestId,
      src,
      source: 'large fixture',
      license: 'test grant',
    });
    const content = clone(f.editor.content),
      artifact = f.editor.artifact,
      revision = f.editor.revision;
    const canUndo = f.editor.canUndo;
    await expect(run.generate(new AbortController().signal)).rejects.toThrow('保存候補');
    expect(refusal).toHaveBeenCalled();
    expect(run.view).toMatchObject({ applied: false, record: { state: 'preview' } });
    const proposalId = run.view.proposalId!;
    expect(
      f.editor.proposals
        .find((p) => p.id === proposalId)
        ?.preview.content.elements.find((e) => e.id === f.layer)?.src,
    ).toBe(src);
    await expect(run.accept()).rejects.toThrow('保存候補');
    await expect(run.generate(new AbortController().signal)).rejects.toThrow('保存候補');
    expect(f.provider.generate).toHaveBeenCalledTimes(1);
    expect(f.editor.artifact).toEqual(artifact);
    expect(f.editor.content).toEqual(content);
    expect(f.editor.revision).toEqual(revision);
    expect(f.editor.canUndo).toBe(canUndo);
    expect(f.rows.get(run.operationId)?.usages).toEqual([]);
    await run.reject();
    expect(f.editor.proposals).toEqual([]);
  }, 30_000);
  for (const mode of ['character', 'setting'] as const)
    it(`${mode}: prepares, previews, accepts, saves and reloads without changing adoption pins`, async () => {
      const f = await fixture(mode),
        pins = clone(f.w.mapping.world),
        before = clone(f.editor.content);
      const run = await f.prepare();
      expect(f.rows.get(run.operationId)?.state).toBe('prepared');
      expect(run.view.input.context.references.length).toBeGreaterThan(0);
      const review = await run.generate(new AbortController().signal);
      expect(f.editor.content).toEqual(before);
      expect(f.rows.get(run.operationId)?.state).toBe('preview');
      expect(() => f.editor.acceptProposal(review.id)).toThrow('正式');
      expect(() => f.editor.execute(review.preview.proposal.commands[0])).toThrow('正式');
      const revision = f.editor.revision.sequence;
      await run.accept();
      expect(f.editor.revision.sequence).toBe(revision + 1);
      expect(f.rows.get(run.operationId)?.state).toBe('applied');
      expect(f.rows.get(run.operationId)?.usages).toEqual([]);
      await run.save();
      const saved = f.rows.get(run.operationId)!;
      expect(saved.usages).toHaveLength(1);
      expect(saved.usages[0].versionId).toBe(f.editor.artifact.draft.baseVersionId);
      expect(saved.usages[0].contentHash).toBe(f.editor.artifact.versions.at(-1)?.contentHash);
      expect(f.w.mapping.world).toEqual(pins);
      f.connection.dispose();
      const reopened = await CreativeWorkspace.open(f.io),
        again = new CreativeWorldGenerationConnection(reopened, {
          records: f.records,
          assertActive() {},
          maySendEditorRequest: () => true,
          maySendReference: () => true,
        });
      const history = await again.history(f.editor.id);
      expect(history[0]).toMatchObject({ confirmed: true, retained: true });
      expect(history[0].record.usages).toEqual(saved.usages);
      expect(reopened.mapping.world).toEqual(pins);
      expect(reopened.project(mode).editor(f.card)!.proposalTransactions).toEqual([]);
      again.dispose();
    });
  it('refuses bare v1 send and native preview once a request is World-bound', async () => {
    const f = await fixture(),
      native = await f.native();
    await f.connection.prepare(native, { sceneId: f.sceneId });
    const bare = { generate: vi.fn() };
    await expect(generateCreativeLayer(native, bare, new AbortController().signal)).rejects.toThrow(
      '裸のv1',
    );
    expect(bare.generate).not.toHaveBeenCalled();
    expect(() =>
      native.preview({
        requestId: native.request.id,
        src: generatedPng(),
        source: 'fixture',
        license: 'test',
      }),
    ).toThrow('World対応Host');
    expect(f.editor.proposals).toEqual([]);
  });
  it('keeps an unrecorded apply on record failure and retries without another native apply', async () => {
    const f = await fixture(),
      run = await f.prepare();
    await run.generate(new AbortController().signal);
    f.failures.record = 'applied';
    const before = f.editor.revision.sequence;
    await expect(run.accept()).rejects.toThrow('record failed');
    expect(f.editor.revision.sequence).toBe(before + 1);
    expect(run.view).toMatchObject({ applied: true, dirty: true });
    f.failures.record = '';
    await run.accept();
    expect(f.editor.revision.sequence).toBe(before + 1);
    expect(f.rows.get(run.operationId)?.state).toBe('applied');
  });
  it('acknowledges a lost record response idempotently', async () => {
    const f = await fixture();
    f.failures.ack = 'prepared';
    const run = await f.prepare();
    expect(f.rows.size).toBe(1);
    expect(f.rows.get(run.operationId)?.revision).toBe(1);
    await run.retryRecord();
    expect(f.rows.get(run.operationId)?.revision).toBe(1);
  });
  it('reuses the same prepared operation after initial record failure', async () => {
    const f = await fixture(),
      native = await f.native();
    f.failures.record = 'prepared';
    await expect(f.connection.prepare(native, { sceneId: f.sceneId })).rejects.toThrow(
      'record failed',
    );
    f.failures.record = '';
    const run = await f.connection.prepare(native, { sceneId: f.sceneId });
    expect(f.rows.size).toBe(1);
    expect(f.rows.get(run.operationId)?.state).toBe('prepared');
  });
  for (const change of ['adoption', 'send', 'read', 'active', 'edit'] as const)
    it(`refuses a previewed result after ${change} changes`, async () => {
      const f = await fixture(),
        run = await f.prepare();
      await run.generate(new AbortController().signal);
      const before = clone(f.editor.content),
        revision = f.editor.revision;
      if (change === 'adoption') {
        const c = f.w.worldContext('work');
        await f.w.saveWorldContext(c, c.revision);
      } else f.access[change] = false;
      await expect(run.accept()).rejects.toThrow();
      expect(f.editor.content).toEqual(before);
      expect(f.editor.revision).toEqual(revision);
      expect(f.rows.get(run.operationId)?.applied).toBeUndefined();
    });
  it('never counts pre-save Undo or saved drafts as immutable usage; Redo restores the native witness', async () => {
    const f = await fixture(),
      run = await f.prepare();
    await run.generate(new AbortController().signal);
    await run.accept();
    f.editor.undo();
    await f.editor.save({ commitVersion: true });
    await f.connection.flush();
    expect(f.rows.get(run.operationId)?.usages).toEqual([]);
    f.editor.redo();
    await f.editor.save();
    await f.connection.flush();
    expect(f.rows.get(run.operationId)?.usages).toEqual([]);
    await f.editor.save({ commitVersion: true });
    await f.connection.flush();
    expect(f.rows.get(run.operationId)?.usages).toHaveLength(1);
  });
  it('keeps old saved usage after Undo and carries a confirmed base through reload and geometry edits', async () => {
    const f = await fixture(),
      run = await f.prepare();
    await run.generate(new AbortController().signal);
    await run.accept();
    await run.save();
    const first = clone(f.rows.get(run.operationId)!.usages[0]);
    f.editor.undo();
    await f.editor.save({ commitVersion: true });
    await f.connection.flush();
    expect(f.rows.get(run.operationId)?.usages).toEqual([first]);
    f.editor.redo();
    await f.editor.save({ commitVersion: true });
    await f.connection.flush();
    // Direct native save does not update the Project's separate reference table.
    await f.p.save({ reuseSavedVersions: true });
    f.connection.dispose();
    const w = await CreativeWorkspace.open(f.io),
      p = w.characters,
      editor = p.editor(f.card)!;
    const connection = new CreativeWorldGenerationConnection(w, {
      records: f.records,
      assertActive() {},
      maySendEditorRequest: () => true,
      maySendReference: () => true,
    });
    await connection.history(editor.id);
    p.execute(f.card, updateElement(f.layer, { opacity: 0.7 }));
    await p.save({ reuseSavedVersions: true });
    await connection.flush();
    expect(f.rows.get(run.operationId)!.usages.at(-1)).toMatchObject({
      versionId: editor.artifact.draft.baseVersionId,
      derived: true,
    });
    expect(f.rows.get(run.operationId)!.usages[0]).toEqual(first);
  });
  it('saves native once when the mapping fails and retries reference storage', async () => {
    const f = await fixture(),
      run = await f.prepare();
    await run.generate(new AbortController().signal);
    await run.accept();
    f.failures.mapping = true;
    await expect(run.save()).rejects.toThrow('mapping failed');
    const versions = f.editor.artifact.versions.length;
    f.failures.mapping = false;
    await run.save();
    expect(f.editor.artifact.versions).toHaveLength(versions);
    expect(f.rows.get(run.operationId)?.usages).toHaveLength(1);
  });
  it('requires an exact external manifest, PNG hash and current permissions', async () => {
    const f = await fixture(),
      run = await f.prepare(),
      src = generatedPng();
    const result = {
      requestId: run.identity.requestId,
      src,
      source: 'external',
      license: 'test grant',
    };
    const manifest = await createCreativeWorldResultManifest(run.identity, result);
    const other = clone(manifest);
    other.identity.operationId = 'another-operation';
    await expect(run.importPng(src, other)).rejects.toThrow('一致');
    await expect(run.importPng(src, { ...manifest, unknown: true })).rejects.toThrow('不正');
    await run.importPng(src, manifest);
    await run.accept();
    expect(f.rows.get(run.operationId)?.applied).toBeDefined();
  });
  it('cancel ends local waiting and ignores a provider that later resolves', async () => {
    const f = await fixture();
    let resolve!: (v: unknown) => void;
    const provider: CreativeWorldProvider = {
      capability: 'creative-world-v1',
      label: 'slow',
      generate: () =>
        new Promise((r) => {
          resolve = r;
        }),
    };
    const connection = new CreativeWorldGenerationConnection(f.w, {
      records: f.records,
      provider,
      assertActive() {},
      maySendEditorRequest: () => true,
      maySendReference: () => true,
    });
    const run = await connection.prepare(await f.native(), { sceneId: f.sceneId }),
      controller = new AbortController();
    const work = run.generate(controller.signal);
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    controller.abort();
    await expect(work).rejects.toThrow('中止');
    resolve({
      requestId: run.identity.requestId,
      src: generatedPng(),
      source: 'late',
      license: 'test',
    });
    await Promise.resolve();
    expect(f.editor.proposals).toEqual([]);
  });
  it('probes World capability before sending data and sends exactly the guarded envelope', async () => {
    const f = await fixture(),
      calls: RequestInit[] = [];
    const fetcher = vi.fn(async (_url: unknown, init: RequestInit | undefined) => {
      calls.push(init!);
      if (init?.method === 'OPTIONS')
        return new Response(null, { headers: { 'X-Creative-World-Contract': '1' } });
      const input = JSON.parse(init!.body as string);
      return new Response(
        JSON.stringify({
          requestId: input.editorRequest.id,
          src: generatedPng(),
          source: 'HTTP fixture',
          license: 'test',
        }),
        { headers: { 'X-Creative-World-Contract': '1' } },
      );
    });
    const provider = createCreativeWorldHttpProvider('/world', fetcher as unknown as typeof fetch);
    const connection = new CreativeWorldGenerationConnection(f.w, {
      records: f.records,
      provider,
      assertActive() {},
      maySendEditorRequest: () => true,
      maySendReference: () => true,
    });
    const run = await connection.prepare(await f.native(), { sceneId: f.sceneId });
    await run.generate(new AbortController().signal);
    expect(calls.map((c) => c.method)).toEqual(['OPTIONS', 'POST']);
    expect(JSON.parse(calls[1].body as string)).toEqual(run.view.input);
    expect(JSON.parse(calls[1].body as string).editorRequest.styleGuide).toBe('今回の指示');
    expect(calls[1].headers).toMatchObject({ 'Idempotency-Key': run.identity.operationId });
  });
  it('refuses a non-World endpoint without sending a World body or bare v1', async () => {
    const f = await fixture(),
      fetcher = vi.fn(async () => new Response(null));
    const provider = createCreativeWorldHttpProvider('/legacy', fetcher as unknown as typeof fetch);
    const connection = new CreativeWorldGenerationConnection(f.w, {
      records: f.records,
      provider,
      assertActive() {},
      maySendEditorRequest: () => true,
      maySendReference: () => true,
    });
    const run = await connection.prepare(await f.native(), { sceneId: f.sceneId });
    await expect(run.generate(new AbortController().signal)).rejects.toThrow('対応');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('CW2 boundary regressions', () => {
  it('serializes concurrent preparation of one original request into one operation', async () => {
    const f = await fixture(),
      native = await f.native();
    const [a, b] = await Promise.all([
      f.connection.prepare(native, { sceneId: f.sceneId }),
      f.connection.prepare(native, { sceneId: f.sceneId }),
    ]);
    expect(a).toBe(b);
    expect(f.rows.size).toBe(1);
  });
  it('does not dispatch when the prepared execution record cannot be saved', async () => {
    const f = await fixture();
    f.failures.record = 'prepared';
    await expect(f.prepare()).rejects.toThrow('record failed');
    expect(f.provider.generate).not.toHaveBeenCalled();
    expect(f.editor.proposals).toEqual([]);
  });
  it('retries a preview record failure without another provider call or proposal', async () => {
    const f = await fixture(),
      run = await f.prepare();
    f.failures.record = 'preview';
    await expect(run.generate(new AbortController().signal)).rejects.toThrow('record failed');
    const ids = f.editor.proposals.map((p) => p.id);
    expect(ids).toHaveLength(1);
    expect(() => f.editor.acceptProposal(ids[0])).toThrow('正式');
    f.failures.record = '';
    await run.generate(new AbortController().signal);
    expect(f.provider.generate).toHaveBeenCalledTimes(1);
    expect(f.editor.proposals.map((p) => p.id)).toEqual(ids);
    await run.accept();
    expect(f.editor.proposalTransactions).toHaveLength(1);
  });
  it('refuses adoption changed during applying-record persistence before native commit', async () => {
    const f = await fixture(),
      run = await f.prepare();
    await run.generate(new AbortController().signal);
    let done!: () => void;
    const original = f.records.write;
    // The connection captures storage methods, so make a second explicit connection.
    const c = new CreativeWorldGenerationConnection(f.w, {
      ...f.connection.options,
      records: {
        ...f.records,
        write: async (r, e) => {
          if (r.state === 'applying')
            await new Promise<void>((resolve) => {
              done = resolve;
            });
          await original(r, e);
        },
      },
    });
    const other = await c.prepare(await f.native(), { sceneId: f.sceneId });
    await other.generate(new AbortController().signal);
    const before = clone(f.editor.content),
      work = other.accept();
    await vi.waitFor(() => expect(done).toBeTypeOf('function'));
    const adopted = f.w.worldContext('work');
    await f.w.saveWorldContext(adopted, adopted.revision);
    done();
    await expect(work).rejects.toThrow('採用前提');
    expect(f.editor.content).toEqual(before);
    expect(f.editor.proposalTransactions).toEqual([]);
  });
  it('keeps prior usage and records an explicitly inherited result as derived', async () => {
    const f = await fixture(),
      first = await f.prepare();
    await first.generate(new AbortController().signal);
    await first.accept();
    // Two applies to this same part: only the current raster can be used by the saved version.
    await f.p.save({ reuseSavedVersions: true });
    await f.connection.flush();
    await f.w.refreshReference(
      f.sceneId,
      'character',
      f.card.id,
      f.w.item(f.sceneId, 'character', f.card.id),
    );
    const next = await f.prepare();
    await next.importPng(
      generatedPng(2, 2, false, false, 1),
      await createCreativeWorldResultManifest(next.identity, {
        requestId: next.identity.requestId,
        src: generatedPng(2, 2, false, false, 1),
        source: 'second',
        license: 'test',
      }),
    );
    await next.accept();
    const prior = f.rows.get(first.operationId)!.usages.length;
    await next.save();
    expect(f.rows.get(next.operationId)!.usages).toHaveLength(1);
    expect(f.rows.get(first.operationId)!.usages).toHaveLength(prior + 1);
    expect(f.rows.get(first.operationId)!.usages.at(-1)).toMatchObject({
      derived: true,
      versionId: f.rows.get(next.operationId)!.usages[0].versionId,
    });
  });
  it('keeps rejection out of native history and saved usage; cleanup does not reclassify it', async () => {
    const f = await fixture(),
      run = await f.prepare();
    const before = clone(f.editor.content),
      ancestry = f.editor.proposalTransactions;
    await run.generate(new AbortController().signal);
    await run.reject();
    run.cancel();
    await f.connection.flush();
    expect(f.editor.content).toEqual(before);
    expect(f.editor.proposalTransactions).toEqual(ancestry);
    expect(f.rows.get(run.operationId)).toMatchObject({ state: 'rejected', usages: [] });
  });
  it('masks cached input and history after permission revocation', async () => {
    const f = await fixture(),
      run = await f.prepare();
    await run.generate(new AbortController().signal);
    await run.accept();
    await run.save();
    const history = await f.connection.history(f.editor.id);
    expect(history[0].retained).toBe(true);
    f.access.read = false;
    expect(() => run.view).toThrow('権限');
    expect(() => f.connection.assertReadable(history[0].record)).toThrow('権限');
    await expect(f.connection.history(f.editor.id)).rejects.toThrow();
  });
  it('requires current per-raster send authorization and valid attribution for image samples', async () => {
    const f = await fixture(),
      context = f.w.worldContext('work'),
      reference = context.references.find((r) => r.role === 'sample')!;
    const source = await f.w.openWorldSource(reference);
    source.execute(
      insertElement('image', {
        id: 'sample-raster',
        parentId: 'sample-anime',
        bounds: { x: 0, y: 0, width: 2, height: 2 },
        src: generatedPng(),
      }) as never,
    );
    source.execute(
      updateElement('sample-raster', {
        provenance: { src: generatedPng(), source: 'sample owner', license: 'sample grant' },
      }) as never,
    );
    await f.w.saveWorldSource(source.id);
    const latest = (await f.w.readWorld('work')).find(
      (r) => r.reference.id === reference.id,
    )!.latest!;
    await f.w.saveWorldContext(
      {
        ...context,
        references: context.references.map((r) =>
          r.id === reference.id ? { ...r, ...latest } : r,
        ),
      },
      context.revision,
    );
    const run = await f.prepare();
    expect(
      run.view.input.context.references.find((r) => r.reference.id === reference.id)!.projection
        .value,
    ).toContain('data:image/png');
    f.access.imageSend = false;
    await expect(run.export()).rejects.toThrow('画像入り見本');
    expect(f.provider.generate).not.toHaveBeenCalled();
  });
});

describe('CW2 saved usage impact and response boundaries', () => {
  it('keeps an unadopted publication usable, and compares selected blocks after explicit adoption', async () => {
    const f = await fixture(),
      run = await f.prepare();
    await run.generate(new AbortController().signal);
    const work = f.w.worldContext('work'),
      ref = work.references.find((r) => r.role === 'facts')!,
      source = await f.w.openWorldSource(ref);
    source.execute(updateBlock('scene-state', { text: 'Another Scene state changed' }) as never);
    await f.w.saveWorldSource(source.id);
    // Publishing alone never changes this operation's old pin.
    await run.accept();
    await run.save();
    expect((await f.connection.history(f.editor.id))[0].impact?.state).toBe('current');
    const latest = (await f.w.readWorld('work')).find((v) => v.reference.id === ref.id)!.latest!;
    await f.w.saveWorldContext(
      {
        ...work,
        references: work.references.map((r) => (r.id === ref.id ? { ...r, ...latest } : r)),
      },
      work.revision,
    );
    expect((await f.connection.history(f.editor.id))[0].impact?.state).toBe('current');
    source.execute(updateBlock('world-facts', { text: '世界の固定事実を訂正' }) as never);
    await f.w.saveWorldSource(source.id);
    const current = f.w.worldContext('work'),
      newer = (await f.w.readWorld('work')).find((v) => v.reference.id === ref.id)!.latest!;
    await f.w.saveWorldContext(
      {
        ...current,
        references: current.references.map((r) => (r.id === ref.id ? { ...r, ...newer } : r)),
      },
      current.revision,
    );
    expect((await f.connection.history(f.editor.id))[0].impact?.state).toBe('review');
    expect(
      f.rows.get(run.operationId)!.context.references.find((r) => r.reference.id === ref.id)!
        .reference,
    ).toEqual(ref);
  });
  it('does not count manual replacement without inherited native provenance as another use', async () => {
    const f = await fixture(),
      run = await f.prepare();
    await run.generate(new AbortController().signal);
    await run.accept();
    await run.save();
    const usage = clone(f.rows.get(run.operationId)!.usages);
    const src = generatedPng(2, 2, true);
    f.p.execute(
      f.card,
      updateElement(f.layer, {
        src,
        provenance: { src, source: 'independent manual replacement', license: 'test' },
      }),
    );
    await f.p.save({ reuseSavedVersions: true });
    await f.connection.flush();
    expect(f.rows.get(run.operationId)!.usages).toEqual(usage);
  });
  it('uses owned snapshots and retires dispatch capabilities after the provider returns', async () => {
    const f = await fixture();
    let dispatch!: Parameters<CreativeWorldProvider['generate']>[0];
    const c = new CreativeWorldGenerationConnection(f.w, {
      ...f.connection.options,
      provider: {
        capability: 'creative-world-v1',
        label: 'mutation fixture',
        generate: async (value) => {
          dispatch = value;
          const copy = value.input;
          copy.context.scope.itemId = 'other';
          copy.editorRequest.target.address.elementId = 'other';
          return {
            requestId: value.identity.requestId,
            src: generatedPng(),
            source: 'fixture',
            license: 'test',
          };
        },
      },
    });
    const run = await c.prepare(await f.native(), { sceneId: f.sceneId });
    await run.generate(new AbortController().signal);
    expect(run.view.record.scope.itemId).toBe(f.card.id);
    expect(run.view.input.editorRequest.target.address.elementId).toBe(f.layer);
    expect(() => dispatch.input).toThrow('失効');
    await expect(
      createCreativeWorldHttpProvider('/endpoint').generate(
        {
          serialize: () => '',
          preflight: async () => {},
          input: run.view.input,
          identity: run.identity,
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow('固定dispatch');
  });
  it('rejects changed send permission after the safe HTTP capability probe without POST', async () => {
    const f = await fixture(),
      fetcher = vi.fn(async () => {
        f.access.send = false;
        return new Response(null, { headers: { 'X-Creative-World-Contract': '1' } });
      });
    const c = new CreativeWorldGenerationConnection(f.w, {
      ...f.connection.options,
      provider: createCreativeWorldHttpProvider('/endpoint', fetcher as unknown as typeof fetch),
    });
    const run = await c.prepare(await f.native(), { sceneId: f.sceneId });
    await expect(run.generate(new AbortController().signal)).rejects.toThrow('送信');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('refuses malformed, wrong-correlated and oversized HTTP results without a native proposal', async () => {
    for (const fault of ['request', 'header', 'size'] as const) {
      const f = await fixture(),
        fetcher = vi.fn(async (_url: unknown, init: RequestInit | undefined) => {
          if (init?.method === 'OPTIONS')
            return new Response(null, { headers: { 'X-Creative-World-Contract': '1' } });
          const req = JSON.parse(init!.body as string).editorRequest;
          return new Response(
            JSON.stringify({
              requestId: fault === 'request' ? 'wrong' : req.id,
              src: generatedPng(),
              source: 'fixture',
              license: 'test',
            }),
            {
              headers: {
                ...(fault !== 'header' ? { 'X-Creative-World-Contract': '1' } : {}),
                ...(fault === 'size' ? { 'content-length': String(7 * 1024 * 1024) } : {}),
              },
            },
          );
        });
      const c = new CreativeWorldGenerationConnection(f.w, {
          ...f.connection.options,
          provider: createCreativeWorldHttpProvider(
            '/endpoint',
            fetcher as unknown as typeof fetch,
          ),
        }),
        run = await c.prepare(await f.native(), { sceneId: f.sceneId });
      await expect(run.generate(new AbortController().signal)).rejects.toThrow();
      expect(f.editor.proposals).toEqual([]);
      expect(f.editor.proposalTransactions).toEqual([]);
    }
  });
});

describe('CW2 native observation ordering', () => {
  it('owns a preview before Surface observers run, and recovers its record after observer-time revocation', async () => {
    const f = await fixture(),
      run = await f.prepare();
    let once = true;
    const off = f.editor.attach(() => {
      const proposal = f.editor.proposals[0];
      if (proposal && once) {
        once = false;
        expect(isCreativeWorldLayerProposal(proposal, f.editor)).toBe(true);
        f.access.read = false;
      }
    });
    await expect(run.generate(new AbortController().signal)).rejects.toThrow('権限');
    off();
    f.access.read = true;
    await run.generate(new AbortController().signal);
    await run.accept();
    expect(f.provider.generate).toHaveBeenCalledTimes(1);
    expect(f.rows.get(run.operationId)!.applied).toBeDefined();
  });
  it('associates two distinct real applies with the same final saved version', async () => {
    const f = await fixture(),
      first = await f.prepare();
    await first.generate(new AbortController().signal);
    await first.accept();
    const secondLayer = addCreativeGenerationLayer(f.p, f.card, 'candidate-1', 'second part', {
      x: 5,
      y: 5,
      width: 2,
      height: 2,
    });
    await f.p.save({ reuseSavedVersions: true });
    await f.connection.flush();
    await f.w.refreshReference(
      f.sceneId,
      'character',
      f.card.id,
      f.w.item(f.sceneId, 'character', f.card.id),
    );
    const native = await prepareCreativeLayerGeneration(
        f.p,
        f.card,
        'candidate-1',
        { elementId: secondLayer },
        { instructions: 'second part only' },
      ),
      second = await f.connection.prepare(native, { sceneId: f.sceneId });
    await second.generate(new AbortController().signal);
    await second.accept();
    await second.save();
    const version = f.editor.artifact.draft.baseVersionId!;
    expect(f.rows.get(first.operationId)!.usages.at(-1)!.versionId).toBe(version);
    expect(f.rows.get(second.operationId)!.usages.at(-1)!.versionId).toBe(version);
    expect(f.rows.get(first.operationId)!.applied!.transactionId).not.toBe(
      f.rows.get(second.operationId)!.applied!.transactionId,
    );
  });
});

describe('CW2 retained usage revalidation', () => {
  for (const fault of ['version', 'hash', 'element'] as const)
    it(`does not claim retained usage after native ${fault} loss/corruption`, async () => {
      const f = await fixture(),
        run = await f.prepare();
      await run.generate(new AbortController().signal);
      await run.accept();
      await run.save();
      const observed = clone(f.rows.get(run.operationId)!),
        usage = observed.usages[0],
        artifact = (await f.artifacts.get(usage.artifactId))!;
      const version = artifact.versions.find((v) => v.versionId === usage.versionId)!;
      if (fault === 'version')
        artifact.versions = artifact.versions.filter((v) => v.versionId !== usage.versionId);
      else if (fault === 'hash') version.contentHash = '0'.repeat(64);
      else {
        const content = version.content as DesignContent;
        content.elements = content.elements.filter((e) => e.id !== f.layer);
        version.contentHash = await contentHash(content);
      }
      await f.artifacts.put(artifact);
      const history = await f.connection.history(usage.artifactId);
      expect(history[0]).toMatchObject({ confirmed: true, retained: false });
      expect(history[0].problem).toBeTruthy();
      expect(f.rows.get(run.operationId)).toEqual(observed);
    });
});

it('requires the original Host activity assertion before wrapping or exposing World capability', async () => {
  const f = await fixture();
  for (const field of ['assertActive', 'maySendEditorRequest', 'maySendReference'] as const) {
    const invalid = { ...f.connection.options, [field]: undefined };
    expect(
      () =>
        new CreativeWorldGenerationConnection(
          f.w,
          invalid as unknown as ConstructorParameters<typeof CreativeWorldGenerationConnection>[1],
        ),
    ).toThrow('認可');
  }
});

describe('CW2 R1: cached input is independently authorized after preview and apply', () => {
  for (const mode of ['character', 'setting'] as const)
    for (const role of ['source', 'rough', 'current', 'scene'] as const)
      for (const applied of [false, true])
        it(`${mode} ${role} only revocation masks new input reads, applied=${applied}`, async () => {
          const f = await fixture(mode),
            run = await f.prepare();
          await run.generate(new AbortController().signal);
          if (applied) await run.accept();
          const original = run.view.input,
            record = clone(f.rows.get(run.operationId)!),
            before = clone(f.editor.content),
            revision = clone(f.editor.revision);
          const id = role === 'source' ? f.p.source.id : f.w.scene(f.sceneId).origin.artifactId;
          // v1 rough/current share the result Artifact. The existing request-read grant
          // lets a Host deny either retained input while keeping target/World access.
          if (role === 'rough') f.access.roughRead = false;
          else if (role === 'current') f.access.currentRead = false;
          else f.deniedReads.add(id);
          expect(f.w.canReadWorld(record.scope.artifactId)).toBe(true);
          expect(
            record.context.references.every((r) => f.w.canReadWorld(r.reference.artifactId)),
          ).toBe(true);
          expect(() => f.connection.assertReadable(record)).not.toThrow(); // metadata is not a v1 input
          for (let attempt = 0; attempt < 2; attempt++)
            expect(() => run.view.input).toThrow('閲覧');
          if (applied) {
            const history = await f.connection.history(f.editor.id);
            expect(history[0].record).not.toHaveProperty('input');
            expect(JSON.stringify(history)).not.toContain(
              JSON.stringify(original.editorRequest.instructions),
            );
            expect(JSON.stringify(history)).not.toContain(
              JSON.stringify(original.editorRequest.currentSvg),
            );
          }
          f.deniedReads.delete(id);
          f.access.roughRead = true;
          f.access.currentRead = true;
          expect(run.view.input).toEqual(original);
          expect(f.editor.content).toEqual(before);
          expect(f.editor.revision).toEqual(revision);
        });
  it('keeps read permission separate from edit/send permission after an apply', async () => {
    const f = await fixture(),
      run = await f.prepare();
    await run.generate(new AbortController().signal);
    await run.accept();
    const original = run.view.input;
    f.access.edit = false;
    f.access.send = false;
    expect(run.view.input).toEqual(original);
  });
});

for (const applied of [false, true])
  it(`R1 cached input checks original Scene Artifact after a later retarget, applied=${applied}`, async () => {
    const f = await fixture(),
      run = await f.prepare();
    await run.generate(new AbortController().signal);
    if (applied) await run.accept();
    const original = f.w.scene(f.sceneId),
      input = run.view.input;
    const selected = vi.spyOn(f.w, 'scene').mockReturnValue({
      ...original,
      origin: { ...original.origin, artifactId: 'replacement-scene' },
    });
    f.deniedReads.add(original.origin.artifactId);
    expect(f.w.canReadWorld('replacement-scene')).toBe(true);
    expect(() => run.view.input).toThrow('閲覧');
    selected.mockRestore();
    f.deniedReads.clear();
    expect(run.view.input).toEqual(input);
  });
