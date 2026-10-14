import { expect, it } from 'vitest';
import { clone } from '@editor-platform/artifact-core';
import { Authority, initial, operation } from '@editor-platform/collaboration-core';
import { contentToNode } from '@editor-platform/document/engine';
import type { DocumentContent } from '@editor-platform/document/model';
import { Transform } from 'prosemirror-transform';
import { authorReusableComponent } from './reuse-definition';
import { createReusableVersion } from './reuse-catalog';
import { prepareComponentInsertion } from './reuse-apply';
import { applyLocalTemplate, localTemplateSnapshot, templateCodec } from './apply';
import { prepareComponentBatch, applyComponentBatch } from './reuse-batch';

const identity = { actorId: 'A', clientId: 'a', sessionId: 'a' };
const principal = { ...identity, writable: true, scopes: ['*'] };
const empty: DocumentContent = {
  schemaVersion: 2,
  blocks: [{ id: 'outside', type: 'paragraph', text: '案件' }],
};
async function fixture() {
  const source = await authorReusableComponent({
    name: '注意書き',
    domain: 'document',
    ids: [],
    content: {
      schemaVersion: 2,
      blocks: [
        { id: 'notice', type: 'paragraph', text: '維持する本文', style: { color: '#112233' } },
      ],
    },
  });
  const payload = clone(source.definition.payload);
  (payload.template.content as DocumentContent).blocks[0].style!.color = '#336699';
  const revised = await createReusableVersion(source.definition, { payload });
  const content = applyLocalTemplate(
    await prepareComponentInsertion({
      ...source,
      state: localTemplateSnapshot('base', 'document', empty),
      identity,
      reuse: 'linked',
      requestId: 'insert',
    }),
    empty,
  ) as DocumentContent;
  return { source, revised, content };
}

