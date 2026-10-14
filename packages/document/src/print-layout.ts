import type { DocumentBlock, InlineSpan } from './model';
export const tableLineHeight = 24;
export type PrintLine = { span: InlineSpan; text: string; width: number }[];
export interface PrintCell {
  x: number;
  y: number;
  width: number;
  height: number;
  header: boolean;
  lines: PrintLine[];
}
export function layoutPrintTable(
  block: DocumentBlock,
  width: number,
  measure: (text: string, span: InlineSpan) => number,
) {
  const rows = block.cells ?? [],
    cols = rows[0]?.length ?? 1;
  const raw =
    block.columnWidths?.length === cols ? block.columnWidths : Array<number>(cols).fill(1);
  const sum = raw.reduce((n, w) => n + w, 0),
    widths = raw.map((w) => (width * w) / sum);
  const x = [0];
  widths.forEach((w) => x.push(x.at(-1)! + w));
  const heights = rows.map(() => tableLineHeight * 2);
  const boxes: { row: number; col: number; rows: number; width: number; lines: PrintLine[] }[] = [];
  rows.forEach((row, r) =>
    row.forEach((value, c) => {
      const merge = block.merges?.find(
        (m) => r >= m.row && r < m.row + m.rows && c >= m.col && c < m.col + m.cols,
      );
      if (merge && (r !== merge.row || c !== merge.col)) return;
      const cellWidth = x[c + (merge?.cols ?? 1)] - x[c];
      const spans = block.cellParagraphs?.[r]?.[c]?.flatMap((p, i) => [
        ...(i ? [{ text: '\n' }] : []),
        ...p.rich,
      ]) ??
        block.cellRich?.[r]?.[c] ?? [{ text: value }];
      const lines: PrintLine[] = [[]];
      let used = 0;
      for (const original of spans) {
        const span = {
          ...((block.cellHeaders?.[r]?.[c] ?? r === 0) ? { bold: true } : {}),
          ...original,
        };
        for (const char of span.text) {
          const cw = measure(char, span);
          if (char === '\n' || (used + cw > cellWidth - 12 && lines.at(-1)!.length)) {
            lines.push([]);
            used = 0;
          }
          if (char !== '\n') {
            lines.at(-1)!.push({ span, text: char, width: cw });
            used += cw;
          }
        }
      }
      boxes.push({ row: r, col: c, rows: merge?.rows ?? 1, width: cellWidth, lines });
      if (!merge || merge.rows === 1)
        heights[r] = Math.max(heights[r], (lines.length + 1) * tableLineHeight);
    }),
  );
  for (const box of boxes) {
    const required = (box.lines.length + 1) * tableLineHeight;
    const available = heights.slice(box.row, box.row + box.rows).reduce((a, b) => a + b, 0);
    if (required > available) heights[box.row + box.rows - 1] += required - available;
  }
  const y = [0];
  heights.forEach((h) => y.push(y.at(-1)! + h));
  return {
    height: y.at(-1)!,
    rows: y,
    cells: boxes.map(
      (box): PrintCell => ({
        x: x[box.col],
        y: y[box.row],
        width: box.width,
        height: y[box.row + box.rows] - y[box.row],
        header: block.cellHeaders?.[box.row]?.[box.col] ?? box.row === 0,
        lines: box.lines,
      }),
    ),
  };
}
