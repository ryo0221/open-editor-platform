import { expect, it } from 'vitest';
import { layoutPrintTable } from './print-layout';
it('wraps long rich cells, preserves column ratios and expands spanning rows without losing text', () => {
  const body = '日本語の長い説明。'.repeat(200);
  const result = layoutPrintTable(
    {
      id: 'table',
      type: 'table',
      text: '',
      columnWidths: [100, 200],
      cells: [
        ['項目', '説明'],
        ['結合', body],
        ['', '続き'],
      ],
      cellRich: [
        [[{ text: '項目' }], [{ text: '説明' }]],
        [[{ text: '結合', bold: true }], [{ text: body, color: '#cc3300' }]],
        [[{ text: '' }], [{ text: '続き' }]],
      ],
      merges: [{ row: 1, col: 0, rows: 2, cols: 1 }],
    },
    600,
    () => 13,
  );
  expect(result.cells).toHaveLength(5);
  expect(result.cells[0].width).toBe(200);
  const long = result.cells.find((c) => c.x === 200 && !c.header)!;
  expect(
    long.lines
      .flat()
      .map((c) => c.text)
      .join(''),
  ).toBe(body);
  expect(long.height).toBeGreaterThan(1000);
  expect(long.height % 24).toBe(0);
  expect(result.cells.find((c) => c.x === 0 && !c.header)!.height).toBe(
    result.height - result.rows[1],
  );
  expect(long.lines[0][0].span.color).toBe('#cc3300');
});
