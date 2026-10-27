import { describe, expect, it } from 'vitest';
import { csvColumnWidths, csvMatches, isCsv, parseCsv } from './csv';

describe('parseCsv', () => {
  it('keeps quoted commas, line breaks and doubled quotes in one cell with source lines', () => {
    const { records, columns } = parseCsv(
      '﻿name,note\r\nTurbine,"blade, 3"\r\nHub,"line one\nline two"\n"Say ""hi""",\n',
    );
    expect(columns).toBe(2);
    expect(records).toEqual([
      { cells: ['name', 'note'], start: 1, end: 1 },
      { cells: ['Turbine', 'blade, 3'], start: 2, end: 2 },
      { cells: ['Hub', 'line one\nline two'], start: 3, end: 4 },
      { cells: ['Say "hi"', ''], start: 5, end: 5 },
    ]);
  });

  it('keeps ragged rows and a last row without a line break', () => {
    const { records, columns } = parseCsv('a,b,c\n1\n2,3');
    expect(columns).toBe(3);
    expect(records.map((r) => r.cells)).toEqual([['a', 'b', 'c'], ['1'], ['2', '3']]);
    expect(records.at(-1)).toMatchObject({ start: 3, end: 3 });
  });

  it('keeps a last record whose only cell is a quoted empty value', () => {
    expect(parseCsv('header\n""').records).toEqual([
      { cells: ['header'], start: 1, end: 1 },
      { cells: [''], start: 2, end: 2 },
    ]);
  });

  it('searches the decoded cells and gives one width per column for every row', () => {
    const { records, columns } = parseCsv(
      'name,note\n"Say ""hi""",x\nHub,"a very long note\nshort"\n',
    );
    expect(csvMatches(records, 'say "HI"')).toEqual([1]);
    expect(csvMatches(records, '""')).toEqual([]);
    expect(csvColumnWidths(records, columns)).toEqual([10, 18]);
    expect(csvColumnWidths([{ cells: ['x'.repeat(200)], start: 1, end: 1 }], 1)).toEqual([48]);
  });

  it('detects CSV by type or by name', () => {
    expect(isCsv('text/csv', 'data.txt')).toBe(true);
    expect(isCsv('text/plain', 'DATA.CSV')).toBe(true);
    expect(isCsv('text/plain', 'session.log')).toBe(false);
  });
});
