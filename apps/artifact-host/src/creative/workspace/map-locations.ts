import {
  canonicalJson,
  clone,
  contentHash,
  serializeArtifact,
  type Artifact,
} from '@editor-platform/artifact-core';
import {
  ArtifactEditor,
  loadHostArtifact,
  type HostSaveContext,
} from '@editor-platform/editor-host';
import {
  parseFictionMapArtifact,
  fictionMapHostAdapter,
  adoptFictionMapBase,
} from '@editor-platform/fiction-map/host';
import {
  prepareFictionMapChange,
  commitFictionMapChange,
  type FictionMapContent,
} from '@editor-platform/fiction-map/model';
import type { DocumentContent } from '@editor-platform/document/model';
import { workspaceDocumentAdapter, type CreativeWorkspace } from './model';
import {
  readCreativeMapLinks,
  projectCreativeMapLocation,
  CreativeMapReferenceError,
  type CreativeMapLinks,
  type CreativeMapLocation,
} from './map-links';

type State = 'current' | 'stale' | 'missing' | 'invalid' | 'forbidden';
class MapProblem extends Error {
  constructor(
    readonly state: State,
    message: string,
  ) {
    super(message);
  }
}
export interface CreativeMapLocationView {
  reference: CreativeMapLocation;
  state: State;
  reason?: string;
  name?: string;
  summary?: string;
  svg?: string;
  overviewSvg?: string;
  features?: { id: string; name: string }[];
  latestVersionId?: string | null;
}
/** Coordination over WorkspaceLinks and native Editors. No duplicate association store or history. */
export class CreativeMapLocations {
  private editors = new Map<string, ArtifactEditor<FictionMapContent>>();
  private opens = new Map<string, Promise<ArtifactEditor<FictionMapContent>>>();
  private navigation = 0;
  constructor(
    private readonly workspace: CreativeWorkspace,
    private readonly write: (value: CreativeMapLinks, validate: () => void) => Promise<void>,
  ) {}
  get mapping(): CreativeMapLinks {
    return this.workspace.mapping.mapLocations ?? { revision: 0, locations: [] };
  }
  get hasUnsavedSources() {
    return [...this.editors.values()].some((e) => e.snapshot.dirty);
  }
  private readable(...ids: string[]) {
    if (!ids.every((id) => this.workspace.canReadWorld(id)))
      throw new MapProblem(
        'forbidden',
        '地図・場所の閲覧権限がありません。保存された画像も表示しません。',
      );
  }
  private writable(id: string) {
    this.readable(id);
    if (!this.workspace.canPrepareWorldInput)
      throw Error('閲覧のみのため地図・参照を変更できません。');
  }
  private assertIdentity(r: CreativeMapLocation) {
    readCreativeMapLinks({ revision: 0, locations: [r] });
    this.readable(r.source.artifactId, r.map.artifactId);
    if (
      r.namespace !== this.workspace.mapping.world?.namespace ||
      r.source.artifactId !== this.workspace.settings.source.id
    )
      throw new MapProblem(
        'invalid',
        '作品namespaceまたはLO正本が異なります。同名の場所へ付け替えません。',
      );
    if (r.sceneId) {
      const item = this.workspace
        .scene(r.sceneId)
        .items.find((i) => i.mode === 'setting' && i.itemId === r.itemId);
      if (
        !item ||
        item.source.artifactId !== r.source.artifactId ||
        item.source.elementId !== r.source.elementId
      )
        throw new MapProblem('invalid', 'このSceneと場所の対応がありません。');
    }
  }
  private async artifact(id: string) {
    this.readable(id);
    const a = await this.workspace.io.artifacts.get(id);
    this.readable(id);
    if (!a || a.id !== id) throw new MapProblem('missing', '固定参照のArtifactがありません。');
    return a;
  }
  async readMapVersion(artifactId: string, versionId: string) {
    const a = await this.artifact(artifactId);
    if (a.kind !== 'fiction-map')
      throw new MapProblem('invalid', '参照先はFiction Mapではありません。');
    const map = await parseFictionMapArtifact(serializeArtifact(a));
    this.readable(artifactId);
    const v = map.versions.find((v) => v.versionId === versionId);
    if (!v)
      throw new MapProblem('missing', '指定した地図保存版がありません。最新版で代用しません。');
    return { artifact: map, version: v };
  }
  async sources() {
    const list = await this.workspace.io.artifacts.list();
    return list
      .filter((a) => a.kind === 'fiction-map' && this.workspace.canReadWorld(a.id))
      .map((a) => ({
        id: a.id,
        name: a.name,
        versions: a.versions.map((v) => ({ versionId: v.versionId, contentHash: v.contentHash })),
      }));
  }
  async location(
    itemId: string,
    sceneId?: string,
  ): Promise<Pick<CreativeMapLocation, 'namespace' | 'itemId' | 'source' | 'sceneId'>> {
    const namespace = this.workspace.mapping.world?.namespace;
    if (!namespace) throw Error('先に作品設定を接続してください。');
    const item = sceneId
      ? this.workspace.item(sceneId, 'setting', itemId)
      : await this.workspace.currentItem('setting', itemId);
    const a = await this.artifact(item.source.artifactId);
    const v = a.versions.find((v) => v.versionId === item.source.versionId);
    if (!v || (await contentHash(v.content)) !== v.contentHash)
      throw Error('場所の保存版・hashを確認してください。');
    this.readable(a.id);
    return {
      namespace,
      itemId,
      source: { ...item.source, contentHash: v.contentHash },
      ...(sceneId ? { sceneId } : {}),
    };
  }
  async read(reference: CreativeMapLocation): Promise<CreativeMapLocationView> {
    const r = clone(reference);
    try {
      this.assertIdentity(r);
      const source = await this.artifact(r.source.artifactId);
      const native = await loadHostArtifact(serializeArtifact(source), workspaceDocumentAdapter);
      const v = native.versions.find((v) => v.versionId === r.source.versionId);
      if (!v) throw new MapProblem('missing', '場所の指定保存版がありません。');
      if (
        v.contentHash !== r.source.contentHash ||
        (await contentHash(v.content)) !== r.source.contentHash
      )
        throw new MapProblem('invalid', '場所のhashが一致しません。');
      const cards = this.workspace.settings.mode
        .cards(v.content as DocumentContent)
        .filter((c) => c.id === r.itemId && c.elementId === r.source.elementId);
      if (cards.length !== 1) throw new MapProblem('invalid', '場所の参照が欠落または曖昧です。');
      const { artifact, version } = await this.readMapVersion(r.map.artifactId, r.map.versionId);
      if (version.contentHash !== r.map.contentHash)
        throw new MapProblem('invalid', '地図のhashが一致しません。');
      const projection = projectCreativeMapLocation(r, version.content);
      this.assertIdentity(r);
      const stale =
        artifact.draft.baseVersionId !== r.map.versionId ||
        source.draft.baseVersionId !== r.source.versionId;
      return {
        reference: r,
        state: stale ? 'stale' : 'current',
        name: cards[0].name,
        summary: cards[0].summary,
        ...projection,
        latestVersionId: artifact.draft.baseVersionId,
        ...(stale
          ? { reason: '新版があります。場所と地図の採用版は明示更新まで維持します。' }
          : {}),
      };
    } catch (e) {
      return {
        reference: r,
        state:
          e instanceof MapProblem || e instanceof CreativeMapReferenceError ? e.state : 'invalid',
        reason: e instanceof Error ? e.message : String(e),
      };
    }
  }
  async save(reference: CreativeMapLocation, expectedRevision: number) {
    const r = readCreativeMapLinks({ revision: 0, locations: [reference] }).locations[0];
    const expected = this.mapping;
    if (expected.revision !== expectedRevision) throw Error('地図対応表revisionが競合しています。');
    this.writable(r.map.artifactId);
    const existing = expected.locations.find((v) => v.id === r.id);
    if (
      existing &&
      canonicalJson([existing.namespace, existing.itemId, existing.sceneId ?? null]) !==
        canonicalJson([r.namespace, r.itemId, r.sceneId ?? null])
    )
      throw Error('別の場所・Sceneの参照へ上書きできません。');
    const locations = existing
      ? expected.locations.map((v) => (v.id === r.id ? r : v))
      : [...expected.locations, r];
    const next = readCreativeMapLinks({ revision: expectedRevision + 1, locations });
    const valid = await this.read(r);
    if (!['current', 'stale'].includes(valid.state)) throw Error(valid.reason);
    const check = () => {
      this.writable(r.map.artifactId);
      this.assertIdentity(r);
      if (canonicalJson(this.mapping) !== canonicalJson(expected))
        throw Error('地図対応表revisionが競合しています。');
    };
    check();
    await this.write(next, check);
  }
  async remove(id: string, expectedRevision: number) {
    const expected = this.mapping;
    if (expected.revision !== expectedRevision) throw Error('地図対応表revisionが競合しています。');
    if (!expected.locations.some((r) => r.id === id)) throw Error('地図参照がありません。');
    await this.write(
      { revision: expectedRevision + 1, locations: expected.locations.filter((r) => r.id !== id) },
      () => {
        if (canonicalJson(this.mapping) !== canonicalJson(expected))
          throw Error('地図対応表revisionが競合しています。');
      },
    );
  }
  async open(reference: CreativeMapLocation) {
    reference = clone(reference);
    const navigation = ++this.navigation;
    const view = await this.read(reference);
    if (!['current', 'stale'].includes(view.state)) throw Error(view.reason);
    const a = await this.artifact(reference.map.artifactId);
    const map = await parseFictionMapArtifact(serializeArtifact(a));
    this.readable(a.id, reference.source.artifactId);
    // A retained old pin may still render, while an edit destination may have been deleted.
    projectCreativeMapLocation(reference, map.draft.content);
    const editor = await this.session(map);
    if (navigation !== this.navigation)
      throw Error('新しい地図移動が選択されました。遅い読取を適用しません。');
    this.readable(a.id, reference.source.artifactId);
    if (editor.snapshot.dirty)
      throw Error('地図に未保存編集があります。保存してから移動してください。');
    editor.select({
      addresses: reference.map.featureIds.map((elementId) => ({ artifactId: a.id, elementId })),
    });
    return editor;
  }
  /** Resolve the native Setting target without adding a work-wide LO to a Scene. */
  async editLocation(reference: CreativeMapLocation) {
    reference = clone(reference);
    const view = await this.read(reference);
    if (!['current', 'stale'].includes(view.state)) throw Error(view.reason);
    if (reference.sceneId)
      await this.workspace.editTarget(reference.sceneId, 'setting', reference.itemId);
    else await this.workspace.editCurrentTarget('setting', reference.itemId);
    const target = await this.workspace.currentItem('setting', reference.itemId);
    this.readable(target.source.artifactId, target.artwork.artifactId);
    if (
      target.source.artifactId !== reference.source.artifactId ||
      target.source.elementId !== reference.source.elementId
    )
      throw Error('地図と場所正本の対応が変わりました。推測で接続しません。');
    return target;
  }
  private async session(map: Artifact<FictionMapContent>) {
    const id = map.id;
    const check = (editor: ArtifactEditor<FictionMapContent>) => {
      this.readable(id);
      if (
        editor.artifact.draft.baseVersionId !== map.draft.baseVersionId ||
        canonicalJson(editor.artifact.draft.content) !== canonicalJson(map.draft.content)
      )
        throw Error('地図draftが外部で変わりました。未保存作業を保持します。');
      return editor;
    };
    const current = this.editors.get(id);
    if (current) return check(current);
    const pending = this.opens.get(id);
    if (pending) return check(await pending);
    const opening = Promise.resolve().then(() => {
      let baseline = clone(map),
        attempted: Artifact<FictionMapContent> | undefined;
      const editor = new ArtifactEditor(
        map,
        fictionMapHostAdapter,
        {
          put: async (value: Artifact<FictionMapContent>, context?: HostSaveContext) => {
            this.writable(id);
            const stored = await this.artifact(id);
            this.writable(id);
            // An unknown put outcome is retried with the native Editor's exact captured version.
            if (
              attempted &&
              canonicalJson(stored) === canonicalJson(attempted) &&
              canonicalJson(value) === canonicalJson(attempted)
            ) {
              baseline = clone(value);
              attempted = undefined;
              return;
            }
            if (canonicalJson(stored) !== canonicalJson(baseline))
              throw Error('地図保存が競合しています。未保存編集を保持します。');
            attempted = clone(value);
            await this.workspace.io.artifacts.put(value, context);
            baseline = clone(value);
            attempted = undefined;
          },
        },
        () => this.workspace.canPrepareWorldInput && this.workspace.canReadWorld(id),
      );
      this.editors.set(id, editor);
      return check(editor);
    });
    this.opens.set(id, opening);
    try {
      return await opening;
    } finally {
      if (this.opens.get(id) === opening) this.opens.delete(id);
    }
  }
  /** Open a saved map explicitly before assigning a missing opaque ref. Does not adopt a pin. */
  async openUnbound(artifactId: string, versionId: string) {
    const { artifact } = await this.readMapVersion(artifactId, versionId);
    return this.session(artifact);
  }
  assign(editor: ArtifactEditor<FictionMapContent>, ids: string[], itemId: string) {
    this.writable(editor.id);
    if (this.editors.get(editor.id) !== editor)
      throw Error('現在の地図編集セッションではありません。');
    editor.flushInputs();
    const namespace = this.workspace.mapping.world?.namespace;
    if (!namespace || !this.workspace.settings.cards.some((c) => c.id === itemId))
      throw Error('場所の接続を確認してください。');
    this.readable(this.workspace.settings.source.id);
    if (!ids.length || new Set(ids).size !== ids.length)
      throw Error('地物を重複なく明示選択してください。');
    const base = adoptFictionMapBase(editor);
    const update = ids.map((id) => {
      const f = base.content.features.find((f) => f.id === id);
      if (!f) throw Error('地物がありません。');
      if (
        f.worldEntityRef &&
        (f.worldEntityRef.namespace !== namespace || f.worldEntityRef.entityId !== itemId)
      )
        throw Error('既存の意味参照と衝突します。上書きしません。');
      return { ...f, worldEntityRef: { namespace, entityId: itemId } };
    });
    const prepared = prepareFictionMapChange(base, { update });
    if (!prepared.ok) throw Error(prepared.diagnostic.code);
    const committed = commitFictionMapChange(
      editor,
      prepared.value,
      () =>
        this.workspace.canPrepareWorldInput &&
        this.workspace.canReadWorld(editor.id) &&
        this.workspace.canReadWorld(this.workspace.settings.source.id),
    );
    if (!committed.ok) throw Error(committed.diagnostic.code);
  }
  async saveSource(editor: ArtifactEditor<FictionMapContent>) {
    this.writable(editor.id);
    if (this.editors.get(editor.id) !== editor)
      throw Error('現在の地図編集セッションではありません。');
    editor.flushInputs();
    if (editor.snapshot.dirty) await editor.save({ commitVersion: true });
  }
}
