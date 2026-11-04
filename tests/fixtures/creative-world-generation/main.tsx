import { createRoot } from 'react-dom/client';
import {
  canonicalJson,
  clone,
  IndexedDBStorage,
  type Artifact,
} from '@editor-platform/artifact-core';
import {
  CreativeWorkspace,
  CreativeProductionHost,
  CreativeWorldHost,
  createHarborWorkspace,
  createCreativeWorldGenerationConnection,
  createBrowserCreativeWorldRecords,
  createCreativeWorldResultManifest,
  mountCreativeProduction,
  type CreativeWorkspaceStorage,
  type CreativeWorldInput,
  type CreativeWorldIdentity,
  type CreativeWorldExecutionRecord,
} from '@editor-platform/reference-artifact-host/creative/workspace';
import {
  addCreativeGenerationLayer,
  characterMode,
  type CreativeProject,
} from '@editor-platform/reference-artifact-host/creative';
import { mountCreativeMode } from '@editor-platform/reference-artifact-host/creative/browser';
import { generatedPng } from '../creative-host/generated-png';

/** Real native sessions/storage; provider output is a fixed PNG and proves no AI quality. */
async function mount() {
  const root = createRoot(document.getElementById('root')!),
    store = new IndexedDBStorage<Artifact<unknown>>();
  const access = { read: true, write: true, send: true, roughRead: true, currentRead: true },
    faults = { record: '', native: false, mapping: false, lost: false, hold: false };
  const deniedReads = new Set<string>();
  const canRead = (id: string) => access.read && !deniedReads.has(id);
  const held: (() => void)[] = [];
  const releases: (() => void)[] = [];
  const key = 'cw2:workspace';
  const artifacts = {
    get: store.get.bind(store),
    list: store.list.bind(store),
    remove: store.remove.bind(store),
    putIfAbsent: store.putIfAbsent.bind(store),
    put: async (a: Artifact<unknown>) => {
      if (faults.native) {
        faults.native = false;
        throw Error('fixture: native disk full');
      }
      await store.put(a);
    },
  };
  const io: CreativeWorkspaceStorage = {
    artifacts,
    creative: (mode) => ({
      artifacts,
      readMapping: async () => {
        const raw = localStorage.getItem('cw2:' + mode);
        return raw ? JSON.parse(raw) : undefined;
      },
      writeMapping: async (value) => {
        if (faults.mapping) throw Error('fixture: mapping disk full');
        localStorage.setItem('cw2:' + mode, JSON.stringify(value));
      },
    }),
    readLinks: async () => {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : undefined;
    },
    writeLinks: async (value, expected) => {
      if (expected && canonicalJson(expected) !== canonicalJson(await io.readLinks()))
        throw Error('fixture: links conflict');
      localStorage.setItem(key, JSON.stringify(value));
    },
  };
  const fresh = !(await io.readLinks());
  if (fresh) await createHarborWorkspace(io);
  const workspace = await CreativeWorkspace.open(io, () => access.write, canRead);
  if (fresh) {
    // Two characters, two locations, two document Scenes + the existing comic Scene,
    // and both style guides. Select only one style in this request's work context.
    for (const mode of ['character', 'setting'] as const) {
      const p = workspace.project(mode) as CreativeProject<unknown>;
      for (const card of p.cards) {
        await p.save({ rough: { itemId: card.id, frameId: 'candidate-1' } });
        addCreativeGenerationLayer(p, card, 'candidate-1', 'CW2 fixture part', {
          x: 64,
          y: 64,
          width: 64,
          height: 64,
        });
        await p.save({ reuseSavedVersions: true });
        await workspace.connectWorldContext(workspace.itemContextId(mode, card.id)!);
      }
    }
    for (const scene of workspace.mapping.scenes)
      for (const item of scene.items)
        await workspace.refreshReference(
          scene.id,
          item.mode,
          item.itemId,
          workspace.item(scene.id, item.mode, item.itemId),
        );
    const work = workspace.worldContext('work');
    await workspace.saveWorldContext(
      {
        ...work,
        references: work.references.filter((r) => r.id !== 'style-1' && r.id !== 'sample-gekiga'),
      },
      work.revision,
    );
    // Another work's same-named native materials retain different Artifact IDs.
    for (const id of ['d3a:characters', 'd3a:world-notes']) {
      const a = (await store.get(id))!;
      await store.put({ ...a, id: 'other-work:' + id });
    }
  }
  const browserRecords = createBrowserCreativeWorldRecords(
    workspace.mapping.world!.namespace,
    canRead,
    () => access.write,
  );
  let latest: { input: CreativeWorldInput; identity: CreativeWorldIdentity } | undefined;
  let originalSceneArtifactId: string | undefined;
  let calls = 0;
  let resultPadding = 0;
  const generation = createCreativeWorldGenerationConnection(workspace, {
    assertActive() {},
    maySendEditorRequest: () => access.send,
    maySendReference: () => access.send,
    maySendSampleImage: () => access.send,
    records: {
      list: browserRecords.list,
      write: async (record, expected) => {
        if (faults.hold) await new Promise<void>((resolve) => releases.push(resolve));
        if (faults.record === record.state) throw Error('fixture: record disk full');
        await browserRecords.write(record, expected);
        if (faults.lost) {
          faults.lost = false;
          throw Error('fixture: record response lost');
        }
      },
    },
    provider: {
      capability: 'creative-world-v1',
      label: '固定PNG fixture（実AI未使用）',
      generate: async (dispatch) => {
        calls++;
        const captured = { input: dispatch.input, identity: dispatch.identity };
        latest = captured;
        const sceneId = captured.input.context.scope.sceneId;
        originalSceneArtifactId = sceneId ? workspace.scene(sceneId).origin.artifactId : undefined;
        if (holdProvider) await new Promise<void>((resolve) => held.push(resolve));
        const request = captured.input.editorRequest;
        return {
          requestId: request.id,
          src: generatedPng(
            request.target.pixelWidth,
            request.target.pixelHeight,
            false,
            false,
            0,
            undefined,
            resultPadding,
          ),
          source: 'fixed fixture; no AI',
          license: 'test-only fixture grant',
        };
      },
    },
  });
  generation.mayRead = () => access.roughRead && access.currentRead;
  let holdProvider = false,
    renderRevision = 0;
  const surface = new URLSearchParams(location.search).get('surface') ?? 'production';
  const render = () =>
    root.render(
      <div data-cw2-revision={++renderRevision}>
        {surface === 'production' ? (
          <CreativeProductionHost workspace={workspace} generation={generation} />
        ) : (
          <CreativeWorldHost
            workspace={workspace}
            project={
              workspace.project(
                surface === 'setting' ? 'setting' : 'character',
              ) as CreativeProject<unknown>
            }
            generation={generation}
          />
        )}
      </div>,
    );
  window.cw2Fixture = {
    resultPadding(bytes) {
      resultPadding = bytes;
    },
    readInput(role, value) {
      if (!latest) throw Error('prepare and preview first');
      if (role === 'rough') access.roughRead = value;
      else if (role === 'current') access.currentRead = value;
      else {
        const id =
          role === 'source'
            ? latest.input.editorRequest.source.artifactId
            : originalSceneArtifactId;
        if (!id) throw Error('no original input Artifact');
        if (value) deniedReads.delete(id);
        else deniedReads.add(id);
      }
      render();
    },
    async invalidProductionMount(existing) {
      const linksKey = 'creative-design:production:harbor';
      const mappingKeys = ['character', 'setting'].map(
        (mode) =>
          `creative-design:${mode}:${workspace.project(mode as 'character' | 'setting').source.id}`,
      );
      if (existing) {
        localStorage.setItem(linksKey, JSON.stringify(workspace.mapping));
        for (const mode of ['character', 'setting'] as const)
          localStorage.setItem(
            `creative-design:${mode}:${workspace.project(mode).source.id}`,
            JSON.stringify(workspace.project(mode).mapping),
          );
      }
      const snapshot = async () => ({
        artifacts: await store.list(),
        links: localStorage.getItem(linksKey),
        mappings: mappingKeys.map((key) => localStorage.getItem(key)),
      });
      const before = await snapshot(),
        original = Storage.prototype.getItem;
      let reads = 0,
        message = 'unexpected success';
      Storage.prototype.getItem = function (key: string) {
        if (key === linksKey || mappingKeys.includes(key)) reads++;
        return original.call(this, key);
      };
      try {
        await mountCreativeProduction({
          generation,
          worldGeneration: () => generation.world!.options,
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      } finally {
        Storage.prototype.getItem = original;
      }
      return { before, after: await snapshot(), reads, message };
    },
    async invalidMount() {
      const errors: string[] = [];
      const worldGeneration = () => generation.world!.options;
      for (const options of [{ worldGeneration }, { worldGeneration, generation }]) {
        try {
          await mountCreativeMode(characterMode, options);
          errors.push('unexpected success');
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }
      return errors;
    },
    access(value) {
      Object.assign(access, value);
      render();
    },
    failRecord(state) {
      faults.record = state;
    },
    failNative() {
      faults.native = true;
    },
    failMapping(value) {
      faults.mapping = value;
    },
    loseRecordResponse() {
      faults.lost = true;
    },
    holdRecords(value) {
      faults.hold = value;
    },
    releaseRecords() {
      faults.hold = false;
      releases.splice(0).forEach((r) => r());
    },
    holdProvider(value) {
      holdProvider = value;
    },
    releaseProvider() {
      holdProvider = false;
      held.splice(0).forEach((r) => r());
    },
    get pendingProvider() {
      return held.length;
    },
    get pendingRecords() {
      return releases.length;
    },
    get calls() {
      return calls;
    },
    get latest() {
      return clone(latest);
    },
    async records() {
      const rows: CreativeWorldExecutionRecord[] = [];
      for (const mode of ['character', 'setting'] as const)
        for (const id of workspace.project(mode).designs.keys())
          rows.push(
            ...((await browserRecords.list(
              workspace.mapping.world!.namespace,
              id,
            )) as CreativeWorldExecutionRecord[]),
          );
      return clone(rows);
    },
    async artifacts() {
      return store.list();
    },
    async context() {
      return clone(workspace.mapping.world!);
    },
    async adoptStyle(style) {
      const work = workspace.worldContext('work');
      const a = (await store.get('cw1:harbor:guide:' + style))!,
        v = a.versions.find((v) => v.versionId === a.draft.baseVersionId)!;
      await workspace.saveWorldContext(
        {
          ...work,
          references: work.references.map((r) =>
            r.role === 'style'
              ? { ...r, artifactId: a.id, versionId: v.versionId, contentHash: v.contentHash }
              : r,
          ),
        },
        work.revision,
      );
      render();
    },
    async manifest() {
      if (!latest) throw Error('export or dispatch first');
      const r = latest.input.editorRequest;
      return createCreativeWorldResultManifest(latest.identity, {
        requestId: r.id,
        src: generatedPng(r.target.pixelWidth, r.target.pixelHeight),
        source: 'external fixed fixture',
        license: 'test grant',
      });
    },
    async flush() {
      await generation.world!.flush();
    },
  };
  render();
}
declare global {
  interface Window {
    cw2Fixture: {
      resultPadding(bytes: number): void;
      readInput(role: 'source' | 'rough' | 'current' | 'scene', value: boolean): void;
      invalidProductionMount(existing: boolean): Promise<{
        before: {
          artifacts: Artifact<unknown>[];
          links: string | null;
          mappings: (string | null)[];
        };
        after: {
          artifacts: Artifact<unknown>[];
          links: string | null;
          mappings: (string | null)[];
        };
        reads: number;
        message: string;
      }>;
      invalidMount(): Promise<string[]>;
      access(v: Partial<{ read: boolean; write: boolean; send: boolean }>): void;
      failRecord(state: string): void;
      failNative(): void;
      failMapping(value: boolean): void;
      loseRecordResponse(): void;
      holdRecords(value: boolean): void;
      releaseRecords(): void;
      holdProvider(value: boolean): void;
      releaseProvider(): void;
      readonly pendingProvider: number;
      readonly pendingRecords: number;
      readonly calls: number;
      readonly latest: { input: CreativeWorldInput; identity: CreativeWorldIdentity } | undefined;
      records(): Promise<CreativeWorldExecutionRecord[]>;
      artifacts(): Promise<Artifact<unknown>[]>;
      context(): Promise<NonNullable<CreativeWorkspace['mapping']['world']>>;
      adoptStyle(style: 'anime' | 'gekiga'): Promise<void>;
      manifest(): ReturnType<typeof createCreativeWorldResultManifest>;
      flush(): Promise<void>;
    };
  }
}
void mount().catch((error) => {
  const p = document.createElement('p');
  p.setAttribute('role', 'alert');
  p.textContent = String(error);
  document.getElementById('root')!.append(p);
});
