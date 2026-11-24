import { describe, expect, it } from 'vitest';
import { EditorSession } from '@editor-platform/editor-core';
import { canonicalJson } from '@editor-platform/artifact-core';
import { readItems } from '@editor-platform/extension-runtime/items';
import {
  dataDiff,
  exportCsv,
  importCsv,
  isStructuredData,
  removeColumn,
  setCell,
  setRowRefs,
  type StructuredData,
} from './model';
import { saveView, updateColumn, defaultView, deleteRows, reorderRow, setCells } from './views';
import { dataItemsDeclaration, dataItemsProblems, itemsWithoutColumn } from './items';
import { prepareCsvExport } from './csv-transfer';
import { dataProposalDiff } from './proposal-diff';

const table = (): StructuredData => ({
  schemaVersion: 3,
  columns: [
    { id: 'fmId', name: '故障モードの ID', type: 'text' },
    { id: 'failure', name: '故障モード', type: 'text' },
    { id: 'fcId', name: '故障原因の ID', type: 'text' },
    { id: 'cause', name: '故障原因', type: 'text' },
    { id: 'o', name: 'O', type: 'number' },
  ],
  rows: [
    {
      id: 'r1',
      values: { fmId: 'FM-01', failure: '止まらない', fcId: 'FC-01', cause: '接点の溶着', o: 3 },
      refs: { causeCandidates: ['CC-01', 'CC-02'] },
    },
    {
      id: 'r2',
      values: { fmId: 'FM-01', failure: '止まらない', fcId: 'FC-02', cause: '感知の遅れ', o: 5 },
    },
  ],
  items: [
    { kind: 'failure-cause', id: 'fcId', title: 'cause', refs: ['fmId', 'refs.causeCandidates'] },
    { kind: 'failure-mode', id: 'fmId', title: 'failure', merge: { equal: ['failure'] } },
  ],
});

