import {
  clone,
  newId,
  canonicalJson,
  contentHash,
  serializeArtifact,
  type Artifact,
} from '@editor-platform/artifact-core';
import {
  sameLocalRevision,
  type ElementAddress,
  type LocalDraftRevision,
} from '@editor-platform/editor-core';
import {
  ArtifactEditor,
  loadHostArtifact,
  type HostArtifactStorage,
  type HostSaveContext,
} from '@editor-platform/editor-host';
import {
  isDocument,
  resolveDocumentAddress,
  type DocumentContent,
} from '@editor-platform/document/model';
import { isDesignWithPaths, type DesignContent } from '@editor-platform/design/model';
import type { StructuredData } from '@editor-platform/structured-data/model';
import type { CreativeDesignAddress } from '@editor-platform/design/creative-proposal-diff';
import {
  CreativeProject,
  readCreativeMapping,
  type CreativeEdit,
  type CreativeStorage,
} from '../project';
import {
  readWorldContexts,
  readWorldReference,
  projectWorldReference,
  type WorldContexts,
  type WorldContext,
  type WorldReference,
} from './world-context';
import { CreativeMapLocations } from './map-locations';
import { characterMode } from '../character-mode';
import { settingMode } from '../setting-mode';
import { projectCreativeLayerReference, type CreativeLayerRequest } from '../generation';

export * from './links';
import {
  readWorkspaceLinks,
  type NativeReference,
  type SceneItemReference,
  type CreativeScene,
  type SceneReturn,
  type CreativeWorkspaceLinks,
} from './links';

export interface CreativeWorkspaceStorage {
  artifacts: HostArtifactStorage;
  creative(mode: 'character' | 'setting'): CreativeStorage;
  readLinks(): Promise<unknown>;
  /** Trusted store must compare expected and write atomically; no cross-native-store guarantee. */
  writeLinks(links: CreativeWorkspaceLinks, expected?: CreativeWorkspaceLinks): Promise<void>;
}
import {
  workspaceDocumentAdapter,
  workspaceComicAdapter,
  captureWorkspaceDocumentAdapter,
  type CreativeWorkspaceOptions,
} from './native-adapters';
export type { CreativeWorkspaceOptions } from './native-adapters';
export { workspaceDocumentAdapter, workspaceComicAdapter } from './native-adapters';

export type ReferenceView = {
  reference: SceneItemReference;
  state: 'current' | 'stale' | 'missing' | 'forbidden' | 'invalid';
  reason?: string;
  name?: string;
  summary?: string;
  sourceContent?: StructuredData | DocumentContent;
  artworkContent?: DesignContent;
  currentSourceVersion?: string | null;
  currentArtworkVersion?: string | null;
};
export function hasElement(kind: CreativeScene['kind'], content: unknown, id: string): boolean {
  return kind === 'document'
    ? isDocument(content) &&
        resolveDocumentAddress(content, { artifactId: '', elementId: id }).state === 'Current'
    : isDesignWithPaths(content) && content.elements.some((e) => e.id === id);
}

function containsAddress(scene: CreativeScene, content: unknown, id: string) {
  if (!hasElement(scene.kind, content, id)) return false;
  if ([scene.origin.elementId, ...scene.members].includes(id)) return true;
  if (scene.kind === 'design' && isDesignWithPaths(content)) {
    let current = content.elements.find((e) => e.id === id);
    const seen = new Set<string>();
    while (current?.parentId && !seen.has(current.id)) {
      seen.add(current.id);
      if (current.parentId === scene.origin.elementId) return true;
      current = content.elements.find((e) => e.id === current!.parentId);
    }
  }
  return false;
}

function roleStorage(
  io: CreativeWorkspaceStorage,
  mode: SceneItemReference['mode'],
  mayRead: (id: string) => boolean,
): CreativeStorage {
  const storage = io.creative(mode),
    artifacts = storage.artifacts;
  const check = (id: string) => {
    if (!mayRead(id)) throw Error('設定画・正本の参照権限がありません。');
  };
  return {
    readMapping: () => storage.readMapping(),
    writeMapping: (value) => storage.writeMapping(value),
    artifacts: {
      async get(id) {
        check(id);
        const a = await artifacts.get(id);
        check(id);
        return a;
      },
      async list() {
        return (await artifacts.list()).filter((a) => mayRead(a.id));
      },
      async put(a, context) {
        check(a.id);
        await artifacts.put(a, context);
      },
      async remove(id) {
        check(id);
        await artifacts.remove(id);
      },
      ...(artifacts.putIfAbsent
        ? {
            async putIfAbsent(a: Artifact<unknown>) {
              check(a.id);
              return artifacts.putIfAbsent!(a);
            },
          }
        : {}),
    },
  };
}

