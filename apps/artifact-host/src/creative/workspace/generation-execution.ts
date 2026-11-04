import {
  canonicalJson,
  clone,
  contentHash,
  newId,
  type Artifact,
} from '@editor-platform/artifact-core';
import type {
  ArtifactEditor,
  HostPendingProposal,
  HostProposalApplied,
  HostProposalResult,
  HostSavedEvent,
} from '@editor-platform/editor-host';
import { isDesignWithPaths, type DesignContent } from '@editor-platform/design/model';
import { creativeDesignAddressKey } from '@editor-platform/design/creative-proposal-diff';
import {
  bindCreativeWorldReview,
  declareCreativeWorldRequest,
  readPreparedCreativeLayerInput,
  type CreativeLayerConnection,
  type CreativeLayerPreparation,
  type CreativeLayerResult,
} from '../generation';
import {
  prepareCreativeWorldInput,
  type CreativeWorldInput,
  type CreativeWorldInputOptions,
  type CreativeWorldInputPreparation,
} from './generation-context';
import type { CreativeWorkspace } from './model';
import {
  readCreativeWorldResultManifest,
  worldGenerationEvidence,
  matchWorldSavedTarget,
  type CreativeWorldExecutionRecord,
  type CreativeWorldIdentity,
  type CreativeWorldRecordStorage,
  type CreativeWorldResultManifest,
} from './generation-record';
import { compareCreativeWorldUsage, type CreativeWorldUsageImpact } from './generation-impact';
import { WorldRecordStore } from './generation-record-store';
import { assertWorldGenerationCapacity, checkWorldResultCapacity } from './generation-capacity';

export interface CreativeWorldDispatch {
  readonly input: CreativeWorldInput;
  readonly identity: CreativeWorldIdentity;
  serialize(): string;
  preflight(): Promise<void>;
}
export interface CreativeWorldProvider {
  readonly capability: 'creative-world-v1';
  readonly label: string;
  generate(dispatch: CreativeWorldDispatch, signal: AbortSignal): Promise<unknown>;
}
export interface CreativeWorldGenerationOptions
  extends Omit<CreativeWorldInputOptions, 'mode' | 'itemId' | 'sceneId'> {
  records: CreativeWorldRecordStorage;
  provider?: CreativeWorldProvider;
}
export interface CreativeWorldHistory {
  record: CreativeWorldExecutionRecord;
  confirmed: boolean;
  retained: boolean;
  problem?: string;
  impact?: CreativeWorldUsageImpact;
}
function assertVoid(assertion: () => void) {
  const result: unknown = assertion();
  if (result !== undefined) {
    if (result && typeof (result as PromiseLike<unknown>).then === 'function')
      void Promise.resolve(result).catch(() => {});
    throw Error('Hostの活動・認可検査は同期のvoid assertionにしてください。');
  }
}
const dispatches = new WeakSet<object>();
/** Transport-only internal check: a copied/forged/expired dispatch cannot send World data. */
export function assertCreativeWorldDispatch(dispatch: CreativeWorldDispatch) {
  if (!dispatches.has(dispatch)) throw Error('World実行の固定dispatchがありません。');
  dispatch.serialize();
}
const cancelled = () => Error('生成依頼を中止しました。');
async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void work.catch(() => {});
    throw cancelled();
  }
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(cancelled());
    };
    signal.addEventListener('abort', abort, { once: true });
    work.then(
      (v) => {
        signal.removeEventListener('abort', abort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', abort);
        reject(e);
      },
    );
  });
}
function withinLimit(value: unknown) {
  const json = canonicalJson(value);
  if (new TextEncoder().encode(json).length > 12 * 1024 * 1024)
    throw Error('World入力全体は12MiBまでです。');
  return json;
}

