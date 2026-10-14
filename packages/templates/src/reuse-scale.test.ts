import { expect, it } from 'vitest';
import { clone } from '@editor-platform/artifact-core';
import { Authority, initial, operation } from '@editor-platform/collaboration-core';
import {
  documentAttributePatchLimit,
  documentAttributeTransform,
} from '@editor-platform/document/engine';
import { type DocumentContent } from '@editor-platform/document/model';
import { authorReusableComponent } from './reuse-definition';
import { prepareComponentInsertion, reusableNativeActions } from './reuse-apply';
import { templateCodec } from './apply';

const actor = { actorId: 'A', clientId: 'a', sessionId: 'a', writable: true, scopes: ['*'] };
const peer = { ...actor, actorId: 'B', clientId: 'b', sessionId: 'b' };

it('chunks 1000 Document attributes in one operation and preserves peer text through Undo/Redo', () => {
  const before: DocumentContent = {
    schemaVersion: 2,
    blocks: Array.from({ length: 1000 }, (_, index) => ({
      id: `block-${index}`,
      type: 'paragraph',
      text: '既存の本文',
    })),
  };
  const codec = templateCodec('document');
  const authority = new Authority(codec, initial('scale', codec, before));
  const next = clone(before);
  next.blocks.forEach((block) => {
    block.style = { color: '#336699' };
  });
  const actions = reusableNativeActions(authority.snapshot(), actor, next);
  expect(actions).toHaveLength(2);
  expect(
    actions.every((a) => (a.payload.patches as unknown[]).length <= documentAttributePatchLimit),
  ).toBe(true);
  expect(() =>
    documentAttributeTransform(
      before,
      next.blocks.map((b) => ({ id: b.id, values: { style: b.style } })),
    ),
  ).toThrow(/patch count/);
  const applied = authority.commit(actor, operation(codec, authority.snapshot(), actor, actions));
  expect(applied.status).toBe('accepted');
  const edited = clone(authority.snapshot().content) as DocumentContent;
  edited.blocks[700].text += ' 別の人の追記';
  edited.blocks[700].rich = [{ text: edited.blocks[700].text }];
  expect(
    authority.commit(
      peer,
      operation(
        codec,
        authority.snapshot(),
        peer,
        reusableNativeActions(authority.snapshot(), peer, edited),
      ),
    ).status,
  ).toBe('accepted');
  const undone = authority.undo(actor, applied.operationId);
  expect(undone.status).toBe('accepted');
  const result = authority.snapshot().content as DocumentContent;
  expect(result.blocks.every((b) => b.style === undefined)).toBe(true);
  expect(result.blocks[700].text).toBe(edited.blocks[700].text);
  expect(authority.undo(actor, undone.operationId, true).status).toBe('accepted');
  expect(
    (authority.snapshot().content as DocumentContent).blocks.every(
      (b) => b.style?.color === '#336699',
    ),
  ).toBe(true);
});

it('sends identical adjacent closures once, retains complete inverses, and rejects same-hash tampering', async () => {
  const codec = templateCodec('document');
  const before: DocumentContent = {
    schemaVersion: 2,
    blocks: [{ id: 'outside', type: 'paragraph', text: '本文' }],
  };
  const value = await authorReusableComponent({
    domain: 'document',
    content: before,
    ids: [],
    name: '本文の部品',
  });
  const authority = new Authority(codec, initial('closures', codec, before));
  for (let i = 0; i < 3; i++) {
    const prepared = await prepareComponentInsertion({
      ...value,
      state: authority.snapshot(),
      identity: actor,
      reuse: 'linked',
      requestId: `closure-${i}`,
    });
    expect(authority.commit(actor, prepared.operation).status).toBe('accepted');
  }
  const state = authority.snapshot();
  const reuse = (state.content as DocumentContent).reuse!;
  const actions = reuse.instances.map((instance) => ({
    type: 'reuse.instance',
    target: instance.id,
    payload: { value: instance, closure: reuse.closures[0] },
  }));
  const prepared = operation(codec, state, actor, actions);
  expect(prepared.actions.filter((a) => a.payload.closure)).toHaveLength(1);
  const applied = authority.commit(actor, prepared);
  expect(applied.status).toBe('accepted');
  expect(authority.undo(actor, applied.operationId).status).toBe('accepted');
  const current = authority.snapshot();
  const proposalOperation = operation(codec, current, actor, actions);
  authority.register({
    schema: 1,
    id: 'uncompacted-proposal',
    artifactId: current.artifactId,
    sourceActorId: actor.actorId,
    baseRevision: current.revision,
    summary: '同じ定義の一括更新',
    actions,
    reads: proposalOperation.conditions,
    writes: proposalOperation.conditions,
    external: [],
  });
  const preview = authority.preview(actor, 'uncompacted-proposal');
  expect(authority.applyProposal(actor, 'uncompacted-proposal', preview.token).status).toBe(
    'accepted',
  );
  const tampered = clone(actions);
  tampered[1].payload.closure.definitions[0].name = 'hashを変えずに差し替え';
  expect(() => operation(codec, state, actor, tampered)).toThrow(/hash/);
  const withRemoval = operation(codec, state, actor, [
    actions[0],
    { type: 'reuse.instance', target: actions[0].target, payload: { value: null } },
    actions[1],
  ]);
  expect(withRemoval.actions.filter((a) => a.payload.closure)).toHaveLength(2);
});