/** Trusted consuming-Host coordination over retained native Editors; never another history. */
export class CreativeWorkspace {
  private readonly documentAdapter: typeof workspaceDocumentAdapter;
  readonly sessionId = newId('creative-workspace');
  readonly maps: CreativeMapLocations;
  private links: CreativeWorkspaceLinks;
  private busy = false;
  private localReturn?: SceneReturn;
  private returnNavigation = 0;
  private worldEditors = new Map<
    string,
    ArtifactEditor<DocumentContent> | ArtifactEditor<DesignContent>
  >();
  canReadWorld(id: string) {
    return this.mayRead(id);
  }
  get canEditWorld() {
    return this.mayEdit() && !this.busy;
  }
  /** Input authority is independent of unrelated association-write busy state. */
  get canPrepareWorldInput() {
    return this.mayEdit();
  }
  get hasUnsavedWorldSources() {
    return (
      this.maps.hasUnsavedSources || [...this.worldEditors.values()].some((e) => e.snapshot.dirty)
    );
  }
  worldContext(id: string) {
    const c = this.links.world?.contexts.find((c) => c.id === id);
    if (!c) throw Error('採用前提がありません。Hostで資料を接続してください。');
    return clone(c);
  }
  async connectWorld(world: WorldContexts) {
    if (this.links.world)
      throw Error('作品設定は接続済みです。既存の採用版を明示更新してください。');
    const valid = readWorldContexts(world);
    const views = await Promise.all(
      valid.contexts
        .flatMap((c) => c.references)
        .map((r) => readWorldReference(this.io, r, this.mayRead)),
    );
    if (views.some((v) => !['current', 'stale'].includes(v.state)))
      throw Error('接続資料を確認してください。');
    await this.write({ ...this.links, world: valid }, () => {
      if (this.links.world) throw Error('作品設定が競合しています。');
      if (!valid.contexts.flatMap((c) => c.references).every((r) => this.mayRead(r.artifactId)))
        throw Error('資料の閲覧権限が失効しました。');
    });
  }
  itemContextId(mode: SceneItemReference['mode'], itemId: string) {
    const p = this.project(mode),
      card = p.cards.find((c) => c.id === itemId);
    if (!card) return undefined;
    const binding = p.binding(card);
    return binding
      ? 'item:' +
          canonicalJson([
            mode,
            p.source.id,
            itemId,
            binding.design.artifactId,
            binding.chosenFrameId,
          ])
      : undefined;
  }
  async connectWorldContext(id: string) {
    if (!this.links.world) throw Error('先に作品設定を接続してください。');
    if (this.links.world.contexts.some((c) => c.id === id)) throw Error('採用前提が接続済みです。');
    const next = clone(this.links);
    next.world!.contexts.push({ id, revision: 0, references: [] });
    await this.write(next);
  }
  async readWorld(
    contextId: string,
    purpose: 'view' | 'generation' = 'view',
    maySendImage?: import('./world-context').WorldSamplePermission,
  ) {
    const views = await Promise.all(
      this.worldContext(contextId).references.map((r) =>
        readWorldReference(this.io, r, this.mayRead, purpose, maySendImage),
      ),
    );
    return views.map((view) =>
      this.mayRead(view.reference.artifactId)
        ? view
        : {
            reference: view.reference,
            state: 'forbidden' as const,
            reason: '資料の閲覧権限が失効しました。',
          },
    );
  }
  /** Explicit author operation. Native edits never call this method. */
  async saveWorldContext(context: WorldContext, expectedRevision: number) {
    const expected = this.worldContext(context.id);
    if (!this.mayEdit()) throw Error('閲覧のみのため採用版を変更できません。');
    if (expected.revision !== expectedRevision) throw Error('採用前提revisionが競合しています。');
    const proposed = clone(this.links);
    const candidate = { ...clone(context), revision: expectedRevision + 1 };
    proposed.world!.contexts = proposed.world!.contexts.map((c) =>
      c.id === context.id ? candidate : c,
    );
    readWorkspaceLinks(proposed);
    const views = await Promise.all(
      candidate.references.map((r) => readWorldReference(this.io, r, this.mayRead)),
    );
    if (views.some((v) => !['current', 'stale'].includes(v.state)))
      throw Error('採用資料が欠落・不正・権限不足です。元資料を復旧して再試行してください。');
    const validate = () => {
      if (canonicalJson(this.worldContext(context.id)) !== canonicalJson(expected))
        throw Error('採用前提revisionが競合しています。');
      if (!candidate.references.every((r) => this.mayRead(r.artifactId)))
        throw Error('資料の閲覧権限が失効しました。');
    };
    validate();
    // Only replace this context after all async validation; preserve intervening saves.
    const next = clone(this.links);
    next.world!.contexts = next.world!.contexts.map((c) => (c.id === context.id ? candidate : c));
    await this.write(next, validate);
  }
  private nativeSessions = new Map<
    string,
    ArtifactEditor<DocumentContent> | ArtifactEditor<DesignContent>
  >();
  private nativeOpens = new Map<
    string,
    Promise<ArtifactEditor<DocumentContent> | ArtifactEditor<DesignContent>>
  >();
  private knownNativeSession(id: string) {
    const sessions = new Set(
      [
        this.nativeSessions.get(id),
        this.worldEditors.get(id),
        this.manuscripts.get(id),
        this.settingProject?.source.id === id ? this.settingProject.source : undefined,
        this.characterProject?.designs.get(id),
        this.settingProject?.designs.get(id),
      ].filter((e): e is ArtifactEditor<DocumentContent> | ArtifactEditor<DesignContent> => !!e),
    );
    if (sessions.size > 1)
      throw Error('同じArtifactの編集セッションが競合しています。上書きしません。');
    return [...sessions][0];
  }
  private async nativeSession(a: Artifact<unknown>, kind: 'document' | 'design') {
    const check = (editor: ArtifactEditor<DocumentContent> | ArtifactEditor<DesignContent>) => {
      if (!this.mayRead(a.id)) throw Error('資料の閲覧権限が失効しました。');
      if (
        editor.artifact.kind !== kind ||
        editor.artifact.draft.baseVersionId !== a.draft.baseVersionId ||
        canonicalJson(editor.artifact.draft.content) !== canonicalJson(a.draft.content)
      )
        throw Error('資料のdraftが外部で変更されました。未保存作業を保持しています。');
      return editor;
    };
    const existing = this.knownNativeSession(a.id);
    if (existing) return check(existing);
    const pending = this.nativeOpens.get(a.id);
    if (pending) return check(await pending);
    const writable = () => this.mayEdit() && this.mayRead(a.id);
    const store = {
      put: async (value: Artifact<unknown>, context?: HostSaveContext) => {
        if (!writable()) throw Error('資料の編集権限がありません。');
        await this.io.artifacts.put(value, context);
      },
    };
    const opening = (async () => {
      if (kind === 'document') {
        const native = await loadHostArtifact(serializeArtifact(a), this.documentAdapter);
        const found = this.knownNativeSession(a.id);
        if (found) return check(found);
        const editor = new ArtifactEditor<DocumentContent>(
          native,
          this.documentAdapter,
          store,
          writable,
        );
        this.nativeSessions.set(a.id, editor);
        return check(editor);
      }
      const native = await loadHostArtifact(serializeArtifact(a), workspaceComicAdapter);
      const found = this.knownNativeSession(a.id);
      if (found) return check(found);
      const editor = new ArtifactEditor<DesignContent>(
        native,
        workspaceComicAdapter,
        store,
        writable,
      );
      this.nativeSessions.set(a.id, editor);
      return check(editor);
    })();
    this.nativeOpens.set(a.id, opening);
    try {
      return await opening;
    } finally {
      if (this.nativeOpens.get(a.id) === opening) this.nativeOpens.delete(a.id);
    }
  }
  async openWorldSource(reference: WorldReference) {
    const view = await readWorldReference(this.io, reference, this.mayRead);
    if (!['current', 'stale'].includes(view.state)) throw Error(view.reason);
    const a = await this.io.artifacts.get(reference.artifactId);
    if (!this.mayRead(reference.artifactId)) throw Error('資料の閲覧権限が失効しました。');
    if (!a) throw Error('資料が削除されました。');
    projectWorldReference(reference, a.draft.content);
    const editor = await this.nativeSession(
      a,
      reference.selector.type === 'document-blocks' ? 'document' : 'design',
    );
    this.worldEditors.set(a.id, editor);
    return editor;
  }
  async saveWorldSource(id: string) {
    const editor = this.worldEditors.get(id);
    if (!editor || !this.mayRead(id) || !this.mayEdit())
      throw Error('資料を保存する権限がありません。');
    editor.flushInputs();
    const current = await this.io.artifacts.get(id);
    if (!this.mayRead(id) || !this.mayEdit()) throw Error('資料の権限が失効しました。');
    if (
      !current ||
      current.draft.baseVersionId !== editor.artifact.draft.baseVersionId ||
      canonicalJson(current.draft.content) !== canonicalJson(editor.artifact.draft.content)
    )
      throw Error('資料の保存が競合しています。未保存作業を保持しています。');
    for (const project of [this.characterProject, this.settingProject])
      if (project && (project.source.id === id || project.designs.has(id)))
        project.assertSaveIntegrity();
    if (this.links.scenes.some((scene) => scene.origin.artifactId === id)) {
      await this.saveManuscript(editor);
    } else if (editor.snapshot.dirty) await editor.save({ commitVersion: true });
  }
  private manuscripts = new Map<
    string,
    ArtifactEditor<DocumentContent> | ArtifactEditor<DesignContent>
  >();
  constructor(
    readonly io: CreativeWorkspaceStorage,
    links: CreativeWorkspaceLinks,
    private characterProject: CreativeProject<StructuredData> | undefined,
    private settingProject: CreativeProject<DocumentContent> | undefined,
    private readonly mayEdit: () => boolean = () => true,
    private readonly mayRead: (id: string) => boolean = () => true,
    private readonly mayEditShared: (
      mode: SceneItemReference['mode'],
      itemId: string,
    ) => boolean = () => false,
    options: CreativeWorkspaceOptions = {},
  ) {
    this.documentAdapter = captureWorkspaceDocumentAdapter(options.documentAdapter);
    this.links = readWorkspaceLinks(links);
    this.maps = new CreativeMapLocations(this, (value, validate) =>
      this.write({ ...this.links, mapLocations: value }, validate),
    );
  }
  static async open(
    io: CreativeWorkspaceStorage,
    mayEdit = () => true,
    mayRead = (_id: string) => true,
    mayEditShared: (mode: SceneItemReference['mode'], itemId: string) => boolean = () => false,
    options: CreativeWorkspaceOptions = {},
  ) {
    const links = readWorkspaceLinks(await io.readLinks());
    const failures: Partial<Record<'character' | 'setting', string>> = {};
    async function role<T>(
      mode: 'character' | 'setting',
      config: import('../types').CreativeMode<T>,
    ) {
      try {
        const map = await io.creative(mode).readMapping();
        if (!map) throw Error('正本の対応表がありません。別の正本は作成しません。');
        const mapping = readCreativeMapping(map, config.id);
        const readable = () =>
          [mapping.source.artifactId, ...mapping.bindings.map((b) => b.design.artifactId)].every(
            mayRead,
          );
        if (!readable())
          throw Error('正本または設定画の参照権限がありません。Mode全体の接続を停止します。');
        return await CreativeProject.open(
          config,
          roleStorage(io, mode, mayRead),
          () => mayEdit() && readable(),
        );
      } catch (error) {
        failures[mode] = error instanceof Error ? error.message : String(error);
        return undefined;
      }
    }
    const characters = await role('character', characterMode),
      settings = await role('setting', settingMode);
    const workspace = new CreativeWorkspace(
      io,
      links,
      characters,
      settings,
      mayEdit,
      mayRead,
      mayEditShared,
      options,
    );
    workspace.unavailable = failures;
    return workspace;
  }
  private unavailable: Partial<Record<'character' | 'setting', string>> = {};
  get characters() {
    if (!this.characterProject)
      throw Error(this.unavailable.character ?? '人物の正本接続がありません。');
    return this.characterProject;
  }
  set characters(value: CreativeProject<StructuredData>) {
    this.characterProject = value;
  }
  get settings() {
    if (!this.settingProject)
      throw Error(this.unavailable.setting ?? '場所の正本接続がありません。');
    return this.settingProject;
  }
  set settings(value: CreativeProject<DocumentContent>) {
    this.settingProject = value;
  }

