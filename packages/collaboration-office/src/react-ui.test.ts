import { describe, expect, it } from 'vitest';
import {
  Authority,
  FaultAdapter,
  initial,
  localAdapter,
  operation,
  uid,
  type Principal,
  type Proposal,
} from '@editor-platform/collaboration-core';
import {
  reactUiCommand,
  duplicateReactUiCommand,
  type ReactUiDocument,
} from '@editor-platform/react-ui-core';
import { createReferenceDocument } from '../../../apps/react-ui-reference/src/catalog';
import { immutableCommand, type EditorCommand } from '@editor-platform/editor-core';
import { sealReactComponent, prepareReactUiRevision } from '@editor-platform/react-ui-core';
import { referenceTextRevision } from '../../../apps/react-ui-reference/src/catalog';
import { reactUiEditorCodec } from './react-ui';
import { prepareEditorCommand } from './editor-transactions';
import { SharedEditorSession, type EditorHostAdapter } from './editor-session';
const proposalHost = {
  actorId: 'host',
  clientId: 'host',
  sessionId: 'host',
  writable: true,
  scopes: ['*'],
};
const A: Principal = {
  actorId: 'A',
  sessionId: 'A-session',
  clientId: 'A-client',
  writable: true,
  scopes: ['*'],
};
const B: Principal = {
  actorId: 'B',
  sessionId: 'B-session',
  clientId: 'B-client',
  writable: true,
  scopes: ['*'],
};
const prop = (id: string, name: string, value: string) =>
  reactUiCommand([{ type: 'set-prop', nodeId: id, prop: name, value }]);
