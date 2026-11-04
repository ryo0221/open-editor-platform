import { rubyGroups, type DocumentBlock, type InlineSpan } from './model';

const segmenter = new Intl.Segmenter('ja', { granularity: 'grapheme' });
/** Printed text is laid out per displayed character, so a combining mark or an emoji sequence
 * is never split across lines or given its own 傍点. */
export const printGraphemes = (text: string) =>
  Array.from(segmenter.segment(text), (s) => (s.segment === '\r\n' ? '\n' : s.segment));
/** One unbreakable piece of a printed line: a character, or a ruby base with its reading.
 * A reading wider than its base spreads the base by `pad` on each side, so readings never
 * overlap their neighbours. */
export interface PrintUnit {
  tokens: { text: string; span: InlineSpan; width: number }[];
  width: number;
  pad: number;
  ruby?: { text: string; width: number };
}
/** Greedy horizontal line breaking shared by drawing and measuring, so both agree. */
export function printTextLines(
  spans: InlineSpan[],
  available: number,
  measure: (text: string, span: InlineSpan) => number,
  measureRuby: (text: string) => number,
): PrintUnit[][] {
  const lines: PrintUnit[][] = [[]];
  let used = 0,
    broken = false;
  const place = (unit: PrintUnit) => {
    if (used + unit.width > available && lines.at(-1)!.length) {
      lines.push([]);
      used = 0;
    }
    lines.at(-1)!.push(unit);
    used += unit.width;
    broken = false;
  };
  for (const { spans: group, ruby } of rubyGroups(spans)) {
    if (ruby) {
      const tokens = group.flatMap((span) =>
        printGraphemes(span.text)
          .filter((text) => text !== '\n')
          .map((text) => ({ text, span, width: measure(text, span) })),
      );
      if (!tokens.length) continue;
      const base = tokens.reduce((n, t) => n + t.width, 0),
        width = measureRuby(ruby.text),
        pad = Math.max(0, (width - base) / 2);
      if (base + pad * 2 > available + 0.01)
        throw new Error(
          `ルビの親文字「${tokens
            .map((t) => t.text)
            .join('')
            .slice(
              0,
              20,
            )}」が1行より長いため印刷できません。親文字を短くするか文字を小さくしてください。`,
        );
      place({ tokens, width: base + pad * 2, pad, ruby: { text: ruby.text, width } });
      continue;
    }
    for (const span of group)
      for (const text of printGraphemes(span.text)) {
        if (text === '\n') {
          lines.push([]);
          used = 0;
          broken = true;
          continue;
        }
        const width = measure(text, span);
        place({ tokens: [{ text, span, width }], width, pad: 0 });
      }
  }
  // A final line break ends the last line rather than starting an empty one.
  if (broken && lines.length > 1) lines.pop();
  return lines;
}
/** Where a printed line's ink reaches, in ems from its top: text from 0.12 to 1.2 below the top,
 * a highlight across the whole line height, a reading up to 0.38em (+1px) above it, 傍点 over
 * plain text up to 0.14em above it, and 傍点 under a ruby down to 1.38. */
export const printLineReach = (line: PrintUnit[], size: number, lineHeight: number) => {
  const dots = (ruby: boolean) =>
    line.some((u) => !!u.ruby === ruby && u.tokens.some((t) => t.span.emphasisDots));
  const highlighted = line.some((u) => u.tokens.some((t) => t.span.highlight));
  const underDots = dots(true);
  return {
    above: line.some((u) => u.ruby)
      ? size * 0.38 + 1
      : dots(false)
        ? size * 0.14
        : highlighted
          ? 0
          : -size * 0.12,
    below: Math.max(underDots ? size * 1.38 : size * 1.2, highlighted ? lineHeight : 0),
    underDots,
  };
};
/** The lowest ink so far, relative to where the next printed line starts, and whether it is 傍点
 * under a ruby. */
export interface PrintInk {
  floor: number;
  underDots: boolean;
}
/** How far a printed line moves down so its reading or 傍点 keeps clear of the ink before it,
 * and the ink it leaves for the next line. Lines without annotations next to plain text keep
 * their line height, however tight. */
export function placePrintLine(line: PrintUnit[], size: number, lineHeight: number, ink: PrintInk) {
  const reach = printLineReach(line, size, lineHeight);
  const top = reach.above > 0 || ink.underDots ? Math.max(0, ink.floor + reach.above) : 0;
  return {
    top,
    reach,
    ink: { floor: reach.below - lineHeight, underDots: reach.underDots },
  };
}
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
        for (const char of printGraphemes(span.text)) {
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
