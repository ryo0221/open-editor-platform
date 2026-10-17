import { deepFreeze, isDeepFrozen } from '@editor-platform/artifact-core';
import {
  copy,
  fail,
  rejected,
  type Accepted,
  type DomainCodec,
  type Operation,
  type Principal,
  type Receipt,
  type Snapshot,
  type SyncAdapter,
} from './contracts';
import { evaluate, validateSnapshot } from './state';
import { sameContent } from './immutable-content';
import { preparedProjection, type PreparedOperation } from './prepared';
/** Each instance owns a distinct confirmed snapshot, pending queue and private view. */
export class CollaborationClient<T> {
  confirmed!: Snapshot<T>;
  optimistic!: Snapshot<T>;
  pending: Operation[] = [];
  receipts = new Map<string, Receipt>();
  held = new Map<string, Receipt>();
  private connectionStatus:
    | 'closed'
    | 'connecting'
    | 'online'
    | 'disconnected'
    | 'resync-required' = 'closed';
  private statusRevision = 0;
  private connectionAllowsRecovery = true;
  get status() {
    return this.connectionStatus;
  }
  set status(value: typeof this.connectionStatus) {
    // A second failure may have the same display value. It still supersedes an
    // older in-flight sync's success.
    this.statusRevision++;
    this.connectionStatus = value;
  }
  readonly view = { zoom: 1, panel: false, page: '' };
  private epoch = 0;
  private permissionSignature = '';
  private optimisticBasis?: Snapshot<T>;
  private optimisticIntents: Operation[] = [];
  private buffer = new Map<number, Accepted<T>>();
  permissions?: Principal;
  private stopStatus?: () => void;
  private unsubscribe?: () => void;
  onChange = () => {};
  onEvent = (_event: Accepted<T>) => {};
  onReset = (_snapshot: Snapshot<T>) => {};
  constructor(
    readonly codec: DomainCodec<T>,
    readonly adapter: SyncAdapter<T>,
    /** Opt in to frozen confirmed/optimistic content; ordinary snapshots remain copied. */
    private readonly options: { immutableContent?: boolean } = {},
  ) {}
  private copySnapshot(snapshot: Snapshot<T>, reuseOptimistic = false): Snapshot<T> {
    if (!snapshot || typeof snapshot !== 'object')
      fail('schema-mismatch', 'Invalid collaboration snapshot');
    if (!this.options.immutableContent) return copy(snapshot);
    const optimistic = this.optimistic?.content;
    return {
      ...copy({ ...snapshot, content: undefined }),
      // A receipt often confirms exactly the native content already painted.
      // Reuse only after comparing every field; metadata/permissions/revisions
      // still advance independently and differing authority content always wins.
      content:
        reuseOptimistic &&
        optimistic !== undefined &&
        isDeepFrozen(optimistic) &&
        sameContent(optimistic, snapshot.content)
          ? optimistic
          : isDeepFrozen(snapshot.content)
            ? snapshot.content
            : deepFreeze(copy(snapshot.content)),
    };
  }
  private installPermissions(value: Principal) {
    // Permission expiry changes effective UI access without a content revision.
    const signature = JSON.stringify([
      value,
      value.expiresAt !== undefined && value.expiresAt <= Date.now(),
    ]);
    this.permissions = copy(value);
    if (signature !== this.permissionSignature) {
      this.permissionSignature = signature;
      this.onChange();
    }
  }
  async open() {
    const epoch = ++this.epoch;
    this.connectionAllowsRecovery = true;
    this.status = 'connecting';
    this.stopStatus?.();
    this.stopStatus = this.adapter.subscribeStatus((status) => {
      if (epoch !== this.epoch) return;
      if (status.type === 'permissions') this.installPermissions(status.principal);
      else {
        this.connectionAllowsRecovery = status.state === 'online';
        const changed = this.status !== status.state;
        this.status = status.state;
        if (changed) this.onChange();
      }
    });
    // Subscribe first; updates racing snapshot installation are buffered.
    this.unsubscribe?.();
    this.unsubscribe = this.adapter.subscribe((event) => {
      if (epoch === this.epoch) this.receive(event);
    });
    const permissions = await this.adapter.permissions();
    if (epoch !== this.epoch) return;
    this.installPermissions(permissions);
    const snapshot = await this.adapter.open();
    if (epoch !== this.epoch) return;
    if (this.confirmed) await this.sync();
    else this.install(snapshot);
    if (epoch !== this.epoch) return;
    this.status = 'online';
    this.onChange();
  }
  install(snapshot: Snapshot<T>) {
    const owned = this.copySnapshot(snapshot, true);
    validateSnapshot(this.codec, owned);
    if (this.confirmed && snapshot.revision < this.confirmed.revision) return;
    this.confirmed = owned;
    this.onReset(snapshot);
    for (const revision of this.buffer.keys())
      if (revision <= snapshot.revision) this.buffer.delete(revision);
    this.drain();
    this.recompute();
  }
  receive(event: Accepted<T>) {
    // A matching authoritative projection can retain its already owned immutable
    // tree before validation. Every field is compared and all snapshot/codec
    // checks still run; differing authority content is independently owned.
    const snapshot = this.copySnapshot(event.snapshot, true);
    validateSnapshot(this.codec, snapshot);
    if (
      snapshot.revision !== event.revision ||
      (this.confirmed && snapshot.artifactId !== this.confirmed.artifactId)
    )
      fail('resync-required', 'Invalid event identity/revision');
    if (this.confirmed && event.revision <= this.confirmed.revision) return;
    const retained = this.options.immutableContent
      ? {
          ...copy({ ...event, snapshot: undefined }),
          snapshot,
        }
      : copy(event);
    this.buffer.set(event.revision, retained);
    if (this.confirmed) {
      this.drain();
      this.recompute();
    }
  }
  private drain() {
    let event: Accepted<T> | undefined;
    while ((event = this.buffer.get(this.confirmed.revision + 1))) {
      this.buffer.delete(event.revision);
      this.confirmed = this.copySnapshot(event.snapshot, true);
      this.onEvent(event);
      const operationId = event.operation.operationId;
      this.pending = this.pending.filter((o) => o.operationId !== operationId);
      this.receipts.set(event.operation.operationId, {
        operationId: event.operation.operationId,
        status: 'accepted',
        revision: event.revision,
        durable: false,
      });
    }
  }
  private recompute() {
    if (!this.confirmed) return;
    if (
      this.optimisticBasis === this.confirmed &&
      this.optimisticIntents.length === this.pending.length &&
      this.pending.every((op, i) => this.optimisticIntents[i] === op)
    )
      return;
    this.optimisticBasis = this.confirmed;
    this.optimisticIntents = [...this.pending];
    let state = this.confirmed;
    this.held.clear();
    for (const op of this.pending) {
      try {
        state = evaluate(this.codec, state, op.actions, op.actorId, this.options).state;
      } catch (error) {
        this.held.set(op.operationId, rejected(op.operationId, error));
      }
    }
    this.optimistic = state === this.confirmed ? this.copySnapshot(state) : state;
    this.onChange();
  }
  enqueue(op: Operation) {
    if (!this.pending.some((p) => p.operationId === op.operationId)) {
      this.pending.push(copy(op));
      this.recompute();
    }
  }
  enqueuePrepared(prepared: PreparedOperation<T>) {
    const projection = preparedProjection(prepared, this.codec, this.confirmed);
    const op = prepared.operation;
    if (this.pending.some((pending) => pending.operationId === op.operationId)) return;
    // An existing queue may need replay (including held intents). Keep that path
    // unchanged; the common confirmed-to-first-edit transition needs no replay.
    if (!this.options.immutableContent || this.pending.length || this.held.size || !projection) {
      this.enqueue(op);
      return;
    }
    this.pending.push(op);
    this.optimisticBasis = this.confirmed;
    this.optimisticIntents = [...this.pending];
    // Metadata stays caller-owned just as in ordinary client snapshots.
    this.optimistic = this.copySnapshot(projection);
    this.onChange();
  }
  /** Only the owning session may discard an intent known never to have been submitted. */
  discardUnsubmitted(id: string) {
    this.pending = this.pending.filter((op) => op.operationId !== id);
    this.recompute();
  }
  async submit(op: Operation) {
    const epoch = this.epoch;
    this.enqueue(op);
    try {
      const receipt = await this.adapter.submit(op);
      if (epoch !== this.epoch) return receipt;
      this.receipts.set(op.operationId, receipt);
      if (receipt.status === 'rejected')
        this.pending = this.pending.filter((p) => p.operationId !== op.operationId);
      await this.sync();
      if (epoch !== this.epoch) return receipt;
      this.recompute();
      return receipt;
    } catch (error) {
      if (epoch === this.epoch) {
        this.status = 'disconnected';
        this.onChange();
      }
      throw error;
    }
  }
  async sync() {
    const epoch = this.epoch;
    const statusRevision = this.statusRevision;
    const permissions = await this.adapter.permissions();
    if (epoch !== this.epoch) return;
    this.installPermissions(permissions);
    const update = await this.adapter.changes(this.confirmed.revision);
    if (epoch !== this.epoch) return;
    if (update.snapshot) this.install(update.snapshot);
    for (const event of update.events) this.receive(event);
    // Snapshot might include accepted pending operations whose event was compacted.
    for (const op of [...this.pending]) {
      const receipt = await this.adapter.receipt(op.operationId);
      if (epoch !== this.epoch) return;
      if (receipt) {
        this.receipts.set(op.operationId, receipt);
        if (receipt.status === 'rejected' || receipt.revision <= this.confirmed.revision)
          this.pending = this.pending.filter((p) => p.operationId !== op.operationId);
      }
    }
    this.recompute();
    // Only a complete read/reconciliation can recover a transport failure.
    // Explicit adapter stops, close and failures arriving during this sync win.
    if (
      epoch === this.epoch &&
      statusRevision === this.statusRevision &&
      this.connectionAllowsRecovery &&
      this.status === 'disconnected'
    ) {
      this.status = 'online';
      this.onChange();
    }
  }
  async reconnect() {
    await this.open();
    await this.sync();
    for (const op of [...this.pending]) await this.submit(op);
    this.status = 'online';
    this.onChange();
  }
  checkpoint() {
    return copy({
      schema: 1,
      identity: this.adapter.identity,
      confirmed: this.confirmed,
      pending: this.pending,
    });
  }
  resume(value: ReturnType<CollaborationClient<T>['checkpoint']>) {
    if (
      value.schema !== 1 ||
      JSON.stringify(value.identity) !== JSON.stringify(this.adapter.identity)
    )
      fail(
        'unauthorized',
        'Pending checkpoint belongs to a different authenticated client/session',
      );
    this.pending = copy(value.pending);
    this.install(value.confirmed);
  }
  close() {
    this.epoch++;
    this.unsubscribe?.();
    this.stopStatus?.();
    this.adapter.close();
    this.status = 'closed';
    this.onChange();
  }
}