interface PreparationFacts {
  record(): CreativeWorldExecutionRecord;
  state(): { dirty: boolean; error?: string };
  mutate(mutate: (record: CreativeWorldExecutionRecord) => void): void;
  persist(): Promise<void>;
  applied(event: HostProposalApplied<DesignContent>): void;
}
/** Consuming Host connection. Its storage is observations, never native/World configuration. */
export class CreativeWorldGenerationConnection {
  readonly capability = 'creative-world-v1' as const;
  private readonly records: WorldRecordStore;
  private readonly listeners = new Set<() => void>();
  private revision = 0;
  private readonly watched = new Map<string, () => void>();
  private readonly preparations = new WeakMap<object, CreativeWorldGenerationPreparation>();
  private readonly preparing = new WeakMap<object, Promise<CreativeWorldGenerationPreparation>>();
  private readonly applies = new Map<string, HostProposalApplied<DesignContent>>();
  private readonly saves = new Map<
    string,
    {
      editor: ArtifactEditor<DesignContent>;
      event: HostSavedEvent;
      content: DesignContent;
      hash: string;
    }
  >();
  private observing?: Promise<void>;
  private observationError = '';
  private disposed = false;
  constructor(
    readonly workspace: CreativeWorkspace,
    readonly options: CreativeWorldGenerationOptions,
  ) {
    if (
      (options?.provider &&
        (options.provider.capability !== 'creative-world-v1' ||
          typeof options.provider.generate !== 'function' ||
          typeof options.provider.label !== 'string' ||
          !options.provider.label.trim())) ||
      !['assertActive', 'maySendEditorRequest', 'maySendReference'].every(
        (key) => typeof options?.[key as keyof CreativeWorldGenerationOptions] === 'function',
      ) ||
      !options?.records ||
      typeof options.records.list !== 'function' ||
      typeof options.records.write !== 'function'
    )
      throw Error('World対応Host・認可・実行記録の接続が必要です。');
    const assertActive = options.assertActive;
    options = Object.freeze({
      ...options,
      assertActive: () => assertVoid(assertActive),
      records: Object.freeze({
        list: options.records.list.bind(options.records),
        write: options.records.write.bind(options.records),
      }),
      ...(options.provider
        ? {
            provider: Object.freeze({
              capability: options.provider.capability,
              label: options.provider.label,
              generate: options.provider.generate.bind(options.provider),
            }),
          }
        : {}),
    });
    this.options = options;
    if (
      !workspace.mapping.world ||
      !options.records ||
      typeof options.records.list !== 'function' ||
      typeof options.records.write !== 'function' ||
      !['assertActive', 'maySendEditorRequest', 'maySendReference'].every(
        (key) => typeof options[key as keyof CreativeWorldGenerationOptions] === 'function',
      ) ||
      (options.provider &&
        (options.provider.capability !== 'creative-world-v1' ||
          typeof options.provider.generate !== 'function' ||
          !options.provider.label))
    )
      throw Error('World対応Host・認可・実行記録の接続が必要です。');
    this.records = new WorldRecordStore(
      workspace.mapping.world.namespace,
      options.records,
      (id, write) => {
        options.assertActive();
        if (
          this.disposed ||
          workspace.mapping.world?.namespace !== this.records.namespace ||
          !workspace.canReadWorld(id) ||
          (write && !workspace.canPrepareWorldInput)
        )
          throw Error('実行記録の現在権限・作品が変わりました。');
      },
      this.changed,
    );
  }
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  readonly getSnapshot = () => this.revision;
  readonly changed = () => {
    this.revision++;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* Observation cannot change native state. */
      }
    }
  };
  get pending() {
    return this.records.pending || this.applies.size > 0 || this.saves.size > 0 || !!this.observing;
  }
  get label() {
    return this.options.provider?.label ?? '外部ファイル';
  }
  /** Record metadata contains no cached v1 input. Preparations separately authorize every input read. */
  assertReadable(record: CreativeWorldExecutionRecord) {
    this.options.assertActive();
    if (
      this.disposed ||
      this.workspace.mapping.world?.namespace !== record.namespace ||
      ![
        record.scope.artifactId,
        ...record.context.references.map((r) => r.reference.artifactId),
      ].every((id) => this.workspace.canReadWorld(id))
    )
      throw Error('制作前提・結果の閲覧権限が失効しました。');
  }
  private editor(artifactId: string) {
    const editors = ['character', 'setting'].flatMap((mode) => {
      if (!this.workspace.modeAvailable(mode as 'character' | 'setting')) return [];
      const editor = this.workspace
        .project(mode as 'character' | 'setting')
        .designs.get(artifactId);
      return editor ? [editor] : [];
    });
    if (editors.length !== 1) throw Error('設定画の実行対象が欠落・曖昧です。');
    return editors[0];
  }
  private watch(editor: ArtifactEditor<DesignContent>) {
    if (this.watched.has(editor.id)) return;
    this.watched.set(
      editor.id,
      editor.onSaved((event) => {
        if (!event.committed || !event.versionId) return; // A persisted draft is never an old version's usage.
        const saved = editor.readSaved(event.versionId);
        this.saves.set(editor.id + ':' + event.versionId, {
          editor,
          event: clone(event),
          content: saved.content,
          hash: saved.contentHash!,
        });
        this.changed();
        void this.flush().catch(() => {});
      }),
    );
  }
  private record(operationId: string) {
    const record = this.records.get(operationId);
    this.assertReadable(record);
    return record;
  }
  private recordState(operationId: string) {
    return this.records.state(operationId);
  }
  private mutate(operationId: string, mutate: (record: CreativeWorldExecutionRecord) => void) {
    this.records.update(operationId, mutate);
  }
  private persist(operationId: string) {
    return this.records.flush(operationId);
  }
  private applied(operationId: string, event: HostProposalApplied<DesignContent>) {
    this.applies.set(operationId, clone(event));
    this.changed();
  }
  async prepare(
    native: CreativeLayerPreparation,
    activity: { sceneId?: string; assertActive?(): void } = {},
  ) {
    const pending = this.preparing.get(native);
    if (pending) {
      const result = await pending;
      if (result.view.record.scope.sceneId !== activity.sceneId)
        throw Error('依頼は別のSceneへ付け替えられません。');
      if (activity.assertActive) assertVoid(activity.assertActive);
      return result;
    }
    const work = this.prepareInput(native, {
      sceneId: activity.sceneId,
      assertActive: activity.assertActive,
    });
    this.preparing.set(native, work);
    try {
      return await work;
    } finally {
      if (this.preparing.get(native) === work) this.preparing.delete(native);
    }
  }
  private async prepareInput(
    native: CreativeLayerPreparation,
    activity: { sceneId?: string; assertActive?(): void },
  ) {
    declareCreativeWorldRequest(native);
    const previous = this.preparations.get(native);
    if (previous) {
      if (previous.view.record.scope.sceneId !== activity.sceneId)
        throw Error('依頼は別のSceneへ付け替えられません。');
      await this.records.flush(previous.operationId);
      native.assertCurrent();
      return previous;
    }
    const request = readPreparedCreativeLayerInput(native).request;
    const modes = (['character', 'setting'] as const).filter(
      (mode) =>
        this.workspace.modeAvailable(mode) &&
        this.workspace.project(mode).source.id === request.source.artifactId,
    );
    if (modes.length !== 1) throw Error('生成元の作品・domainが一致しません。');
    const input = await prepareCreativeWorldInput(this.workspace, native, {
      ...this.options,
      mode: modes[0],
      itemId: request.source.itemId,
      sceneId: activity.sceneId,
      assertActive: () => {
        this.options.assertActive();
        if (activity.assertActive) assertVoid(activity.assertActive);
        if (this.disposed) throw cancelled();
      },
    });
    const snapshot = input.snapshot,
      editor = this.editor(request.currentReference.artifactId);
    this.watch(editor);
    await this.records.load(editor.id);
    input.assertCurrent();
    const record: CreativeWorldExecutionRecord = {
      schemaVersion: 1,
      operationId: newId('creative-world-operation'),
      revision: 1,
      namespace: snapshot.context.namespace,
      requestId: request.id,
      scope: {
        ...clone(snapshot.context.scope),
        artifactId: editor.id,
        frameId: request.frameId,
        address: clone(request.target.address),
      },
      context: {
        fingerprint: snapshot.context.fingerprint,
        payloadHash: input.payloadHash,
        adoptions: clone(snapshot.context.adoptions),
        references: snapshot.context.references.map(({ contextId, reference, projectionHash }) => ({
          contextId,
          reference: clone(reference),
          projectionHash,
        })),
      },
      state: 'prepared',
      usages: [],
    };
    this.records.create(record);
    const preparation = new CreativeWorldGenerationPreparation(
      this,
      native,
      input,
      snapshot,
      record.operationId,
      editor,
      {
        record: () => this.record(record.operationId),
        state: () => this.recordState(record.operationId),
        mutate: (mutate) => this.mutate(record.operationId, mutate),
        persist: () => this.persist(record.operationId),
        applied: (event) => this.applied(record.operationId, event),
      },
      activity.assertActive,
    );
    this.preparations.set(native, preparation);
    // Record before dispatch/export. Failure leaves a retryable object, not an untracked send.
    await this.records.flush(record.operationId);
    input.assertCurrent();
    return preparation;
  }
  async history(artifactId: string): Promise<CreativeWorldHistory[]> {
    const editor = this.editor(artifactId);
    this.watch(editor);
    const records = await this.records.load(artifactId);
    const artifact = await this.workspace.io.artifacts.get(artifactId);
    const views: CreativeWorldHistory[] = [];
    for (const record of records) {
      this.assertReadable(record);
      let problem: string | undefined;
      try {
        for (const usage of record.usages) {
          const version =
            artifact?.id === artifactId &&
            artifact.kind === 'design' &&
            artifact.versions.find((v) => v.versionId === usage.versionId);
          if (
            !version ||
            !isDesignWithPaths(version.content) ||
            version.contentHash !== usage.contentHash ||
            (await contentHash(version.content)) !== usage.contentHash ||
            (await matchWorldSavedTarget(record, version.content))?.targetHash !== usage.targetHash
          )
            throw Error('利用した保存版・対象・hashが欠落/不一致です。');
          this.assertReadable(record);
        }
      } catch (error) {
        problem = error instanceof Error ? error.message : String(error);
      }
      this.assertReadable(record);
      let impact: CreativeWorldUsageImpact | undefined;
      if (record.usages.length) {
        try {
          const references: CreativeWorldExecutionRecord['context']['references'] = [];
          for (const adopted of record.context.adoptions) {
            // Local comparison is a read, not permission to send these samples.
            for (const view of await this.workspace.readWorld(
              adopted.id,
              'generation',
              () => true,
            )) {
              if (!['current', 'stale'].includes(view.state))
                throw Error('現在の採用資料を照合できません。');
              const projection =
                view.reference.role === 'sample'
                  ? { kind: 'svg', value: view.svg!, rasterSources: view.rasterSources ?? [] }
                  : { kind: 'text', value: view.text! };
              references.push({
                contextId: adopted.id,
                reference: view.reference,
                projectionHash: await contentHash(projection),
              });
              this.assertReadable(record);
            }
          }
          impact = compareCreativeWorldUsage(record, references);
        } catch {
          impact = { state: 'unavailable', reasons: ['現在の採用資料・権限を照合してください。'] };
        }
      }
      this.assertReadable(record);
      views.push({
        record,
        ...(impact ? { impact } : {}),
        confirmed: !this.records.state(record.operationId).dirty,
        retained: !problem,
        ...(problem ? { problem } : {}),
      });
    }
    return views;
  }
  async flush(operationId?: string): Promise<void> {
    const previous = this.observing ?? Promise.resolve();
    const current = previous.catch(() => {}).then(() => this.observe(operationId));
    this.observing = current;
    try {
      await current;
    } finally {
      if (this.observing === current) this.observing = undefined;
      this.changed();
    }
  }
  private async observe(operationId?: string) {
    try {
      for (const [id, event] of [...this.applies].filter(
        ([id]) => !operationId || operationId === id,
      )) {
        const record = this.record(id);
        const expectedKey = creativeDesignAddressKey(record.scope.address);
        if (
          event.artifactId !== record.scope.artifactId ||
          event.proposalId !== record.proposalId ||
          !event.changedElementIds?.includes(expectedKey)
        )
          throw Error('実適用の対象・変更IDが依頼と一致しません。');
        const evidence = await worldGenerationEvidence(
          event.content,
          record.scope.address,
          record.scope.frameId,
        );
        if (evidence.srcHash !== record.result?.srcHash)
          throw Error('依頼の結果と実適用の画像hashが一致しません。');
        this.assertReadable(record);
        this.mutate(id, (next) => {
          next.applied = {
            transactionId: event.transactionId,
            beforeRevision: event.beforeRevision,
            revision: event.revision,
            ...evidence,
          };
          next.state = 'applied';
        });
        this.applies.delete(id);
      }
      for (const [key, captured] of [...this.saves]) {
        if (operationId && this.record(operationId).scope.artifactId !== captured.editor.id)
          continue;
        await this.records.load(captured.editor.id);
        const artifact = await this.workspace.io.artifacts.get(captured.editor.id);
        const version =
          artifact?.id === captured.editor.id &&
          artifact.kind === 'design' &&
          artifact.versions.find((v) => v.versionId === captured.event.versionId);
        if (
          !version ||
          !isDesignWithPaths(version.content) ||
          version.contentHash !== captured.hash ||
          (await contentHash(captured.content)) !== captured.hash ||
          (await contentHash(version.content)) !== captured.hash
        )
          throw Error('実際に保存されたnative版・hashを照合できません。');
        for (const record of this.records.forArtifact(captured.editor.id)) {
          if (operationId && record.operationId !== operationId) continue;
          this.assertReadable(record);
          if (
            !record.applied ||
            record.usages.some((u) => u.versionId === captured.event.versionId)
          )
            continue;
          let witness =
            captured.event.proposalTransactions?.includes(record.applied.transactionId) ?? false;
          if (!witness) {
            const base = record.usages.find((u) => u.versionId === captured.event.baseVersionId);
            const baseVersion =
              base && artifact!.versions.find((v) => v.versionId === base.versionId);
            witness =
              !!base &&
              !!baseVersion &&
              isDesignWithPaths(baseVersion.content) &&
              base.contentHash === baseVersion.contentHash &&
              (await contentHash(baseVersion.content)) === base.contentHash &&
              (await matchWorldSavedTarget(record, baseVersion.content))?.targetHash ===
                base.targetHash;
          }
          if (!witness) continue; // Never infer a lost apply association from equal pixels.
          let match;
          try {
            match = await matchWorldSavedTarget(record, captured.content);
          } catch {
            continue;
          }
          this.assertReadable(record);
          if (match)
            this.mutate(record.operationId, (next) => {
              next.usages.push({
                artifactId: captured.editor.id,
                versionId: captured.event.versionId!,
                contentHash: captured.hash,
                ...match,
              });
            });
        }
        if (!operationId) this.saves.delete(key);
      }
      await this.records.flush(operationId);
      this.observationError = '';
    } catch (error) {
      this.observationError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.changed();
    }
  }
  async assertSettled() {
    await this.flush();
    if (this.pending) throw Error('利用記録が未保存です。再試行してから移動してください。');
  }
  dispose() {
    this.disposed = true;
    for (const off of this.watched.values()) off();
    this.watched.clear();
    this.changed();
  }
  get problem() {
    return this.observationError;
  }
}