it('reports partial failures independently, retries the same receipt, and preserves peer text with per-artifact Undo', async () => {
  const { revised, content } = await fixture();
  const codec = templateCodec('document');
  const authorities = ['A', 'B', 'C', 'pinned'].map(
    (id) => new Authority(codec, initial(id, codec, content)),
  );
  const original = clone(content);
  const batch = await prepareComponentBatch({
    requestId: 'rollout',
    ...revised,
    targets: authorities.map((authority, index) => ({
      name: ['A', 'B', 'C', 'pinned'][index],
      identity,
      state: authority.snapshot(),
      selections: [
        { instanceId: content.reuse!.instances[0].id, choice: index === 3 ? 'pin' : 'adopt' },
      ],
    })),
  });
  expect(batch.results.map((r) => r.status)).toEqual([
    'prepared',
    'prepared',
    'prepared',
    'unchanged',
  ]);
  const tokens = new Map<string, string>();
  for (const [index, result] of batch.results.entries())
    if (result.prepared) {
      authorities[index].register(result.prepared.proposal);
      tokens.set(
        result.artifactId,
        authorities[index].preview(principal, result.prepared.id).token,
      );
    }
  // Another actor edits inside the same paragraph after the reviewed diff.
  const peer = { actorId: 'B', sessionId: 'b', clientId: 'b', writable: true, scopes: ['*'] };
  const state = authorities[0].snapshot();
  const tr = new Transform(contentToNode(state.content as DocumentContent));
  tr.insert(tr.doc.child(0).nodeSize + 1, tr.doc.type.schema.text('日本語の追記'));
  expect(
    authorities[0].submit(
      peer,
      operation(codec, state, peer, [
        {
          type: 'document.steps',
          target: 'text',
          payload: { version: state.engineVersion, steps: tr.steps.map((s) => s.toJSON()) },
        },
      ]),
    ).status,
  ).toBe('accepted');
  // B's relevant attribute changes; C loses permission; A's receipt is lost once.
  const address = Object.values(content.reuse!.instances[0].parts)[0];
  expect(
    authorities[1].submit(
      peer,
      operation(codec, authorities[1].snapshot(), peer, [
        {
          type: 'document.attributes',
          target: 'text',
          payload: { patches: [{ id: address, values: { style: { color: '#cc0000' } } }] },
        },
      ]),
    ).status,
  ).toBe('accepted');
  let writable = false,
    lost = false;
  const calls: string[] = [];
  const apply = async (prepared: NonNullable<(typeof batch.results)[number]['prepared']>) => {
    const index = ['A', 'B', 'C'].indexOf(prepared.proposal.artifactId);
    calls.push(prepared.id);
    const authority = authorities[index];
    const receipt = authority.applyProposal(
      index === 2 ? { ...principal, writable } : principal,
      prepared.id,
      tokens.get(prepared.proposal.artifactId)!,
    );
    if (receipt.status === 'rejected') throw new Error(receipt.message);
    if (index === 0 && !lost) {
      lost = true;
      throw new Error('Response lost');
    }
  };
  const first = await applyComponentBatch(batch, apply);
  expect(first.results.map((r) => r.status)).toEqual(['failed', 'failed', 'failed', 'unchanged']);
  expect((authorities[0].snapshot().content as DocumentContent).blocks[1].style!.color).toBe(
    '#336699',
  );
  expect(authorities[0].snapshot().revision).toBe(2);
  writable = true;
  tokens.set('C', authorities[2].preview(principal, batch.results[2].prepared!.id).token);
  const retry = await applyComponentBatch(first, apply);
  expect(retry.results.map((r) => r.status)).toEqual(['applied', 'failed', 'applied', 'unchanged']);
  expect(authorities[0].snapshot().revision).toBe(2);
  expect(authorities[2].snapshot().revision).toBe(1);
  expect(authorities[3].snapshot().content).toEqual(original);
  const repeated = await applyComponentBatch(retry, apply);
  expect(repeated.results.map((r) => r.status)).toEqual(retry.results.map((r) => r.status));
  expect(calls.filter((id) => id === batch.results[0].prepared!.id)).toHaveLength(2);
  expect(calls.filter((id) => id === batch.results[2].prepared!.id)).toHaveLength(2);
  expect(authorities[0].undo(principal, `proposal:${batch.results[0].prepared!.id}`).status).toBe(
    'accepted',
  );
  const undone = authorities[0].snapshot().content as DocumentContent;
  expect(undone.blocks[1].text).toBe('日本語の追記維持する本文');
  expect(undone.blocks[1].style!.color).toBe('#112233');
  expect((authorities[2].snapshot().content as DocumentContent).blocks[1].style!.color).toBe(
    '#336699',
  );
});

it('owns all target snapshots before awaiting, reports malformed targets, and rejects duplicate artifact identities', async () => {
  const { revised, content } = await fixture();
  const targets = ['valid', 'missing'].map((id) => ({
    name: id,
    identity,
    state: localTemplateSnapshot(id, 'document', content),
    selections: [
      {
        instanceId: id === 'missing' ? 'missing' : content.reuse!.instances[0].id,
        choice: 'adopt' as const,
      },
    ],
  }));
  const pending = prepareComponentBatch({ requestId: 'owned', ...revised, targets });
  targets[0].selections[0].instanceId = 'mutated';
  const batch = await pending;
  expect(batch.results.map((r) => r.status)).toEqual(['prepared', 'failed']);
  expect(batch.results[1].error).toMatch(/missing/i);
  await expect(
    prepareComponentBatch({
      requestId: 'duplicate',
      ...revised,
      targets: [targets[0], targets[0]],
    }),
  ).rejects.toThrow(/unique/);
});

it('already adopted exact versions do not add another operation or Undo entry', async () => {
  const { source, content } = await fixture();
  const batch = await prepareComponentBatch({
    requestId: 'unchanged',
    ...source,
    targets: [
      {
        name: 'Current',
        identity,
        state: localTemplateSnapshot('current', 'document', content),
        selections: [{ instanceId: content.reuse!.instances[0].id, choice: 'adopt' }],
      },
    ],
  });
  expect(batch.results[0].status).toBe('unchanged');
  const result = await applyComponentBatch(batch, async () => {
    throw new Error('Should not submit');
  });
  expect(result).toEqual(batch);
});
