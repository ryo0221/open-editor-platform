import { EditorState, type Transaction } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { Step, Transform, Mapping } from 'prosemirror-transform';
import { collab, getVersion, receiveTransaction, sendableSteps } from 'prosemirror-collab';
import { isDeepFrozen } from '@editor-platform/artifact-core';
import {
  contentToNode,
  nodeToContent,
  documentSchema,
  documentPlugins,
  documentAttributeFields,
  documentAttributeTransform,
  type DocumentAttributePatch,
} from '@editor-platform/document/engine';
import { isDocument, type DocumentContent } from '@editor-platform/document/model';
import {
  canonical,
  copy,
  fail,
  operation,
  type Action,
  type Anchor,
  type DomainCodec,
  type Receipt,
  type Principal,
  type Snapshot,
  type SyncAdapter,
} from '@editor-platform/collaboration-core';
export function documentAttributeKey(id: string, field: string): string {
  return 'attribute/' + encodeURIComponent(id) + '/' + field;
}
const attributeFields = ['$exists', ...documentAttributeFields];
function attributeValue(node: unknown, field: string): unknown {
  if (field === '$exists') return !!node;
  const attrs = (node as { attrs?: Record<string, unknown> } | undefined)?.attrs;
  if (['src', 'alt', 'width', 'caption'].includes(field))
    return (attrs?.block as Record<string, unknown> | undefined)?.[field] ?? null;
  return attrs?.[field] ?? null;
}
function attributeKeys(before: Map<string, unknown>, after: Map<string, unknown>) {
  const keys: string[] = [];
  for (const id of new Set([...before.keys(), ...after.keys()]))
    if (before.get(id) !== after.get(id))
      for (const field of attributeFields)
        if (
          before.has(id) !== after.has(id) ||
          canonical(attributeValue(before.get(id), field)) !==
            canonical(attributeValue(after.get(id), field))
        )
          keys.push(documentAttributeKey(id, field));
  return keys;
}
function mapTextAnchor(anchor: Anchor, mapping: Mapping): Anchor {
  if (anchor.type !== 'text' || anchor.orphan) return anchor;
  const from = mapping.mapResult(anchor.from, 1),
    to = mapping.mapResult(anchor.to, -1);
  return {
    ...anchor,
    from: from.pos,
    to: Math.max(from.pos, to.pos),
    orphan:
      (from.deletedAcross && to.deletedAcross) ||
      (anchor.from < anchor.to && from.deleted && to.deleted),
  };
}
function transform(content: DocumentContent, steps: unknown[]) {
  const tr = new Transform(contentToNode(content)),
    inverse: unknown[] = [];
  for (const json of steps) {
    const step = Step.fromJSON(documentSchema, json);
    inverse.unshift(step.invert(tr.doc).toJSON());
    const result = tr.maybeStep(step);
    if (result.failed) fail('invalid-operation', result.failed);
  }
  tr.doc.check();
  return { tr, inverse };
}
function engineResources(content: DocumentContent) {
  const values = new Map<string, unknown>();
  contentToNode(content).descendants((node) => {
    if (typeof node.attrs.id === 'string') values.set(node.attrs.id, node.toJSON());
  });
  return values;
}
function engineNodes(node: PMNode): Map<string, PMNode> {
  const values = new Map<string, PMNode>();
  node.descendants((child) => {
    if (typeof child.attrs.id === 'string') values.set(child.attrs.id, child);
  });
  return values;
}
function documentResources(content: DocumentContent, keys: readonly string[]): unknown[] {
  // One transient lookup for a precondition batch; mutable callers are never cached.
  const values = keys.some((key) => key.startsWith('attribute/') || key.startsWith('block/'))
    ? engineResources(content)
    : undefined;
  let text: unknown;
  return keys.map((key) => {
    if (key.startsWith('attribute/')) {
      const [, id, field] = key.split('/');
      return attributeFields.includes(field)
        ? attributeValue(values!.get(decodeURIComponent(id)), field)
        : undefined;
    }
    if (key.startsWith('block/')) return values!.get(key.slice(6));
    if (key === 'text') return (text ??= contentToNode(content).toJSON());
    return undefined;
  });
}
const checkedEngineIds = new WeakSet<DocumentContent['blocks']>();
function validIds(content: DocumentContent) {
  if (checkedEngineIds.has(content.blocks)) return true;
  // Paragraphs/headings contain inline text/marks with no additional engine IDs.
  // Lists, tables and embedded content retain the full schema traversal below.
  let valid: boolean;
  if (content.blocks.every((block) => ['paragraph', 'heading'].includes(block.type))) {
    const ids = content.blocks.map((block) => block.id);
    valid = ids.every((id) => typeof id === 'string' && !!id) && new Set(ids).size === ids.length;
  } else valid = validNodeIds(contentToNode(content));
  if (valid && isDeepFrozen(content.blocks)) checkedEngineIds.add(content.blocks);
  return valid;
}
function validNodeIds(node: PMNode) {
  const ids = new Set<string>();
  let valid = true;
  node.descendants((node) => {
    if (node.isText) return;
    const id = node.attrs.id;
    if (id !== undefined && (typeof id !== 'string' || !id || ids.has(id))) valid = false;
    else if (id) ids.add(id);
  });
  return valid;
}
export const documentCodec: DomainCodec<DocumentContent> = {
  domain: 'document',
  validate: (v): v is DocumentContent => {
    try {
      return isDocument(v) && validIds(v);
    } catch {
      return false;
    }
  },
  resource: (d, key) => documentResources(d, [key])[0],
  resources: documentResources,
  validateAnchor: (d, a) =>
    a.type === 'text' &&
    Number.isSafeInteger(a.from) &&
    Number.isSafeInteger(a.to) &&
    a.from >= 0 &&
    a.to >= a.from &&
    a.to <= contentToNode(d).content.size,
  mapAnchor(anchor, before, action): Anchor {
    if (anchor.type !== 'text' || anchor.orphan || action.type !== 'document.steps') return anchor;
    const { tr } = transform(before, action.payload.steps as unknown[]);
    return mapTextAnchor(anchor, tr.mapping);
  },
  rebaseInverse(event, later, current) {
    if (event.inverse.length && event.inverse.every((a) => a.type === 'document.attributes')) {
      // Authority already folds this actor/session's proven inverse pairs. Attribute
      // operations own only their declared fields, so remaining overlap is a conflict.
      fail('undo-conflict', 'Later editing owns these document attributes');
    }
    if (!event.engineSteps.length || event.inverse.some((a) => a.type !== 'document.steps'))
      fail('undo-conflict', 'Mixed annotation/text inverse requires explicit review');
    const affected = new Set(event.touched.filter((k) => k.startsWith('block/')));
    if (later.some((e) => e.touched.some((k) => affected.has(k))))
      fail('undo-conflict', 'Later text changed the same stable block; inverse requires review');
    let state = EditorState.create({
      schema: documentSchema,
      doc: contentToNode(event.snapshot.content),
      plugins: [collab({ version: event.snapshot.engineVersion, clientID: 'selective-inverse' })],
    });
    for (const action of event.inverse) {
      const tr = state.tr;
      for (const json of action.payload.steps as unknown[])
        tr.step(Step.fromJSON(documentSchema, json));
      state = state.apply(tr);
    }
    const steps = later.flatMap((e) => e.engineSteps).map((s) => Step.fromJSON(documentSchema, s));
    state = state.apply(
      receiveTransaction(
        state,
        steps,
        steps.map(() => 'remote'),
      ),
    );
    const inverse = sendableSteps(state);
    if (!inverse) fail('undo-conflict', 'Inverse was removed by rebase');
    return [
      {
        type: 'document.steps',
        target: 'text',
        payload: { version: current.engineVersion, steps: inverse.steps.map((s) => s.toJSON()) },
      },
    ];
  },
  apply(content, action, version) {
    if (action.type === 'domain.restore')
      fail(
        'unsupported-operation',
        'Document snapshot restore requires an explicit reviewed engine replacement',
      );
    if (action.type === 'document.attributes') {
      if (action.target !== 'text' || !Array.isArray(action.payload.patches))
        fail('invalid-operation', 'Invalid document attribute action');
      const patches = action.payload.patches as DocumentAttributePatch[];
      const tr = documentAttributeTransform(content, patches),
        after = nodeToContent(tr.doc, content),
        before = engineNodes(tr.before);
      const keys = patches.flatMap((p) =>
        Object.keys(p.values).map((field) => documentAttributeKey(p.id, field)),
      );
      return {
        content: after,
        required: [...keys, ...patches.map((p) => documentAttributeKey(p.id, '$exists'))],
        touched: keys,
        invalidates: ['text', ...patches.map((p) => 'block/' + p.id)],
        targets: ['text'],
        inverse: [
          {
            type: 'document.attributes',
            target: 'text',
            payload: {
              patches: patches.map((p) => ({
                id: p.id,
                values: Object.fromEntries(
                  Object.keys(p.values).map((field) => [
                    field,
                    copy(attributeValue(before.get(p.id), field)),
                  ]),
                ),
              })),
            },
          },
        ],
        engineSteps: tr.steps.map((s) => s.toJSON()),
      };
    }
    if (action.type !== 'document.steps')
      fail('unsupported-operation', 'Shared Document edits require ProseMirror steps');
    if (
      action.target !== 'text' ||
      !Number.isSafeInteger(action.payload.version) ||
      !Array.isArray(action.payload.steps) ||
      !action.payload.steps.length ||
      action.payload.steps.length > 500
    )
      fail('schema-mismatch', 'Invalid engine update');
    if (action.payload.version !== version)
      fail('resync-required', 'Text engine version changed; receive and rebase before retry');
    const { tr, inverse } = transform(content, action.payload.steps);
    const after = nodeToContent(tr.doc, content);
    if (!validNodeIds(tr.doc))
      fail('invalid-operation', 'Text engine IDs must be stable and unique');
    const beforeResources = engineNodes(tr.before),
      afterResources = engineNodes(tr.doc);
    return {
      content: after,
      required: [],
      touched: [
        'text',
        ...[...new Set([...beforeResources.keys(), ...afterResources.keys()])]
          .filter(
            (id) =>
              beforeResources.get(id) !== afterResources.get(id) &&
              canonical(beforeResources.get(id)?.toJSON()) !==
                canonical(afterResources.get(id)?.toJSON()),
          )
          .map((id) => `block/${id}`),
        ...attributeKeys(beforeResources, afterResources),
      ],
      targets: ['text'],
      inverse: [
        {
          type: 'document.steps',
          target: 'text',
          payload: { version: version + action.payload.steps.length, steps: inverse },
        },
      ],
      engineSteps: copy(action.payload.steps),
    };
  },
};
// Engine transforms and native projection create new content. They never write
// into the source tree, so private evaluation can retain its immutable basis.
documentCodec.applyReadonly = (content, action, version, textVersions) =>
  documentCodec.apply(content, action, version, textVersions);
