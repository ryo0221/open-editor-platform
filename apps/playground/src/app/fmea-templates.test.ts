import { describe, expect, it } from 'vitest';
import {
  cellValue,
  isStructuredData,
  setCell,
  validateData,
} from '@editor-platform/structured-data';
import { readItems } from '@editor-platform/extension-runtime/items';
import { dataItemsDeclaration, removeRow, setRowRefs } from '@editor-platform/structured-data';
import {
  createFmeaData,
  fmeaItemIssues,
  fmeaTemplateOptions,
  inspectFmeaData,
  isFmeaData,
} from './fmea-templates';
import { makeArtifact } from '../model';

describe('FMEA Structured Data templates', () => {
  it.each(['pfmea', 'dfmea'] as const)(
    '%s uses native Data with stable row IDs, valid views and editable ratings',
    (which) => {
      const data = createFmeaData(which);
      expect(isStructuredData(data)).toBe(true);
      expect(isFmeaData(data)).toBe(true);
      expect(validateData(data)).toEqual([]);
      expect(data.views?.map((view) => view.name)).toEqual(['リスク分析', '対策管理']);
      expect(new Set(data.rows.map((row) => row.id)).size).toBe(data.rows.length);
      expect(JSON.parse(JSON.stringify(data))).toEqual(data);
      expect(inspectFmeaData(data)).toMatchObject({ rowCount: 3, apPending: 3, issues: [] });
    },
  );

  it('computes RPN from S/O/D with normal Data formulas and keeps AP unassigned', () => {
    const data = createFmeaData('pfmea');
    const rpn = data.columns.find((column) => column.id === 'rpn')!;
    expect(cellValue(data, data.rows[0], rpn)).toBe(210);
    const changed = setCell(data.rows[0].id, 'o', 3).apply(data);
    expect(cellValue(changed, changed.rows[0], rpn)).toBe(126);
    expect(changed.rows[0].values.ap).toBe('未評価');
    expect(data.rows[0].values.o).toBe(5);
    expect(data.rows[0].id).toBe(changed.rows[0].id);
  });

  it('flags rating ranges and noninteger numbers that native Data does not restrict', () => {
    const data = createFmeaData('dfmea');
    for (const badValue of [0, 11, 1.5, -2]) {
      const changed = setCell(data.rows[0].id, 's', badValue).apply(data);
      expect(inspectFmeaData(changed).issues.some((issue) => issue.includes('/ S:'))).toBe(true);
    }
  });

  it('flags missing and invalid ratings without inventing a valid risk classification', () => {
    const data = createFmeaData('pfmea');
    const changed = setCell(data.rows[0].id, 'o', null).apply(data);
    expect(inspectFmeaData(changed).issues.length).toBeGreaterThan(0);
    const badText = setCell(data.rows[0].id, 'o', 'unknown').apply(data);
    expect(inspectFmeaData(badText).issues.length).toBeGreaterThan(0);
    const result = inspectFmeaData(data);
    expect(result.apPending).toBe(data.rows.length);
  });

  it('does not confuse a regular Data artifact with FMEA', () => {
    expect(fmeaTemplateOptions.map((option) => option.id)).toEqual(['blank', 'pfmea', 'dfmea']);
    const data = createFmeaData('pfmea');
    expect(
      isFmeaData({ ...data, columns: data.columns.filter((column) => column.id !== 'ap') }),
    ).toBe(false);
  });

  it('keeps the FMEA checks after the RPN formula or a rating column name is edited', () => {
    const data = createFmeaData('pfmea');
    const edited = {
      ...data,
      columns: data.columns.map((column) =>
        column.id === 'rpn'
          ? { ...column, formula: 'O * S * D' }
          : column.id === 's'
            ? { ...column, name: '重大度' }
            : column,
      ),
    };
    expect(isFmeaData(edited)).toBe(true);
    const invalid = setCell(edited.rows[0].id, 's', 11).apply(edited);
    expect(inspectFmeaData(invalid).issues.some((issue) => issue.includes('/ S:'))).toBe(true);
  });

  it('creates PFMEA, DFMEA and blank Data through the registered Data kind', () => {
    const pfmea = makeArtifact('data', 1, 'relations', undefined, 'empty', 'pfmea');
    expect(pfmea.kind).toBe('data');
    expect(pfmea.name).toBe('PFMEA: 製造工程（試作）');
    expect(isFmeaData(pfmea.draft.content as never)).toBe(true);
    const dfmea = makeArtifact('data', 2, 'relations', undefined, 'empty', 'dfmea');
    expect(dfmea.name).toBe('DFMEA: 製品設計（試作）');
    const blank = makeArtifact('data', 3);
    expect(blank.name).toBe('Structured Data 3');
    expect(isFmeaData(blank.draft.content as never)).toBe(false);
  });
});

