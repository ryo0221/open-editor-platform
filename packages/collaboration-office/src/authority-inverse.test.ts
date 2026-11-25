import { expect, it } from 'vitest';
import * as publicCore from '@editor-platform/collaboration-core';
import {
  Authority,
  initial,
  type Operation,
  type Principal,
} from '@editor-platform/collaboration-core';
import { addRow, createData, setCell } from '@editor-platform/structured-data';
import { dataEditorCodec, prepareEditorCommand } from './editor-transactions';

function fixture() {
  const content = addRow().apply(addRow().apply(createData()));
  const codec = { ...dataEditorCodec };
  class TestAuthority extends Authority<typeof content> {
    beforeCommit?: (op: Operation) => void;
    override commit(principal: Principal, input: unknown) {
      const intercept = this.beforeCommit;
      this.beforeCommit = undefined;
      if (intercept) intercept(input as Operation);
      return super.commit(principal, input);
    }
  }
  const authority = new TestAuthority(codec, initial('inverse', codec, content));
  const actor: Principal = {
    actorId: 'a',
    clientId: 'a',
    sessionId: 'a',
    writable: true,
    scopes: ['*'],
  };
  const peer: Principal = {
    actorId: 'b',
    clientId: 'b',
    sessionId: 'b',
    writable: true,
    scopes: ['*'],
  };
  const field = content.columns[2].id;
  const op = prepareEditorCommand(
    codec,
    authority.snapshot(),
    actor,
    setCell(content.rows[0].id, field, 12),
  )!;
  expect(authority.submit(actor, op).status).toBe('accepted');
  return { authority, codec, content, actor, peer, field, op };
}

it('keeps internal evaluations private and checks current permission before inverse commit', () => {
  expect('evaluatedOperation' in publicCore).toBe(false);
  const { authority, actor, op } = fixture();
  const before = authority.snapshot();
  authority.beforeCommit = () => {
    actor.writable = false;
  };
  expect(authority.undo(actor, op.operationId)).toMatchObject({
    status: 'rejected',
    code: 'unauthorized',
  });
  expect(authority.snapshot()).toEqual(before);
  actor.writable = true;
  expect(authority.undo(actor, op.operationId).status).toBe('accepted');
});

it('re-evaluates an inverse after a reentrant independent commit and preserves the peer edit', () => {
  const { authority, codec, content, actor, peer, field, op } = fixture();
  authority.beforeCommit = () => {
    const edit = prepareEditorCommand(
      codec,
      authority.snapshot(),
      peer,
      setCell(content.rows[1].id, field, 90),
    )!;
    expect(authority.submit(peer, edit).status).toBe('accepted');
  };
  const undo = authority.undo(actor, op.operationId);
  expect(undo.status).toBe('accepted');
  expect(authority.snapshot().content.rows.map((r) => r.values[field])).toEqual([1, 90]);
  expect(authority.undo(actor, op.operationId)).toEqual(undo);
  expect(authority.undo(actor, undo.operationId, true).status).toBe('accepted');
  expect(authority.snapshot().content.rows.map((r) => r.values[field])).toEqual([12, 90]);
});

it('honors a replaced codec at inverse submission instead of reusing an earlier result', () => {
  const { authority, codec, actor, op } = fixture();
  const before = authority.snapshot(),
    apply = codec.applyReadonly;
  authority.beforeCommit = () => {
    codec.applyReadonly = () => {
      throw Error('Updated codec refuses this inverse');
    };
  };
  expect(authority.undo(actor, op.operationId).status).toBe('rejected');
  expect(authority.snapshot()).toEqual(before);
  codec.applyReadonly = apply;
  expect(authority.undo(actor, op.operationId).status).toBe('accepted');
});

it('checks changed inverse wire actions before committing the private projection', () => {
  const { authority, actor, op } = fixture();
  const before = authority.snapshot();
  authority.beforeCommit = (inverse) => {
    inverse.actions[0] = { type: 'unknown.action', target: inverse.actions[0].target, payload: {} };
  };
  expect(authority.undo(actor, op.operationId).status).toBe('rejected');
  expect(authority.snapshot()).toEqual(before);
  expect(authority.undo(actor, op.operationId).status).toBe('accepted');
});