/** ProseMirror's actual rebase algorithm owns text positions, marks and unconfirmed steps. */
export class DocumentReplica {
  state!: EditorState;
  confirmed!: Snapshot<DocumentContent>;
  onChange = () => {};
  private mappingBase = 0;
  private maps = new Map<number, Mapping>();
  private running?: Promise<void>;
  private inflight?: ReturnType<typeof operation<DocumentContent>>;
  lastReceipt?: Receipt;
  permissions?: Principal;
  private stopStatus?: () => void;
  conflict?: string;
  constructor(readonly adapter: SyncAdapter<DocumentContent>) {}
  async open() {
    this.stopStatus?.();
    this.stopStatus = this.adapter.subscribeStatus((s) => {
      if (s.type === 'permissions') {
        this.permissions = s.principal;
        this.onChange();
      }
    });
    this.permissions = await this.adapter.permissions();
    this.confirmed = await this.adapter.open();
    this.mappingBase = this.confirmed.revision;
    this.maps.clear();
    this.state = this.create(this.confirmed);
    this.onChange();
  }
  private create(snapshot: Snapshot<DocumentContent>) {
    return EditorState.create({
      schema: documentSchema,
      doc: contentToNode(snapshot.content),
      plugins: [
        ...documentPlugins(),
        collab({ version: snapshot.engineVersion, clientID: this.adapter.identity.clientId }),
      ],
    });
  }
  dispatch(transaction: Transaction) {
    this.state = this.state.applyTransaction(transaction).state;
    this.onChange();
  }
  async sync() {
    this.permissions = await this.adapter.permissions();
    const result = await this.adapter.changes(this.confirmed.revision);
    if (result.snapshot) {
      if (sendableSteps(this.state)) {
        this.conflict = 'Text history compacted: pending text retained for explicit review';
        fail('resync-required', this.conflict);
      }
      this.confirmed = result.snapshot;
      this.mappingBase = result.snapshot.revision;
      this.maps.clear();
      this.state = this.create(result.snapshot);
    }
    for (const event of result.events) {
      if (event.revision <= this.confirmed.revision) continue;
      if (event.revision !== this.confirmed.revision + 1)
        fail('resync-required', 'Missing canonical history');
      if (event.engineSteps.length) {
        const steps = event.engineSteps.map((s) => Step.fromJSON(documentSchema, s));
        this.maps.set(event.revision, new Mapping(steps.map((s) => s.getMap())));
        const own =
          event.operation.clientId === this.adapter.identity.clientId &&
          event.operation.operationId === this.inflight?.operationId;
        const clientId = own
          ? this.adapter.identity.clientId
          : `remote:${event.operation.operationId}`;
        this.state = this.state.apply(
          receiveTransaction(
            this.state,
            steps,
            steps.map(() => clientId),
          ),
        );
        if (own) this.inflight = undefined;
      }
      this.confirmed = copy(event.snapshot);
    }
    this.onChange();
  }
  /** Pending text has no confirmed position yet; withhold that ephemeral cursor. */
  presencePosition(): { basis: number; anchor?: Anchor } {
    return {
      basis: this.confirmed.revision,
      ...(sendableSteps(this.state)
        ? {}
        : {
            anchor: {
              type: 'text',
              from: this.state.selection.from,
              to: this.state.selection.to,
            } as Anchor,
          }),
    };
  }
  /** Map canonical remote annotations/carets into this client's optimistic document. */
  localAnchor(anchor: Anchor, basis = this.confirmed.revision): Anchor {
    if (basis < this.mappingBase || basis > this.confirmed.revision)
      return { ...anchor, orphan: true };
    const mapping = new Mapping();
    for (const [revision, maps] of this.maps) if (revision > basis) mapping.appendMapping(maps);
    for (const step of sendableSteps(this.state)?.steps ?? []) mapping.appendMap(step.getMap());
    return mapTextAnchor(anchor, mapping);
  }
  async flush() {
    if (this.running) return this.running;
    this.running = this.send();
    try {
      await this.running;
    } finally {
      this.running = undefined;
    }
  }
  private async send() {
    for (let attempts = 0; attempts < 30; attempts++) {
      await this.sync();
      const pending = sendableSteps(this.state);
      if (!pending) return;
      if (!this.inflight) {
        const action: Action = {
          type: 'document.steps',
          target: 'text',
          payload: { version: pending.version, steps: pending.steps.map((s) => s.toJSON()) },
        };
        this.inflight = operation(documentCodec, this.confirmed, this.adapter.identity, [action]);
      }
      const receipt = await this.adapter.submit(this.inflight);
      this.lastReceipt = receipt;
      if (receipt.status === 'rejected') {
        this.inflight = undefined;
        if (receipt.code !== 'resync-required') {
          this.conflict = receipt.message;
          fail(receipt.code, receipt.message);
        }
      }
      await this.sync();
    }
    fail('resync-required', 'Text contention requires another retry');
  }
  checkpoint() {
    return {
      schema: 1,
      identity: copy(this.adapter.identity),
      confirmed: copy(this.confirmed),
      version: getVersion(this.state),
      steps: sendableSteps(this.state)?.steps.map((s) => s.toJSON()) ?? [],
      inflight: copy(this.inflight ?? null),
    };
  }
  resume(checkpoint: ReturnType<DocumentReplica['checkpoint']>) {
    if (
      checkpoint.schema !== 1 ||
      canonical(checkpoint.identity) !== canonical(this.adapter.identity) ||
      checkpoint.version !== checkpoint.confirmed.engineVersion
    )
      fail('unauthorized', 'Text checkpoint identity/version mismatch');
    this.confirmed = copy(checkpoint.confirmed);
    this.mappingBase = this.confirmed.revision;
    this.maps.clear();
    this.state = this.create(checkpoint.confirmed);
    const tr = this.state.tr;
    for (const json of checkpoint.steps) tr.step(Step.fromJSON(documentSchema, json));
    this.state = this.state.apply(tr);
    this.inflight = checkpoint.inflight ?? undefined;
    this.onChange();
  }
  close() {
    this.stopStatus?.();
    this.adapter.close();
  }
}