const harness = () => {
  const authority = new Authority(
    reactUiEditorCodec,
    initial('react-artifact', reactUiEditorCodec, createReferenceDocument()),
  );
  return {
    authority,
    prepare(command: EditorCommand<ReactUiDocument>, principal = A) {
      return prepareEditorCommand(reactUiEditorCodec, authority.snapshot(), principal, command)!;
    },
    commit(command: EditorCommand<ReactUiDocument>, principal = A) {
      const op = this.prepare(command, principal);
      expect(authority.commit(principal, op)).toMatchObject({ status: 'accepted' });
      return op;
    },
  };
};
describe('React UI uses the existing authority and actor/session selective history', () => {
  it('preserves independent props on the same node and Undo/Redo keeps peer changes', () => {
    const h = harness(),
      a = h.prepare(prop('buy', 'label', 'A label')),
      b = h.prepare(prop('buy', 'variant', 'secondary'), B);
    expect(h.authority.commit(A, a)).toMatchObject({ status: 'accepted' });
    expect(h.authority.commit(B, b)).toMatchObject({ status: 'accepted' });
    const undo = h.authority.undo(A, a.operationId);
    expect(undo.status).toBe('accepted');
    expect(h.authority.snapshot().content.nodes.find((n) => n.id === 'buy')!.props).toEqual({
      label: 'Add to cart',
      variant: 'secondary',
    });
    expect(h.authority.undo(A, undo.operationId, true)).toMatchObject({ status: 'accepted' });
    expect(h.authority.snapshot().content.nodes.find((n) => n.id === 'buy')!.props).toEqual({
      label: 'A label',
      variant: 'secondary',
    });
    expect(h.authority.undo(B, a.operationId)).toMatchObject({ code: 'unauthorized' });
  });
  it('detects same prop, same slot, deletion/edit and movement/deletion conflicts without partial changes', () => {
    const h = harness(),
      a = h.prepare(prop('buy', 'label', 'A')),
      b = h.prepare(prop('buy', 'label', 'B'), B);
    h.authority.commit(A, a);
    expect(h.authority.commit(B, b)).toMatchObject({ code: 'stale-precondition' });
    const edit = h.prepare(prop('title', 'text', 'Peer text'), B),
      remove = h.prepare(reactUiCommand([{ type: 'delete', nodeId: 'title' }]));
    h.authority.commit(B, edit);
    const before = h.authority.snapshot();
    expect(h.authority.commit(A, remove)).toMatchObject({ code: 'stale-precondition' });
    expect(h.authority.snapshot()).toEqual(before);
    const move = h.prepare(
      reactUiCommand([
        {
          type: 'move',
          nodeId: 'title',
          parent: { nodeId: 'card', slotId: 'footer' },
          beforeId: null,
        },
      ]),
    );
    const erase = h.prepare(reactUiCommand([{ type: 'delete', nodeId: 'title' }]), B);
    h.authority.commit(B, erase);
    expect(h.authority.commit(A, move).status).toBe('rejected');
    const h2 = harness(),
      first = h2.prepare(
        reactUiCommand([
          {
            type: 'move',
            nodeId: 'buy',
            parent: { nodeId: 'card', slotId: 'body' },
            beforeId: 'image',
          },
        ]),
      );
    const second = h2.prepare(
      reactUiCommand([
        {
          type: 'move',
          nodeId: 'title',
          parent: { nodeId: 'card', slotId: 'body' },
          beforeId: 'image',
        },
      ]),
      B,
    );
    h2.authority.commit(A, first);
    expect(h2.authority.commit(B, second)).toMatchObject({ code: 'stale-precondition' });
  });
  it('round trips structure and responsive overrides atomically, blocking Undo of inserted nodes edited by a peer', () => {
    const h = harness(),
      before = h.authority.snapshot().content;
    const copy = h.commit(duplicateReactUiCommand(before, 'card'));
    const inserted = h.authority.snapshot().content.roots[1];
    expect(h.authority.undo(A, copy.operationId)).toMatchObject({ status: 'accepted' });
    expect(h.authority.snapshot().content).toEqual(before);
    const redone = h.authority.undo(
      A,
      h.authority.changes(0).events.at(-1)!.operation.operationId,
      true,
    );
    expect(redone.status).toBe('accepted');
    const child = h.authority
      .snapshot()
      .content.nodes.find(
        (n) => !before.nodes.some((old) => old.id === n.id) && n.component.componentId === 'Text',
      )!;
    h.commit(prop(child.id, 'text', 'Peer retained'), B);
    expect(h.authority.undo(A, redone.operationId)).toMatchObject({ code: 'undo-conflict' });
    expect(h.authority.snapshot().content.roots).toContain(inserted);
    const baseline = h.authority.snapshot().content;
    const layout = h.commit(
      reactUiCommand([
        {
          type: 'set-layout',
          nodeId: 'card',
          breakpoint: 'wide',
          style: { display: { kind: 'literal', value: 'flex' } },
        },
      ]),
    );
    expect(h.authority.undo(A, layout.operationId)).toMatchObject({ status: 'accepted' });
    expect(h.authority.snapshot().content).toEqual(baseline);
  });
  it('rejects forged scope, invalid type, rewritten registration identity and missing preconditions at commit', () => {
    const h = harness(),
      op = h.prepare(prop('buy', 'label', 'A'));
    expect(h.authority.commit({ ...A, writable: false }, op)).toMatchObject({
      code: 'unauthorized',
    });
    expect(h.authority.commit({ ...A, scopes: ['title'] }, op)).toMatchObject({
      code: 'unauthorized',
    });
    expect(h.authority.commit(A, { ...op, operationId: uid(), conditions: [] }).status).toBe(
      'rejected',
    );
    const before = h.authority.snapshot();
    expect(() =>
      operation(reactUiEditorCodec, before, A, [
        {
          type: 'react-ui.patch',
          target: '*',
          payload: {
            changes: [{ path: ['prop', 'buy', 'variant'], value: 'invalid', present: true }],
            reads: [],
          },
        },
      ]),
    ).toThrow();
    expect(h.authority.snapshot()).toEqual(before);
    const old = before.content.components.find((c) => c.name === 'Button')!;
    const changed = sealReactComponent({
      ...old,
      name: 'Rewritten',
      ref: {
        registryId: old.ref.registryId,
        componentId: old.ref.componentId,
        version: old.ref.version,
        implementationHash: old.ref.implementationHash,
      },
    });
    expect(() =>
      h.prepare(
        immutableCommand<ReactUiDocument>('rewrite', 'Rewrite pin', (content) => ({
          ...content,
          components: content.components.map((c) =>
            c === old || c.ref.componentId === 'Button' ? changed : c,
          ),
          nodes: content.nodes.map((node) =>
            node.component.componentId === 'Button' ? { ...node, component: changed.ref } : node,
          ),
        })),
      ),
    ).toThrow(/immutable/);
  });
  it('retains independent layout properties and rejects stale mapped revision when a peer changes the reviewed node', () => {
    const h = harness();
    const first = h.prepare(
      reactUiCommand([
        {
          type: 'set-layout',
          nodeId: 'card',
          breakpoint: 'desktop',
          style: {
            ...h.authority.snapshot().content.nodes[0].layout.breakpoints.desktop,
            gap: { kind: 'literal', value: 20 },
          },
        },
      ]),
    );
    const second = h.prepare(
      reactUiCommand([
        {
          type: 'set-layout',
          nodeId: 'card',
          breakpoint: 'desktop',
          style: {
            ...h.authority.snapshot().content.nodes[0].layout.breakpoints.desktop,
            padding: { kind: 'literal', value: 24 },
          },
        },
      ]),
      B,
    );
    h.authority.commit(A, first);
    expect(h.authority.commit(B, second)).toMatchObject({ status: 'accepted' });
    expect(h.authority.undo(A, first.operationId)).toMatchObject({ status: 'accepted' });
    expect(h.authority.snapshot().content.nodes[0].layout.breakpoints.desktop.padding).toEqual({
      kind: 'literal',
      value: 24,
    });
    const candidate = prepareReactUiRevision(h.authority.snapshot().content, {
      component: referenceTextRevision,
      nodeIds: ['title'],
      propMap: { text: 'content' },
      slotMap: {},
    });
    const adoption = h.prepare(candidate.command);
    h.commit(prop('title', 'text', 'Peer update'), B);
    expect(h.authority.commit(A, adoption)).toMatchObject({ code: 'stale-precondition' });
  });
  it('uses revision/stamp checks for stale proposal and ABA instead of auto-applying it', () => {
    const h = harness(),
      prepared = h.prepare(prop('buy', 'label', 'Proposal'));
    const proposal: Proposal = {
      schema: 1,
      id: uid(),
      artifactId: 'react-artifact',
      sourceActorId: 'C',
      baseRevision: 0,
      summary: 'Candidate',
      actions: prepared.actions,
      reads: prepared.conditions,
      writes: prepared.conditions,
      external: [],
    };
    h.authority.register({ ...proposalHost, actorId: proposal.sourceActorId }, proposal);
    const preview = h.authority.preview(A, proposal.id);
    const peer = h.commit(prop('buy', 'label', 'Peer'), B);
    h.authority.undo(B, peer.operationId);
    expect(h.authority.applyProposal(A, proposal.id, preview.token)).toMatchObject({
      code: 'stale-precondition',
    });
    expect(h.authority.snapshot().content.nodes.find((n) => n.id === 'buy')!.props.label).toBe(
      'Add to cart',
    );
  });
  it('retains offline intent/checkpoints and replays a lost acknowledgement exactly once through SharedEditorSession', async () => {
    const h = harness(),
      base = localAdapter(h.authority, { ...A });
    const faults = new FaultAdapter(base);
    const host = Object.assign(faults, {
      undo: async (id: string, redo = false) => h.authority.undo(A, id, redo),
      versions: async () => [],
      save: async () => {
        throw new Error('Unused');
      },
      restore: async () => {
        throw new Error('Unused');
      },
      registerProposal: async (p: Proposal) =>
        h.authority.register({ ...proposalHost, actorId: p.sourceActorId }, p),
      previewProposal: async (id: string) => h.authority.preview(A, id),
      applyProposal: async (id: string, token: string) => h.authority.applyProposal(A, id, token),
      cancelProposal: async (id: string) => h.authority.cancelProposal(proposalHost, id),
    }) as EditorHostAdapter<ReactUiDocument>;
    const session = new SharedEditorSession(reactUiEditorCodec, host);
    await session.open();
    faults.connected = false;
    session.execute(prop('buy', 'label', 'Offline'));
    await session.flush();
    const checkpoint = session.checkpoint();
    expect(checkpoint.queue.length).toBe(1);
    faults.connected = true;
    faults.dropAck = true;
    await session.reconnect();
    expect(session.pendingCount).toBe(1);
    expect(h.authority.snapshot().revision).toBe(1);
    await session.reconnect();
    expect(session.pendingCount).toBe(0);
    expect(h.authority.snapshot().revision).toBe(1);
    await session.history('undo');
    expect(h.authority.snapshot().content.nodes.find((n) => n.id === 'buy')!.props.label).toBe(
      'Add to cart',
    );
    session.close();
  });
});
