import { describe, expect, it } from 'vitest';
import {
  Authority,
  initial,
  operation,
  proposal,
  type ExternalCheck,
  type Principal,
  type Receipt,
} from '@editor-platform/collaboration-core';
import type { CurrentRead } from '@editor-platform/artifact-core';
import { setField, slideCodec } from './canvas';
import { person, slideFixture } from './fixtures';

const A = person('A'),
  B = person('B'),
  C = person('C');
function setup(now = () => 1000, externalCheck?: ExternalCheck) {
  return new Authority(
    slideCodec,
    initial('authz', slideCodec, slideFixture()),
    now,
    externalCheck,
  );
}
function code(receipt: Receipt) {
  return receipt.status === 'rejected' ? receipt.code : receipt.status;
}
function agentProposal(authority: Authority<ReturnType<typeof slideFixture>>) {
  const p = proposal(authority, 'C', [setField('shape2', 'fill', '#aabbcc')], null, 'Agent fill');
  authority.register(C, p);
  return p;
}
const fill = (authority: Authority<ReturnType<typeof slideFixture>>, id: string) =>
  authority.snapshot().content.slides[0].objects.find((o) => o.id === id)?.fill;

describe('proposal cancel/reject authorization', () => {
  it('lets the source actor withdraw but requires target write access to reject or cancel others', () => {
    const authority = setup(),
      p = agentProposal(authority);
    const readOnly: Principal = { ...B, writable: false };
    const outOfScope: Principal = { ...B, scopes: ['shape1'] };
    const expired: Principal = { ...B, expiresAt: 10 };
    for (const [who, reject] of [
      [readOnly, false],
      [readOnly, true],
      [outOfScope, true],
      [expired, true],
      [{ ...C, writable: false }, true],
    ] as const)
      expect(() => authority.cancelProposal(who, p.id, reject)).toThrow(
        expect.objectContaining({ code: 'unauthorized' }),
      );
    expect(authority.proposal(p.id)?.state).toBe('ready');
    expect(authority.cancelProposal({ ...B, scopes: ['shape2'] }, p.id, true)?.state).toBe(
      'rejected',
    );
    // The source cannot rewrite a reviewer's rejection into a withdrawal.
    expect(authority.cancelProposal(C, p.id)?.state).toBe('rejected');
    expect(authority.proposal(p.id)?.state).toBe('rejected');
    const own = agentProposal(authority);
    expect(authority.cancelProposal({ ...C, writable: false }, own.id)?.state).toBe('cancelled');
    expect(authority.cancelProposal(B, own.id, true)?.state).toBe('cancelled');
    expect(authority.cancelProposal(A, 'missing')).toBeUndefined();
  });
  it('requires whole-artifact scope when a stale proposal can no longer be evaluated', () => {
    const authority = setup(),
      p = agentProposal(authority);
    expect(
      code(
        authority.commit(
          A,
          operation(slideCodec, authority.snapshot(), A, [
            { type: 'canvas.delete', target: 'shape2', payload: {} },
          ]),
        ),
      ),
    ).toBe('accepted');
    expect(() => authority.cancelProposal({ ...B, scopes: ['shape2'] }, p.id, true)).toThrow(
      'write access',
    );
    expect(authority.cancelProposal(B, p.id, true)?.state).toBe('rejected');
  });
  it('binds registration to the authenticated, unexpired source actor', () => {
    const authority = setup(),
      p = proposal(authority, 'C', [setField('shape2', 'fill', '#aabbcc')], null, 'Agent fill');
    expect(() => authority.register(A, p)).toThrow('authenticated actor');
    expect(() => authority.register({ ...C, expiresAt: 5 }, p)).toThrow('authenticated actor');
    expect(authority.proposal(p.id)).toBeUndefined();
    expect(authority.register(C, p).state).toBe('ready');
  });
});

describe('submitted operation provenance', () => {
  it('rejects agent, restore and source-actor spoofing from ordinary connections', () => {
    const authority = setup(),
      base = authority.snapshot();
    const agent = operation(slideCodec, base, A, [setField('shape1', 'fill', '#111111')], 'agent');
    expect(authority.commit(A, agent)).toMatchObject({ status: 'rejected', code: 'unauthorized' });
    const restoreOrigin = operation(
      slideCodec,
      base,
      A,
      [setField('shape1', 'fill', '#222222')],
      'restore',
    );
    expect(code(authority.commit(A, restoreOrigin))).toBe('protocol-error');
    const sourced = {
      ...operation(slideCodec, base, A, [setField('shape1', 'fill', '#333333')]),
      sourceActorId: 'C',
    };
    expect(code(authority.commit(A, sourced))).toBe('unauthorized');
    expect(authority.snapshot()).toEqual(base);
    // A Host may grant an agent connection its declared origin explicitly.
    expect(code(authority.commit({ ...A, origins: ['agent'] }, agent))).toBe('accepted');
    expect(authority.changes(0).events.at(-1)?.operation.origin).toBe('agent');
  });
  it('keeps whole-content restore behind the restore API and its revision review', () => {
    const authority = setup(),
      base = authority.snapshot();
    expect(
      code(
        authority.commit(
          A,
          operation(slideCodec, base, A, [setField('shape1', 'fill', '#444444')]),
        ),
      ),
    ).toBe('accepted');
    const bypass = operation(
      slideCodec,
      authority.snapshot(),
      B,
      [{ type: 'domain.restore', target: '*', payload: { content: base.content } }],
      'human',
    );
    expect(authority.commit(B, bypass)).toMatchObject({ status: 'rejected', code: 'unauthorized' });
    expect(fill(authority, 'shape1')).toBe('#444444');
    expect(code(authority.restore(B, base.content, 0))).toBe('stale-precondition');
    const restored = authority.restore(B, base.content, 1);
    expect(code(restored)).toBe('accepted');
    expect(authority.snapshot().content).toEqual(base.content);
    // The restore's own inverse remains available through the authority Undo API.
    expect(code(authority.undo(B, restored.operationId))).toBe('accepted');
    expect(fill(authority, 'shape1')).toBe('#444444');
  });
  it('keeps human and locally reviewed proposal labels available by default', () => {
    const authority = setup();
    const labelled = operation(
      slideCodec,
      authority.snapshot(),
      A,
      [setField('shape1', 'fill', '#555555')],
      'proposal',
    );
    expect(code(authority.commit(A, labelled))).toBe('accepted');
  });
});