export class CreativeWorldGenerationPreparation {
  readonly identity: CreativeWorldIdentity;
  private previewing = false;
  private applying = false;
  private sending = false;
  private inactive = false;
  private hidden = false;
  private busy = false;
  private proposal?: HostPendingProposal<DesignContent>;
  private accepted?: HostProposalResult;
  private assertCapacity?: (current: Artifact<DesignContent>) => void;
  constructor(
    readonly connection: CreativeWorldGenerationConnection,
    private readonly native: CreativeLayerPreparation,
    private readonly prepared: CreativeWorldInputPreparation,
    private readonly input: CreativeWorldInput,
    readonly operationId: string,
    private readonly editor: ArtifactEditor<DesignContent>,
    private readonly facts: PreparationFacts,
    private readonly activity?: () => void,
  ) {
    this.identity = Object.freeze({
      schemaVersion: 1,
      operationId,
      requestId: input.editorRequest.id,
      payloadHash: prepared.payloadHash,
      fingerprint: input.context.fingerprint,
    });
    bindCreativeWorldReview(
      native,
      {
        assertCurrent: () => {
          this.current();
          if (!this.previewing && !this.applying)
            throw Error('World対応Hostのpreview/accept入口を使ってください。');
        },
        beforeApply: () => {
          this.current();
          if (!this.applying)
            throw Error('World生成はpreflightと実行記録を経た正式なacceptが必要です。');
          if (!this.assertCapacity) throw Error('生成結果の保存容量を再確認してください。');
          this.assertCapacity(this.editor.artifact);
        },
        onApplied: (event) => {
          this.applying = false;
          facts.applied(event);
        },
      },
      () => this.current(),
    );
  }
  private current(signal?: AbortSignal) {
    if (this.inactive || signal?.aborted) throw cancelled();
    this.activity?.();
    this.prepared.assertCurrent();
  }
  private async preflight(signal?: AbortSignal) {
    this.current(signal);
    try {
      await this.prepared.preflight();
      this.current(signal);
    } catch (error) {
      this.hidden = true;
      throw error;
    }
  }
  private async estimateCapacity(signal?: AbortSignal) {
    this.current(signal);
    const { request, ancestorBytes } = readPreparedCreativeLayerInput(this.native);
    const artifact = this.editor.artifact;
    await assertWorldGenerationCapacity(
      artifact,
      this.editor.content,
      request.target.pixelWidth,
      request.target.pixelHeight,
      ancestorBytes,
    );
    this.current(signal);
    if (canonicalJson(this.editor.artifact) !== canonicalJson(artifact))
      throw Error('容量見積り中に保存版が変わりました。もう一度依頼してください。');
  }
  private async resultCapacity(signal?: AbortSignal) {
    this.current(signal);
    if (!this.proposal) throw Error('容量確認する生成結果がありません。');
    this.assertCapacity = undefined;
    const assertion = await checkWorldResultCapacity(
      this.editor.artifact,
      this.proposal.preview.content,
    );
    this.current(signal);
    assertion(this.editor.artifact);
    this.assertCapacity = assertion;
  }
  get view() {
    const record = this.facts.record();
    if (this.hidden) throw Error('資料を再確認できません。制作前提を再準備してください。');
    let stale = false;
    if (!this.accepted) {
      try {
        this.current();
      } catch {
        stale = true;
      }
    }
    // A stale input is still secret. Apply/revision checks cannot replace its live read grant.
    this.prepared.assertReadable();
    return {
      record,
      input: clone(this.input),
      identity: clone(this.identity),
      ...this.facts.state(),
      stale,
      proposalId: this.proposal?.id,
      applied: !!this.accepted,
    };
  }
  async retryRecord() {
    await this.connection.flush(this.operationId);
    await this.facts.persist();
  }
  private async action<T>(work: () => Promise<T>): Promise<T> {
    if (this.busy) throw Error('World処理の完了を待ってください。');
    this.busy = true;
    try {
      return await work();
    } finally {
      this.busy = false;
      this.connection.changed();
    }
  }
  async export(signal = new AbortController().signal) {
    return this.action(async () => {
      await this.preflight(signal);
      await this.facts.persist();
      await this.preflight(signal);
      await this.estimateCapacity(signal);
      return {
        identity: clone(this.identity),
        input: clone(this.input),
        json: withinLimit({ schemaVersion: 1, identity: this.identity, input: this.input }),
      };
    });
  }
  async generate(signal: AbortSignal) {
    return this.action(async () => {
      this.current(signal);
      if (this.accepted) throw Error('既に適用されています。新しい依頼を準備してください。');
      if (this.proposal) {
        await this.facts.persist();
        await this.preflight(signal);
        await this.resultCapacity(signal);
        return this.proposal;
      }
      const provider = this.connection.options.provider;
      if (!provider || provider.capability !== 'creative-world-v1')
        throw Error('World対応providerが未接続です。');
      await this.facts.persist();
      await this.preflight(signal);
      await this.estimateCapacity(signal);
      this.sending = true;
      const current = () => {
        this.current(signal);
        if (!this.sending) throw Error('World dispatchは失効しています。');
      };
      const dispatch: CreativeWorldDispatch = {
        get input() {
          current();
          return clone(thisInput);
        },
        get identity() {
          current();
          return clone(identity);
        },
        serialize: () => {
          current();
          return this.prepared.serialize();
        },
        preflight: async () => {
          current();
          await this.preflight(signal);
          await this.estimateCapacity(signal);
          current();
        },
      };
      const thisInput = this.input,
        identity = this.identity;
      dispatches.add(dispatch);
      Object.freeze(dispatch);
      let result: unknown;
      try {
        result = await abortable(
          Promise.resolve().then(() => {
            current();
            return provider.generate(dispatch, signal);
          }),
          signal,
        );
      } catch (error) {
        if (signal.aborted) {
          this.inactive = true;
          this.facts.mutate((r) => {
            r.state = 'cancelled';
          });
          void this.facts.persist().catch(() => {});
        }
        throw error;
      } finally {
        this.sending = false;
      }
      return this.preview(result, signal);
    });
  }
  private async preview(raw: unknown, signal: AbortSignal) {
    const result = clone(raw) as CreativeLayerResult;
    const srcHash = await contentHash(result?.src);
    await this.preflight(signal);
    this.previewing = true;
    try {
      this.proposal = this.native.preview(result);
    } finally {
      this.previewing = false;
    }
    this.facts.mutate((r) => {
      r.state = 'preview';
      r.proposalId = this.proposal!.id;
      r.result = { srcHash, source: result.source, license: result.license };
    });
    this.current(signal);
    await this.facts.persist();
    this.current(signal);
    await this.resultCapacity(signal);
    return this.proposal;
  }
  async importPng(src: string, rawManifest: unknown, signal = new AbortController().signal) {
    return this.action(async () => {
      this.current(signal);
      if (this.accepted || this.proposal)
        throw Error('結果は既に固定されています。再試行または再準備してください。');
      const manifest = readCreativeWorldResultManifest(rawManifest);
      if (
        canonicalJson(manifest.identity) !== canonicalJson(this.identity) ||
        (await contentHash(src)) !== manifest.srcHash
      )
        throw Error('外部PNGと依頼・採用前提・hashが一致しません。');
      this.current(signal);
      return this.preview(
        {
          requestId: manifest.identity.requestId,
          src,
          source: manifest.source,
          license: manifest.license,
          ...(manifest.name ? { name: manifest.name } : {}),
        },
        signal,
      );
    });
  }
  async accept(signal = new AbortController().signal) {
    return this.action(async () => {
      if (this.accepted) {
        await this.retryRecord();
        return clone(this.accepted);
      }
      this.current(signal);
      if (!this.proposal) throw Error('採用するWorld結果がありません。');
      await this.preflight(signal);
      await this.resultCapacity(signal);
      this.facts.mutate((r) => {
        r.state = 'applying';
      });
      await this.facts.persist();
      await this.preflight(signal);
      this.applying = true;
      try {
        this.accepted = this.editor.acceptProposal(this.proposal.id);
      } finally {
        this.applying = false;
      }
      // A recording failure cannot cause a second native apply on retry.
      await this.retryRecord();
      return clone(this.accepted);
    });
  }
  async reject() {
    return this.action(async () => {
      if (this.accepted) throw Error('適用済みの結果はnative Undoで戻してください。');
      if (this.proposal && this.editor.proposals.some((p) => p.id === this.proposal!.id))
        this.editor.rejectProposal(this.proposal.id);
      this.inactive = true;
      this.facts.mutate((r) => {
        r.state = 'rejected';
      });
      await this.facts.persist();
    });
  }
  cancel() {
    if (this.inactive) return;
    this.inactive = true;
    if (!this.accepted) {
      if (this.proposal && this.editor.proposals.some((p) => p.id === this.proposal!.id))
        this.editor.withdrawProposal(this.proposal.id);
      this.facts.mutate((r) => {
        r.state = 'cancelled';
      });
      void this.facts.persist().catch(() => {});
    }
    this.connection.changed();
  }
  async save() {
    const record = this.facts.record();
    const project = this.connection.workspace.project(record.scope.mode);
    let nativeError: unknown;
    try {
      await project.save({ reuseSavedVersions: true });
    } catch (error) {
      nativeError = error;
    }
    await this.connection.flush();
    if (nativeError) throw nativeError;
  }
}

export function createCreativeWorldGenerationConnection(
  workspace: CreativeWorkspace,
  options: CreativeWorldGenerationOptions,
): CreativeLayerConnection {
  return { context: 'world', world: new CreativeWorldGenerationConnection(workspace, options) };
}
/** Explicit file result correspondence, with no image bytes in the manifest. */
export async function createCreativeWorldResultManifest(
  identity: CreativeWorldIdentity,
  result: CreativeLayerResult,
): Promise<CreativeWorldResultManifest> {
  if (result.requestId !== identity.requestId) throw Error('結果のrequest IDが一致しません。');
  return readCreativeWorldResultManifest({
    identity,
    srcHash: await contentHash(result.src),
    source: result.source,
    license: result.license,
    ...(result.name ? { name: result.name } : {}),
  });
}
