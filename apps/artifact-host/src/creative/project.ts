import {
  canonicalJson,
  clone,
  contentHash,
  commitVersion,
  createArtifact,
  newId,
  serializeArtifact,
  type Artifact,
  type StorageAdapter,
} from '@editor-platform/artifact-core';
import {
  command,
  sameLocalRevision,
  type EditorCommand,
  type ProposedCommands,
} from '@editor-platform/editor-core';
import {
  ArtifactEditor,
  checkHostProposal,
  loadHostArtifact,
  type EditorHostAdapter,
  type HostPendingProposal,
  type HostProposalHooks,
} from '@editor-platform/editor-host';
import {
  duplicateElements,
  guardDesignCommand,
  isDesignWithPaths,
  transformElements,
  updateElement,
  type DesignContent,
  type DesignElement,
} from '@editor-platform/design/model';
import {
  createCreativeDesignHostAdapter,
  creativeDesignEditCommand,
  prepareCreativeDesignProposal,
  type CreativeDesignAddress,
} from '@editor-platform/design/creative-proposal-diff';
import { attributedCreativeRasterEdit } from './raster-edit';
import type { CreativeMode, CreativeSourceCard } from './types';

export interface CreativeBinding {
  itemId: string;
  sourceElementId: string;
  design: { artifactId: string; versionId: string };
  chosenFrameId: string;
  /** Host reference only. The rough content remains in this Design's immutable version. */
  rough?: { versionId: string; frameId: string };
  related?: { artifactId: string; versionId: string }[];
}
/** Host references and choices only: no copied character/location text or geometry. */
export interface CreativeMapping {
  schemaVersion: 1;
  mode: string;
  source: { artifactId: string; versionId: string };
  bindings: CreativeBinding[];
}
export interface CreativeStorage {
  artifacts: StorageAdapter<Artifact<unknown>>;
  readMapping(): Promise<unknown>;
  writeMapping(value: CreativeMapping): Promise<void>;
}
export interface CreativeEdit {
  address: CreativeDesignAddress;
  patch: Partial<DesignElement>;
}
const designAdapter = createCreativeDesignHostAdapter({
  kind: 'design',
  validate: isDesignWithPaths,
  capabilities: {
    undo: true,
    nativeJson: true,
    formats: [],
    preview: 'none',
    shared: false,
    proposals: true,
  },
} as const);
const nonempty = (v: unknown): v is string =>
  typeof v === 'string' && !!v.trim() && v.length <= 4096;
const keys = (v: unknown, allowed: string[]) =>
  !!v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).every((key) => allowed.includes(key));
