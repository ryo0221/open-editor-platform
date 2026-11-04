import { expect, it } from 'vitest';
import { layoutPrintTable, printGraphemes, placePrintLine, printTextLines } from './print-layout';
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
it('lays printed text out per displayed character', () => {
  const text = 'が👨‍👩‍👧a\r\nb';
  expect(printGraphemes(text)).toEqual(['が', '👨‍👩‍👧', 'a', '\n', 'b']);
  const result = layoutPrintTable(
    {
      id: 'table',
      type: 'table',
      text: '',
      cells: [['が']],
      cellRich: [[[{ text: 'が👨‍👩‍👧', emphasisDots: true }]]],
    },
    600,
    () => 13,
  );
  expect(result.cells[0].lines[0].map((t) => t.text)).toEqual(['が', '👨‍👩‍👧']);
});
it('breaks printed lines with each ruby base whole and spread under a wider reading', () => {
  const ruby = { text: 'とうきょう', base: '東京' };
  const lines = printTextLines(
    [{ text: 'あいう' }, { text: '東京', ruby }, { text: 'え\nお\n' }],
    80,
    () => 16,
    (text) => text.length * 8,
  );
  // 東京 (32) does not fit after あいう (48) in 80 and moves whole to the next line; its
  // 40-wide reading spreads it by 4 on each side.
  expect(lines.map((line) => line.map((u) => u.tokens.map((t) => t.text).join('')))).toEqual([
    ['あ', 'い', 'う'],
    ['東京', 'え'],
    ['お'],
  ]);
  expect(lines[1][0]).toMatchObject({ width: 40, pad: 4, ruby: { text: 'とうきょう', width: 40 } });
  expect(
    printTextLines(
      [{ text: '\n' }],
      80,
      () => 16,
      () => 0,
    ),
  ).toHaveLength(1);
  expect(
    printTextLines(
      [],
      80,
      () => 16,
      () => 0,
    ),
  ).toEqual([[]]);
  expect(() =>
    printTextLines(
      [{ text: '東'.repeat(10), ruby: { text: 'と', base: '東'.repeat(10) } }],
      80,
      () => 16,
      () => 8,
    ),
  ).toThrow('1行より長いため印刷できません');
  // Lines move down only where a reading or 傍点 meets the ink before it.
  const plain = { floor: 16 * 1.2 - 16, underDots: false };
  expect(placePrintLine(lines[1], 16, 16, plain).top).toBeCloseTo(16 * 0.2 + 16 * 0.38 + 1);
  expect(placePrintLine(lines[0], 16, 16, plain).top).toBe(0);
  const dotted = printTextLines(
    [{ text: '東京', ruby, emphasisDots: true }],
    80,
    () => 16,
    () => 40,
  )[0];
  const afterDots = placePrintLine(dotted, 16, 16 * 1.65, plain).ink;
  expect(afterDots).toEqual({ floor: 16 * 1.38 - 16 * 1.65, underDots: true });
  // Dots under a ruby and the next line's reading share the gap, even at the default height…
  expect(placePrintLine(lines[1], 16, 16 * 1.65, afterDots).top).toBeCloseTo(
    16 * 1.38 + 16 * 0.38 + 1 - 16 * 1.65,
  );
  // …as do dots over the next line's plain text, and a plain line after the dots.
  const plainDots = printTextLines(
    [{ text: '本当', emphasisDots: true }],
    80,
    () => 16,
    () => 0,
  )[0];
  const tight = placePrintLine(dotted, 16, 16 * 1.5, plain).ink;
  expect(placePrintLine(plainDots, 16, 16 * 1.5, tight).top).toBeCloseTo(
    16 * 1.38 + 16 * 0.14 - 16 * 1.5,
  );
  expect(placePrintLine(lines[0], 16, 16, tight).top).toBe(0);
  // A highlight is painted from the line's top, so it too stays below dots under a ruby.
  const highlighted = printTextLines(
    [{ text: '本当', highlight: '#fff3a3' }],
    80,
    () => 16,
    () => 0,
  )[0];
  expect(placePrintLine(highlighted, 16, 16 * 1.2, afterDots).top).toBe(0);
  const tightDots = placePrintLine(dotted, 16, 16 * 1.2, plain).ink;
  expect(placePrintLine(highlighted, 16, 16 * 1.2, tightDots).top).toBeCloseTo(16 * 0.18);
  // A reading after a highlight stays clear of the background's bottom at the line height.
  const afterHighlight = placePrintLine(highlighted, 16, 16 * 1.65, plain).ink;
  expect(afterHighlight).toEqual({ floor: 0, underDots: false });
  expect(placePrintLine(lines[1], 16, 16 * 1.65, afterHighlight).top).toBeCloseTo(16 * 0.38 + 1);
  const twoReadings = placePrintLine(lines[1], 16, 16 * 1.65, plain).ink;
  expect(placePrintLine(lines[1], 16, 16 * 1.65, twoReadings).top).toBe(0);
});
