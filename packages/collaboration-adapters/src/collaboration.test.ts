import { designDrawings } from '@editor-platform/design/model';
import { describe, it, expect } from 'vitest';
import {
  Authority,
  CollaborationClient,
  FaultAdapter,
  localAdapter,
  initial,
  operation,
  proposal,
  copy,
  type Action,
  type DomainCodec,
  type Receipt,
} from '@editor-platform/collaboration-core';
import { contentHash, createArtifact, commitVersion } from '@editor-platform/artifact-core';
import { slideCodec, designCodec, whiteboardCodec, setField, move } from './canvas';
import { dataCodec, cell } from './data';
import { documentCodec } from './document';
import { reviewCodec, fileCodec } from './review';
import { AssetRegistry } from './assets';
import {
  person,
  slideFixture,
  dataFixture,
  documentFixture,
  designFixture,
  boardFixture,
} from './fixtures';
const A = person('A'),
  B = person('B'),
  C = person('C');
function setup<T>(codec: DomainCodec<T>, content: T) {
  const authority = new Authority(codec, initial('artifact', codec, content));
  const submit = (who: typeof A, actions: Action[]) =>
    authority.commit(who, operation(codec, authority.snapshot(), who, actions));
  return { authority, submit };
}
function code(receipt: Receipt) {
  return receipt.status === 'rejected' ? receipt.code : receipt.status;
}
describe('ordered collaboration contract — CO-Q01–17', () => {
  it('CO-Q01 merges independent fields/cells from the same revision', async () => {
    for (const [codec, content, actions] of [
      [
        slideCodec,
        slideFixture(),
        [setField('shape1', 'fill', '#ff0000'), setField('shape2', 'fill', '#0000ff')],
      ],
      [dataCodec, dataFixture(), [cell('row1', 'value', 11), cell('row2', 'value', 22)]],
    ] as const) {
      const typed = codec as DomainCodec<unknown>,
        { authority } = setup(typed, content),
        a = new CollaborationClient(typed, localAdapter(authority, A)),
        b = new CollaborationClient(typed, localAdapter(authority, B));
      await Promise.all([a.open(), b.open()]);
      const ao = operation(typed, a.confirmed, A, [actions[0]]),
        bo = operation(typed, b.confirmed, B, [actions[1]]);
      await Promise.all([a.submit(ao), b.submit(bo)]);
      expect(authority.snapshot().revision).toBe(2);
      expect(a.confirmed).toEqual(b.confirmed);
      expect(a.confirmed).not.toBe(b.confirmed);
    }
  });
  it('CO-Q03 detects same-cell, same-geometry and delete/edit conflicts', () => {
    const { authority, submit } = setup(dataCodec, dataFixture()),
      old = operation(dataCodec, authority.snapshot(), B, [cell('row1', 'value', 99)]);
    submit(A, [cell('row1', 'value', 12)]);
    expect(code(authority.commit(B, old))).toBe('stale-precondition');
    const canvas = setup(slideCodec, slideFixture()),
      bounds = { x: 1, y: 2, width: 200, height: 100 },
      stale = operation(slideCodec, canvas.authority.snapshot(), B, [
        setField('shape1', 'bounds', bounds),
      ]);
    canvas.submit(A, [setField('shape1', 'bounds', { ...bounds, x: 30 })]);
    expect(code(canvas.authority.commit(B, stale))).toBe('stale-precondition');
    const edit = operation(slideCodec, canvas.authority.snapshot(), B, [
      setField('shape1', 'fill', '#ff0000'),
    ]);
    canvas.submit(A, [{ type: 'canvas.delete', target: 'shape1', payload: {} }]);
    expect(code(canvas.authority.commit(B, edit))).toBe('stale-precondition');
    expect(canvas.authority.snapshot().content.slides[0].objects.map((o) => o.id)).toEqual([
      'shape2',
    ]);
  });
  it('CO-Q04/05 actor/session Undo and Redo preserve remote fields, reject overwritten values', () => {
    const { authority, submit } = setup(slideCodec, slideFixture());
    const a = submit(A, [setField('shape1', 'fill', '#ff0000')]);
    submit(B, [setField('shape2', 'fill', '#0000ff')]);
    const undo = authority.undo(A, a.operationId);
    expect(code(undo)).toBe('accepted');
    expect(authority.snapshot().content.slides[0].objects[1].fill).toBe('#0000ff');
    expect(code(authority.undo(A, undo.operationId, true))).toBe('accepted');
    expect(authority.snapshot().content.slides[0].objects[0].fill).toBe('#ff0000');
    const own = submit(A, [setField('shape1', 'fill', '#00ff00')]);
    submit(B, [setField('shape1', 'fill', '#123456')]);
    expect(code(authority.undo(A, own.operationId))).toBe('undo-conflict');
    expect(code(authority.undo({ ...A, sessionId: 'another-tab' }, own.operationId))).toBe(
      'unauthorized',
    );
  });
  it('explicit relative moves compose and duplicated operation moves once', () => {
    const { authority } = setup(slideCodec, slideFixture()),
      base = authority.snapshot();
    const a = operation(slideCodec, base, A, [move('shape1', 5, 0)]),
      b = operation(slideCodec, base, B, [move('shape1', 7, 0)]);
    expect(code(authority.commit(A, a))).toBe('accepted');
    expect(code(authority.commit(B, b))).toBe('accepted');
    authority.commit(A, a);
    expect(authority.snapshot().content.slides[0].objects[0].bounds.x).toBe(92);
  });
  it('CO-Q06 accepts an independently generated agent proposal and attributes adoption', () => {
    const { authority, submit } = setup(slideCodec, slideFixture()),
      p = proposal(
        authority,
        'C',
        [setField('shape2', 'fill', '#aabbcc')],
        ['shape2/fill'],
        'Agent color',
      );
    authority.register(p);
    submit(A, [setField('shape1', 'fill', '#ff0000')]);
    const preview = authority.preview(A, p.id),
      before = authority.snapshot();
    expect(preview.after.slides[0].objects[1].fill).toBe('#aabbcc');
    expect(authority.snapshot()).toEqual(before);
    const receipt = authority.applyProposal(A, p.id, preview.token);
    expect(code(receipt)).toBe('accepted');
    expect(authority.changes(0).events.at(-1)?.operation).toMatchObject({
      origin: 'proposal',
      sourceActorId: 'C',
      actorId: 'A',
    });
    expect(code(authority.undo(A, receipt.operationId))).toBe('accepted');
  });
  it('CO-Q07/08 checks read dependencies at commit after preview, including ABA', () => {
    const { authority, submit } = setup(slideCodec, slideFixture()),
      p = proposal(
        authority,
        'C',
        [setField('shape2', 'fill', '#aabbcc')],
        ['shape1/fill'],
        'Read shape 1',
      );
    authority.register(p);
    const preview = authority.preview(A, p.id);
    submit(B, [setField('shape1', 'fill', '#ff0000')]);
    submit(B, [setField('shape1', 'fill', slideFixture().slides[0].objects[0].fill)]);
    expect(code(authority.applyProposal(A, p.id, preview.token))).toBe('stale-precondition');
    expect(authority.snapshot().content.slides[0].objects[1].fill).toBe('#c2a172');
  });
  it('unknown reads conservatively require unchanged artifact and external reads require Host validation', () => {
    const { authority, submit } = setup(slideCodec, slideFixture()),
      p = proposal(authority, 'C', [setField('shape2', 'fill', '#aabbcc')], null, 'Unknown');
    authority.register(p);
    submit(A, [setField('shape1', 'fill', '#ff0000')]);
    expect(() => authority.preview(A, p.id)).toThrow('Unknown read scope');
    const external = proposal(authority, 'C', [move('shape2', 1, 0)], [], 'External');
    external.external = [{ reference: 'source:1', version: 'v1' }];
    authority.register(external);
    expect(() => authority.preview(A, external.id)).toThrow('External read');
  });
  it('CO-Q09 receipts survive lost acknowledgements, retries, compaction and backup', async () => {
    const { authority } = setup(slideCodec, slideFixture()),
      fault = new FaultAdapter(localAdapter(authority, A)),
      client = new CollaborationClient(slideCodec, fault);
    await client.open();
    fault.dropAck = true;
    const op = operation(slideCodec, client.confirmed, A, [move('shape1', 10, 0)]);
    await expect(client.submit(op)).rejects.toThrow('Acknowledgement lost');
    expect(client.pending).toHaveLength(0);
    await client.reconnect();
    authority.compact();
    expect(code(authority.commit(A, op))).toBe('accepted');
    const altered = copy(op);
    altered.actions[0].payload.dx = 999;
    expect(code(authority.commit(A, altered))).toBe('protocol-error');
    const restored = Authority.fromBackup(slideCodec, authority.backup());
    expect(restored.commit(A, op)).toEqual(authority.receipt(op.operationId));
    expect(restored.snapshot().revision).toBe(1);
  });
  it('CO-Q10 buffers reversed duplicated deliveries, detects gaps and resyncs', async () => {
    const { authority, submit } = setup(dataCodec, dataFixture()),
      fault = new FaultAdapter(localAdapter(authority, A)),
      client = new CollaborationClient(dataCodec, fault);
    await client.open();
    fault.hold = true;
    submit(B, [cell('row1', 'value', 30)]);
    submit(B, [cell('row2', 'value', 40)]);
    const second = fault.queue[1];
    client.receive(second);
    expect(client.confirmed.revision).toBe(0);
    fault.flush(true);
    client.receive(second);
    expect(client.confirmed).toEqual(authority.snapshot());
    fault.connected = false;
    submit(B, [cell('row2', 'value', 50)]);
    authority.compact();
    fault.connected = true;
    await client.reconnect();
    expect(client.confirmed).toEqual(authority.snapshot());
  });
  it('CO-Q11 rejected optimistic edit retains a later local edit and remote edit', async () => {
    const { authority, submit } = setup(dataCodec, dataFixture()),
      fault = new FaultAdapter(localAdapter(authority, A)),
      client = new CollaborationClient(dataCodec, fault);
    await client.open();
    fault.hold = true;
    const rejectedOp = operation(dataCodec, client.confirmed, A, [cell('row1', 'value', 100)]),
      later = operation(dataCodec, client.confirmed, A, [cell('row2', 'value', 200)]);
    client.enqueue(rejectedOp);
    client.enqueue(later);
    submit(B, [cell('row1', 'value', 300)]);
    expect(code(await client.submit(rejectedOp))).toBe('stale-precondition');
    expect(client.pending.map((o) => o.operationId)).toEqual([later.operationId]);
    expect(client.optimistic.content.rows.map((r) => r.values.value)).toEqual([300, 200]);
    await client.submit(later);
    expect(client.confirmed.content.rows.map((r) => r.values.value)).toEqual([300, 200]);
  });
  it('CO-Q12 cancellation and commit expose true terminal states and deduplicate adoption', () => {
    const { authority } = setup(slideCodec, slideFixture());
    for (const first of ['cancel', 'commit']) {
      const p = proposal(authority, 'C', [move('shape1', 1, 0)], [], 'Move');
      authority.register(p);
      const preview = authority.preview(A, p.id);
      if (first === 'cancel') authority.cancelProposal(p.id);
      const result = authority.applyProposal(A, p.id, preview.token);
      expect(code(result)).toBe(first === 'cancel' ? 'cancelled' : 'accepted');
      authority.cancelProposal(p.id);
      expect(authority.proposal(p.id)?.state).toBe(first === 'cancel' ? 'cancelled' : 'applied');
      if (first === 'commit')
        expect(authority.applyProposal(A, p.id, preview.token)).toEqual(result);
    }
    expect(authority.snapshot().content.slides[0].objects[0].bounds.x).toBe(81);
  });
  it('CO-Q13 validates atomic batches, trusted identity, scopes and unsupported actions', () => {
    const { authority } = setup(dataCodec, dataFixture());
    const good = operation(dataCodec, authority.snapshot(), A, [cell('row1', 'value', 42)]);
    const batch = copy(good);
    batch.actions.push(cell('row2', 'value', 'wrong'));
    expect(code(authority.commit(A, batch))).toBe('invalid-operation');
    expect(authority.snapshot().revision).toBe(0);
    expect(code(authority.commit({ ...A, writable: false }, good))).toBe('unauthorized');
    expect(code(authority.commit({ ...A, scopes: ['row2'] }, good))).toBe('unauthorized');
    expect(code(authority.commit(B, good))).toBe('unauthorized');
    const unsupported = copy(good);
    unsupported.operationId = 'unsupported';
    unsupported.actions[0].type = 'arbitrary-js';
    unsupported.conditions = [];
    expect(code(authority.commit(A, unsupported))).toBe('unsupported-operation');
    expect(code(authority.commit(A, { ...good, protocol: 2 }))).toBe('schema-mismatch');
    expect(code(authority.commit(A, { ...good, callback: () => 0 }))).toBe('schema-mismatch');
  });
  it('CO-Q14 preserves group hierarchy, components, connector endpoints, page/row order', () => {
    const design = setup(designCodec, designFixture());
    expect(() =>
      operation(designCodec, design.authority.snapshot(), A, [
        { type: 'canvas.reparent', target: 'group', payload: { parentId: 'child' } },
      ]),
    ).toThrow('Domain invariant');
    const stale = operation(designCodec, design.authority.snapshot(), B, [
      { type: 'canvas.reparent', target: 'child', payload: { parentId: null } },
    ]);
    design.submit(A, [{ type: 'canvas.delete', target: 'group', payload: {} }]);
    expect(code(design.authority.commit(B, stale))).toBe('stale-precondition');
    expect(design.authority.snapshot().content.elements.map((e) => e.id)).toEqual(['instance']);
    expect(
      code(
        design.submit(A, [
          {
            type: 'component.fill',
            target: 'component',
            payload: { elementId: 'part', value: '#ff0000' },
          },
        ]),
      ),
    ).toBe('accepted');
    expect(
      code(
        design.submit(B, [
          {
            type: 'instance.override-fill',
            target: 'instance',
            payload: { elementId: 'part', value: '#00ff00' },
          },
        ]),
      ),
    ).toBe('accepted');
    const content = design.authority.snapshot().content;
    expect(content.components[0].elements![0].fill).toBe('#ff0000');
    expect(designDrawings(content, content.elements[0])[0].fill).toBe('#00ff00');
    const inherited = { ...content.elements[0], id: 'second-instance', overrides: {} };
    expect(
      designDrawings({ ...content, elements: [...content.elements, inherited] }, inherited)[0].fill,
    ).toBe('#ff0000');
    const board = setup(whiteboardCodec, boardFixture());
    board.submit(A, [{ type: 'canvas.delete', target: 'one', payload: {} }]);
    expect(board.authority.snapshot().content.connectors).toEqual([]);
    const slide = setup(slideCodec, slideFixture());
    slide.submit(A, [{ type: 'slide.order', target: '*', payload: { ids: ['page2', 'page1'] } }]);
    expect(slide.authority.snapshot().content.slides.map((s) => s.id)).toEqual(['page2', 'page1']);
    const data = setup(dataCodec, dataFixture());
    data.submit(A, [{ type: 'data.order', target: '*', payload: { ids: ['row2', 'row1'] } }]);
    expect(data.authority.snapshot().content.rows.map((r) => r.id)).toEqual(['row2', 'row1']);
  });
  it('schema changes conflict with pending paste/formula edits without partial application', () => {
    const { authority, submit } = setup(dataCodec, dataFixture());
    const paste = operation(dataCodec, authority.snapshot(), B, [
      cell('row1', 'value', 50),
      cell('row2', 'value', 60),
    ]);
    submit(A, [
      { type: 'data.column', target: 'value', payload: { field: 'name', value: 'Amount' } },
    ]);
    expect(code(authority.commit(B, paste))).toBe('stale-precondition');
    expect(authority.snapshot().content.rows.map((r) => r.values.value)).toEqual([10, 20]);
  });
  it('CO-Q15 install race and checkpoint retain pending edits over compacted snapshots', async () => {
    const { authority, submit } = setup(dataCodec, dataFixture()),
      base = localAdapter(authority, A),
      client = new CollaborationClient(dataCodec, base);
    await client.open();
    const pending = operation(dataCodec, client.confirmed, A, [cell('row2', 'value', 99)]);
    client.enqueue(pending);
    const checkpoint = client.checkpoint();
    submit(B, [cell('row1', 'value', 77)]);
    authority.compact();
    const restored = new CollaborationClient(dataCodec, localAdapter(authority, A));
    restored.resume(checkpoint);
    await restored.reconnect();
    expect(restored.confirmed.content.rows.map((r) => r.values.value)).toEqual([77, 99]);
    const old = authority.snapshot();
    submit(B, [cell('row1', 'value', 88)]);
    restored.install(old);
    expect(restored.confirmed.revision).toBe(authority.snapshot().revision);
    expect(() =>
      new CollaborationClient(dataCodec, localAdapter(authority, B)).resume(checkpoint),
    ).toThrow('different authenticated');
  });
  it('CO-Q16 saved snapshots stay immutable, restore is conditional, exports omit transport', async () => {
    const legacy = slideFixture();
    legacy.schemaVersion = 1;
    const artifact = await commitVersion(
        createArtifact('slide', 'Legacy', legacy),
        'A',
        'Original',
      ),
      hash = artifact.versions[0].contentHash;
    const { authority, submit } = setup(slideCodec, artifact.draft.content);
    submit(A, [move('shape1', 10, 0)]);
    expect(code(authority.restore(A, legacy, 0))).toBe('stale-precondition');
    expect(code(authority.restore(A, legacy, 1))).toBe('accepted');
    expect(await contentHash(artifact.versions[0].content)).toBe(hash);
    expect(authority.snapshot().revision).toBe(2);
    const ordinary = JSON.stringify(authority.snapshot().content);
    expect(ordinary).not.toMatch(/operationId|sessionId|stamps|engineVersion/);
    expect(Authority.fromBackup(slideCodec, authority.backup()).snapshot()).toEqual(
      authority.snapshot(),
    );
  });
  it('CO-Q17 presence expires/disconnects, never enters content, history, or private view', async () => {
    let now = 0;
    const authority = new Authority(
        slideCodec,
        initial('artifact', slideCodec, slideFixture()),
        () => now,
      ),
      adapter = localAdapter(authority, A),
      client = new CollaborationClient(slideCodec, adapter);
    await client.open();
    client.view.zoom = 2;
    await adapter.presence({
      name: 'A',
      color: '#ff0000',
      page: 'page1',
      anchor: { type: 'element', elementId: 'shape1' },
    });
    expect(authority.presenceList()).toHaveLength(1);
    expect(authority.snapshot().revision).toBe(0);
    now = 15001;
    expect(authority.presenceList()).toHaveLength(0);
    await adapter.presence({ name: 'A', color: '#ff0000' });
    client.close();
    expect(authority.presenceList()).toEqual([]);
    expect(client.view.zoom).toBe(2);
    expect(JSON.stringify(authority.backup())).not.toContain('expiresAt');
  });
  it('annotations use independent replies/resolve operations across every domain', () => {
    const fixtures: [DomainCodec<unknown>, unknown, unknown][] = [
      [
        slideCodec as DomainCodec<unknown>,
        slideFixture(),
        { type: 'element', elementId: 'shape1' },
      ],
      [
        designCodec as DomainCodec<unknown>,
        designFixture(),
        { type: 'element', elementId: 'child' },
      ],
      [
        whiteboardCodec as DomainCodec<unknown>,
        boardFixture(),
        { type: 'element', elementId: 'one' },
      ],
      [dataCodec as DomainCodec<unknown>, dataFixture(), { type: 'element', elementId: 'row1' }],
      [documentCodec as DomainCodec<unknown>, documentFixture(), { type: 'text', from: 1, to: 6 }],
      [
        reviewCodec as DomainCodec<unknown>,
        {
          schemaVersion: 2,
          files: [
            {
              id: 'file',
              name: 'a',
              oldText: 'old',
              newText: 'new',
              oldRevision: 'v1',
              newRevision: 'v2',
            },
          ],
        },
        { type: 'fixed', elementId: 'file', versionId: 'v2', side: 'new' },
      ],
      [
        fileCodec as DomainCodec<unknown>,
        {
          schemaVersion: 2,
          id: 'source-v1',
          name: 'a.txt',
          mime: 'text/plain',
          size: 3,
          data: 'abc',
        },
        { type: 'fixed', elementId: 'source-v1', versionId: 'source-v1' },
      ],
    ];
    for (const [codec, content, anchor] of fixtures) {
      const { authority, submit } = setup(codec, content);
      submit(A, [{ type: 'thread.create', target: 'thread', payload: { anchor } }]);
      const base = authority.snapshot();
      const a = operation(codec, base, A, [
          { type: 'thread.reply', target: 'thread', payload: { id: 'a', text: 'A' } },
        ]),
        b = operation(codec, base, B, [
          { type: 'thread.reply', target: 'thread', payload: { id: 'b', text: 'B' } },
        ]);
      expect(code(authority.commit(A, a))).toBe('accepted');
      expect(code(authority.commit(B, b))).toBe('accepted');
      submit(C, [{ type: 'thread.resolve', target: 'thread', payload: { value: true } }]);
      expect(authority.snapshot().threads[0]).toMatchObject({
        resolved: true,
        replies: [{ text: 'A' }, { text: 'B' }],
      });
    }
  });
  it('asset references distinguish unavailable/deleted/hash mismatch', () => {
    const assets = new AssetRegistry();
    expect(() => assets.resolve({ id: 'image', hash: 'h' })).toThrow('Asset missing');
    assets.put('image', 'h', 'bytes');
    expect(assets.resolve({ id: 'image', hash: 'h' })).toBe('bytes');
    expect(() => assets.put('image', 'other', 'bytes')).toThrow('different hash');
    assets.unavailable('image');
    expect(() => assets.resolve({ id: 'image', hash: 'h' })).toThrow('Asset missing');
  });
  it.each([19, 20261004, 371631645])(
    'seed %i: reordered/drop/duplicate history preserves accepted IDs and domain invariants',
    async (seed) => {
      let random = seed;
      const next = () => {
        random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
        return random / 2 ** 32;
      };
      const { authority, submit } = setup(slideCodec, slideFixture()),
        fault = new FaultAdapter(localAdapter(authority, A)),
        client = new CollaborationClient(slideCodec, fault);
      await client.open();
      fault.hold = true;
      for (let i = 0; i < 40; i++) {
        const receipt = submit(i % 2 ? B : C, [move(next() < 0.5 ? 'shape1' : 'shape2', 1, 0)]);
        expect(code(receipt), `seed ${seed}, iteration ${i}`).toBe('accepted');
      }
      const shuffled = fault.queue.sort(() => next() - 0.5);
      for (const event of shuffled) {
        if (next() < 0.2) continue;
        client.receive(event);
        if (next() < 0.5) client.receive(event);
      }
      await client.sync();
      expect(client.confirmed).toEqual(authority.snapshot());
      expect(slideCodec.validate(client.confirmed.content)).toBe(true);
      expect(
        client.confirmed.content.slides[0].objects.reduce((sum, o) => sum + o.bounds.x, 0),
      ).toBe(500);
      expect(new Set(authority.changes(0).events.map((e) => e.operation.operationId)).size).toBe(
        40,
      );
    },
  );
});
it('asset attachment travels as ID/hash through authority and Undo while exports retain bytes', async () => {
  const { withAssets } = await import('./assets');
  const assets = new AssetRegistry(),
    bytes = 'data:image/png;base64,aGVsbG8=';
  assets.put('img', 'hash', bytes);
  const deck = slideFixture();
  deck.slides[0].objects[0].type = 'image';
  const codec = withAssets(slideCodec, assets),
    { authority } = setup(codec, deck);
  const op = operation(codec, authority.snapshot(), A, [
    { type: 'asset.attach', target: 'shape1', payload: { reference: { id: 'img', hash: 'hash' } } },
  ]);
  expect(JSON.stringify(op)).not.toContain(bytes);
  expect(code(authority.commit(A, op))).toBe('accepted');
  expect(authority.snapshot().content.slides[0].objects[0].src).toBe(bytes);
  expect(code(authority.undo(A, op.operationId))).toBe('accepted');
  assets.unavailable('img');
  const missing = { ...op, operationId: 'missing' };
  expect(code(authority.commit(A, missing))).toBe('stale-precondition');
});
it('permissions and connection changes notify clients and remain enforced at commit', async () => {
  const { authority } = setup(dataCodec, dataFixture()),
    principal = person('revoked'),
    adapter = localAdapter(authority, principal),
    fault = new FaultAdapter(adapter),
    client = new CollaborationClient(dataCodec, fault);
  await client.open();
  const op = operation(dataCodec, client.confirmed, principal, [cell('row1', 'value', 12)]);
  adapter.setPermissions({ writable: false, scopes: ['*'] });
  expect(client.permissions?.writable).toBe(false);
  expect(code(await client.submit(op))).toBe('unauthorized');
  fault.connected = false;
  expect(client.status).toBe('disconnected');
  client.close();
});
it('CO-Q16 save captures only authority-confirmed content while pending and later remote edits survive', async () => {
  const { saveConfirmedVersion } = await import('@editor-platform/collaboration-core');
  const { authority, submit } = setup(dataCodec, dataFixture()),
    client = new CollaborationClient(dataCodec, localAdapter(authority, A));
  await client.open();
  client.enqueue(operation(dataCodec, client.confirmed, A, [cell('row1', 'value', 999)]));
  const saving = saveConfirmedVersion(authority, A.actorId, 'Confirmed only');
  submit(B, [cell('row2', 'value', 88)]);
  const saved = await saving;
  expect(saved.confirmedRevision).toBe(0);
  expect(saved.version.content.rows.map((r) => r.values.value)).toEqual([10, 20]);
  expect(await contentHash(saved.version.content)).toBe(saved.version.contentHash);
  expect(client.pending).toHaveLength(1);
  expect(authority.snapshot().content.rows[1].values.value).toBe(88);
});
it('proposal cannot omit write dependencies or bypass the preview commit path', () => {
  const { authority } = setup(slideCodec, slideFixture()),
    p = proposal(authority, 'C', [setField('shape1', 'fill', '#ff0000')], [], 'Color');
  const missing = copy(p);
  missing.writes = [];
  expect(() => authority.register(missing)).toThrow('omits');
  authority.register(p);
  authority.preview(A, p.id);
  const forged = operation(slideCodec, authority.snapshot(), A, p.actions, 'proposal');
  forged.proposalId = p.id;
  expect(code(authority.commit(A, forged))).toBe('cancelled');
  expect(authority.snapshot().revision).toBe(0);
});
it('invalid native snapshots reject before installing content', () => {
  const { authority } = setup(slideCodec, slideFixture()),
    backup = authority.backup();
  backup.state.revision = -1;
  expect(() => Authority.fromBackup(slideCodec, backup)).toThrow('Invalid collaboration snapshot');
});
it('CO-Q15 remote delivery racing snapshot installation is buffered with local pending intact', async () => {
  const { authority, submit } = setup(dataCodec, dataFixture()),
    base = localAdapter(authority, A),
    snapshot = authority.snapshot();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let subscribed!: () => void;
  const listening = new Promise<void>((resolve) => {
    subscribed = resolve;
  });
  const adapter = {
    ...base,
    subscribe: (fn: Parameters<typeof base.subscribe>[0]) => {
      const stop = base.subscribe(fn);
      subscribed();
      return stop;
    },
    open: async () => {
      await gate;
      return snapshot;
    },
  };
  const client = new CollaborationClient(dataCodec, adapter),
    opening = client.open();
  await listening;
  const pending = operation(dataCodec, snapshot, A, [cell('row2', 'value', 55)]);
  client.enqueue(pending);
  submit(B, [cell('row1', 'value', 66)]);
  release();
  await opening;
  expect(client.confirmed.revision).toBe(1);
  expect(client.optimistic.content.rows.map((r) => r.values.value)).toEqual([66, 55]);
  expect(client.pending).toHaveLength(1);
  await client.submit(pending);
  expect(client.confirmed).toEqual(authority.snapshot());
});
it('canvas property codec cannot add another domain field or untyped values', () => {
  const { authority } = setup(whiteboardCodec, boardFixture());
  expect(() =>
    operation(whiteboardCodec, authority.snapshot(), A, [setField('one', 'fill', '#ffffff')]),
  ).toThrow('does not belong');
  expect(() =>
    operation(whiteboardCodec, authority.snapshot(), A, [
      setField('one', 'name', { unexpected: true }),
    ]),
  ).toThrow('Invalid canvas property value');
  expect(authority.snapshot().revision).toBe(0);
});
