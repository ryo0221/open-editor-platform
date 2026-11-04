import { breakJapaneseLines } from '@editor-platform/editor-core';
import type { PrintedTextLine } from './pdf-text';
import {
  blockFontSize,
  blockLineHeight,
  blockSpaceAfter,
  blockSpans,
  emphasisDot,
  paintEmphasisDot,
  printFont,
} from './print-renderer';
import {
  rubyGroups,
  uprightDigitRanges,
  type DocumentBlock,
  type DocumentContent,
  type InlineSpan,
} from './model';

/** Vertical print covers the novel manuscript subset; other blocks have no vertical layout yet. */
const verticalBlockTypes = new Set(['paragraph', 'heading']);
const blockLabels: Record<string, string> = {
  image: '画像',
  table: '表',
  mermaid: '図',
  code: 'コード',
  html: 'HTML',
  'bulleted-list': '箇条書き',
  'numbered-list': '番号付きリスト',
  'check-list': 'チェックリスト',
};
export function checkVerticalPrintBlocks(blocks: DocumentBlock[]) {
  const unsupported = [
    ...new Set(blocks.filter((b) => !verticalBlockTypes.has(b.type)).map((b) => b.type)),
  ];
  if (unsupported.length)
    throw new Error(
      `縦書きの印刷・PDFは段落と見出しだけに対応しています。未対応: ${unsupported.map((t) => blockLabels[t] ?? t).join('、')}。横書きにするかDOCXで出力してください。`,
    );
}

/** 'rotated' glyphs lie on their side (brackets, dashes, Latin); 'small' sit in the upper right
 * of the cell (、。 and small kana); 'upright' groups are 縦中横. */
export type VerticalGlyphKind = 'plain' | 'rotated' | 'punctuation' | 'small' | 'upright';
export interface VerticalGlyph {
  text: string;
  /** Top of the glyph's cells, and its length along the column. */
  y: number;
  advance: number;
  kind: VerticalGlyphKind;
  span: InlineSpan;
  /** 傍点 beside the glyph: right of the column, or left where the run also has ruby. */
  dot?: 'right' | 'left';
}
export interface VerticalColumn {
  /** Centre of the column. */
  x: number;
  top: number;
  size: number;
  family?: string;
  glyphs: VerticalGlyph[];
  /** Each reading with its base's extent and the centre and size of every reading character. */
  ruby: {
    text: string;
    y: number;
    length: number;
    glyphs: { text: string; y: number; size: number }[];
  }[];
  /** Hanging punctuation extends past the column's cells into the bottom margin. */
  hanging: boolean;
}
export interface VerticalLayout {
  width: number;
  height: number;
  margin: number;
  pages: VerticalColumn[][];
}

const rotated = /^[「」『』（）〔〕［］｛｝〈〉《》【】〘〙〖〗ー～〜…‥—―－‐−=＝<>＜＞(){}[\]]$/u;
const punctuation = /^[、。，．]$/u;
const small = /^[ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶ]$/u;
// Full-width scripts take one cell; everything else is measured and set on its side.
const wide =
  /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3000-\u303f\uff01-\uff60\uffe0-\uffe6ー]/u;
// Emoji and keycaps stay upright as in CSS vertical text (Unicode vertical orientation U).
const uprightSymbol = /\p{Extended_Pictographic}|\u20e3|\ufe0f/u;
const isWide = (grapheme: string) => wide.test(grapheme) || uprightSymbol.test(grapheme);
const graphemes = new Intl.Segmenter('ja', { granularity: 'grapheme' });

/** A reading longer than its base overhangs it at full size and stays between `top` and
 * `bottom`. Readings in a column are fitted together: pushed down past the previous one, then
 * back up from the bottom, and only when they cannot all fit at full size are they set smaller. */
