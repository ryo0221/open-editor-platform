import { describe, expect, it } from 'vitest';
import {
  cellValue,
  isStructuredData,
  setCell,
  validateData,
} from '@editor-platform/structured-data';
import { createFmeaData, fmeaTemplateOptions, inspectFmeaData, isFmeaData } from './fmea-templates';
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