  get hasUnsavedManuscripts() {
    return [...this.manuscripts.values()].some((e) => e.snapshot.dirty);
  }
  get mapping() {
    return clone({ ...this.links, ...(this.localReturn ? { returnTo: this.localReturn } : {}) });
  }
  project(mode: SceneItemReference['mode']) {
    return mode === 'character' ? this.characters : this.settings;
  }
  modeProblem(mode: SceneItemReference['mode']) {
    if (this.modeAvailable(mode) && !this.canReadMode(mode))
      return '正本または設定画の参照権限が変更されました。';
    return this.unavailable[mode];
  }
  modeAvailable(mode: SceneItemReference['mode']) {
    return !!(mode === 'character' ? this.characterProject : this.settingProject);
  }
  canReadMode(mode: SceneItemReference['mode']) {
    const p = mode === 'character' ? this.characterProject : this.settingProject;
    return (
      !!p &&
      [p.source.id, ...p.mapping.bindings.map((b) => b.design.artifactId)].every((id) =>
        this.mayRead(id),
      )
    );
  }
  canUpdateReferences(mode: SceneItemReference['mode']) {
    const p = mode === 'character' ? this.characterProject : this.settingProject;
    return !!p && !p.source.readOnly;
  }
  scene(id: string) {
    const scene = this.links.scenes.find((s) => s.id === id);
    if (!scene) throw Error('Sceneがありません。');
    return clone(scene);
  }
  item(sceneId: string, mode: SceneItemReference['mode'], itemId: string) {
    const item = this.scene(sceneId).items.find((i) => i.mode === mode && i.itemId === itemId);
    if (!item) throw Error('このSceneに人物・場所の参照がありません。');
    return item;
  }
  sceneForAddress(address: ElementAddress) {
    const editor = this.manuscripts.get(address.artifactId);
    if (!editor) throw Error('原稿を開いてからSceneを照合してください。');
    const matches = this.links.scenes.filter(
      (s) =>
        s.origin.artifactId === address.artifactId &&
        containsAddress(s, editor.content, address.elementId),
    );
    if (matches.length > 1) throw Error('選択位置に対応するSceneが曖昧です。');
    return matches[0] && clone(matches[0]);
  }
  private async record(ref: NativeReference) {
    if (!this.mayRead(ref.artifactId)) throw Error('参照権限がありません。');
    const artifact = await this.io.artifacts.get(ref.artifactId);
    if (!this.mayRead(ref.artifactId)) throw Error('参照権限が変更されました。');
    if (!artifact || artifact.id !== ref.artifactId)
      throw Error('参照Artifactが欠落または不一致です。');
    const version = artifact.versions.find((v) => v.versionId === ref.versionId);
    if (!version) throw Error('参照していたexact versionがありません。');
    if (artifact.kind === 'data')
      await loadHostArtifact(
        serializeArtifact(artifact),
        (this.characterProject?.mode ?? characterMode).adapter,
      );
    else if (artifact.kind === 'document')
      await loadHostArtifact(serializeArtifact(artifact), workspaceDocumentAdapter);
    else if (artifact.kind === 'design')
      await loadHostArtifact(serializeArtifact(artifact), workspaceComicAdapter);
    else throw Error('参照先の形式に対応していません。');
    if ((await contentHash(version.content)) !== version.contentHash)
      throw Error('参照版のhashが不正です。');
    if (!this.mayRead(ref.artifactId)) throw Error('参照権限が変更されました。');
    return { artifact, version };
  }
  /** Existing local manuscript inputs remain native; preparing an input never discards them. */
  assertGenerationSceneCurrent(sceneId: string) {
    const scene = this.scene(sceneId);
    if (!this.mayRead(scene.origin.artifactId)) throw Error('Scene原稿の閲覧権限がありません。');
    const editor = this.knownNativeSession(scene.origin.artifactId);
    editor?.flushInputs();
    if (
      editor &&
      (editor.snapshot.dirty ||
        editor.artifact.draft.baseVersionId !== scene.origin.versionId ||
        ![scene.origin.elementId, ...scene.members].every((id) =>
          hasElement(scene.kind, editor.content, id),
        ))
    )
      throw Error('Scene原稿に未保存または外部変更があります。作業を保存して再準備してください。');
  }
  /** Host-side retained reads for CW2 input only; no apply, provider, or new source store. */
  async preflightGenerationSources(
    mode: SceneItemReference['mode'],
    request: CreativeLayerRequest,
    options: { sourceContentHash: string; sceneId?: string; assertCurrent(): void },
  ) {
    const check = options.assertCurrent;
    check();
    if (options.sceneId) this.assertGenerationSceneCurrent(options.sceneId);
    const source = await this.record(request.source);
    check();
    if (
      source.artifact.kind !== this.project(mode).mode.adapter.kind ||
      source.version.contentHash !== options.sourceContentHash
    )
      throw Error('生成元の保存版・hashが一致しません。');
    for (const [reference, svg] of [
      [request.rough, request.rough.svg],
      [request.currentReference, request.currentSvg],
    ] as const) {
      const retained = await this.record({ ...reference, elementId: reference.frameId });
      check();
      if (
        retained.artifact.kind !== 'design' ||
        !isDesignWithPaths(retained.version.content) ||
        retained.version.contentHash !== reference.contentHash ||
        canonicalJson(
          projectCreativeLayerReference(retained.version.content, reference.frameId),
        ) !== canonicalJson({ svg, rasterSources: reference.rasterSources })
      )
        throw Error('生成画像参照の保存版・hash・Frame投影が一致しません。');
    }
    if (options.sceneId) {
      const scene = this.scene(options.sceneId),
        retained = await this.record(scene.origin);
      check();
      if (
        retained.artifact.kind !== scene.kind ||
        retained.artifact.draft.baseVersionId !== scene.origin.versionId ||
        ![scene.origin.elementId, ...scene.members].every(
          (id) =>
            hasElement(scene.kind, retained.version.content, id) &&
            hasElement(scene.kind, retained.artifact.draft.content, id),
        )
      )
        throw Error('Scene原稿の保存版・要素が不正です。参照を明示更新してください。');
      const editor = this.knownNativeSession(scene.origin.artifactId);
      this.assertGenerationSceneCurrent(options.sceneId);
      if (
        editor &&
        (editor.snapshot.dirty ||
          canonicalJson(editor.content) !== canonicalJson(retained.artifact.draft.content))
      )
        throw Error(
          'Scene原稿に未保存または外部変更があります。作業を保存して再準備してください。',
        );
      check();
    }
  }
  async readReference(
    sceneId: string,
    mode: SceneItemReference['mode'],
    itemId: string,
  ): Promise<ReferenceView> {
    const reference = this.item(sceneId, mode, itemId);
    if (![reference.source, reference.artwork].every((r) => this.mayRead(r.artifactId)))
      return { reference, state: 'forbidden', reason: '参照権限がありません。' };
    try {
      const source = await this.record(reference.source),
        artwork = await this.record(reference.artwork);
      const config =
        mode === 'character'
          ? (this.characterProject?.mode ?? characterMode)
          : (this.settingProject?.mode ?? settingMode);
      // Validate the entire retained artifact, not only the advertised version hash.
      if (
        source.artifact.kind !== config.adapter.kind ||
        artwork.artifact.kind !== 'design' ||
        !isDesignWithPaths(artwork.version.content)
      )
        throw Error('参照先の形式が一致しません。');
      const cards =
        mode === 'character'
          ? (this.characterProject?.mode ?? characterMode).cards(
              source.version.content as StructuredData,
            )
          : (this.settingProject?.mode ?? settingMode).cards(
              source.version.content as DocumentContent,
            );
      const card = cards.find((c) => c.id === itemId && c.elementId === reference.source.elementId);
      if (!card || !hasElement('design', artwork.version.content, reference.artwork.elementId))
        throw Error('参照していた項目・候補Frameがありません。');
      const stale =
        source.artifact.draft.baseVersionId !== reference.source.versionId ||
        artwork.artifact.draft.baseVersionId !== reference.artwork.versionId;
      return {
        reference,
        state: stale ? 'stale' : 'current',
        reason: stale ? '参照は旧版のままです。新しい保存版を確認できます。' : undefined,
        name: card.name,
        summary: card.summary,
        sourceContent: clone(source.version.content) as StructuredData | DocumentContent,
        artworkContent: clone(artwork.version.content),
        currentSourceVersion: source.artifact.draft.baseVersionId,
        currentArtworkVersion: artwork.artifact.draft.baseVersionId,
      };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return {
        reference,
        state: reason.includes('権限')
          ? 'forbidden'
          : reason.includes('欠落') || reason.includes('exact version')
            ? 'missing'
            : 'invalid',
        reason,
      };
    }
  }
  private async write(next: CreativeWorkspaceLinks, validate: () => void = () => {}) {
    if (!this.mayEdit()) throw Error('閲覧のみのため参照を変更できません。');
    if (this.busy) throw Error('参照保存中です。');
    this.busy = true;
    try {
      const valid = readWorkspaceLinks(next);
      validate();
      const expected = clone(this.links);
      const stored = canonicalJson(await this.io.readLinks());
      if (stored !== canonicalJson(expected) && stored !== canonicalJson(valid))
        throw Error('参照表が外部で更新されました。再読込して確認してください。');
      if (!this.mayEdit()) throw Error('保存権限が失効しました。');
      validate();
      if (stored !== canonicalJson(valid)) await this.io.writeLinks(valid, expected);
      if (!this.mayEdit()) throw Error('保存中に権限が変更されました。');
      validate();
      this.links = valid;
    } finally {
      this.busy = false;
    }
  }
  async openScene(id: string) {
    const scene = this.scene(id),
      { artifact, version } = await this.record(scene.origin);
    if (
      artifact.kind !== scene.kind ||
      !hasElement(scene.kind, version.content, scene.origin.elementId)
    )
      throw Error('Scene参照が不正です。');
    if (artifact.draft.baseVersionId !== scene.origin.versionId)
      throw Error(
        `Scene ${scene.id} の保存版が異なります。参照 ${scene.origin.versionId} / 現在 ${artifact.draft.baseVersionId}。自動更新しません。`,
      );
    if (!hasElement(scene.kind, artifact.draft.content, scene.origin.elementId))
      throw Error('Sceneが削除されています。別の要素へ移動しません。');
    const editor = await this.nativeSession(artifact, scene.kind);
    this.manuscripts.set(artifact.id, editor);
    return editor;
  }
  async saveScene(id: string) {
    const scene = this.scene(id);
    const editor = this.manuscripts.get(scene.origin.artifactId) ?? (await this.openScene(id));
    const { artifact } = await this.record(scene.origin);
    if (artifact.draft.baseVersionId !== editor.artifact.draft.baseVersionId)
      throw Error('原稿の保存版が外部で変わりました。上書きしません。');
    if (canonicalJson(artifact.draft.content) !== canonicalJson(editor.artifact.draft.content))
      throw Error('原稿の保存draftが外部で変わりました。上書きしません。');
    editor.flushInputs();
    if (!hasElement(scene.kind, editor.content, scene.origin.elementId))
      throw Error('現在のSceneが削除されています。保存前に対応を確認してください。');
    await this.saveManuscript(editor, scene);
  }
  /** Native content and Host links save separately. A clean retry reconciles links only. */
  private async saveManuscript(
    editor: ArtifactEditor<DocumentContent> | ArtifactEditor<DesignContent>,
    explicitScene?: CreativeScene,
  ) {
    const result =
      editor.snapshot.dirty ||
      (explicitScene && editor.artifact.draft.baseVersionId === explicitScene.origin.versionId)
        ? await editor.save({ commitVersion: true })
        : { artifact: editor.artifact, revision: clone(editor.revision) };
    const { artifact: saved, revision } = result;
    const validate = () => {
      if (!this.mayRead(editor.id)) throw Error('原稿の閲覧権限が失効しました。');
      if (editor.snapshot.dirty || !sameLocalRevision(editor.revision, revision))
        throw Error('保存中に原稿が編集されました。再保存してください。');
    };
    validate();
    const content = saved.draft.content,
      versionId = saved.draft.baseVersionId!;
    const next = this.mapping;
    // These are editable Scene views of one native file, not independent adopted world pins.
    for (const s of next.scenes)
      if (s.origin.artifactId === editor.id && hasElement(s.kind, content, s.origin.elementId))
        s.origin.versionId = versionId;
    if (next.returnTo?.address.artifactId === editor.id) {
      const ticket = next.returnTo;
      const scene = explicitScene ?? next.scenes.find((s) => s.id === ticket.sceneId);
      const selected = editor.snapshot.selection.addresses[0];
      // Material save preserves the return element. Never substitute the material's selection.
      const address = explicitScene
        ? selected
        : selected?.elementId === ticket.address.elementId
          ? selected
          : ticket.address;
      if (
        scene &&
        address &&
        hasElement(scene.kind, content, scene.origin.elementId) &&
        (explicitScene || containsAddress(scene, content, ticket.address.elementId)) &&
        containsAddress(scene, content, address.elementId) &&
        (scene.kind !== 'document' ||
          resolveDocumentAddress(content as DocumentContent, address).state === 'Current')
      ) {
        next.returnTo = {
          sceneId: scene.id,
          versionId,
          // Keep the occurrence the author came from while the ticket stays on the same region.
          ...(ticket.occurrenceLinkId !== undefined && scene.id === ticket.sceneId
            ? { occurrenceLinkId: ticket.occurrenceLinkId }
            : {}),
          address: {
            artifactId: editor.id,
            elementId: address.elementId,
            ...(address.region?.type === 'text'
              ? { region: { type: 'text', start: address.region.start, end: address.region.end } }
              : {}),
          },
        };
      } else delete next.returnTo;
    }
    const localReturn = this.localReturn;
    await this.write(next, validate);
    if (localReturn && this.localReturn === localReturn)
      this.localReturn = next.returnTo ? clone(next.returnTo) : undefined;
  }
  async captureReturn(id: string) {
    const navigation = ++this.returnNavigation;
    const validateNavigation = () => {
      if (navigation !== this.returnNavigation)
        throw Error('別の移動が選択されました。古い戻り先を適用しません。');
    };
    const scene = this.scene(id),
      editor = await this.openScene(id);
    validateNavigation();
    editor.flushInputs();
    if (editor.snapshot.dirty) throw Error('原稿を保存してから設定を開いてください。');
    const selected = editor.snapshot.selection.addresses[0];
    if (selected && !containsAddress(scene, editor.content, selected.elementId))
      throw Error('選択位置はこのSceneに属していないか、削除されています。推測で補正しません。');
    const address: ElementAddress =
      selected && containsAddress(scene, editor.content, selected.elementId)
        ? {
            artifactId: editor.id,
            elementId: selected.elementId,
            ...(selected.region?.type === 'text'
              ? { region: { type: 'text', start: selected.region.start, end: selected.region.end } }
              : {}),
          }
        : { artifactId: editor.id, elementId: scene.origin.elementId };
    const next = this.mapping;
    next.returnTo = { sceneId: id, address, versionId: scene.origin.versionId };
    // Navigation works for a viewer without persisting a new mapping.
    if (this.mayEdit()) {
      await this.write(next);
      validateNavigation();
      // Keep the previous viewer ticket through failure; retire it only on current success.
      this.localReturn = undefined;
    } else this.localReturn = clone(next.returnTo);
    return clone(next.returnTo!);
  }
  async returnToScene() {
    const navigation = ++this.returnNavigation;
    const ticket = this.mapping.returnTo;
    if (!ticket) throw Error('戻り先Sceneがありません。');
    const scene = this.scene(ticket.sceneId);
    if (
      scene.origin.artifactId !== ticket.address.artifactId ||
      scene.origin.versionId !== ticket.versionId
    )
      throw Error('戻り先の参照が変更されています。');
    const previousSelection = this.knownNativeSession(scene.origin.artifactId)?.snapshot.selection;
    const editor = await this.openScene(scene.id);
    if (
      navigation !== this.returnNavigation ||
      (previousSelection &&
        canonicalJson(previousSelection) !== canonicalJson(editor.snapshot.selection))
    )
      throw Error('別の移動または選択が行われました。古い戻り先を適用しません。');
    if (editor.snapshot.dirty || editor.artifact.draft.baseVersionId !== ticket.versionId)
      throw Error('戻り先の原稿が変わっています。推測で復帰しません。');
    if (!containsAddress(scene, editor.content, ticket.address.elementId))
      throw Error('戻り先の要素が削除されています。');
    if (
      scene.kind === 'document' &&
      resolveDocumentAddress(editor.content as DocumentContent, ticket.address).state !== 'Current'
    )
      throw Error('戻り先の選択位置が一致しません。');
    editor.select({ addresses: [ticket.address] });
    return { scene, editor, address: ticket.address };
  }
  async currentItem(mode: SceneItemReference['mode'], itemId: string): Promise<SceneItemReference> {
    const project = this.project(mode),
      card = project.cards.find((c) => c.id === itemId);
    if (!card) throw Error('正本に項目がありません。');
    const binding = project.binding(card);
    if (!binding) throw Error('設定画の対応がありません。');
    return {
      mode,
      itemId,
      source: {
        artifactId: project.source.id,
        versionId: project.mapping.source.versionId,
        elementId: card.elementId,
      },
      artwork: { ...binding.design, elementId: binding.chosenFrameId },
    };
  }
  async refreshReference(
    sceneId: string,
    mode: SceneItemReference['mode'],
    itemId: string,
    expected: SceneItemReference,
  ) {
    if (JSON.stringify(this.item(sceneId, mode, itemId)) !== JSON.stringify(expected))
      throw Error('参照が変更されています。再確認してください。');
    await this.editTarget(sceneId, mode, itemId);
    const p = this.project(mode);
    if (
      p.mappingDirty ||
      p.source.snapshot.dirty ||
      [...p.designs.values()].some((e) => e.snapshot.dirty)
    )
      throw Error('設定を保存してから参照版を更新してください。');
    const candidate = await this.currentItem(mode, itemId);
    if (
      candidate.source.artifactId !== expected.source.artifactId ||
      candidate.source.elementId !== expected.source.elementId ||
      candidate.artwork.artifactId !== expected.artwork.artifactId
    )
      throw Error('正本・設定画の対応が変わっています。別の成果物へ付け替えません。');
    const source = await this.record(candidate.source),
      artwork = await this.record(candidate.artwork);
    if (
      source.artifact.draft.baseVersionId !== candidate.source.versionId ||
      artwork.artifact.draft.baseVersionId !== candidate.artwork.versionId
    )
      throw Error('設定の対応表の保存が未完了です。設定画面で再保存してください。');
    if (JSON.stringify(this.item(sceneId, mode, itemId)) !== JSON.stringify(expected))
      throw Error('参照が確認中に変わりました。');
    const next = this.mapping;
    const scene = next.scenes.find((s) => s.id === sceneId)!;
    scene.items = scene.items.map((i) => (i.mode === mode && i.itemId === itemId ? candidate : i));
    await this.write(next);
  }
  async editTarget(sceneId: string, mode: SceneItemReference['mode'], itemId: string) {
    if (this.modeAvailable(mode) && !this.canReadMode(mode))
      throw Error('正本または設定画の参照権限が変更されました。');
    const view = await this.readReference(sceneId, mode, itemId);
    if (!['current', 'stale'].includes(view.state)) throw Error(view.reason);
    return this.editReferencedTarget(mode, itemId, view.reference);
  }
  /** Work-wide references do not imply membership in the Scene used as a return ticket. */
  async editCurrentTarget(mode: SceneItemReference['mode'], itemId: string) {
    if (!this.canReadMode(mode)) throw Error('正本または設定画の参照権限が変更されました。');
    return this.editReferencedTarget(mode, itemId, await this.currentItem(mode, itemId));
  }
  private async editReferencedTarget(
    mode: SceneItemReference['mode'],
    itemId: string,
    reference: SceneItemReference,
  ) {
    let current = await this.currentItem(mode, itemId);
    if (
      current.source.artifactId !== reference.source.artifactId ||
      current.source.elementId !== reference.source.elementId ||
      current.artwork.artifactId !== reference.artwork.artifactId
    )
      throw Error('正本・設定画の対応が一致しません。');
    const source = await this.record(current.source),
      art = await this.record(current.artwork);
    const p = this.project(mode);
    const localArt = p.editor(p.cards.find((c) => c.id === itemId)!);
    if (
      (source.artifact.draft.baseVersionId === p.source.artifact.draft.baseVersionId &&
        canonicalJson(source.artifact.draft.content) !==
          canonicalJson(p.source.artifact.draft.content)) ||
      (localArt &&
        art.artifact.draft.baseVersionId === localArt.artifact.draft.baseVersionId &&
        canonicalJson(art.artifact.draft.content) !==
          canonicalJson(localArt.artifact.draft.content))
    )
      throw Error('設定の保存draftが外部で変わりました。上書きしません。');
    if (
      source.artifact.draft.baseVersionId !== p.source.artifact.draft.baseVersionId ||
      art.artifact.draft.baseVersionId !== current.artwork.versionId
    ) {
      if (
        p.mappingDirty ||
        p.source.snapshot.dirty ||
        [...p.designs.values()].some((e) => e.snapshot.dirty)
      )
        throw Error('設定に未保存の変更があります。外部版へ再接続しません。');
      if (mode === 'character')
        this.characters = await CreativeProject.open(
          this.characters.mode,
          roleStorage(this.io, mode, this.mayRead),
          () => this.mayEdit() && this.canReadMode(mode),
        );
      else
        this.settings = await CreativeProject.open(
          this.settings.mode,
          roleStorage(this.io, mode, this.mayRead),
          () => this.mayEdit() && this.canReadMode(mode),
        );
      current = await this.currentItem(mode, itemId);
      if (
        current.source.artifactId !== reference.source.artifactId ||
        current.source.elementId !== reference.source.elementId ||
        current.artwork.artifactId !== reference.artwork.artifactId
      )
        throw Error('正本・設定画の対応が一致しません。');
    }
    return this.project(mode);
  }
  async readWorkingTarget(sceneId: string, mode: SceneItemReference['mode'], itemId: string) {
    const project = await this.editTarget(sceneId, mode, itemId);
    const card = project.cards.find((c) => c.id === itemId)!;
    const editor = project.editor(card);
    if (!editor || !this.mayRead(project.source.id) || !this.mayRead(editor.id))
      throw Error('設定画を参照できません。');
    return {
      reference: this.item(sceneId, mode, itemId),
      source: project.source.content,
      artwork: editor.content,
      baseLocalRevision: clone(editor.revision),
    };
  }
  /** AI port: saved snapshots + qualified proposals only. It never submits manuscript commands. */
  async proposePart(
    sceneId: string,
    mode: SceneItemReference['mode'],
    itemId: string,
    edits: readonly CreativeEdit[],
    scope: readonly CreativeDesignAddress[],
    request: { baseLocalRevision: LocalDraftRevision; allowShared?: boolean },
  ) {
    if (!this.mayEdit()) throw Error('閲覧のみのため変更案を受け付けません。');
    const view = await this.readReference(sceneId, mode, itemId);
    if (view.state !== 'current') throw Error(view.reason ?? '参照版が一致しません。');
    const shared = edits.some((e) => e.address.componentId && !e.address.instanceId);
    if (shared && (!request?.allowShared || !this.mayEditShared(mode, itemId)))
      throw Error('共有部品変更にはHostの明示的な許可が必要です。');
    const project = await this.editTarget(sceneId, mode, itemId),
      card = project.cards.find((c) => c.id === itemId)!;
    const sourceRevision = clone(project.source.revision);
    const expected = clone(view.reference);
    const editor = project.editor(card);
    if (!editor) throw Error('設定画がありません。');
    if (
      !request?.baseLocalRevision ||
      !sameLocalRevision(request.baseLocalRevision, editor.revision)
    )
      throw Error('変更計算時のrevisionが一致しません。');
    // CreativeProject revalidates source/target revision, permissions, qualified scope and locks.
    const proposal = project.propose(card, edits, scope, request.baseLocalRevision);
    return {
      preview: proposal,
      apply: async () => {
        const latest = await this.readReference(sceneId, mode, itemId);
        if (
          latest.state !== 'current' ||
          JSON.stringify(latest.reference) !== JSON.stringify(expected) ||
          !sameLocalRevision(sourceRevision, project.source.revision)
        )
          throw Error('参照が変わりました。変更案を作り直してください。');
        if (
          !this.mayEdit() ||
          !this.mayRead(expected.source.artifactId) ||
          !this.mayRead(expected.artwork.artifactId) ||
          (shared && !this.mayEditShared(mode, itemId))
        )
          throw Error('権限が変わりました。');
        if ((await this.editTarget(sceneId, mode, itemId)) !== project)
          throw Error('設定の編集接続が変わりました。変更案を作り直してください。');
        return editor.acceptProposal(proposal.id);
      },
      reject: () => editor.rejectProposal(proposal.id),
    };
  }
}