function placeRuby(col: VerticalColumn, top: number, bottom: number) {
  const rubySize = col.size * 0.5;
  const chars = col.ruby.map((r) => [...graphemes.segment(r.text)].map((s) => s.segment));
  const count = chars.reduce((n, c) => n + c.length, 0);
  const step = Math.min(rubySize, (bottom - top) / Math.max(1, count));
  const starts: number[] = [];
  let free = top;
  col.ruby.forEach((r, i) => {
    const total = step * chars[i].length;
    starts[i] = Math.max(free, r.y + (r.length - total) / 2);
    free = starts[i] + total;
  });
  let limit = bottom;
  for (let i = col.ruby.length - 1; i >= 0; i--) {
    starts[i] = Math.min(starts[i], limit - step * chars[i].length);
    limit = starts[i];
  }
  col.ruby.forEach((r, i) => {
    r.glyphs = chars[i].map((text, k) => ({ text, y: starts[i] + step * (k + 0.5), size: step }));
  });
}

function glyphKind(segment: string): Exclude<VerticalGlyphKind, 'upright'> {
  return punctuation.test(segment)
    ? 'punctuation'
    : small.test(segment)
      ? 'small'
      : rotated.test(segment) || !isWide(segment)
        ? 'rotated'
        : 'plain';
}

/** Deterministic vertical layout: columns run right to left, lines break with
 * `breakJapaneseLines` (kinsoku, hanging 、。, ruby bases and 縦中横 kept whole). `measure`
 * returns a horizontal glyph width in pixels for a CSS font, used only for Latin text. */
