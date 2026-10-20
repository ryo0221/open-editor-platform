import { deepFreeze } from '@editor-platform/artifact-core';
import {
  canonical,
  copy,
  fail,
  rejected,
  serializable,
  uid,
  validateOperation,
  type Accepted,
  type Action,
  type Anchor,
  type DomainCodec,
  type Operation,
  type Presence,
  type Preview,
  type Principal,
  type Proposal,
  type ProposalState,
  type Receipt,
  type Snapshot,
} from './contracts';
import {
  checkConditions,
  condition,
  evaluate,
  evaluatedOperation,
  mapAnchor,
  operation,
  prepareInverseActions,
  resourceRevisions,
  validateSnapshot,
} from './state';
const codecMethods = <T>(codec: DomainCodec<T>) => [
  codec.domain,
  codec.apply,
  codec.applyReadonly,
  codec.validate,
  codec.validateAnchor,
  codec.mapAnchor,
  codec.resource,
  codec.resources,
  codec.encode,
  codec.encodeActions,
];
export class Authority<T> {
  private state: Snapshot<T>;
  private seed: Snapshot<T>;
  private log: Accepted<T>[] = [];
  private floor = 0;
  private receipts = new Map<string, { canonical: string; receipt: Receipt }>();
  private histories = new Map<string, Accepted<T>>();
  private applyingProposal?: string;
  private applyingInverse?: string;
  private applyingRestore?: string;
  // Only this authority's synchronous Undo/Redo call can populate this map.
  // No client preparation handle supplies these results; public events contain
  // an isolated operation copy.
  private inverseEvaluations = new WeakMap<
    Operation,
    {
      source: Snapshot<T>;
      signature: string;
      methods: unknown[];
      result: ReturnType<typeof evaluate<T>>;
    }
  >();
  private proposals = new Map<string, ProposalState>();
  private listeners = new Set<(event: Accepted<T>) => void>();
  private presences = new Map<string, Presence>();
  readonly capabilities = {
    durable: false,
    offlineMerge: false,
    atomicBatch: true,
    selectiveUndo: true,
  } as const;
  constructor(
    readonly codec: DomainCodec<T>,
    snapshot: Snapshot<T>,
    readonly now = () => Date.now(),
    readonly externalCheck: (reference: string, version: string) => boolean = () => false,
  ) {
    validateSnapshot(codec, snapshot);
    this.state = copy(snapshot);
    if (codec.applyReadonly) deepFreeze(this.state.content);
    this.seed = copy(snapshot);
  }
  private evaluate(source: Snapshot<T>, actions: Action[], actorId: string) {
    // Keep the authority's private native tree immutable when the codec declares
    // pure evaluation. Public snapshots/events/previews remain isolated copies;
    // validation, authorization and dependency checks still run on every commit.
    return evaluate(this.codec, source, actions, actorId, {
      immutableContent: !!this.codec.applyReadonly,
    });
  }
  snapshot() {
    return copy(this.state);
  }
  subscribe(listener: (event: Accepted<T>) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  receipt(id: string) {
    return copy(this.receipts.get(id)?.receipt);
  }
  changes(after: number) {
    return after < this.floor || after > this.state.revision
      ? { snapshot: this.snapshot(), events: [] }
      : { events: copy(this.log.filter((e) => e.revision > after)) };
  }
  compact() {
    this.floor = this.state.revision;
    this.log = []; /* receipts and inverse ownership survive */
  }
  private authorize(principal: Principal, op: Operation) {
    if (
      !principal.writable ||
      (principal.expiresAt !== undefined && principal.expiresAt <= this.now()) ||
      ['actorId', 'clientId', 'sessionId'].some(
        (k) => principal[k as keyof Principal] !== op[k as keyof Operation],
      )
    )
      fail('unauthorized', 'Connection identity or permission rejected');
    if (!principal.scopes.includes('*') && !op.targets.every((t) => principal.scopes.includes(t)))
      fail('unauthorized', 'Target is outside connection scope');
  }
  /** Provenance is part of authorization: only the authority's own Undo, restore and
   * proposal APIs may issue their origins, reserved IDs, source actors or restores. */
  private checkProvenance(principal: Principal, op: Operation) {
    const proposal = !!op.proposalId && this.applyingProposal === op.proposalId;
    if (op.operationId.startsWith('proposal:') && !proposal)
      fail('protocol-error', 'Proposal operation IDs are reserved for the authority');
    if (proposal) {
      if (
        op.origin !== 'proposal' ||
        op.sourceActorId !== this.proposals.get(op.proposalId!)?.proposal.sourceActorId
      )
        fail('protocol-error', 'Proposal provenance changed');
      return;
    }
    if (op.sourceActorId !== undefined)
      fail('unauthorized', 'Source actor may only be issued by the proposal API');
    if (op.origin === 'restore' && this.applyingRestore !== op.operationId)
      fail('protocol-error', 'Restore may only be issued by the authority restore API');
    // Undo/redo links are checked separately; their inverses may restore whole content.
    if (['undo', 'redo', 'restore'].includes(op.origin)) return;
    if (!(principal.origins ?? ['human', 'proposal']).includes(op.origin))
      fail('unauthorized', `Connection may not declare ${op.origin} origin`);
    if (op.actions.some((action) => action.type === 'domain.restore'))
      fail('unauthorized', 'Whole-content restore requires the authority restore API');
  }
  submit(principal: Principal, input: unknown): Receipt {
    let id = '';
    let signature = '';
    try {
      validateOperation(input);
      const op = copy(input);
      id = op.operationId;
      this.authorize(principal, op);
      this.checkProvenance(principal, op);
      signature = canonical(op);
      const old = this.receipts.get(id);
      if (old) {
        if (old.canonical !== signature)
          fail('protocol-error', 'Operation ID was reused with different payload');
        return copy(old.receipt);
      }
      if (
        (op.undoOf || op.origin === 'undo' || op.origin === 'redo') &&
        (!op.undoOf || this.applyingInverse !== op.operationId)
      )
        fail('protocol-error', 'History links may only be issued by the authority Undo API');
      if (op.artifactId !== this.state.artifactId || op.domain !== this.state.domain)
        fail('schema-mismatch', 'Wrong artifact/domain');
      if (op.baseRevision > this.state.revision) fail('resync-required', 'Future base revision');
      if (op.proposalId) {
        const p = this.proposals.get(op.proposalId);
        if (!p || p.state !== 'preview' || this.applyingProposal !== op.proposalId)
          fail('cancelled', 'Proposal is not applicable');
        if (
          canonical(this.codec.encodeActions?.(p.proposal.actions) ?? p.proposal.actions) !==
          canonical(op.actions)
        )
          fail('protocol-error', 'Proposal intent changed');
        this.checkProposal(p.proposal);
      }
      checkConditions(this.codec, this.state, op.conditions);
      const prepared = this.inverseEvaluations.get(input);
      const result =
        prepared &&
        this.codec.applyReadonly &&
        prepared.source === this.state &&
        prepared.signature === signature &&
        codecMethods(this.codec).every((method, index) => method === prepared.methods[index])
          ? prepared.result
          : this.evaluate(this.state, op.actions, op.actorId);
      if (canonical(result.targets) !== canonical([...op.targets].sort()))
        fail('protocol-error', 'Declared targets differ from actual targets');
      const suppliedConditions = new Set(op.conditions.map((c) => c.key));
      if (result.required.some((key) => !suppliedConditions.has(key)))
        fail('stale-precondition', 'Missing required write precondition', result.required);
      this.authorize(principal, op);
      const mappedPresences = new Map(this.presences);
      for (const [key, presence] of mappedPresences)
        if (presence.anchor) {
          let anchor = presence.anchor,
            before = copy(this.state.content),
            version = this.state.engineVersion;
          const textVersions = { ...this.state.textVersions };
          for (const action of op.actions) {
            let after = before;
            if (!action.type.startsWith('thread.')) {
              const effect = this.codec.apply(copy(before), action, version, textVersions);
              after = effect.content;
              version += effect.engineSteps?.length ?? 0;
              if (effect.textSteps)
                textVersions[effect.textSteps.target] =
                  (textVersions[effect.textSteps.target] ?? 0) + effect.textSteps.steps.length;
            }
            anchor = mapAnchor(this.codec, anchor, before, action, after);
            before = after;
          }
          mappedPresences.set(key, { ...presence, anchor, basis: this.state.revision + 1 });
        }
      const revision = this.state.revision + 1;
      result.state.revision = revision;
      if (result.touched.includes('*')) result.state.stamps.structure = revision;
      for (const key of [...result.touched, ...result.invalidates, '*'])
        result.state.stamps[key] = revision;
      // Content validation alone cannot guarantee cross-content annotation invariants.
      validateSnapshot(this.codec, result.state);
      const event: Accepted<T> = {
        revision,
        operation: op,
        snapshot: copy(result.state),
        inverse: result.inverse,
        touched: result.touched,
        engineSteps: result.engineSteps,
      };
      const receipt: Receipt = { operationId: id, status: 'accepted', revision, durable: false };
      this.state = result.state;
      this.receipts.set(id, { canonical: signature, receipt });
      this.histories.set(id, event);
      this.log.push(event);
      this.presences = mappedPresences;
      if (op.proposalId) {
        const p = this.proposals.get(op.proposalId)!;
        p.state = 'applied';
        p.receipt = copy(receipt);
      }
      for (const listener of this.listeners) {
        try {
          listener(copy(event));
        } catch {
          /* transport failure never rolls back committed state */
        }
      }
      return copy(receipt);
    } catch (error) {
      const receipt = rejected(id, error);
      if (id && signature && !this.receipts.has(id))
        this.receipts.set(id, { canonical: signature, receipt });
      return receipt;
    }
  }
  commit(principal: Principal, input: unknown) {
    return this.submit(principal, input);
  }
  undo(principal: Principal, id: string, redo = false): Receipt {
    try {
      const event = this.histories.get(id);
      if (
        !event ||
        event.operation.actorId !== principal.actorId ||
        event.operation.sessionId !== principal.sessionId
      )
        fail('unauthorized', 'Undo belongs to another actor/session');
      if (redo && event.operation.origin !== 'undo')
        fail('undo-conflict', 'Redo requires an accepted undo');
      const previous = [...this.histories.values()].find(
        (e) =>
          e.operation.undoOf === id &&
          e.operation.origin === (redo ? 'redo' : 'undo') &&
          e.operation.sessionId === principal.sessionId,
      );
      if (previous) {
        this.authorize(principal, previous.operation);
        return this.receipt(previous.operation.operationId)!;
      }
      const later = [...this.histories.values()]
        .filter((e) => e.revision > event.revision)
        .sort((a, b) => a.revision - b.revision);
      // Keep revision stamps monotonic for proposal ABA checks. Only proven inverse pairs
      // from this actor/session cancel in the ownership check; foreign history never does.
      const currentStamps = resourceRevisions(this.state, event.touched);
      const laterStamps = later.map((next) => resourceRevisions(next.snapshot, event.touched));
      const bad = event.touched.filter((_key, index) => {
        const latest = currentStamps[index];
        if (latest === event.revision) return false;
        if (!later.some((e) => e.revision === latest)) return true;
        const active = new Map<string, Accepted<T>>();
        for (const [laterIndex, next] of later.entries()) {
          if (laterStamps[laterIndex][index] !== next.revision) continue;
          const own =
            next.operation.actorId === principal.actorId &&
            next.operation.sessionId === principal.sessionId;
          if (own && next.operation.undoOf && active.has(next.operation.undoOf))
            active.delete(next.operation.undoOf);
          else active.set(next.operation.operationId, next);
        }
        return active.size > 0;
      });
      if (bad.length && !this.codec.rebaseInverse)
        fail('undo-conflict', 'A later edit owns this resource', bad);
      let inverse = copy(event.inverse);
      if (bad.length && this.codec.rebaseInverse)
        inverse = this.codec.rebaseInverse(event, later, this.state);
      inverse = prepareInverseActions(this.codec, this.state, inverse, principal.actorId);
      const source = this.state,
        methods = codecMethods(this.codec);
      const prepared = this.codec.applyReadonly
        ? evaluatedOperation(this.codec, source, principal, inverse, redo ? 'redo' : 'undo')
        : undefined;
      const op =
        prepared?.operation ??
        operation(this.codec, source, principal, inverse, redo ? 'redo' : 'undo');
      op.undoOf = id;
      if (prepared)
        this.inverseEvaluations.set(op, {
          source,
          signature: canonical(op),
          methods,
          result: prepared.result,
        });
      this.applyingInverse = op.operationId;
      try {
        return this.commit(principal, op);
      } finally {
        this.inverseEvaluations.delete(op);
        this.applyingInverse = undefined;
      }
    } catch (error) {
      return rejected(`undo:${id}`, error);
    }
  }
  register(principal: Principal, proposal: Proposal): ProposalState {
    if (
      !serializable(proposal) ||
      proposal.schema !== 1 ||
      proposal.artifactId !== this.state.artifactId ||
      typeof proposal.id !== 'string' ||
      typeof proposal.sourceActorId !== 'string' ||
      !Array.isArray(proposal.actions) ||
      !Array.isArray(proposal.writes) ||
      !Array.isArray(proposal.external)
    )
      fail('schema-mismatch', 'Invalid proposal');
    if (
      !Number.isSafeInteger(proposal.baseRevision) ||
      proposal.baseRevision < 0 ||
      proposal.baseRevision > this.state.revision ||
      typeof proposal.summary !== 'string' ||
      (proposal.reads !== null && !Array.isArray(proposal.reads))
    )
      fail('schema-mismatch', 'Invalid proposal dependencies');
    for (const c of [...(proposal.reads ?? []), ...proposal.writes])
      if (
        !c ||
        typeof c.key !== 'string' ||
        typeof c.fingerprint !== 'string' ||
        !Number.isSafeInteger(c.stamp) ||
        c.stamp < 0
      )
        fail('schema-mismatch', 'Invalid proposal condition');
    if (
      !proposal.external.every(
        (d) => d && typeof d.reference === 'string' && typeof d.version === 'string',
      )
    )
      fail('schema-mismatch', 'Invalid external dependencies');
    if (
      proposal.sourceActorId !== principal.actorId ||
      (principal.expiresAt !== undefined && principal.expiresAt <= this.now())
    )
      fail('unauthorized', 'Proposal source is not the authenticated actor');
    const old = this.proposals.get(proposal.id);
    if (old) {
      if (canonical(old.proposal) !== canonical(proposal))
        fail('protocol-error', 'Proposal ID reused');
      return copy(old);
    }
    const required = this.evaluate(this.state, proposal.actions, proposal.sourceActorId).required;
    if (required.some((k) => !proposal.writes.some((c) => c.key === k)))
      fail('stale-precondition', 'Proposal omits a write dependency', required);
    const state: ProposalState = { proposal: copy(proposal), state: 'ready' };
    this.proposals.set(proposal.id, state);
    return copy(state);
  }
  proposal(id: string) {
    return copy(this.proposals.get(id));
  }
  private checkProposal(p: Proposal) {
    if (p.reads === null) {
      if (p.baseRevision !== this.state.revision)
        fail('stale-precondition', 'Unknown read scope requires unchanged artifact', ['*']);
    } else checkConditions(this.codec, this.state, p.reads);
    checkConditions(this.codec, this.state, p.writes);
    if (!p.external.every((d) => this.externalCheck(d.reference, d.version)))
      fail('stale-precondition', 'External read dependency changed');
  }
  preview(principal: Principal, id: string): Preview<T> {
    const p = this.proposals.get(id);
    if (!p || !['ready', 'preview', 'conflicted'].includes(p.state))
      fail('cancelled', 'Proposal is terminal or missing');
    this.checkProposal(p.proposal);
    const op = operation(this.codec, this.state, principal, p.proposal.actions, 'proposal');
    this.authorize(principal, op);
    const result = this.evaluate(this.state, p.proposal.actions, principal.actorId);
    const token = uid();
    p.state = 'preview';
    p.token = token;
    return {
      token,
      before: copy(this.state.content),
      after: copy(result.state.content),
      changedKeys: result.touched,
    };
  }
  applyProposal(principal: Principal, id: string, token: string): Receipt {
    const p = this.proposals.get(id);
    if (p?.state === 'applied' && p.receipt) return copy(p.receipt);
    try {
      if (!p || p.state !== 'preview' || p.token !== token)
        fail('cancelled', 'Preview token is missing, superseded, or cancelled');
      this.checkProposal(p.proposal);
      const op = operation(this.codec, this.state, principal, p.proposal.actions, 'proposal');
      op.operationId = `proposal:${id}`;
      op.transactionId = id;
      op.proposalId = id;
      op.sourceActorId = p.proposal.sourceActorId;
      this.applyingProposal = id;
      let receipt: Receipt;
      try {
        receipt = this.commit(principal, op);
      } finally {
        this.applyingProposal = undefined;
      }
      p.receipt = receipt;
      p.state = receipt.status === 'accepted' ? 'applied' : 'conflicted';
      return receipt;
    } catch (error) {
      const receipt = rejected(`proposal:${id}`, error);
      if (p && !['cancelled', 'rejected', 'applied'].includes(p.state)) {
        p.state = 'conflicted';
        p.receipt = receipt;
      }
      return receipt;
    }
  }
  /** The source actor may withdraw its proposal; rejecting or cancelling another
   * actor's proposal needs write access to every target it would change. */
  cancelProposal(principal: Principal, id: string, reject = false) {
    const p = this.proposals.get(id);
    if (!p) return undefined;
    // Terminal outcomes are final: a late cancel reports applied, and a withdrawal
    // never rewrites a reviewer's rejection (nor a rejection a withdrawal).
    if (['applied', 'cancelled', 'rejected'].includes(p.state)) return copy(p);
    if (principal.expiresAt !== undefined && principal.expiresAt <= this.now())
      fail('unauthorized', 'Session expired');
    if (reject || p.proposal.sourceActorId !== principal.actorId) {
      let targets = ['*'];
      try {
        targets = this.evaluate(this.state, p.proposal.actions, p.proposal.sourceActorId).targets;
      } catch {
        /* An inapplicable proposal falls back to whole-artifact scope. */
      }
      if (
        !principal.writable ||
        (!principal.scopes.includes('*') && !targets.every((t) => principal.scopes.includes(t)))
      )
        fail('unauthorized', 'Proposal review requires write access to its targets');
    }
    p.state = reject ? 'rejected' : 'cancelled';
    return copy(p);
  }
  private resolvePresenceAnchor(anchor: Anchor, basis: number): Anchor {
    if (!Number.isSafeInteger(basis) || basis < 0 || basis > this.state.revision)
      fail('invalid-operation', 'Invalid presence basis');
    const source =
      basis === this.state.revision
        ? this.state
        : basis === this.seed.revision
          ? this.seed
          : [...this.histories.values()].find((event) => event.revision === basis)?.snapshot;
    if (!source) return { ...anchor, orphan: true }; // Ephemeral position cannot be guessed across an unavailable checkpoint.
    if (!this.codec.validateAnchor(source.content, anchor))
      fail('invalid-operation', 'Invalid presence anchor at its basis');
    let mapped = copy(anchor),
      content = copy(source.content),
      version = source.engineVersion;
    const textVersions = { ...source.textVersions };
    for (const event of [...this.histories.values()]
      .filter((e) => e.revision > basis)
      .sort((a, b) => a.revision - b.revision)) {
      for (const action of event.operation.actions) {
        let after = content;
        if (!action.type.startsWith('thread.')) {
          const effect = this.codec.apply(copy(content), action, version, textVersions);
          after = effect.content;
          version += effect.engineSteps?.length ?? 0;
          if (effect.textSteps)
            textVersions[effect.textSteps.target] =
              (textVersions[effect.textSteps.target] ?? 0) + effect.textSteps.steps.length;
        }
        mapped = mapAnchor(this.codec, mapped, content, action, after);
        content = after;
      }
    }
    return mapped;
  }
  presence(
    principal: Principal,
    value: Omit<Presence, 'actorId' | 'clientId' | 'sessionId' | 'expiresAt'> | null,
  ) {
    const key = `${principal.clientId}:${principal.sessionId}`;
    if (value === null) this.presences.delete(key);
    else {
      if (principal.expiresAt !== undefined && principal.expiresAt <= this.now())
        fail('unauthorized', 'Session expired');
      if (typeof value.name !== 'string' || !/^#[0-9a-f]{6}$/i.test(value.color))
        fail('invalid-operation', 'Invalid presence');
      const anchor = value.anchor
        ? this.resolvePresenceAnchor(value.anchor, value.basis ?? this.state.revision)
        : undefined;
      this.presences.set(key, {
        basis: this.state.revision,
        name: value.name.slice(0, 100),
        color: value.color,
        ...(value.page ? { page: value.page } : {}),
        ...(anchor ? { anchor } : {}),
        ...(value.activity ? { activity: value.activity.slice(0, 100) } : {}),
        actorId: principal.actorId,
        clientId: principal.clientId,
        sessionId: principal.sessionId,
        expiresAt: this.now() + 15000,
      });
    }
    return this.presenceList();
  }
  presenceList() {
    for (const [key, p] of this.presences)
      if (p.expiresAt <= this.now()) this.presences.delete(key);
    return copy([...this.presences.values()]);
  }
  restore(principal: Principal, content: T, expectedRevision: number) {
    if (expectedRevision !== this.state.revision)
      return {
        operationId: 'restore',
        status: 'rejected',
        code: 'stale-precondition',
        message: 'Restore requires review of latest confirmed revision',
        keys: ['*'],
      } as Receipt;
    const op = operation(
      this.codec,
      this.state,
      principal,
      [{ type: 'domain.restore', target: '*', payload: { content } }],
      'restore',
    );
    this.applyingRestore = op.operationId;
    try {
      return this.commit(principal, op);
    } finally {
      this.applyingRestore = undefined;
    }
  }
  backup() {
    return copy({
      format: 'editor-collaboration',
      schema: 1,
      state: this.state,
      floor: this.floor,
      log: this.log,
      receipts: [...this.receipts],
      histories: [...this.histories],
      proposals: [...this.proposals],
    });
  }
  static fromBackup<T>(
    codec: DomainCodec<T>,
    value: ReturnType<Authority<T>['backup']>,
    now?: () => number,
    externalCheck?: (reference: string, version: string) => boolean,
  ) {
    if (
      !serializable(value) ||
      value.format !== 'editor-collaboration' ||
      value.schema !== 1 ||
      !codec.validate(value.state.content)
    )
      fail('schema-mismatch', 'Invalid collaboration backup');
    validateSnapshot(codec, value.state);
    if (
      !Number.isSafeInteger(value.floor) ||
      value.floor < 0 ||
      value.floor > value.state.revision ||
      !Array.isArray(value.log) ||
      !Array.isArray(value.receipts) ||
      !Array.isArray(value.histories) ||
      !Array.isArray(value.proposals)
    )
      fail('schema-mismatch', 'Invalid backup history');
    for (const event of [...value.log, ...value.histories.map(([, e]) => e)]) {
      validateOperation(event.operation);
      validateSnapshot(codec, event.snapshot);
      if (event.revision !== event.snapshot.revision || event.revision > value.state.revision)
        fail('schema-mismatch', 'Invalid history revision');
    }
    const a = new Authority(codec, value.state, now, externalCheck);
    a.floor = value.floor;
    a.log = copy(value.log);
    a.receipts = new Map(copy(value.receipts));
    a.histories = new Map(copy(value.histories));
    a.proposals = new Map(copy(value.proposals));
    return a;
  }
}
/** Runtime records dependencies at generation time. Unknown scope is represented by null. */
export function proposal<T>(
  authority: Authority<T>,
  sourceActorId: string,
  actions: Action[],
  reads: string[] | null,
  summary: string,
): Proposal {
  const state = authority.snapshot(),
    op = operation(
      authority.codec,
      state,
      { actorId: sourceActorId, clientId: 'generation', sessionId: 'generation' },
      actions,
      'agent',
    );
  return {
    schema: 1,
    id: uid(),
    artifactId: state.artifactId,
    sourceActorId,
    baseRevision: state.revision,
    summary,
    actions: copy(actions),
    reads: reads?.map((k) => condition(authority.codec, state, k)) ?? null,
    writes: op.conditions,
    external: [],
  };
}
