import { expect, it } from 'vitest';
import {
  Authority,
  CollaborationClient,
  initial,
  localAdapter,
  operation,
  proposal,
  validateSnapshot,
  type DomainCodec,
} from '@editor-platform/collaboration-core';
import { slideCodec, setField, move } from './canvas';
import { dataCodec, cell } from './data';
import { person, slideFixture, dataFixture } from './fixtures';

const A = person('A'),
  B = person('B');

it.each(['slide', 'data'] as const)(
  'R3-01 %s Undo preserves another actor’s restored value',
  (domain) => {
    const codec = (domain === 'slide' ? slideCodec : dataCodec) as DomainCodec<unknown>;
    const content = domain === 'slide' ? slideFixture() : dataFixture();
    const authority = new Authority(codec, initial('artifact', codec, content));
    const edit =
      domain === 'slide' ? setField('shape1', 'fill', '#ff0000') : cell('row1', 'value', 100);
    const receipt = authority.commit(A, operation(codec, authority.snapshot(), A, [edit]));
    expect(receipt.status).toBe('accepted');
    const restored = domain === 'slide' ? slideFixture() : dataFixture();
    if ('slides' in restored) restored.slides[0].objects[0].fill = '#0000ff';
    else restored.rows[0].values.value = 200;
    expect(authority.restore(B, restored, authority.snapshot().revision).status).toBe('accepted');
    const before = authority.snapshot();
    expect(authority.undo(A, receipt.operationId)).toMatchObject({
      status: 'rejected',
      code: 'undo-conflict',
    });
    expect(authority.snapshot()).toEqual(before);
  },
);

it.each(['slide', 'data-row', 'data-column'] as const)(
  'R3-02 %s restore orphans missing anchors and independent clients converge',
  async (domain) => {
    const codec = (domain === 'slide' ? slideCodec : dataCodec) as DomainCodec<unknown>;
    const content = domain === 'slide' ? slideFixture() : dataFixture();
    const removed = domain === 'slide' ? 'shape2' : domain === 'data-row' ? 'row2' : 'value';
    const retained = domain === 'slide' ? 'shape1' : 'row1';
    const authority = new Authority(
      codec,
      initial(
        'artifact',
        codec,
        content,
        [removed, retained].map((id) => ({
          id,
          anchor: { type: 'element', elementId: id },
          resolved: false,
          replies: [],
        })),
      ),
    );
    const a = new CollaborationClient(codec, localAdapter(authority, A));
    const b = new CollaborationClient(codec, localAdapter(authority, B));
    await Promise.all([a.open(), b.open()]);
    authority.presence(A, {
      name: 'A',
      color: '#ff0000',
      anchor: { type: 'element', elementId: removed },
    });
    if ('slides' in content)
      content.slides[0].objects = content.slides[0].objects.filter((e) => e.id !== removed);
    else if (domain === 'data-row') content.rows = content.rows.filter((r) => r.id !== removed);
    else {
      content.columns = content.columns.filter((c) => c.id !== removed);
      content.rows.forEach((r) => {
        delete r.values[removed];
      });
    }
    expect(authority.restore(B, content, 0).status).toBe('accepted');
    const snapshot = authority.snapshot();
    expect(snapshot.threads[0].anchor).toMatchObject({ orphan: true });
    expect(snapshot.threads[1].anchor.orphan).not.toBe(true);
    expect(() => validateSnapshot(codec, snapshot)).not.toThrow();
    expect(authority.presenceList()[0].anchor).toMatchObject({ orphan: true });
    await Promise.all([a.sync(), b.sync()]);
    expect(a.confirmed).toEqual(snapshot);
    expect(b.confirmed).toEqual(snapshot);
    a.close();
    b.close();
  },
);

it('R3-02 final snapshot validation rejects an incomplete adapter atomically', () => {
  const codec = { ...slideCodec, mapAnchor: undefined };
  const authority = new Authority(
    codec,
    initial('artifact', codec, slideFixture(), [
      {
        id: 'comment',
        anchor: { type: 'element', elementId: 'shape2' },
        resolved: false,
        replies: [],
      },
    ]),
  );
  const before = authority.snapshot();
  let events = 0;
  authority.subscribe(() => {
    events++;
  });
  const op = operation(codec, before, A, [
    { type: 'canvas.delete', target: 'shape2', payload: {} },
  ]);
  expect(authority.commit(A, op)).toMatchObject({ status: 'rejected', code: 'schema-mismatch' });
  expect(authority.snapshot()).toEqual(before);
  expect(events).toBe(0);
  expect(authority.changes(0).events).toEqual([]);
});

it('R3-03 whole-element reads detect change then Undo without blocking independent fields or elements', () => {
  for (const read of ['shape1', 'shape1/fill', 'shape1/bounds', 'shape2']) {
    const authority = new Authority(slideCodec, initial('artifact', slideCodec, slideFixture()));
    const p = proposal(
      authority,
      'C',
      [setField('shape2', 'fill', '#aabbcc')],
      [read],
      'Checked read',
    );
    authority.register(p);
    const preview = authority.preview(A, p.id);
    const edit = authority.commit(
      B,
      operation(slideCodec, authority.snapshot(), B, [setField('shape1', 'fill', '#ff0000')]),
    );
    expect(authority.undo(B, edit.operationId).status).toBe('accepted');
    const result = authority.applyProposal(A, p.id, preview.token);
    if (read === 'shape1' || read === 'shape1/fill')
      expect(result).toMatchObject({ status: 'rejected', code: 'stale-precondition' });
    else expect(result.status).toBe('accepted');
  }
});

it('R3-01/03 independent fields on the same element still allow selective Undo', () => {
  const authority = new Authority(slideCodec, initial('artifact', slideCodec, slideFixture()));
  const edit = authority.commit(
    A,
    operation(slideCodec, authority.snapshot(), A, [setField('shape1', 'fill', '#ff0000')]),
  );
  expect(
    authority.commit(B, operation(slideCodec, authority.snapshot(), B, [move('shape1', 10, 0)]))
      .status,
  ).toBe('accepted');
  expect(authority.undo(A, edit.operationId).status).toBe('accepted');
  expect(authority.snapshot().content.slides[0].objects[0]).toMatchObject({
    fill: '#4f7a5d',
    bounds: { x: 90 },
  });
});