export function layoutVerticalDocument(
  content: DocumentContent,
  page: { width: number; height: number; margin: number },
  measure: (text: string, font: string) => number,
): VerticalLayout {
  const blocks = content.blocks.filter((b) => !b.hidden);
  checkVerticalPrintBlocks(blocks);
  const { width, height, margin } = page;
  const pages: VerticalColumn[][] = [[]];
  let x = width - margin;
  // Left edge of the previous column's text on this page (the paper's edge before the first);
  // ruby to a column's right must clear it.
  let previousLeft = width;
  /** `right` is how far marks reach right of the centre; `left`, past the text's left edge. */
  const column = (lineHeight: number, size: number, right: number, left: number) => {
    const centre = () => Math.min(x - lineHeight / 2, previousLeft - right);
    if (centre() - lineHeight / 2 < margin) {
      // Spacing never pushes a column off a page: an empty page drops it, a used one turns over.
      if (pages.at(-1)!.length) pages.push([]);
      x = width - margin;
      previousLeft = width;
      if (centre() - lineHeight / 2 < margin)
        throw new Error(
          '縦書きの行の幅が用紙に収まりません。余白か文字の大きさを小さくしてください。',
        );
    }
    const cx = centre();
    x = cx - lineHeight / 2;
    previousLeft = cx - size / 2 - left;
    return cx;
  };
  for (const block of blocks) {
    const size = blockFontSize(block);
    const lineHeight = blockLineHeight(block, size) ?? size * 1.75;
    const family = block.style?.fontFamily;
    if (block.style?.spaceBefore) x -= (block.style.spaceBefore * 4) / 3;
    const spans = blockSpans(block);
    const text = spans.map((s) => s.text).join('');
    const spanAt: number[] = [];
    spans.forEach((span, i) => {
      for (let k = 0; k < span.text.length; k++) spanAt.push(i);
    });
    const offsets: number[] = [];
    spans.reduce((offset, span) => (offsets.push(offset), offset + span.text.length), 0);
    const ruby = rubyGroups(spans)
      .filter((g) => g.ruby)
      .map((g) => {
        const start = offsets[g.start];
        const end = start + g.spans.reduce((n, s) => n + s.text.length, 0);
        return { start, end, text: g.ruby!.text };
      });
    // As in the editor, a digit run split by formatting stays in the text direction.
    const upright = uprightDigitRanges(text)
      .filter(([a, b]) => spanAt[a] === spanAt[b - 1])
      .map(([start, end]) => ({ start, end }));
    const uprightAt = new Map(upright.map((r) => [r.start, r]));
    const uprightOf = new Map<number, { start: number; end: number }>();
    for (const r of upright) for (let k = r.start; k < r.end; k++) uprightOf.set(k, r);
    const indent = (block.indent ?? 0) * 1.5 * size;
    const lineLength = Math.max(1, Math.floor((height - margin * 2 - indent) / size));
    const cells = (grapheme: string, offset: number) => {
      const group = uprightOf.get(offset);
      if (group) return 1 / (group.end - group.start);
      if (grapheme === '\r') return 0;
      if (isWide(grapheme)) return 1;
      return Math.min(1, measure(grapheme, printFont(spans[spanAt[offset]], size, family)) / size);
    };
    const lines = breakJapaneseLines(text, {
      lineLength,
      hanging: true,
      unbreakable: [...ruby, ...upright],
      measure: cells,
    });
    const available = height - margin * 2 - indent;
    let nextRuby = 0;
    for (const line of lines) {
      let hasRuby = false;
      for (let i = nextRuby; i < ruby.length && ruby[i].end <= line.end; i++)
        if (ruby[i].start >= line.start) hasRuby = true;
      const col: VerticalColumn = {
        x: 0,
        top: margin + indent,
        size,
        ...(family ? { family } : {}),
        glyphs: [],
        ruby: [],
        hanging: line.hanging,
      };
      let y = col.top;
      const yAt = new Map<number, number>();
      for (const { segment, index } of graphemes.segment(text.slice(line.start, line.end))) {
        const offset = line.start + index;
        yAt.set(offset, y);
        const span = spans[spanAt[offset]];
        if (segment === '\r') continue;
        const group = uprightAt.get(offset);
        const dot = span.emphasisDots && !/^[\s\p{P}]+$/u.test(segment) ? dotSide(span) : {};
        if (group) {
          col.glyphs.push({
            text: text.slice(group.start, group.end),
            y,
            advance: size,
            kind: 'upright',
            span,
            ...dot,
          });
          y += size;
          continue;
        }
        if (uprightOf.has(offset)) continue;
        const advance = cells(segment, offset) * size;
        const kind = glyphKind(segment);
        col.glyphs.push({ text: segment, y, advance, kind, span, ...dot });
        y += advance;
      }
      const dots = new Set(col.glyphs.map((g) => g.dot));
      col.x = column(
        lineHeight,
        size,
        Math.max(
          size / 2,
          hasRuby ? size / 2 + 1 + size * 0.5 : 0,
          dots.has('right') ? size / 2 + emphasisDot.reach * size : 0,
        ),
        dots.has('left') ? emphasisDot.reach * size : 0,
      );
      yAt.set(line.end, y);
      // Only an unbreakable group (a ruby base) can overflow; never cut it off silently.
      const hung = line.hanging ? (col.glyphs.at(-1)?.advance ?? 0) : 0;
      if (y - col.top - hung > available + 0.01)
        throw new Error(
          `ルビの親文字「${text.slice(line.start, line.end).slice(0, 20)}」が縦書きの1行より長いため印刷できません。親文字を短くするか文字を小さくしてください。`,
        );
      // Rubies are in text order and each lies within one line.
      while (nextRuby < ruby.length && ruby[nextRuby].end <= line.end) {
        const r = ruby[nextRuby++];
        if (r.start >= line.start)
          col.ruby.push({
            text: r.text,
            y: yAt.get(r.start)!,
            length: yAt.get(r.end)! - yAt.get(r.start)!,
            glyphs: [],
          });
      }
      // Paragraph alignment runs along the column: right is the column's end.
      const shift =
        block.align === 'center'
          ? (available - (y - col.top)) / 2
          : block.align === 'right'
            ? available - (y - col.top)
            : 0;
      if (shift > 0) {
        col.top += shift;
        for (const g of col.glyphs) g.y += shift;
        for (const r of col.ruby) r.y += shift;
      }
      placeRuby(col, margin, height - margin);
      pages.at(-1)!.push(col);
    }
    x -= blockSpaceAfter(block);
  }
  return { width, height, margin, pages };
}

