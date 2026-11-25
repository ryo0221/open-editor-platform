import { expect, it } from 'vitest';
import { Authority, initial, type Principal } from '@editor-platform/collaboration-core';
import {
  createDesign,
  makeDesignElement,
  previewDesignIntents,
  prepareDesignIntentApplication,
  updateElement,
  type DesignContent,
} from '@editor-platform/design/model';
import { designEditorCodec, prepareEditorCommand } from './editor-transactions';

const actor = (id: string): Principal => ({
  actorId: id,
  clientId: id,
  sessionId: id,
  writable: true,
  scopes: ['*'],
});
function fixture() {
  const content: DesignContent = {
    ...createDesign(),
    elements: [{ ...makeDesignElement('frame'), id: 'frame' }],
  };
  return new Authority(designEditorCodec, initial('artifact', designEditorCodec, content));
}
it('uses the existing Design wire/authority and preserves peer fields through selective Undo', () => {
  const authority = fixture(),
    A = actor('A'),
    B = actor('B');
  const proposal = previewDesignIntents(authority.snapshot().content, [
    { type: 'insert', elementType: 'text', options: { id: 'heading', parentId: 'frame' } },
    { type: 'update', id: 'frame', patch: { fill: '#ffeeaa' } },
  ]).intentProposal;
  const operation = prepareEditorCommand(
    designEditorCodec,
    authority.snapshot(),
    A,
    prepareDesignIntentApplication(JSON.parse(JSON.stringify(proposal))),
  )!;
  const result = authority.commit(A, JSON.parse(JSON.stringify(operation)));
  expect(result.status).toBe('accepted');
  const peer = prepareEditorCommand(
    designEditorCodec,
    authority.snapshot(),
    B,
    updateElement('frame', { name: 'Peer-owned name' }),
  )!;
  expect(authority.commit(B, peer).status).toBe('accepted');
  expect(authority.undo(A, operation.operationId).status).toBe('accepted');
  expect(authority.snapshot().content.elements).toHaveLength(1);
  expect(authority.snapshot().content.elements[0]).toMatchObject({
    name: 'Peer-owned name',
    fill: '#ffffff',
  });
});
it('rejects revoked and stale proposed changes at the trusted native commit boundary', () => {
  const authority = fixture(),
    A = actor('A'),
    B = actor('B');
  const command = prepareDesignIntentApplication(
    previewDesignIntents(authority.snapshot().content, [
      { type: 'update', id: 'frame', patch: { fill: '#112233' } },
    ]).intentProposal,
  );
  const operation = prepareEditorCommand(designEditorCodec, authority.snapshot(), A, command)!;
  const before = authority.snapshot();
  expect(authority.commit({ ...A, writable: false }, operation).status).toBe('rejected');
  expect(authority.snapshot()).toEqual(before);
  const peer = prepareEditorCommand(
    designEditorCodec,
    authority.snapshot(),
    B,
    updateElement('frame', { name: 'Peer' }),
  )!;
  expect(authority.commit(B, peer).status).toBe('accepted');
  const changed = authority.snapshot();
  expect(authority.commit(A, operation).status).toBe('rejected');
  expect(authority.snapshot()).toEqual(changed);
});
