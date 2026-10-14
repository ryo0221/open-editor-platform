import { describe, expect, it } from 'vitest';
import {
  Authority,
  initial,
  operation,
  localAdapter,
  type Principal,
} from '@editor-platform/collaboration-core';
import {
  createDeck,
  insertObject,
  updateObject,
  addSlide,
  duplicateSlide,
  deleteObjects,
} from '@editor-platform/slide/model';
import { createData, addRow, setCell, removeColumn } from '@editor-platform/structured-data/model';
import { deleteRows, updateColumn } from '@editor-platform/structured-data/views';
import { command } from '@editor-platform/editor-core';
import {
  dataEditorCodec,
  prepareEditorCommand,
  slideEditorCodec,
  type EditorChange,
} from './editor-transactions';
import { SharedEditorSession, type EditorHostAdapter } from './editor-session';
const actor = (actorId: string): Principal => ({
  actorId,
  clientId: actorId,
  sessionId: actorId,
  writable: true,
  scopes: ['*'],
});
const A = actor('A'),
  B = actor('B');
function fixture() {
  let d = createDeck();
  const page = d.slides[0].id;
  d = insertObject(page, 'shape').apply(d);
  d = insertObject(page, 'shape').apply(d);
  return {
    d,
    page,
    authority: new Authority(slideEditorCodec, initial('artifact', slideEditorCodec, d)),
  };
}
describe('normal editor prepared domain transactions', () => {
  it.each([false, true])(
    'merges a positioned row deletion with an independent peer position and selectively undoes it (reverse=%s)',
    (reverse) => {
      let d = addRow().apply(addRow().apply(createData()));
      const [one, two] = d.rows;
      d = {
        ...d,
        graphView: {
          schemaVersion: 1,
          labelColumnId: d.columns[0].id,
          positions: { [one.id]: { x: 10, y: 20 }, [two.id]: { x: 30, y: 40 } },
        },
      };
      const authority = new Authority(dataEditorCodec, initial('positions', dataEditorCodec, d)),
        state = authority.snapshot();
      const remove = prepareEditorCommand(dataEditorCodec, state, A, deleteRows([one.id]))!;
      const move = prepareEditorCommand(
        dataEditorCodec,
        state,
        B,
        command('position', 'Move independent row', (current) => ({
          ...current,
          graphView: {
            ...current.graphView!,
            positions: { ...current.graphView!.positions, [two.id]: { x: 300, y: 400 } },
          },
        })),
      )!;
      expect(remove.conditions.some((c) => JSON.stringify(c).includes('root/graphView'))).toBe(
        false,
      );
      expect(JSON.stringify(move)).not.toContain('root/graphView');
      for (const [principal, op] of reverse
        ? ([
            [B, move],
            [A, remove],
          ] as const)
        : ([
            [A, remove],
            [B, move],
          ] as const))
        expect(authority.commit(principal, op).status).toBe('accepted');
      expect(authority.snapshot().content.graphView!.positions).toEqual({
        [two.id]: { x: 300, y: 400 },
      });
      expect(authority.undo(A, remove.operationId).status).toBe('accepted');
      expect(authority.snapshot().content.graphView!.positions).toEqual({
        [one.id]: { x: 10, y: 20 },
        [two.id]: { x: 300, y: 400 },
      });
      expect(
        authority
          .snapshot()
          .content.rows.map((r) => r.id)
          .sort(),
      ).toEqual(d.rows.map((r) => r.id).sort());
      expect(d.graphView!.positions[two.id]).toEqual({ x: 30, y: 40 });
    },
  );
  it('keeps concurrent independent position writes granular and guards whole-view removal against new peer positions', () => {
    let d = addRow().apply(addRow().apply(createData()));
    const [one, two] = d.rows;
    d = { ...d, graphView: { schemaVersion: 1, labelColumnId: d.columns[0].id, positions: {} } };
    const authority = new Authority(dataEditorCodec, initial('positions', dataEditorCodec, d)),
      state = authority.snapshot();
    const move = (id: string, x: number) =>
      command('position', 'Move row', (current: typeof d) => ({
        ...current,
        graphView: {
          ...current.graphView!,
          positions: { ...current.graphView!.positions, [id]: { x, y: x } },
        },
      }));
    const a = prepareEditorCommand(dataEditorCodec, state, A, move(one.id, 10))!,
      b = prepareEditorCommand(dataEditorCodec, state, B, move(two.id, 20))!;
    const clear = prepareEditorCommand(
      dataEditorCodec,
      state,
      A,
      command('clear-layout', 'Remove graph settings', (current) => {
        const next = { ...current };
        delete next.graphView;
        return next;
      }),
    )!;
    expect(authority.commit(A, a).status).toBe('accepted');
    expect(authority.commit(B, b).status).toBe('accepted');
    const before = authority.snapshot();
    expect(authority.commit(A, clear).status).toBe('rejected');
    expect(authority.snapshot()).toEqual(before);
    expect(authority.undo(A, a.operationId).status).toBe('accepted');
    expect(authority.snapshot().content.graphView!.positions).toEqual({
      [two.id]: { x: 20, y: 20 },
    });
    const noView = { ...d };
    delete noView.graphView;
    const fresh = new Authority(dataEditorCodec, initial('view-creation', dataEditorCodec, noView));
    const create = prepareEditorCommand(
      dataEditorCodec,
      fresh.snapshot(),
      A,
      command('create-view', 'Create graph view', (current) => ({
        ...current,
        graphView: {
          schemaVersion: 1,
          labelColumnId: d.columns[0].id,
          positions: { [one.id]: { x: 1, y: 2 } },
        },
      })),
    )!;
    expect(fresh.commit(A, create).status).toBe('accepted');
    const peer = prepareEditorCommand(dataEditorCodec, fresh.snapshot(), B, move(two.id, 30))!;
    expect(fresh.commit(B, peer).status).toBe('accepted');
    const retained = fresh.snapshot();
    expect(fresh.undo(A, create.operationId)).toMatchObject({
      status: 'rejected',
      code: 'undo-conflict',
    });
    expect(fresh.snapshot()).toEqual(retained);
  });
  it('retains the existing row-order precondition for concurrent row deletions without adding a shared graphView lock', () => {
    for (const positioned of [false, true]) {
      let d = addRow().apply(addRow().apply(createData()));
      const [one, two] = d.rows;
      if (positioned)
        d = {
          ...d,
          graphView: {
            schemaVersion: 1,
            labelColumnId: d.columns[0].id,
            positions: { [one.id]: { x: 1, y: 2 }, [two.id]: { x: 3, y: 4 } },
          },
        };
      const authority = new Authority(dataEditorCodec, initial('row-order', dataEditorCodec, d)),
        state = authority.snapshot();
      const a = prepareEditorCommand(dataEditorCodec, state, A, deleteRows([one.id]))!,
        b = prepareEditorCommand(dataEditorCodec, state, B, deleteRows([two.id]))!;
      expect(JSON.stringify(a.conditions)).not.toContain('root/graphView');
      expect(JSON.stringify(b.conditions)).not.toContain('root/graphView');
      expect(authority.commit(A, a).status).toBe('accepted');
      expect(authority.commit(B, b)).toMatchObject({
        status: 'rejected',
        code: 'stale-precondition',
      });
    }
  });
  it('allows an authorized shared field unlock but rejects mixed unlock/value writes even when schema changes come first', () => {
    const d = addRow().apply(createData()),
      col = d.columns[0],
      row = d.rows[0];
    col.readOnly = true;
    const authority = new Authority(dataEditorCodec, initial('readonly', dataEditorCodec, d)),
      state = authority.snapshot();
    expect(() =>
      operation(dataEditorCodec, state, A, [
        {
          type: 'data.edit',
          target: '*',
          payload: {
            reads: [],
            changes: [
              { kind: 'field', collection: 'columns', id: col.id, field: 'readOnly', value: false },
              { kind: 'cell', rowId: row.id, columnId: col.id, value: 'Bypass' },
            ],
          },
        },
      ]),
    ).toThrow('same operation');
    expect(authority.snapshot()).toEqual(state);
    const unlock = prepareEditorCommand(
      dataEditorCodec,
      state,
      A,
      updateColumn(col.id, { readOnly: false }),
    )!;
    expect(authority.commit(A, unlock).status).toBe('accepted');
    const edit = prepareEditorCommand(
      dataEditorCodec,
      authority.snapshot(),
      B,
      setCell(row.id, col.id, 'Allowed later'),
    )!;
    expect(authority.commit(B, edit).status).toBe('accepted');
    expect(authority.undo(B, edit.operationId).status).toBe('accepted');
    expect(authority.undo(A, unlock.operationId).status).toBe('accepted');
    expect(authority.snapshot().content).toEqual(d);
  });
  it('tracks replaced pages and inserted, removed, edited and reordered objects within one atomic action', () => {
    const { authority, page, d } = fixture();
    const [one, two] = d.slides[0].objects;
    const changes: EditorChange[] = [
      { kind: 'remove', collection: 'pages', id: page },
      { kind: 'insert', collection: 'pages', id: page, value: { ...d.slides[0], objects: [] } },
      { kind: 'insert', collection: `objects@${page}`, id: one.id, value: { ...one } },
      { kind: 'insert', collection: `objects@${page}`, id: two.id, value: { ...two } },
      { kind: 'remove', collection: `objects@${page}`, id: one.id },
      {
        kind: 'insert',
        collection: `objects@${page}`,
        id: one.id,
        value: { ...one, fill: '#123456' },
      },
      { kind: 'field', collection: `objects@${page}`, id: one.id, field: 'fill', value: '#abcdef' },
      { kind: 'order', collection: `objects@${page}`, ids: [one.id, two.id] },
    ];
    const op = operation(slideEditorCodec, authority.snapshot(), A, [
      {
        type: 'slide.edit',
        target: '*',
        payload: { reads: [], changes },
      },
    ]);
    expect(authority.commit(A, op).status).toBe('accepted');
    expect(authority.snapshot().content.slides[0].objects).toEqual([
      { ...one, fill: '#abcdef' },
      two,
    ]);
    expect(authority.undo(A, op.operationId).status).toBe('accepted');
    expect(authority.snapshot().content).toEqual(d);
    const invalid = structuredClone(op);
    invalid.operationId += '-invalid';
    (invalid.actions[0].payload.changes as EditorChange[]).push({
      kind: 'field',
      collection: `objects@${page}`,
      id: 'missing',
      field: 'fill',
      value: '#000000',
    });
    const before = authority.snapshot();
    expect(authority.commit(A, invalid).status).toBe('rejected');
    expect(authority.snapshot()).toEqual(before);
  });
  it('fixes insertion IDs once, retains independent property edits, deduplicates and selectively undoes', () => {
    const { authority, page, d } = fixture(),
      state = authority.snapshot();
    const insert = prepareEditorCommand(slideEditorCodec, state, A, insertObject(page, 'shape'))!;
    const edit = prepareEditorCommand(
      slideEditorCodec,
      state,
      B,
      updateObject(page, d.slides[0].objects[0].id, { fill: '#aabbcc' }),
    )!;
    expect(authority.commit(B, edit).status).toBe('accepted');
    expect(authority.commit(A, insert).status).toBe('accepted');
    expect(authority.commit(A, insert).status).toBe('accepted');
    expect(authority.snapshot().content.slides[0].objects).toHaveLength(3);
    expect(authority.undo(A, insert.operationId).status).toBe('accepted');
    expect(authority.snapshot().content.slides[0].objects).toHaveLength(2);
    expect(authority.snapshot().content.slides[0].objects[0].fill).toBe('#aabbcc');
  });
  it('preserves changed inserted elements by rejecting old Undo and deletion ABA', () => {
    const { authority, page } = fixture();
    const insert = prepareEditorCommand(
      slideEditorCodec,
      authority.snapshot(),
      A,
      insertObject(page, 'shape'),
    )!;
    authority.commit(A, insert);
    const id = authority.snapshot().content.slides[0].objects.at(-1)!.id;
    const deletion = prepareEditorCommand(
      slideEditorCodec,
      authority.snapshot(),
      A,
      deleteObjects(page, [id]),
    )!;
    const edit = prepareEditorCommand(
      slideEditorCodec,
      authority.snapshot(),
      B,
      updateObject(page, id, { fill: '#aabbcc' }),
    )!;
    authority.commit(B, edit);
    authority.undo(B, edit.operationId);
    expect(authority.commit(A, deletion)).toMatchObject({
      status: 'rejected',
      code: 'stale-precondition',
    });
    expect(authority.undo(A, insert.operationId)).toMatchObject({
      status: 'rejected',
      code: 'undo-conflict',
    });
  });
  it('page duplication is one transaction with stable child IDs and one Undo', () => {
    const { authority, page, d } = fixture();
    const duplicate = prepareEditorCommand(
      slideEditorCodec,
      authority.snapshot(),
      A,
      duplicateSlide(page),
    )!;
    expect(authority.commit(A, duplicate)).toMatchObject({ status: 'accepted' });
    const pages = authority.snapshot().content.slides;
    expect(pages).toHaveLength(2);
    expect(pages[1].objects[0].id).not.toBe(d.slides[0].objects[0].id);
    expect(authority.undo(A, duplicate.operationId).status).toBe('accepted');
    expect(authority.snapshot().content).toEqual(d);
  });
  it('accepts independent object moves on the same page', () => {
    const { authority, page, d } = fixture(),
      state = authority.snapshot();
    const [a, b] = d.slides[0].objects;
    const move = prepareEditorCommand(
      slideEditorCodec,
      state,
      A,
      updateObject(page, a.id, { bounds: { ...a.bounds, x: 200 } }),
    )!;
    const remote = prepareEditorCommand(
      slideEditorCodec,
      state,
      B,
      updateObject(page, b.id, { bounds: { ...b.bounds, x: 500 } }),
    )!;
    authority.commit(B, remote);
    expect(authority.commit(A, move).status).toBe('accepted');
    expect(authority.snapshot().content.slides[0].objects.map((o) => o.bounds.x)).toEqual([
      200, 500,
    ]);
  });
  it('converts compatibility text editing to engine steps', () => {
    const { authority, page, d } = fixture();
    const op = prepareEditorCommand(
      slideEditorCodec,
      authority.snapshot(),
      A,
      updateObject(page, d.slides[0].objects[0].id, { text: 'engine' }),
    )!;
    expect(op.actions.every((a) => a.type === 'canvas.text-steps')).toBe(true);
    expect(authority.commit(A, op).status).toBe('accepted');
  });
  it('independent Data cells merge while an invalid multi-cell transaction is atomic', () => {
    let d = createData();
    d = addRow().apply(d);
    const authority = new Authority(dataEditorCodec, initial('data', dataEditorCodec, d));
    const state = authority.snapshot(),
      row = d.rows[0].id;
    const a = prepareEditorCommand(
      dataEditorCodec,
      state,
      A,
      setCell(row, d.columns[0].id, 'Name'),
    )!;
    const b = prepareEditorCommand(dataEditorCodec, state, B, setCell(row, d.columns[2].id, 3))!;
    expect(authority.commit(A, a).status).toBe('accepted');
    expect(authority.commit(B, b).status).toBe('accepted');
    expect(() =>
      prepareEditorCommand(
        dataEditorCodec,
        authority.snapshot(),
        A,
        setCell(row, d.columns[2].id, 'not numeric'),
      ),
    ).toThrowError(expect.objectContaining({ code: 'invalid-operation' }));
    expect(authority.snapshot().content.rows[0].values[d.columns[2].id]).toBe(3);
  });
  it('does not allow missing preconditions or a fabricated normal-editor target', () => {
    const { authority } = fixture();
    const op = prepareEditorCommand(slideEditorCodec, authority.snapshot(), A, addSlide())!;
    op.conditions = [];
    expect(authority.commit(A, op).status).toBe('rejected');
    expect(() =>
      operation(slideEditorCodec, authority.snapshot(), A, [
        {
          type: 'slide.edit',
          target: '*',
          payload: {
            changes: [
              { kind: 'field', collection: 'pages', id: 'nope', field: 'title', value: 'x' },
            ],
            reads: [],
          },
        },
      ]),
    ).toThrow('missing');
  });
  it('queues rapid edits on one session without stale local predecessor conditions', async () => {
    const { authority, page, d } = fixture();
    const adapter = {
      ...localAdapter(authority, A),
      versions: async () => [],
      undo: async (id: string, redo?: boolean) => authority.undo(A, id, redo),
    } as unknown as EditorHostAdapter<typeof d>;
    const session = new SharedEditorSession(slideEditorCodec, adapter);
    await session.open();
    const id = d.slides[0].objects[0].id;
    session.execute(updateObject(page, id, { fill: '#111111' }));
    session.execute(updateObject(page, id, { fill: '#222222' }));
    session.execute(updateObject(page, id, { fill: '#333333' }));
    await session.flush();
    expect(session.pendingCount).toBe(0);
    expect(session.rejected).toHaveLength(0);
    expect(authority.snapshot().content.slides[0].objects[0].fill).toBe('#333333');
    await session.history('undo');
    expect(authority.snapshot().content.slides[0].objects[0].fill).toBe('#222222');
  });
  it('serializes graph layout pruning with Data deletions and selective Undo preserves peer edits', async () => {
    let d = createData();
    d = addRow().apply(d);
    d = addRow().apply(d);
    const [one, two] = d.rows,
      label = d.columns[0].id;
    d.graphView = {
      schemaVersion: 1,
      labelColumnId: label,
      positions: {
        [one.id]: { x: 10, y: 20 },
        [two.id]: { x: 30, y: 40 },
      },
    };
    const authority = new Authority(dataEditorCodec, initial('data-layout', dataEditorCodec, d));
    const make = (principal: Principal) =>
      new SharedEditorSession(dataEditorCodec, {
        ...localAdapter(authority, principal),
        versions: async () => [],
        undo: async (id: string, redo?: boolean) => authority.undo(principal, id, redo),
      } as unknown as EditorHostAdapter<typeof d>);
    const a = make(A),
      b = make(B);
    await a.open();
    await b.open();
    b.execute(setCell(one.id, label, 'Peer retained'));
    await b.flush();
    a.execute(deleteRows([two.id]));
    await a.flush();
    expect(a.rejected).toHaveLength(0);
    expect(b.content).toEqual(a.content);
    expect(a.content.graphView?.positions[two.id]).toBeUndefined();
    await a.history('undo');
    expect(b.content).toEqual(a.content);
    expect(a.content.rows).toHaveLength(2);
    expect(a.content.graphView).toEqual(d.graphView);
    expect(a.content.rows[0].values[label]).toBe('Peer retained');
    a.execute(removeColumn(label));
    await a.flush();
    expect(a.rejected).toHaveLength(0);
    expect(b.content.graphView?.labelColumnId).toBe(d.columns[1].id);
    await a.history('undo');
    expect(b.content).toEqual(a.content);
    expect(a.content.graphView).toEqual(d.graphView);
    expect(a.content.rows[0].values[label]).toBe('Peer retained');
    a.close();
    b.close();
  });
});