/** Text for the invisible search/copy layer, one entry per column in reading order. */
export function verticalTextLines(layout: VerticalLayout): PrintedTextLine[][] {
  let order = 0;
  return layout.pages.map((columns) =>
    columns.map((col) => {
      const last = col.glyphs.at(-1);
      return {
        text: col.glyphs.map((g) => g.text).join(''),
        x: col.x,
        y: col.top,
        size: col.size,
        width: last ? last.y + last.advance - col.top : 0,
        order: order++,
        vertical: true,
      };
    }),
  );
}

/** One glyph centred at (x, mid) in a vertical line of the given size. */
function paintText(
  ctx: CanvasRenderingContext2D,
  text: string,
  kind: Exclude<VerticalGlyphKind, 'upright'>,
  x: number,
  mid: number,
  size: number,
) {
  if (kind === 'rotated') {
    ctx.save();
    ctx.translate(x, mid);
    ctx.rotate(Math.PI / 2);
    ctx.fillText(text, 0, 0);
    ctx.restore();
    return;
  }
  // 、。 and small kana move from the lower left of a horizontal cell to the upper right.
  const shift = kind === 'punctuation' ? size * 0.55 : kind === 'small' ? size * 0.1 : 0;
  ctx.fillText(text, x + shift, mid - shift);
}

const dotSide = (span: InlineSpan) => ({ dot: span.ruby ? ('left' as const) : ('right' as const) });

function paintGlyph(ctx: CanvasRenderingContext2D, col: VerticalColumn, glyph: VerticalGlyph) {
  const { size } = col;
  const { span } = glyph;
  const mid = glyph.y + glyph.advance / 2;
  ctx.font = printFont(span, size, col.family);
  if (span.highlight) {
    ctx.fillStyle = span.highlight;
    ctx.fillRect(col.x - size / 2, glyph.y, size, glyph.advance);
  }
  ctx.fillStyle = span.color ?? '#253044';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (glyph.kind === 'upright') {
    const w = ctx.measureText(glyph.text).width;
    ctx.save();
    ctx.translate(col.x, mid);
    if (w > size * 0.95) ctx.scale((size * 0.95) / w, 1);
    ctx.fillText(glyph.text, 0, 0);
    ctx.restore();
  } else paintText(ctx, glyph.text, glyph.kind, col.x, mid, size);
  if (glyph.dot)
    paintEmphasisDot(
      ctx,
      col.x + (glyph.dot === 'right' ? 1 : -1) * (size / 2 + emphasisDot.offset * size),
      mid,
      size,
    );
  if (span.underline || span.link || span.strike) {
    ctx.strokeStyle = ctx.fillStyle;
    ctx.lineWidth = 0.8;
    const lineX = span.strike ? col.x : col.x + size * 0.6;
    ctx.beginPath();
    ctx.moveTo(lineX, glyph.y);
    ctx.lineTo(lineX, glyph.y + glyph.advance);
    ctx.stroke();
  }
}

export function paintVerticalPages(layout: VerticalLayout) {
  return layout.pages.map((columns, index) => {
    const canvas = document.createElement('canvas');
    canvas.width = layout.width * 2;
    canvas.height = layout.height * 2;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(2, 2);
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, layout.width, layout.height);
    for (const col of columns) {
      for (const glyph of col.glyphs) paintGlyph(ctx, col, glyph);
      const rubySize = col.size * 0.5;
      ctx.font = `400 ${rubySize}px ${col.family ? `"${col.family}"` : 'system-ui'}`;
      ctx.fillStyle = '#253044';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const r of col.ruby)
        for (const g of r.glyphs) {
          ctx.font = `400 ${g.size}px ${col.family ? `"${col.family}"` : 'system-ui'}`;
          paintText(
            ctx,
            g.text,
            glyphKind(g.text),
            col.x + col.size / 2 + rubySize / 2 + 1,
            g.y,
            g.size,
          );
        }
    }
    ctx.fillStyle = '#7c8490';
    ctx.font = '11px system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(`${index + 1} / ${layout.pages.length}`, layout.width / 2, layout.height - 28);
    return canvas;
  });
}