describe('FMEA analysis items (AR1)', () => {
  /** The process example with business IDs: rows 1 and 2 share failure mode FM-01. */
  const withIds = () => {
    const data = createFmeaData('pfmea');
    const ids: [string, string, string][] = [
      ['FN-01', 'FM-01', 'FC-01'],
      ['FN-01', 'FM-01', 'FC-02'],
      ['FN-02', 'FM-02', 'FC-03'],
    ];
    data.rows.forEach((row, i) => {
      const [fn, fm, fc] = ids[i]!;
      Object.assign(row.values, { functionRef: fn, fmId: fm, fcId: fc });
    });
    // FM-01 の 2 行は、故障モード・故障影響・S・要求機能を揃える
    Object.assign(data.rows[1]!.values, {
      function: data.rows[0]!.values.function,
      failure: data.rows[0]!.values.failure,
      effect: data.rows[0]!.values.effect,
      s: data.rows[0]!.values.s,
    });
    return data;
  };
  const items = (data: ReturnType<typeof createFmeaData>) =>
    readItems(dataItemsDeclaration(data)!, data, () => undefined);

  it('declares failure causes per row and failure modes projected from rows, with no IDs in the template', () => {
    const data = createFmeaData('dfmea');
    expect(data.schemaVersion).toBe(3);
    expect(data.items!.map((d) => d.kind)).toEqual(['failure-cause', 'failure-mode']);
    expect(items(data).items).toEqual([]);
  });

  it('reads FC → FM and FC → CC citations, and one FM for rows that share its ID', () => {
    let data = withIds();
    data = setRowRefs(data.rows[0]!.id, 'causeCandidates', ['CC-01', 'CC-02']).apply(data);
    expect(isStructuredData(data)).toBe(true);
    const r = items(data);
    expect(r.duplicates).toEqual([]);
    expect(r.items.map((i) => [i.id, i.refs, i.elements])).toEqual([
      ['FC-01', ['FM-01', 'CC-01', 'CC-02'], ['0']],
      ['FC-02', ['FM-01'], ['1']],
      ['FC-03', ['FM-02'], ['2']],
      ['FM-01', ['FN-01'], ['0', '1']],
      ['FM-02', ['FN-02'], ['2']],
    ]);
    expect(fmeaItemIssues(data)).toEqual([]);
  });

  it('keeps FM-01 when one of its rows is deleted, and changes nothing in FM-01 when only O or D changes', () => {
    const data = withIds();
    const fm = (d: typeof data) => items(d).items.find((i) => i.id === 'FM-01')!;
    const before = fm(data);
    const rest = removeRow(data.rows[0]!.id).apply(data);
    expect(fm(rest).body).toEqual(before.body);
    expect(fm(rest).elements).toEqual(['0']);
    const rated = setCell(data.rows[1]!.id, 'o', 9).apply(data);
    expect(fm(rated).body).toEqual(before.body);
  });

  it('diagnoses an FM whose rows disagree and leaves the cells for the user to fix', () => {
    const data = setCell(withIds().rows[1]!.id, 'effect', '別の影響').apply(withIds());
    expect(fmeaItemIssues(data)).toEqual([
      'FM-01 の故障影響が行ごとに違います（pfmea-001・pfmea-002）。',
    ]);
    expect(inspectFmeaData(data).issues).toContain(
      'FM-01 の故障影響が行ごとに違います（pfmea-001・pfmea-002）。',
    );
    expect(items(data).items.map((i) => i.id)).not.toContain('FM-01');
  });

  it('opens an older FMEA table without declarations as it is: no items', () => {
    const data = createFmeaData('pfmea');
    const { items: _i, ...old } = { ...data, schemaVersion: 2 as const };
    expect(isStructuredData(old)).toBe(true);
    expect(isFmeaData(old)).toBe(true);
    expect(fmeaItemIssues(old)).toEqual([]);
  });
});