export function readCreativeMapping(raw: unknown, mode: string): CreativeMapping {
  const m = raw as CreativeMapping | null;
  if (
    !keys(m, ['schemaVersion', 'mode', 'source', 'bindings']) ||
    !m ||
    m.schemaVersion !== 1 ||
    m.mode !== mode ||
    !keys(m.source, ['artifactId', 'versionId']) ||
    !m.source ||
    !nonempty(m.source.artifactId) ||
    !nonempty(m.source.versionId) ||
    !Array.isArray(m.bindings) ||
    m.bindings.length > 256 ||
    m.bindings.some(
      (b) =>
        !keys(b, ['itemId', 'sourceElementId', 'chosenFrameId', 'design', 'related', 'rough']) ||
        !b ||
        !nonempty(b.itemId) ||
        !nonempty(b.sourceElementId) ||
        !nonempty(b.chosenFrameId) ||
        !keys(b.design, ['artifactId', 'versionId']) ||
        !b.design ||
        !nonempty(b.design.artifactId) ||
        !nonempty(b.design.versionId) ||
        (b.rough !== undefined &&
          (!keys(b.rough, ['versionId', 'frameId']) ||
            !b.rough ||
            !nonempty(b.rough.versionId) ||
            !nonempty(b.rough.frameId))) ||
        (b.related !== undefined &&
          (!Array.isArray(b.related) ||
            b.related.length > 64 ||
            b.related.some(
              (r) =>
                !keys(r, ['artifactId', 'versionId']) ||
                !r ||
                !nonempty(r.artifactId) ||
                !nonempty(r.versionId),
            ) ||
            new Set(b.related.map((r) => `${r.artifactId}:${r.versionId}`)).size !==
              b.related.length)),
    ) ||
    new Set(m.bindings.map((b) => b.itemId)).size !== m.bindings.length ||
    new Set(m.bindings.map((b) => b.sourceElementId)).size !== m.bindings.length ||
    new Set(m.bindings.map((b) => b.design.artifactId)).size !== m.bindings.length
  )
    throw Error('保存した設定画の対応表が不正です。元の保存データを確認してください。');
  return clone(m);
}
function typedStorage<T>(
  io: CreativeStorage,
  adapter: EditorHostAdapter<T>,
): StorageAdapter<Artifact<T>> {
  return {
    async list() {
      const all = await io.artifacts.list();
      return Promise.all(
        all
          .filter((a) => a.kind === adapter.kind)
          .map((a) => loadHostArtifact(serializeArtifact(a), adapter)),
      );
    },
    async get(id) {
      const a = await io.artifacts.get(id);
      return a ? loadHostArtifact(serializeArtifact(a), adapter) : undefined;
    },
    put: (value) => io.artifacts.put(value),
    ...(io.artifacts.putIfAbsent
      ? {
          putIfAbsent: async (value: Artifact<T>) =>
            loadHostArtifact(serializeArtifact(await io.artifacts.putIfAbsent!(value)), adapter),
        }
      : {}),
    remove: (id) => io.artifacts.remove(id),
  };
}
export const candidateFrames = (content: DesignContent) =>
  content.elements.filter((e) => e.type === 'frame' && !e.parentId);
export function candidateInstance(
  content: DesignContent,
  frameId: string,
  componentId: string,
): DesignElement {
  const found = content.elements.filter(
    (e) => e.type === 'instance' && e.parentId === frameId && e.componentId === componentId,
  );
  if (found.length !== 1)
    throw Error('候補と共有部品の対応が欠落または曖昧です。レイヤーを確認してください。');
  return found[0];
}