describe('Data schema 3: item declarations and row references', () => {
  it('accepts declarations by column ID and row reference fields only in schema 3', () => {
    const d = table();
    expect(isStructuredData(d)).toBe(true);
    // 2 以下は宣言も行の参照も持たない（古い版が黙って落とさないよう版で分ける）
    expect(isStructuredData({ ...d, schemaVersion: 2 })).toBe(false);
    const { items: _i, ...noItems } = d;
    expect(isStructuredData({ ...noItems, schemaVersion: 2 })).toBe(false);
    expect(
      isStructuredData({
        ...noItems,
        schemaVersion: 2,
        rows: d.rows.map(({ refs: _r, ...r }) => r),
      }),
    ).toBe(true);
  });

  it('refuses declarations that name missing or non-text columns, and malformed row refs', () => {
    const d = table();
    const bad: unknown[] = [
      [],
      [{ kind: 'x', id: 'missing', title: 'cause' }],
      [{ kind: 'x', id: 'o', title: 'cause' }],
      [{ kind: 'x', id: 'fcId', title: 'cause', refs: ['fcId'] }],
      [{ kind: 'x', id: 'fcId', title: 'cause', refs: ['o'] }],
      [{ kind: 'x', id: 'fcId', title: 'cause', refs: ['refs.__proto__'] }],
      [{ kind: 'x', id: 'fcId', title: 'cause', merge: { equal: ['nope'] } }],
      [{ kind: 'x', id: 'fcId', title: 'cause', code: 'x' }],
    ];
    for (const items of bad) {
      expect(dataItemsProblems(items, d.columns).length, JSON.stringify(items)).toBeGreaterThan(0);
      expect(isStructuredData({ ...d, items })).toBe(false);
    }
    for (const refs of [{ a: 'CC-01' }, { a: ['CC-01', 'CC-01'] }, { a: [''] }, { a: [1] }]) {
      const rows = [{ ...d.rows[0]!, refs }, d.rows[1]!];
      expect(isStructuredData({ ...d, rows } as unknown), JSON.stringify(refs)).toBe(false);
    }
  });

  it('turns declarations into an items@1-draft declaration that reads the saved table', () => {
    const d = table();
    const declaration = dataItemsDeclaration(d)!;
    expect(declaration.collections[0]).toEqual({
      at: 'rows',
      id: 'values.fcId',
      title: 'values.cause',
      refs: ['values.fmId', 'refs.causeCandidates'],
    });
    const r = readItems(declaration, d, () => undefined);
    expect(r.items.map((i) => [i.id, i.refs, i.elements])).toEqual([
      ['FC-01', ['FM-01', 'CC-01', 'CC-02'], ['0']],
      ['FC-02', ['FM-01'], ['1']],
      ['FM-01', [], ['0', '1']],
    ]);
    expect(dataItemsDeclaration({ items: undefined })).toBeUndefined();
  });

  it('edits a reference field with one command per change, with Undo and Redo, and keeps cells untouched', () => {
    const session = new EditorSession(table());
    session.execute(setRowRefs('r2', 'causeCandidates', ['CC-03']));
    expect(session.content.rows[1]!.refs).toEqual({ causeCandidates: ['CC-03'] });
    session.execute(setRowRefs('r1', 'causeCandidates', []));
    expect(session.content.rows[0]!.refs).toBeUndefined();
    expect(session.content.rows[0]!.values).toEqual(table().rows[0]!.values);
    expect(isStructuredData(session.content)).toBe(true);
    session.undo();
    expect(session.content.rows[0]!.refs).toEqual({ causeCandidates: ['CC-01', 'CC-02'] });
    session.redo();
    expect(session.content.rows[0]!.refs).toBeUndefined();
    // セルの編集は参照の欄を残す
    session.execute(setCell('r2', 'o', 6));
    expect(session.content.rows[1]!.refs).toEqual({ causeCandidates: ['CC-03'] });
    expect(() => setRowRefs('r1', 'other', ['X']).apply(table())).toThrow(/not declared/);
    expect(() =>
      setRowRefs('r1', 'causeCandidates', ['X']).apply({ ...table(), schemaVersion: 2 }),
    ).toThrow(/schema 3/);
  });

  it('removes a deleted column from the declarations in the same command, and Undo restores both', () => {
    const before = table();
    const session = new EditorSession(before);
    session.execute(removeColumn('fmId'));
    expect(session.content.items).toEqual([
      { kind: 'failure-cause', id: 'fcId', title: 'cause', refs: ['refs.causeCandidates'] },
    ]);
    expect(isStructuredData(session.content)).toBe(true);
    session.undo();
    expect(canonicalJson(session.content)).toBe(canonicalJson(before));
    expect(itemsWithoutColumn(before.items, 'cause')![0]!.title).toBe('fcId');
    expect(itemsWithoutColumn([{ kind: 'x', id: 'fcId', title: 'cause' }], 'fcId')).toBeUndefined();
  });

  it('AR3 refuses a newer schema than this version reads, so it cannot drop fields it does not know', () => {
    expect(isStructuredData({ ...table(), schemaVersion: 4 })).toBe(false);
    expect(isStructuredData(table())).toBe(true);
  });

  it('AR3 keeps declarations and row references through edits made without a Host', () => {
    // Without a Host there is no reference field; ordinary edits must not drop or move references
    let d = setCells(
      [{ rowId: 'r1', columnId: 'cause', value: '接点の溶着（直した）' }],
      'Edit',
    ).apply(table());
    d = reorderRow('r2', 'r1').apply(d);
    expect(d.rows.map((r) => r.id)).toEqual(['r2', 'r1']);
    expect(d.rows.find((r) => r.id === 'r1')!.refs).toEqual({
      causeCandidates: ['CC-01', 'CC-02'],
    });
    expect(d.items).toEqual(table().items);
    d = deleteRows(['r2']).apply(d);
    expect(d.rows[0]!.refs).toEqual({ causeCandidates: ['CC-01', 'CC-02'] });
    expect(isStructuredData(d)).toBe(true);
  });

  it('keeps ID and title columns text, and keeps schema 3 through edits that write schema 2', () => {
    expect(() => updateColumn('fcId', { type: 'number' }).apply(table())).toThrow(
      /must stay a text field/,
    );
    expect(updateColumn('fcId', { name: 'FC' }).apply(table()).items).toEqual(table().items);
    const viewed = saveView(defaultView(table())).apply(table());
    expect(viewed.schemaVersion).toBe(3);
    expect(isStructuredData(viewed)).toBe(true);
  });

  it('writes reference fields to CSV as trailing read-only columns, and CSV import makes no items', () => {
    const csv = exportCsv(table());
    expect(csv.split('\r\n')[0]).toBe(
      '故障モードの ID,故障モード,故障原因の ID,故障原因,O,refs.causeCandidates',
    );
    expect(csv.split('\r\n')[1]).toBe('FM-01,止まらない,FC-01,接点の溶着,3,CC-01;CC-02');
    const back = importCsv(csv);
    expect(back.items).toBeUndefined();
    expect(back.rows.every((r) => r.refs === undefined)).toBe(true);
  });

  it('shows reference field changes in the version comparison', () => {
    const after = setRowRefs('r1', 'causeCandidates', ['CC-02']).apply(table());
    expect(dataDiff(table(), after).changes).toEqual([
      expect.objectContaining({
        elementId: 'r1',
        path: 'FM-01 / refs.causeCandidates',
        before: 'CC-01;CC-02',
        after: 'CC-02',
      }),
    ]);
  });

  it('shows a reference change even when an ID contains the CSV separator', () => {
    const one = setRowRefs('r1', 'causeCandidates', ['CC-1;CC-2']).apply(table());
    const two = setRowRefs('r1', 'causeCandidates', ['CC-1', 'CC-2']).apply(table());
    expect(dataDiff(one, two).changes).toHaveLength(1);
  });

  it('writes reference fields in the scoped CSV download too', () => {
    const out = prepareCsvExport(table(), { rowsScope: 'all', columnsScope: 'all' });
    expect(out.csv.split('\r\n')[0]!.endsWith(',refs.causeCandidates')).toBe(true);
    expect(out.csv.split('\r\n')[1]!.endsWith(',CC-01;CC-02')).toBe(true);
  });

  it('refuses formula columns in a merge, and keeps compared columns from becoming formulas', () => {
    const d = table();
    const columns = [
      ...d.columns,
      { id: 'rpn', name: 'RPN', type: 'formula' as const, formula: 'O * 2' },
    ];
    expect(
      dataItemsProblems(
        [{ kind: 'x', id: 'fmId', title: 'failure', merge: { equal: ['rpn'] } }],
        columns,
      ),
    ).toEqual(['items[0].merge: must be { equal: column IDs }']);
    expect(() => updateColumn('failure', { type: 'formula', formula: 'O' }).apply(d)).toThrow(
      /must stay a text field|cannot become a formula/,
    );
    const withO = {
      ...d,
      items: [{ kind: 'x', id: 'fmId', title: 'failure', merge: { equal: ['o'] } }],
    };
    expect(() => updateColumn('o', { type: 'formula', formula: 'O' }).apply(withO)).toThrow(
      /cannot become a formula/,
    );
  });

  it('shows reference-only edits in the proposal diff', () => {
    const after = setRowRefs('r1', 'causeCandidates', ['CC-02']).apply(table());
    const diff = dataProposalDiff.diff(table(), after);
    expect(diff.changes).toEqual([
      expect.objectContaining({
        elementId: 'r1',
        property: 'refs.causeCandidates',
        before: ['CC-01', 'CC-02'],
        after: ['CC-02'],
      }),
    ]);
  });

  it('refuses reference lists that saved tables would reject, before changing content', () => {
    for (const ids of [
      ['CC-01', 'CC-01'],
      [''],
      ['x'.repeat(129)],
      Array.from({ length: 501 }, (_, i) => `CC-${i}`),
    ])
      expect(() => setRowRefs('r1', 'causeCandidates', ids)).toThrow(/distinct, non-empty/);
  });

  it('shows references of added and removed records in the proposal diff, apart from a refs column', () => {
    const d = {
      ...table(),
      columns: [...table().columns, { id: 'refs', name: 'メモ', type: 'text' as const }],
    };
    const row = {
      id: 'r3',
      values: { fcId: 'FC-03', refs: 'セルの値' },
      refs: { causeCandidates: ['CC-09'] },
    };
    const added = { ...d, rows: [...d.rows, row] };
    expect(dataProposalDiff.diff(d, added).changes).toEqual([
      expect.objectContaining({
        kind: 'added',
        elementId: 'r3',
        property: 'record',
        after: row.values,
      }),
      expect.objectContaining({
        kind: 'added',
        elementId: 'r3',
        property: 'refs.causeCandidates',
        after: ['CC-09'],
      }),
    ]);
    expect(dataProposalDiff.diff(added, d).changes).toEqual([
      expect.objectContaining({
        kind: 'removed',
        elementId: 'r3',
        property: 'record',
        before: row.values,
      }),
      expect.objectContaining({
        kind: 'removed',
        elementId: 'r3',
        property: 'refs.causeCandidates',
        before: ['CC-09'],
      }),
    ]);
  });
});
