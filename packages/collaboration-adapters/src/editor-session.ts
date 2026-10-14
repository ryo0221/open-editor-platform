import { deepFreeze, isDeepFrozen } from '@editor-platform/artifact-core';
import {
  CollaborationClient,
  conditions,
  canonical,
  copy,
  fail,
  operation,
  uid,
  type Action,
  type ConfirmedVersion,
  type DomainCodec,
  type Operation,
  type Preview,
  type Proposal,
  type ProposalState,
  type Receipt,
  type SyncAdapter,
  type Anchor,
  type Presence,
  type Accepted,
  type Snapshot,
} from '@editor-platform/collaboration-core';
import type { EditorCommand } from '@editor-platform/editor-core';
import { prepareEditorProjection, type EditorChange } from './editor-transactions';
import { EditorTextEngine } from './editor-text';
import { threadsToAnnotations } from './editor-annotations';
import { editorAnchor } from './editor-annotations';
import type { Selection } from '@editor-platform/editor-core';
import { encodeEditorOperation, type AssetEditorCodec, type EditorAsset } from './editor-assets';

/** Host services operate on the authenticated session; no Room or organization model. */
export interface EditorHostAdapter<T> extends SyncAdapter<T> {
  undo(id: string, redo?: boolean): Promise<Receipt>;
  versions(): Promise<ConfirmedVersion<T>[]>;
  save(reason: string): Promise<ConfirmedVersion<T>>;
  restore(versionId: string, expectedRevision: number): Promise<Receipt>;
  registerProposal(value: Proposal): Promise<ProposalState>;
  previewProposal(id: string): Promise<Preview<T>>;
  applyProposal(id: string, token: string): Promise<Receipt>;
  cancelProposal(id: string, reject?: boolean): Promise<ProposalState>;
  registerAsset?(reference: EditorAsset, data: string): Promise<void>;
}
interface Intent<T> {
  op: Operation;
  sent: boolean;
  content: T;
}
interface HistoryIntent {
  direction: 'undo' | 'redo';
  targetId?: string;
  /** Undo position at Redo request time; later edits must remain after it. */
  undoAnchor?: string | null;
}
export class SharedEditorSession<T> {
  readonly client: CollaborationClient<T>;
  private queue: Intent<T>[] = [];
  private running?: Promise<void>;
  private syncing?: Promise<void>;
  private historyTail: Promise<void> = Promise.resolve();
  private closed = false;
  private recoveryInputs: unknown[] = [];
  private recoveryCounter = 0;
  private historyRequests: HistoryIntent[] = [];
  private resumedHistory: HistoryIntent[] = [];
  private undoIds: string[] = [];
  private redoIds: string[] = [];
  private ownRevisions = new Set<number>();
  private textEngines = new Map<string, EditorTextEngine<T>>();
  private projection?: { basis: Snapshot<T>; states: unknown[]; content: T };
  private textTimer?: ReturnType<typeof setTimeout>;
  private uploadedAssets = new Set<string>();
  private retryProposals = new Map<string, string>();
  readonly rejected: { operation: Operation; content: T; receipt: Receipt }[] = [];
  savedVersions: ConfirmedVersion<T>[] = [];
  lastReceipt?: Receipt;
  error = '';
  presences: Presence[] = [];
  private presenceAnchor?: Anchor;
  onChange = () => {};
  constructor(
    readonly codec: DomainCodec<T>,
    readonly adapter: EditorHostAdapter<T>,
  ) {
    this.client = new CollaborationClient(codec, adapter, { immutableContent: true });
    this.client.onChange = () => {
      if (!this.closed) this.onChange();
    };
    this.client.onEvent = (event) => this.textEngines.forEach((engine) => engine.receive(event));
    this.client.onReset = (snapshot) =>
      this.textEngines.forEach((engine) => engine.reset(snapshot));
  }
  /** Caller-owned copy for external mutation/export. */
  get content() {
    return copy(this.viewContent);
  }
  /** Immutable rendering projection, reused until confirmed/pending text changes. */
  get viewContent(): T {
    const engines = [...this.textEngines.values()];
    const states = engines.flatMap((engine) => [engine.state.doc, engine.pending]);
    const cached = this.projection;
    if (
      cached?.basis === this.client.optimistic &&
      states.length === cached.states.length &&
      states.every((state, i) => state === cached.states[i])
    )
      return cached.content;
    let content = this.client.optimistic.content;
    if (engines.some((engine) => engine.pending)) {
      // Document projection creates a new block list/root without writing its
      // basis. Preserve owned immutable page/reuse metadata through ordinary
      // typing; canvas text projections still require their mutable private copy.
      if (this.codec.domain !== 'document') content = copy(content);
      for (const engine of engines) content = engine.project(content);
    }
    this.projection = { basis: this.client.optimistic, states, content: deepFreeze(content) };
    return this.projection.content;
  }
  get confirmed() {
    return this.client.confirmed;
  }
  get annotations() {
    if (!this.client.optimistic.threads.length) return [];
    return threadsToAnnotations(
      this.confirmed.artifactId,
      this.viewContent,
      this.client.optimistic.threads,
      (anchor) => {
        if (anchor.orphan) return anchor;
        if (anchor.type === 'text')
          return this.text('text').localAnchor(
            anchor,
            this.client.optimistic.engineVersion - this.confirmed.engineVersion,
          );
        if (anchor.type === 'canvas-text')
          return this.text(anchor.elementId).localAnchor(
            anchor,
            (this.client.optimistic.textVersions?.[anchor.elementId] ?? 0) -
              (this.confirmed.textVersions?.[anchor.elementId] ?? 0),
          );
        return anchor;
      },
    );
  }
  get pendingCount() {
    return this.pendingEditCount + this.historyRequests.length + this.resumedHistory.length;
  }
  private get pendingEditCount() {
    return this.queue.length + [...this.textEngines.values()].filter((e) => e.unsubmitted).length;
  }
  get canUndo() {
    return !this.pendingCount && this.undoIds.length > 0;
  }
  get canRedo() {
    return !this.pendingCount && this.redoIds.length > 0;
  }
  get readOnly() {
    const p = this.client.permissions;
    return this.closed || !p?.writable || (p.expiresAt !== undefined && p.expiresAt <= Date.now());
  }
  get status() {
    if (this.client.status !== 'online')
      return `${this.client.status} · ${this.pendingCount} pending`;
    if (this.rejected.length) return `Rejected · ${this.rejected.length} retained edit(s)`;
    if (this.readOnly) return 'Read only';
    if (this.pendingCount) return `${this.pendingCount} pending`;
    return `Shared · confirmed r${this.confirmed.revision}`;
  }
  private assertActive() {
    if (this.closed)
      fail('resync-required', 'Session is closed; resume its checkpoint in a new session');
  }
  async open() {
    this.assertActive();
    await this.client.open();
    if (this.closed) return;
    if (this.codec.domain === 'document') this.text('text');
    this.savedVersions = await this.adapter.versions();
    if (this.closed) return;
    const history = this.resumedHistory.splice(0);
    await Promise.all(history.map((intent) => this.queueHistory(intent)));
    this.onChange();
  }
  execute(command: EditorCommand<T>) {
    const operation = this.applyCommand(command);
    return operation && copy(operation);
  }
  /** Native view for rendering; avoids copying a large operation that UI callers discard. */
  executeView(command: EditorCommand<T>): T {
    this.applyCommand(command);
    return this.viewContent;
  }
  private applyCommand(command: EditorCommand<T>) {
    this.assertActive();
    if (this.readOnly) fail('unauthorized', 'Shared session is read only or expired');
    const prepared = prepareEditorProjection(
      this.codec,
      { ...this.client.optimistic, content: this.viewContent },
      this.adapter.identity,
      command,
    );
    if (!prepared) return;
    this.client.enqueuePrepared(prepared);
    this.queue.push({ op: prepared.operation, sent: false, content: this.viewContent });
    this.error = '';
    this.onChange();
    void this.flush();
    return prepared.operation;
  }
  text(target: string) {
    let engine = this.textEngines.get(target);
    if (!engine) {
      engine = new EditorTextEngine(this, target);
      this.textEngines.set(target, engine);
    }
    return engine;
  }
  pendingTextInsertion(target: string) {
    return this.queue.find(({ op }) =>
      op.actions.some((action) =>
        (action.payload.changes as EditorChange[] | undefined)?.some(
          (change) =>
            change.kind === 'insert' &&
            (change.id === target ||
              (change.collection === 'pages' &&
                (change.value.objects as { id: string }[]).some((item) => item.id === target))),
        ),
      ),
    )?.op.operationId;
  }
  confirmsIntent(id: string, event: Accepted<T>) {
    return (
      event.operation.operationId === id ||
      (event.operation.proposalId !== undefined &&
        this.retryProposals.get(event.operation.proposalId) === id)
    );
  }
  select(selection: Selection) {
    const address = selection.addresses[0];
    try {
      this.presenceAnchor = address
        ? editorAnchor(this.codec.domain, this.viewContent, address)
        : undefined;
    } catch {
      this.presenceAnchor = undefined;
    }
  }
  textSelection(target: string, from: number, to: number) {
    this.presenceAnchor =
      this.codec.domain === 'document'
        ? { type: 'text', from, to }
        : { type: 'canvas-text', elementId: target, from, to };
  }
  mapTextSelection(target: string, from: number, to: number) {
    if (
      (this.presenceAnchor?.type === 'text' && target === 'text') ||
      (this.presenceAnchor?.type === 'canvas-text' && this.presenceAnchor.elementId === target)
    )
      this.textSelection(target, from, to);
  }
  scheduleText() {
    if (this.closed) return;
    if (this.textTimer) return;
    this.textTimer = setTimeout(() => {
      this.textTimer = undefined;
      void this.flush();
    }, 30);
  }
  private prepareText() {
    for (const engine of this.textEngines.values()) {
      try {
        const prepared = engine.prepare();
        if (prepared) {
          const op = encodeEditorOperation(this.codec, prepared);
          this.client.enqueue(op);
          this.queue.push({ op, sent: false, content: this.viewContent });
        }
      } catch (e) {
        this.error = String(e);
      }
    }
  }
  actions(actions: Action[]) {
    this.assertActive();
    if (this.readOnly) fail('unauthorized', 'Shared session is read only or expired');
    const op = operation(this.codec, this.client.optimistic, this.adapter.identity, actions);
    this.enqueue(op);
    return op;
  }
  enqueue(op: Operation) {
    this.assertActive();
    op = encodeEditorOperation(this.codec, op);
    this.client.enqueue(op);
    this.queue.push({ op: copy(op), sent: false, content: this.viewContent });
    this.error = '';
    this.onChange();
    void this.flush();
  }
  /** Only unsent intentions may follow accepted local predecessors. Sent bytes never change. */
  private followLocalPredecessors(intent: Intent<T>) {
    if (intent.sent) return;
    const current = conditions(
      this.codec,
      this.confirmed,
      intent.op.conditions.map((c) => c.key),
    );
    const next = intent.op.conditions.map((expected, i) => {
      const now = current[i];
      return now.stamp !== expected.stamp &&
        now.fingerprint === expected.fingerprint &&
        this.ownRevisions.has(now.stamp)
        ? now
        : expected;
    });
    if (
      intent.op.baseRevision === this.confirmed.revision &&
      next.every((condition, i) => condition === intent.op.conditions[i])
    )
      return;
    // Queue entries can share a frozen prepared operation. Rebase by replacement;
    // callers' copies and any earlier sent/retained envelope keep their bytes.
    intent.op = deepFreeze({
      ...intent.op,
      conditions: next,
      baseRevision: this.confirmed.revision,
    });
    const index = this.client.pending.findIndex((p) => p.operationId === intent.op.operationId);
    if (index >= 0) this.client.pending[index] = intent.op;
  }
  flush(): Promise<void> {
    if (this.running) return this.running;
    if (this.closed) return Promise.resolve();
    this.prepareText();
    this.running = this.drain().finally(() => {
      this.running = undefined;
      if (!this.closed) this.onChange();
    });
    return this.running;
  }
  private async drain() {
    while (!this.closed && this.queue.length) {
      const intent = this.queue[0];
      try {
        await this.sync();
        if (this.closed) return;
        if (!this.queue.includes(intent)) continue;
        const prior = this.client.receipts.get(intent.op.operationId);
        const assets = (this.codec as AssetEditorCodec<T>).assets;
        for (const ref of assets?.references(intent.op.actions) ?? []) {
          if (this.uploadedAssets.has(ref.id)) continue;
          if (!this.adapter.registerAsset)
            fail('asset-unavailable', 'Host asset registration is unavailable; input retained');
          await this.adapter.registerAsset(ref, assets.resolve(ref));
          if (this.closed) return;
          this.uploadedAssets.add(ref.id);
        }
        if (!this.queue.includes(intent)) continue;
        this.followLocalPredecessors(intent);
        intent.sent = true;
        const receipt = prior ?? (await this.client.submit(intent.op));
        if (this.closed) return;
        this.lastReceipt = receipt;
        this.queue.shift();
        if (receipt.status === 'accepted') {
          this.ownRevisions.add(receipt.revision);
          this.undoIds.push(receipt.operationId);
          this.redoIds = [];
        } else {
          let retryText = false;
          this.textEngines.forEach((engine) => {
            retryText = engine.rejected(intent.op, receipt.code, receipt.message) || retryText;
          });
          if (!retryText) {
            this.rejected.push({
              operation: copy(intent.op),
              content: copy(intent.content),
              receipt,
            });
            this.error = `${receipt.code}: ${receipt.message}. Input retained in checkpoint.`;
          }
        }
        this.prepareText();
      } catch (error) {
        if (this.closed) return;
        this.error = error instanceof Error ? error.message : String(error);
        this.client.status = 'disconnected';
        break;
      }
      this.onChange();
    }
  }
  sync(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.syncing) return this.syncing;
    this.syncing = this.client
      .sync()
      .then(async () => {
        if (this.closed) return;
        const versions = await this.adapter.versions();
        if (this.closed) return;
        const versionsChanged =
          versions.length !== this.savedVersions.length ||
          versions.some((v, i) => v.version.versionId !== this.savedVersions[i]?.version.versionId);
        if (versionsChanged) this.savedVersions = versions;
        const value = {
          name: this.adapter.identity.actorId,
          color: '#8b5cf6',
          basis: this.confirmed.revision,
          ...(!this.pendingCount &&
          this.presenceAnchor &&
          this.codec.validateAnchor(this.confirmed.content, this.presenceAnchor)
            ? { anchor: this.presenceAnchor }
            : {}),
        };
        const expired =
          this.client.permissions?.expiresAt !== undefined &&
          this.client.permissions.expiresAt <= Date.now();
        const next = (await this.adapter.presence(expired ? null : value)).filter(
          (p) =>
            p.clientId !== this.adapter.identity.clientId && p.basis === this.confirmed.revision,
        );
        if (this.closed) return;
        const signature = (values: Presence[]) =>
          canonical(values.map((p) => ({ clientId: p.clientId, name: p.name, anchor: p.anchor })));
        const changed = signature(next) !== signature(this.presences);
        this.presences = next;
        if (changed) this.textEngines.forEach((e) => e.refreshPresence());
        if (changed || versionsChanged) this.onChange();
      })
      .finally(() => {
        this.syncing = undefined;
      });
    return this.syncing;
  }
  async reconnect() {
    this.assertActive();
    await this.client.open();
    await this.sync();
    await this.flush();
    if (!this.closed && !this.pendingCount && !this.rejected.length) {
      this.error = '';
      this.onChange();
    }
  }
  private async syncReceipt(receipt: Receipt) {
    await this.sync();
    if (this.closed || receipt.status !== 'accepted') return;
    // A background poll may have captured its changes before the write. Joining
    // that poll is not sufficient to complete an acknowledged Host action.
    if (this.confirmed.revision < receipt.revision) await this.sync();
    if (!this.closed && this.confirmed.revision < receipt.revision)
      fail('resync-required', 'Accepted change is still awaiting synchronization');
  }
  history(direction: 'undo' | 'redo') {
    this.assertActive();
    return this.queueHistory({ direction });
  }
  private queueHistory(intent: HistoryIntent) {
    // Resolve each target only after the preceding receipt; retained target IDs
    // make an accepted-but-unacknowledged inverse safe to replay after suspension.
    this.historyRequests.push(intent);
    this.onChange();
    const task = this.historyTail.then(() => this.applyHistory(intent));
    const result = task.finally(() => {
      if (this.closed) return;
      this.historyRequests = this.historyRequests.filter((value) => value !== intent);
      this.onChange();
    });
    // The caller observes this action's failure. The queue is only a completion
    // barrier: a recovered session must not inherit a rejected promise forever.
    this.historyTail = result.catch(() => {});
    return result;
  }
  private async applyHistory(intent: HistoryIntent) {
    if (this.closed) return;
    const { direction } = intent;
    await this.flush();
    if (this.closed) return;
    if (this.pendingEditCount)
      fail('resync-required', 'Wait for pending edits or export a checkpoint');
    const ids = direction === 'undo' ? this.undoIds : this.redoIds,
      id = intent.targetId ?? ids.at(-1);
    if (!id) return;
    intent.targetId = id;
    if (direction === 'redo' && intent.undoAnchor === undefined)
      intent.undoAnchor = this.undoIds.at(-1) ?? null;
    const receipt = await this.adapter.undo(id, direction === 'redo');
    if (this.closed) return;
    this.lastReceipt = receipt;
    if (receipt.status === 'accepted') {
      if (direction === 'undo') {
        const index = this.undoIds.indexOf(id);
        if (index >= 0) {
          const newEdit = index !== this.undoIds.length - 1;
          this.undoIds.splice(index, 1);
          if (!newEdit && !this.redoIds.includes(receipt.operationId))
            this.redoIds.push(receipt.operationId);
        }
      } else {
        const index = this.redoIds.indexOf(id);
        if (index >= 0) this.redoIds.splice(index, 1);
        if (!this.undoIds.includes(receipt.operationId)) {
          const after = intent.undoAnchor ? this.undoIds.indexOf(intent.undoAnchor) + 1 : 0;
          this.undoIds.splice(after, 0, receipt.operationId);
        }
      }
    } else this.error = `${receipt.code}: ${receipt.message}`;
    await this.syncReceipt(receipt);
    if (!this.closed) this.onChange();
  }
  async save(reason: string) {
    this.assertActive();
    await this.historyTail;
    this.assertActive();
    await this.flush();
    this.assertActive();
    if (this.pendingCount || this.rejected.length)
      fail(
        'resync-required',
        'Unconfirmed input remains; export a checkpoint or resolve it before saving',
      );
    const saved = await this.adapter.save(reason);
    if (this.closed) return saved;
    this.savedVersions = await this.adapter.versions();
    if (!this.closed) this.onChange();
    return saved;
  }
  async restore(versionId: string) {
    this.assertActive();
    await this.historyTail;
    this.assertActive();
    if (this.pendingCount) fail('resync-required', 'Confirm pending input before restore');
    const receipt = await this.adapter.restore(versionId, this.confirmed.revision);
    if (this.closed) return;
    this.lastReceipt = receipt;
    if (receipt.status === 'accepted') {
      this.undoIds.push(receipt.operationId);
      this.redoIds = [];
    } else this.error = `${receipt.code}: ${receipt.message}`;
    await this.syncReceipt(receipt);
    if (!this.closed) this.onChange();
  }
  async applyProposal(id: string, token: string) {
    this.assertActive();
    const receipt = await this.adapter.applyProposal(id, token);
    if (this.closed) return receipt;
    this.lastReceipt = receipt;
    if (receipt.status === 'accepted' && !this.undoIds.includes(receipt.operationId)) {
      this.undoIds.push(receipt.operationId);
      this.redoIds = [];
    }
    await this.syncReceipt(receipt);
    if (this.closed) return receipt;
    if (receipt.status === 'rejected') fail(receipt.code, receipt.message, receipt.keys);
    const retried = this.retryProposals.get(id);
    if (retried) {
      const index = this.rejected.findIndex((r) => r.operation.operationId === retried);
      if (index >= 0) this.rejected.splice(index, 1);
      this.error = '';
      this.onChange();
    }
    return receipt;
  }
  async previewRetained(index = 0) {
    this.assertActive();
    const retained = this.rejected[index];
    if (!retained) fail('target-deleted', 'No retained edit');
    const assets = (this.codec as AssetEditorCodec<T>).assets;
    for (const ref of assets?.references(retained.operation.actions) ?? [])
      await this.adapter.registerAsset?.(ref, assets.resolve(ref));
    const op = operation(
      this.codec,
      this.confirmed,
      this.adapter.identity,
      retained.operation.actions,
    );
    const id = uid();
    await this.adapter.registerProposal({
      schema: 1,
      id,
      artifactId: this.confirmed.artifactId,
      sourceActorId: this.adapter.identity.actorId,
      baseRevision: this.confirmed.revision,
      summary: 'Review retained input against current content',
      actions: op.actions,
      reads: op.conditions,
      writes: op.conditions,
      external: [],
    });
    this.retryProposals.set(id, retained.operation.operationId);
    return { id, preview: await this.adapter.previewProposal(id) };
  }
  discardUnsubmitted() {
    this.assertActive();
    for (const intent of this.queue.filter((i) => !i.sent)) {
      this.client.discardUnsubmitted(intent.op.operationId);
      this.textEngines.forEach((e) => e.cancelUnsubmitted(intent.op.operationId));
    }
    this.queue = this.queue.filter((i) => i.sent);
    for (const engine of this.textEngines.values())
      if (engine.unsubmitted) this.discardText(engine);
    this.error = '';
    this.onChange();
  }
  private discardText(engine: EditorTextEngine<T>) {
    try {
      engine.discardPending();
    } catch (error) {
      if ((error as { code?: string }).code !== 'target-deleted') throw error;
      this.textEngines.delete(engine.target);
    }
  }
  discardRetained() {
    this.assertActive();
    if (this.queue.length) fail('resync-required', 'Confirm or cancel queued submissions first');
    this.rejected.splice(0);
    this.textEngines.forEach((e) => this.discardText(e));
    this.error = '';
    this.onChange();
  }
  retryText() {
    this.assertActive();
    if (this.readOnly) fail('unauthorized', 'Write access must be restored before retry');
    this.textEngines.forEach((e) => e.retry());
    for (let i = this.rejected.length - 1; i >= 0; i--)
      if (
        this.rejected[i].operation.actions.every((a) =>
          ['document.steps', 'canvas.text-steps'].includes(a.type),
        )
      )
        this.rejected.splice(i, 1);
    this.error = '';
    this.scheduleText();
    this.onChange();
  }
  /** Changes when recovery data changes; Hosts may skip redundant storage writes.
   * This is local to this session, not an authority revision or persistence receipt.
   */
  get recoveryRevision() {
    const inputs: unknown[] = [
      this.client.confirmed,
      this.client.pending.length,
      ...this.client.pending,
      this.queue.length,
      ...this.queue.flatMap((i) => [i.op, i.sent, i.content, i.op.conditions]),
      this.rejected.length,
      ...this.rejected,
      this.undoIds.length,
      ...this.undoIds,
      this.redoIds.length,
      ...this.redoIds,
      this.ownRevisions.size,
      ...this.ownRevisions,
      this.historyRequests.length,
      ...this.historyRequests.flatMap((i) => [i.direction, i.targetId, i.undoAnchor]),
      this.resumedHistory.length,
      ...this.resumedHistory.flatMap((i) => [i.direction, i.targetId, i.undoAnchor]),
      this.textEngines.size,
      ...[...this.textEngines.values()].flatMap((e) => [e, ...e.recoveryState]),
    ];
    if (
      inputs.length !== this.recoveryInputs.length ||
      inputs.some((v, i) => v !== this.recoveryInputs[i])
    ) {
      this.recoveryInputs = inputs;
      this.recoveryCounter++;
    }
    return this.recoveryCounter;
  }
  private checkpointValue() {
    return {
      schema: 1 as const,
      client: {
        schema: 1,
        identity: this.adapter.identity,
        confirmed: this.client.confirmed,
        pending: this.client.pending,
      } satisfies ReturnType<CollaborationClient<T>['checkpoint']>,
      queue: this.queue,
      rejected: this.rejected,
      undoIds: this.undoIds,
      redoIds: this.redoIds,
      ownRevisions: [...this.ownRevisions],
      text: [...this.textEngines.values()].map((e) => e.checkpoint()),
      history: [...this.resumedHistory, ...this.historyRequests],
    };
  }
  checkpoint() {
    return copy(this.checkpointValue());
  }
  /** Point-in-time immutable checkpoint for asynchronous structured storage.
   * Share only certified frozen native content; copy mutable queues and metadata.
   * checkpoint() remains the caller-owned mutable form.
   */
  captureCheckpoint() {
    const value = this.checkpointValue();
    if (!value.client.confirmed) return deepFreeze(copy(value));
    const content = (data: T) => (isDeepFrozen(data) ? data : deepFreeze(copy(data)));
    const metadata = copy({
      ...value,
      client: {
        ...value.client,
        confirmed: { ...value.client.confirmed, content: undefined },
      },
      queue: value.queue.map((intent) => ({ ...intent, content: undefined })),
      rejected: value.rejected.map((edit) => ({ ...edit, content: undefined })),
    });
    return deepFreeze({
      ...metadata,
      client: {
        ...metadata.client,
        confirmed: {
          ...metadata.client.confirmed,
          content: content(value.client.confirmed.content),
        },
      },
      queue: metadata.queue.map((intent, index) => ({
        ...intent,
        content: content(value.queue[index].content),
      })),
      rejected: metadata.rejected.map((edit, index) => ({
        ...edit,
        content: content(value.rejected[index].content),
      })),
    });
  }
  /** Same portable checkpoint, serialized synchronously without intermediate full copies. */
  serializeCheckpoint() {
    return JSON.stringify(this.checkpointValue());
  }
  resume(
    checkpoint: Omit<ReturnType<SharedEditorSession<T>['checkpoint']>, 'history'> & {
      history?: HistoryIntent[];
    },
  ) {
    this.assertActive();
    if (checkpoint.schema !== 1) fail('schema-mismatch', 'Unknown editor checkpoint');
    const assets = (this.codec as AssetEditorCodec<T>).assets;
    assets?.encode(checkpoint.client.confirmed.content);
    for (const intent of checkpoint.queue) assets?.encode(intent.content);
    this.client.resume(checkpoint.client);
    this.queue = copy(checkpoint.queue);
    this.rejected.splice(0, this.rejected.length, ...copy(checkpoint.rejected));
    this.undoIds = copy(checkpoint.undoIds);
    this.redoIds = copy(checkpoint.redoIds);
    this.ownRevisions = new Set(checkpoint.ownRevisions);
    this.resumedHistory = copy(checkpoint.history ?? []);
    for (const text of checkpoint.text ?? []) {
      const engine = new EditorTextEngine(this, text.target, text);
      this.textEngines.set(text.target, engine);
      engine.resume(text);
    }
    this.onChange();
  }
  close() {
    if (this.pendingCount)
      fail('resync-required', 'Pending edits: wait or checkpoint before leaving');
    this.shutdown();
  }
  /** Persist synchronously before detaching. A failed Host write leaves the session live.
   * In-flight commits may still reach the authority; resumption queries their receipts.
   */
  suspend(retain: (checkpoint: ReturnType<SharedEditorSession<T>['checkpoint']>) => void) {
    retain(this.checkpoint());
    this.shutdown();
  }
  private shutdown() {
    if (this.closed) return;
    this.closed = true;
    if (this.textTimer) clearTimeout(this.textTimer);
    this.textTimer = undefined;
    this.client.close();
  }
}