/** Owns native Editors, never another history. Consuming Hosts may inject existing source/artifacts. */
export class CreativeProject<T> {
  readonly designs = new Map<string, ArtifactEditor<DesignContent>>();
  private map: CreativeMapping;
  private creating = new Set<string>();
  mappingDirty = false;
  saving = false;
  private constructor(
    readonly mode: CreativeMode<T>,
    readonly source: ArtifactEditor<T>,
    mapping: CreativeMapping,
    private readonly io: CreativeStorage,
    private readonly writable: () => boolean,
  ) {
    this.map = mapping;
  }
  get mapping() {
    return clone(this.map);
  }
  get cards() {
    return this.mode.cards(this.source.content);
  }
  private assertEdit() {
    if (!this.writable()) throw Error('閲覧のみのため変更できません。');
    if (this.saving) throw Error('保存が完了してから操作してください。');
  }
  binding(item: CreativeSourceCard) {
    const binding = this.findBinding(item);
    return binding && clone(binding);
  }
  private findBinding(item: CreativeSourceCard) {
    return this.map.bindings.find(
      (b) => b.itemId === item.id && b.sourceElementId === item.elementId,
    );
  }
  static async open<T>(
    mode: CreativeMode<T>,
    io: CreativeStorage,
    writable: () => boolean = () => true,
    existingSourceId?: string,
  ): Promise<CreativeProject<T>> {
    const raw = await io.readMapping();
    let mapping: CreativeMapping;
    let artifact: Artifact<T>;
    const store = typedStorage(io, mode.adapter);
    if (raw === undefined || raw === null) {
      if (!writable()) throw Error('最初の接続には編集権限が必要です。');
      if (existingSourceId) {
        const existing = await store.get(existingSourceId);
        if (!existing || !existing.draft.baseVersionId)
          throw Error('正本が見つからないか、保存版がありません。元のEditorで保存してください。');
        artifact = existing;
      } else {
        const id = `creative:${mode.id}:source`;
        artifact =
          (await store.get(id)) ??
          (await commitVersion(
            { ...createArtifact(mode.adapter.kind, mode.sourceLabel, mode.seed()), id },
            null,
            'Create reference source',
          ));
        if (!(await store.get(id))) {
          if (!writable()) throw Error('編集権限が変わりました。');
          if (store.putIfAbsent) artifact = await store.putIfAbsent(artifact);
          else await store.put(artifact);
        }
      }
      mapping = {
        schemaVersion: 1,
        mode: mode.id,
        source: { artifactId: artifact.id, versionId: artifact.draft.baseVersionId! },
        bindings: [],
      };
    } else {
      mapping = readCreativeMapping(raw, mode.id);
      if (existingSourceId && mapping.source.artifactId !== existingSourceId)
        throw Error('保存した対応表と接続先の正本が異なります。');
      const existing = await store.get(mapping.source.artifactId);
      if (!existing)
        throw Error('正本が見つかりません。対応表を破棄せず、元の成果物を復元してください。');
      artifact = existing;
    }
    if (!artifact.versions.some((v) => v.versionId === mapping.source.versionId))
      throw Error('参照していた正本の保存版がありません。対応表を確認してください。');
    mapping = readCreativeMapping(mapping, mode.id);
    const source = new ArtifactEditor(artifact, mode.adapter, store, writable);
    const project = new CreativeProject(mode, source, mapping, io, writable);
    // Verify every retained reference's content/hash through public loading, without silently rebasing.
    for (const binding of mapping.bindings) {
      if (
        !project.cards.some(
          (c) => c.id === binding.itemId && c.elementId === binding.sourceElementId,
        )
      )
        throw Error(`正本のIDと行・見出しの対応が一致しません: ${binding.itemId}`);
      const stored = await typedStorage(io, designAdapter).get(binding.design.artifactId);
      if (!stored) throw Error(`設定画が見つかりません: ${binding.itemId}`);
      if (!stored.versions.some((v) => v.versionId === binding.design.versionId))
        throw Error(`参照していた設定画の保存版がありません: ${binding.itemId}`);
      if (binding.rough) {
        const rough = stored.versions.find((v) => v.versionId === binding.rough!.versionId);
        if (!rough || !candidateFrames(rough.content).some((f) => f.id === binding.rough!.frameId))
          throw Error(`ラフの基準版・Frameがありません: ${binding.itemId}`);
      }
      project.designs.set(
        binding.design.artifactId,
        new ArtifactEditor(stored, designAdapter, typedStorage(io, designAdapter), writable),
      );
    }
    if (raw === undefined || raw === null) {
      if (!writable()) throw Error('最初の接続には編集権限が必要です。');
      await io.writeMapping(project.mapping);
    }
    return project;
  }
  problem(item: CreativeSourceCard): string | undefined {
    const b = this.findBinding(item);
    if (!b) return undefined;
    const design = this.designs.get(b.design.artifactId);
    if (this.source.artifact.draft.baseVersionId !== this.map.source.versionId)
      return '正本の保存版が対応表と異なります。現在の正本との対応を保存してください。';
    if (!this.source.artifact.versions.some((v) => v.versionId === this.map.source.versionId))
      return '参照していた正本の版がありません。';
    if (!design || design.artifact.draft.baseVersionId !== b.design.versionId)
      return '設定画の保存版が対応表と異なります。現在の対応を保存してください。';
    if (!candidateFrames(design.content).some((f) => f.id === b.chosenFrameId))
      return '選択した候補が見つかりません。別の候補を明示的に選んでください。';
    return undefined;
  }
  editor(item: CreativeSourceCard) {
    const b = this.binding(item);
    return b && this.designs.get(b.design.artifactId);
  }
  /** Host-owned exact references. Related content remains in its original artifact/version. */
  availableArtifacts() {
    return this.io.artifacts.list();
  }
  relatedArtifact(id: string) {
    return this.io.artifacts.get(id);
  }
  async linkRelated(item: CreativeSourceCard, artifactId: string, versionId: string) {
    this.assertEdit();
    this.assertLinked(item);
    const a = await this.io.artifacts.get(artifactId);
    const version = a?.versions.find((v) => v.versionId === versionId);
    if (!version) throw Error('参照する保存版がありません。');
    if ((await contentHash(version.content)) !== version.contentHash)
      throw Error('参照する保存版が破損しています。');
    this.assertEdit();
    this.assertLinked(item);
    const b = this.findBinding(item);
    if (!b) throw Error('先に設定画を作成してください。');
    const refs = b.related ?? [];
    if (!refs.some((r) => r.artifactId === artifactId && r.versionId === versionId)) {
      if (refs.length >= 64) throw Error('関連成果物は64件までです。');
      b.related = [...refs, { artifactId, versionId }];
      this.mappingDirty = true;
    }
  }
  unlinkRelated(item: CreativeSourceCard, artifactId: string, versionId: string) {
    this.assertEdit();
    const b = this.findBinding(item);
    if (!b) return;
    b.related = (b.related ?? []).filter(
      (r) => r.artifactId !== artifactId || r.versionId !== versionId,
    );
    this.mappingDirty = true;
  }
  assertLinked(item: CreativeSourceCard) {
    if (!this.cards.some((c) => c.id === item.id && c.elementId === item.elementId))
      throw Error('正本の対象が変更または削除されています。');
    const problem = this.problem(item);
    if (problem) throw Error(problem);
  }
  async ensureDesign(item: CreativeSourceCard) {
    this.assertEdit();
    this.assertLinked(item);
    const found = this.editor(item);
    if (found) return found;
    if (this.map.bindings.length + this.creating.size >= 256)
      throw Error('設定画を接続できる対象は256件までです。');
    if (this.creating.has(item.elementId)) throw Error('設定画を作成中です。');
    if (this.map.bindings.some((b) => b.sourceElementId === item.elementId || b.itemId === item.id))
      throw Error('意味IDと正本の対応が変わっています。保存した対応表を確認してください。');
    const id = `creative:${JSON.stringify([this.mode.id, this.source.id, item.elementId])}`;
    if (!nonempty(id)) throw Error('設定画の複合IDが長すぎます。正本・要素IDを確認してください。');
    const store = typedStorage(this.io, designAdapter);
    this.creating.add(item.elementId);
    try {
      let artifact =
        (await store.get(id)) ??
        (await commitVersion(
          { ...createArtifact('design', `${item.name}の設定画`, this.mode.design(item.name)), id },
          null,
          'Create setting artwork',
        ));
      if (!(await store.get(id))) {
        this.assertEdit();
        this.assertLinked(item);
        if (store.putIfAbsent) artifact = await store.putIfAbsent(artifact);
        else await store.put(artifact);
      }
      this.assertEdit();
      this.assertLinked(item);
      const editor = new ArtifactEditor(artifact, designAdapter, store, this.writable);
      const frame = candidateFrames(editor.content)[0];
      if (!frame) throw Error('候補Frameがありません。');
      if (!nonempty(frame.id)) throw Error('候補FrameのIDが長すぎます。');
      this.designs.set(id, editor);
      this.map.bindings.push({
        itemId: item.id,
        sourceElementId: item.elementId,
        design: { artifactId: id, versionId: artifact.draft.baseVersionId! },
        chosenFrameId: frame.id,
      });
      this.mappingDirty = true;
      return editor;
    } finally {
      this.creating.delete(item.elementId);
    }
  }
  choose(item: CreativeSourceCard, frameId: string) {
    this.assertEdit();
    const editor = this.editor(item),
      binding = this.findBinding(item);
    if (!editor || !binding || !candidateFrames(editor.content).some((f) => f.id === frameId))
      throw Error('選択する候補がありません。');
    binding.chosenFrameId = frameId;
    this.mappingDirty = true;
  }
  addCandidate(item: CreativeSourceCard, frameId: string, name: string) {
    this.assertEdit();
    this.assertLinked(item);
    const editor = this.editor(item);
    if (!editor) throw Error('設定画を開いてください。');
    const oldIds = new Set(candidateFrames(editor.content).map((f) => f.id));
    const edit = command<DesignContent>('creative.candidate', '候補を追加', (content) => {
      const original = candidateFrames(content).find((f) => f.id === frameId);
      if (!original) throw Error('元の候補がありません。');
      const copied = duplicateElements([frameId]).apply(content);
      const frame = candidateFrames(copied).find((f) => !oldIds.has(f.id));
      if (!frame) throw Error('候補を複製できませんでした。');
      const end = Math.max(...candidateFrames(content).map((f) => f.bounds.x + f.bounds.width));
      const moved = transformElements([frame.id], {
        dx: end + 32 - frame.bounds.x,
        dy: original.bounds.y - frame.bounds.y,
        dw: 0,
        dh: 0,
      }).apply(copied);
      return updateElement(frame.id, { name: name.trim() || '新しい候補' }).apply(moved);
    });
    editor.execute(guardDesignCommand(edit));
    return candidateFrames(editor.content).find((f) => !oldIds.has(f.id))!.id;
  }
  execute(item: CreativeSourceCard, edit: EditorCommand<DesignContent>) {
    this.assertEdit();
    this.assertLinked(item);
    const editor = this.editor(item);
    if (!editor) throw Error('設定画がありません。');
    const native =
      edit.type === 'design.raster.edit'
        ? attributedCreativeRasterEdit(edit, editor.artifact)
        : edit;
    return editor.execute(guardDesignCommand(native));
  }
  propose(
    item: CreativeSourceCard,
    edits: readonly CreativeEdit[],
    scope: readonly CreativeDesignAddress[],
    base = this.editor(item)?.revision,
    validate?: () => void,
    hooks?: HostProposalHooks<DesignContent>,
  ): HostPendingProposal<DesignContent> {
    this.assertEdit();
    this.assertLinked(item);
    const editor = this.editor(item);
    if (!editor || !base) throw Error('設定画がありません。');
    for (const { address, patch } of edits) {
      const target = address.componentId
        ? editor.content.components
            .find((c) => c.id === address.componentId)
            ?.elements?.find((e) => e.id === address.elementId)
        : editor.content.elements.find((e) => e.id === address.elementId);
      if (
        target?.type === 'group' &&
        Object.keys(patch).some((key) => key !== 'hidden' && key !== 'locked')
      )
        throw Error(
          '部位グループの変更案は表示・ロックに対応しています。位置や見た目は個々の部位を指定してください。',
        );
    }
    const sourceRevision = clone(this.source.revision),
      sourceVersion = this.source.artifact.draft.baseVersionId;
    const expectedMapping = clone(this.map.source);
    if (!sourceVersion)
      throw Error('正本の保存版がありません。保存してから変更案を作成してください。');
    const proposal: ProposedCommands<DesignContent> = prepareCreativeDesignProposal(
      {
        id: newId('creative-proposal'),
        summary: '選んだ部位の変更案',
        baseLocalRevision: base,
        reads: {
          target: { artifactId: editor.id, versionId: editor.artifact.draft.baseVersionId },
          references: [{ artifactId: this.source.id, versionId: sourceVersion }],
        },
        commands: edits.map((e) => creativeDesignEditCommand(e.address, e.patch)),
      },
      { required: [...scope] },
      () => {
        validate?.();
        this.assertLinked(item);
        if (
          !sameLocalRevision(this.source.revision, sourceRevision) ||
          this.source.artifact.draft.baseVersionId !== sourceVersion ||
          this.map.source.artifactId !== expectedMapping.artifactId ||
          this.map.source.versionId !== expectedMapping.versionId
        )
          throw Error('正本が編集開始後に変わりました。新しい変更案を確認してください。');
        const check = checkHostProposal(editor, proposal, (id) =>
          id === this.source.id
            ? this.source.readOnly
              ? { status: 'forbidden' }
              : { status: 'available', versionId: this.source.artifact.draft.baseVersionId }
            : undefined,
        );
        if (!check.fresh)
          throw Error('参照版または権限が変わりました。変更案を作り直してください。');
        return this.writable();
      },
    );
    return editor.propose(proposal, hooks);
  }
  /** Validate live source/candidate bindings before any project-owned native save. No IO. */
  assertSaveIntegrity() {
    readCreativeMapping(this.map, this.mode.id);
    const cards = this.cards;
    for (const b of this.map.bindings) {
      const editor = this.designs.get(b.design.artifactId);
      if (
        !cards.some((c) => c.id === b.itemId && c.elementId === b.sourceElementId) ||
        !editor ||
        !candidateFrames(editor.content).some((f) => f.id === b.chosenFrameId)
      )
        throw Error(
          '正本または選択候補がありません。元に戻す操作を取り消すか、対応を確認してください。',
        );
    }
  }
  async save(options?: {
    rough?: { itemId: string; frameId: string };
    /** Reuse exact clean saved versions by default. False explicitly requests new versions. */
    reuseSavedVersions?: boolean;
  }) {
    const pinRequest = options?.rough ? clone(options.rough) : undefined;
    this.assertEdit();
    this.source.flushInputs();
    for (const editor of this.designs.values()) editor.flushInputs();
    this.assertSaveIntegrity();
    const cards = this.cards;
    if (pinRequest) {
      const item = cards.find((c) => c.id === pinRequest.itemId),
        editor = item && this.editor(item);
      if (!editor || !candidateFrames(editor.content).some((f) => f.id === pinRequest.frameId))
        throw Error('ラフの対象Frameがありません。');
    }
    // Artifacts and the Host reference table save separately. Keep retry/leave protection
    // even when artifact writes succeeded and only the final reference-table write failed.
    this.mappingDirty = true;
    this.saving = true;
    try {
      const save = async <C>(editor: ArtifactEditor<C>) => {
        const state = editor.snapshot,
          artifact = editor.artifact;
        const version = artifact.versions.find((v) => v.versionId === artifact.draft.baseVersionId);
        if (
          options?.reuseSavedVersions !== false &&
          !state.dirty &&
          version &&
          canonicalJson(version.content) === canonicalJson(state.content) &&
          (state.savedRevision
            ? sameLocalRevision(state.savedRevision, state.revision)
            : editor.proposalTransactions.length === 0)
        )
          return;
        await editor.save({ commitVersion: true });
      };
      await save(this.source);
      for (const editor of this.designs.values()) await save(editor);
      if (this.source.snapshot.dirty || [...this.designs.values()].some((e) => e.snapshot.dirty))
        throw Error('保存中に編集されました。変更を保持しています。もう一度保存してください。');
      if (!this.writable()) throw Error('保存中に権限が変わりました。');
      const next = this.mapping;
      next.source.versionId = this.source.artifact.draft.baseVersionId!;
      for (const b of next.bindings) {
        const card = this.cards.find((c) => c.id === b.itemId && c.elementId === b.sourceElementId),
          editor = this.designs.get(b.design.artifactId);
        if (
          !card ||
          !editor ||
          !candidateFrames(editor.content).some((f) => f.id === b.chosenFrameId)
        )
          throw Error('正本または選択候補がありません。対応を確認してから保存してください。');
        b.design.versionId = editor.artifact.draft.baseVersionId!;
        if (pinRequest?.itemId === b.itemId)
          b.rough = { versionId: b.design.versionId, frameId: pinRequest.frameId };
      }
      const captured = [this.source, ...this.designs.values()].map((editor) => ({
        editor,
        revision: clone(editor.revision),
      }));
      readCreativeMapping(next, this.mode.id);
      await this.io.writeMapping(next);
      if (!this.writable()) throw Error('保存中に権限が変わりました。');
      if (
        captured.some(
          ({ editor, revision }) =>
            !sameLocalRevision(editor.revision, revision) || editor.snapshot.dirty,
        ) ||
        this.source.artifact.draft.baseVersionId !== next.source.versionId ||
        next.bindings.some(
          (b) =>
            this.designs.get(b.design.artifactId)?.artifact.draft.baseVersionId !==
            b.design.versionId,
        )
      )
        throw Error('保存中に編集されました。変更を保持しています。もう一度保存してください。');
      this.map = next;
      this.mappingDirty = false;
    } finally {
      this.saving = false;
    }
  }
}