describe('reserved proposal operation IDs', () => {
  it('cannot be pre-claimed by a client, so the proposal stays applicable', () => {
    const authority = setup(),
      p = agentProposal(authority);
    const squat = {
      ...operation(slideCodec, authority.snapshot(), B, [setField('shape1', 'fill', '#666666')]),
      operationId: `proposal:${p.id}`,
    };
    expect(code(authority.commit(B, squat))).toBe('protocol-error');
    expect(authority.receipt(`proposal:${p.id}`)).toBeUndefined();
    const forged = {
      ...operation(slideCodec, authority.snapshot(), B, p.actions, 'proposal'),
      operationId: `proposal:${p.id}`,
      proposalId: p.id,
      sourceActorId: 'C',
    };
    expect(code(authority.commit(B, forged))).toBe('protocol-error');
    const preview = authority.preview(A, p.id);
    const receipt = authority.applyProposal(A, p.id, preview.token);
    expect(receipt).toMatchObject({ status: 'accepted', operationId: `proposal:${p.id}` });
    const event = authority.changes(0).events.at(-1)!;
    expect(event.operation).toMatchObject({ origin: 'proposal', sourceActorId: 'C', actorId: 'A' });
    expect(fill(authority, 'shape2')).toBe('#aabbcc');
    // A late cancel reports the applied state even without review permission.
    for (const who of [
      { ...B, writable: false },
      { ...B, expiresAt: 10 },
    ])
      expect(authority.cancelProposal(who, p.id, true)?.state).toBe('applied');
  });
});

describe('backup restoration', () => {
  it('keeps the injected clock and external dependency check', () => {
    let external = true;
    const authority = setup(
        () => 1000,
        () => external,
      ),
      p = proposal(authority, 'C', [setField('shape2', 'fill', '#aabbcc')], null, 'Agent fill');
    authority.register(C, { ...p, external: [{ reference: 'source', version: 'v1' }] });
    const restored = Authority.fromBackup(
      slideCodec,
      authority.backup(),
      () => 2000,
      () => external,
    );
    expect(() =>
      restored.presence({ ...A, expiresAt: 1500 }, { name: 'A', color: '#000000' }),
    ).toThrow('expired');
    expect(restored.preview(A, p.id).token).toBeTruthy();
    external = false;
    expect(() => restored.preview(A, p.id)).toThrow('External read dependency changed');
  });
});

describe('external read versions (Issue #402)', () => {
  it('keeps the reason and the changed reference on a stale proposal, and changes nothing', () => {
    // Host-attested current versions, asked synchronously at each preview and apply.
    const current = new Map<string, CurrentRead>([
      ['calendar', { status: 'available', versionId: 'cal-v1' }],
      ['data', { status: 'available', versionId: 'data-v1' }],
    ]);
    const authority = setup(
        () => 1000,
        (reference) => current.get(reference) ?? { status: 'missing' },
      ),
      p = proposal(authority, 'C', [setField('shape2', 'fill', '#aabbcc')], null, 'Agent fill');
    authority.register(C, {
      ...p,
      external: [
        { reference: 'calendar', version: 'cal-v1' },
        { reference: 'data', version: 'data-v1' },
      ],
    });
    const before = fill(authority, 'shape2');
    const preview = authority.preview(A, p.id);
    // Another person changes the referenced Calendar between review and apply.
    current.set('calendar', { status: 'available', versionId: 'cal-v2' });
    current.set('data', { status: 'forbidden' });
    const receipt = authority.applyProposal(A, p.id, preview.token);
    expect(receipt).toMatchObject({
      status: 'rejected',
      code: 'stale-precondition',
      keys: ['external:calendar', 'external:data'],
    });
    const state = authority.proposal(p.id)!;
    expect(state.state).toBe('conflicted');
    expect(state.stale).toEqual([
      {
        artifactId: 'calendar',
        role: 'reference',
        expectedVersionId: 'cal-v1',
        reason: 'version-changed',
        currentVersionId: 'cal-v2',
      },
      { artifactId: 'data', role: 'reference', expectedVersionId: 'data-v1', reason: 'forbidden' },
    ]);
    expect(fill(authority, 'shape2')).toBe(before);
    expect(authority.snapshot().revision).toBe(0);
    current.delete('data');
    expect(() => authority.preview(A, p.id)).toThrow('data missing');
  });
  it('applies once every reference is current again', () => {
    const authority = setup(
        () => 1000,
        (_reference, version) => ({ status: 'available', versionId: version }),
      ),
      p = proposal(authority, 'C', [setField('shape2', 'fill', '#aabbcc')], null, 'Agent fill');
    authority.register(C, { ...p, external: [{ reference: 'calendar', version: 'cal-v1' }] });
    const preview = authority.preview(A, p.id);
    expect(authority.applyProposal(A, p.id, preview.token).status).toBe('accepted');
    expect(authority.proposal(p.id)).not.toHaveProperty('stale');
    expect(fill(authority, 'shape2')).toBe('#aabbcc');
  });
});
