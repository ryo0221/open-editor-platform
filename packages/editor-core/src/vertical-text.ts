import { graphemeSegmenter } from './graphemes';
import { breakJapaneseLines } from './japanese-lines';
import type { Bounds } from './geometry';

/**
 * Japanese text set on a grid of square cells, for vertical writing (縦書き) and for ruby (ルビ).
 * Columns run right to left; 、。 sit in the upper right of their cell, brackets, long vowel
 * marks and Latin lie on their side, two-digit numbers stand upright side by side (縦中横), and
 * line breaks follow the kinsoku rules of `breakJapaneseLines`. Everything is placed glyph by
 * glyph, so the screen, SVG and PNG/PDF exports show the same layout without relying on a
 * browser's vertical text support.
 */

/**
 * Ruby is written in the text itself, in the notation Japanese writers already use:
 * `｜漢字《かんじ》` (or `|漢字《かんじ》`) marks the base explicitly, and `漢字《かんじ》` takes the
 * run of kanji just before the reading. `plain` is the text with the notation removed.
 */
export interface RubyNotation {
  plain: string;
  /** For each UTF-16 unit of `plain`, its index in the notated text. */
  source: number[];
  ruby: { start: number; end: number; text: string }[];
}
const rubyPattern =
  /[｜|]([^｜|《》\n]{1,256})《([^《》\n]{1,64})》|([\p{Script=Han}々〆ヶ]{1,256})《([^《》\n]{1,64})》/gu;
export function parseRubyNotation(text: string): RubyNotation {
  let plain = '',
    last = 0;
  const ruby: RubyNotation['ruby'] = [];
  const source: number[] = [];
  const take = (from: number, to: number) => {
    plain += text.slice(from, to);
    for (let i = from; i < to; i++) source.push(i);
  };
  for (const m of text.matchAll(rubyPattern)) {
    take(last, m.index);
    const base = m[1] ?? m[3],
      reading = m[2] ?? m[4];
    const at = m.index + (m[1] !== undefined ? 1 : 0);
    ruby.push({ start: plain.length, end: plain.length + base.length, text: reading });
    take(at, at + base.length);
    last = m.index + m[0].length;
  }
  take(last, text.length);
  return { plain, source, ruby };
}
export const hasRubyNotation = (text: string) => parseRubyNotation(text).ruby.length > 0;

export type GridGlyphKind = 'plain' | 'rotated' | 'punctuation' | 'small' | 'upright';
const rotatedGlyph =
  /^[「」『』（）〔〕［］｛｝〈〉《》【】〘〙〖〗ー～〜…‥—―－‐−=＝<>＜＞(){}[\]]$/u;
const punctuationGlyph = /^[、。，．]$/u;
const smallGlyph = /^[ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶ]$/u;
const wideGlyph =
  /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3000-\u303f\uff01-\uff60\uffe0-\uffe6ー]/u;
const uprightSymbol = /\p{Extended_Pictographic}|\u20e3|\ufe0f/u;
const isWide = (g: string) => wideGlyph.test(g) || uprightSymbol.test(g);
/** How a grapheme sits in a vertical column. */
export function verticalGlyphKind(g: string): Exclude<GridGlyphKind, 'upright'> {
  return punctuationGlyph.test(g)
    ? 'punctuation'
    : smallGlyph.test(g)
      ? 'small'
      : rotatedGlyph.test(g) || !isWide(g)
        ? 'rotated'
        : 'plain';
}
/** Latin and other narrow glyphs take part of a cell (the same estimate as horizontal text). */
const narrowCells = (g: string) => (/[il.,' ]/.test(g) ? 0.3 : 0.58);

export interface GridGlyph {
  text: string;
  /** Centre of the glyph. */
  x: number;
  y: number;
  kind: GridGlyphKind;
  /** Length along the line. */
  advance: number;
  /** Where the glyph starts in the text without ruby notation. */
  offset: number;
}
export interface GridRuby {
  text: string;
  x: number;
  y: number;
  size: number;
}
export interface GridTextLayout {
  vertical: boolean;
  fontSize: number;
  rubySize: number;
  /** Lines in reading order: columns right to left, or rows top to bottom. */
  lines: { start: number; end: number; glyphs: GridGlyph[] }[];
  ruby: GridRuby[];
  /** The extent the text needs across lines and along the longest line. */
  across: number;
  along: number;
}
export interface GridTextOptions {
  vertical: boolean;
  fontSize: number;
  /** Line pitch as a multiple of the font size. */
  lineHeight?: number;
  padding?: number;
  letterSpacing?: number;
  /** Horizontal block position: in vertical text the block of columns moves, in horizontal text each row. */
  align?: 'left' | 'center' | 'right';
  verticalAlign?: 'top' | 'middle' | 'bottom';
  /** Shrink the font until the text fits the box (to 8 at least). */
  fit?: boolean;
  /**
   * The font size of the character at each offset of the text without ruby notation, as a
   * multiple of `fontSize` (formatted runs); 1 when absent. Advances and line pitch follow it.
   */
  scaleAt?: (offset: number) => number;
  /** Offsets (without ruby notation) that an upright digit group may not span: run boundaries. */
  cuts?: readonly number[];
}

/**
 * The largest size multiple among the characters drawn: a box whose runs are all smaller than its
 * font reserves only their room (Codex on #38). 1 without runs or characters.
 */
// Only characters that draw a glyph count; line breaks draw nothing (Codex on #38). Counted in
// one pass, so long text needs no argument list per character.
function scaleRange(plain: string, scaleAt: GridTextOptions['scaleAt']) {
  let largest = 0;
  let smallest = Infinity;
  if (scaleAt)
    for (let k = 0; k < plain.length; k++) {
      if (plain[k] === '\n' || plain[k] === '\r') continue;
      const s = scaleAt(k);
      if (s > 0) {
        if (s > largest) largest = s;
        if (s < smallest) smallest = s;
      }
    }
  return largest > 0 ? { largest, smallest } : { largest: 1, smallest: 1 };
}
function largestScale(plain: string, scaleAt: GridTextOptions['scaleAt']) {
  return scaleRange(plain, scaleAt).largest;
}
function layoutOnce(text: string, box: Bounds, o: GridTextOptions, size: number): GridTextLayout {
  const { plain, ruby } = parseRubyNotation(text);
  const pad = o.padding ?? 4;
  const scaleAt = (offset: number) => o.scaleAt?.(offset) ?? 1;
  // Lines are as wide as their largest characters, and readings follow that size (Codex on #38).
  const { largest, smallest } = scaleRange(plain, o.scaleAt);
  const big = size * largest;
  const rubySize = big * 0.5;
  // Ruby needs room beside (or above) its base, so the line pitch grows to fit it.
  const pitch = big * Math.max(o.lineHeight ?? (o.vertical ? 1.5 : 1.3), ruby.length ? 1.6 : 0);
  // A letter spacing of minus the font size (or less) would leave no advance (Codex on #29).
  // A run's size scales its glyph, not the spacing between glyphs (Codex on #38).
  const cellAt = (scale: number) =>
    Math.max(size * scale * 0.1, size * scale + (o.letterSpacing ?? 0));
  const cell = cellAt(1);
  const inner = {
    x: box.x + pad,
    y: box.y + pad,
    width: Math.max(1, box.width - pad * 2),
    height: Math.max(1, box.height - pad * 2),
  };
  // A two-digit group that a ruby base starts or ends inside is set one digit a cell, so each
  // annotated base keeps a glyph of its own (Codex on #29).
  const cuts = new Set([...ruby.flatMap((r) => [r.start, r.end]), ...(o.cuts ?? [])]);
  // Only digits that are whole graphemes of their own: a keycap such as 1️⃣ keeps its sequence
  // (Codex on #29).
  const bounds = new Set([
    ...Array.from(graphemeSegmenter().segment(plain), (g) => g.index),
    plain.length,
  ]);
  const upright = o.vertical
    ? Array.from(plain.matchAll(/(?<![0-9])[0-9]{1,2}(?![0-9])/gu), (m) => ({
        start: m.index,
        end: m.index + m[0].length,
      }))
        .filter((r) =>
          Array.from({ length: r.end - r.start + 1 }, (_, k) => r.start + k).every((k) =>
            bounds.has(k),
          ),
        )
        .flatMap((r) =>
          r.end - r.start > 1 && cuts.has(r.start + 1)
            ? [
                { start: r.start, end: r.start + 1 },
                { start: r.start + 1, end: r.end },
              ]
            : [r],
        )
    : [];
  const uprightAt = new Map(upright.map((r) => [r.start, r]));
  const uprightOf = new Set(
    upright.flatMap((r) => Array.from({ length: r.end - r.start }, (_, k) => r.start + k)),
  );
  const cells = (g: string, offset: number) =>
    uprightAt.has(offset) ? 1 : uprightOf.has(offset) ? 0 : isWide(g) ? 1 : narrowCells(g);
  // The drawn advance: the glyph's cells at its run's size, with the box's letter spacing.
  const advanceOf = (g: string, offset: number) =>
    cells(g, offset) * (o.scaleAt ? cellAt(scaleAt(offset)) : cell);
  // Lines are measured in the smallest drawn cell, so a line of small runs holds what fits in
  // its length and no more (Codex on #38). Without runs this is the box's whole cells, as before.
  const unit = cellAt(smallest);
  const room = o.vertical ? inner.height : inner.width;
  const length = o.scaleAt ? Math.max(1, room / unit) : Math.max(1, Math.floor(room / cell));
  const broken = breakJapaneseLines(plain, {
    lineLength: length,
    hanging: true,
    unbreakable: [...ruby, ...upright],
    measure: o.scaleAt ? (g, offset) => advanceOf(g, offset) / unit : cells,
  });
  const lines: GridTextLayout['lines'] = broken.map((line) => {
    const glyphs: GridGlyph[] = [];
    let along = 0;
    for (const { segment, index } of graphemeSegmenter().segment(
      plain.slice(line.start, line.end),
    )) {
      const offset = line.start + index;
      if (uprightOf.has(offset) && !uprightAt.has(offset)) continue;
      const group = uprightAt.get(offset);
      const advance = advanceOf(segment, offset);
      glyphs.push({
        text: group ? plain.slice(group.start, group.end) : segment,
        x: 0,
        y: along + advance / 2,
        kind: !o.vertical ? 'plain' : group ? 'upright' : verticalGlyphKind(segment),
        advance,
        offset,
      });
      along += advance;
    }
    return { start: line.start, end: line.end, glyphs };
  });
  // Readings sit outside the first line (right of the first column, above the first row): the
  // block keeps room for them there, so they are not clipped at the box edge (Codex on #29).
  const rubyRoom = ruby.length ? pitch - big : 0;
  const across = lines.length * pitch - (pitch - big) + rubyRoom;
  const longest = Math.max(0, ...lines.map((l) => l.glyphs.reduce((n, g) => n + g.advance, 0)));
  // Place lines: `a` is the centre across lines, `s` the start along the line.
  const acrossSpace = o.vertical ? inner.width : inner.height;
  const alongSpace = o.vertical ? inner.height : inner.width;
  const blockShift = o.vertical
    ? o.align === 'left'
      ? acrossSpace - across
      : o.align === 'center'
        ? (acrossSpace - across) / 2
        : 0
    : o.verticalAlign === 'middle'
      ? (acrossSpace - across) / 2
      : o.verticalAlign === 'bottom'
        ? acrossSpace - across
        : 0;
  const rubyOut: GridRuby[] = [];
  lines.forEach((line, i) => {
    const used = line.glyphs.reduce((n, g) => n + g.advance, 0);
    const alignOf = o.vertical ? o.verticalAlign : o.align;
    const alongShift =
      alignOf === 'middle' || alignOf === 'center'
        ? (alongSpace - (o.vertical ? longest : used)) / 2
        : alignOf === 'bottom' || alignOf === 'right'
          ? alongSpace - (o.vertical ? longest : used)
          : 0;
    const lineCentre = o.vertical
      ? inner.x + inner.width - blockShift - rubyRoom - big / 2 - i * pitch
      : inner.y + blockShift + rubyRoom + big / 2 + i * pitch;
    const start = (o.vertical ? inner.y : inner.x) + alongShift;
    for (const g of line.glyphs) {
      const along = start + g.y;
      if (o.vertical) {
        g.x = lineCentre;
        g.y = along;
      } else {
        g.x = along;
        g.y = lineCentre;
      }
    }
    // Readings beside the base: right of a column, above a row. A reading longer than its base
    // overhangs it equally on both ends.
    let offset = 0;
    const positions = new Map<number, { from: number; to: number }>();
    for (const g of line.glyphs) {
      const from = (o.vertical ? g.y : g.x) - g.advance / 2;
      positions.set(line.start + offset, { from, to: from + g.advance });
      offset += g.text.length;
    }
    // The line's room along it: a reading that overhangs the box edge is moved in, and one
    // longer than the whole line is set closer (Codex on #29). Neighbouring readings are kept
    // apart: pushed along the line, and all set closer when together they need more room.
    const lo = o.vertical ? inner.y : inner.x;
    const hi = lo + alongSpace;
    const items: { chars: string[]; step: number; begin: number; base: number }[] = [];
    for (const r of ruby) {
      if (r.start < line.start || r.start >= Math.max(line.end, line.start + 1)) continue;
      const first = positions.get(r.start);
      const lastStart = [...positions.keys()].filter((k) => k < r.end).at(-1);
      if (!first || lastStart === undefined) continue;
      const to = positions.get(lastStart)!.to;
      const chars = [...graphemeSegmenter().segment(r.text)].map((s) => s.segment);
      if (!chars.length) continue;
      const step = Math.min(
        rubySize,
        Math.max(to - first.from, rubySize * chars.length) / chars.length,
      );
      items.push({
        chars,
        step,
        begin: (first.from + to) / 2 - (step * chars.length) / 2,
        base: first.from,
      });
    }
    // Readings keep their bases' order, even when a long one would start before an earlier one.
    items.sort((a, b) => a.base - b.base);
    const room = Math.max(0, hi - lo);
    const total = items.reduce((n, it) => n + it.step * it.chars.length, 0);
    if (total > room)
      for (const it of items) {
        const centre = it.begin + (it.step * it.chars.length) / 2;
        it.step *= room / total;
        it.begin = centre - (it.step * it.chars.length) / 2;
      }
    let end = lo;
    for (const it of items) {
      it.begin = Math.max(it.begin, end);
      end = it.begin + it.step * it.chars.length;
    }
    let bound = hi;
    for (const it of [...items].reverse()) {
      it.begin = Math.min(it.begin, bound - it.step * it.chars.length);
      bound = it.begin;
    }
    for (const { chars, step, begin } of items)
      chars.forEach((text, k) => {
        const along = begin + step * (k + 0.5);
        rubyOut.push(
          o.vertical
            ? { text, x: lineCentre + big / 2 + rubySize * 0.6, y: along, size: step }
            : { text, x: along, y: lineCentre - big / 2 - rubySize * 0.6, size: step },
        );
      });
  });
  return {
    vertical: o.vertical,
    fontSize: size,
    rubySize,
    lines,
    ruby: rubyOut,
    across,
    along: longest,
  };
}

/** Lay out text on a cell grid inside `box`. */
export function layoutGridText(text: string, box: Bounds, o: GridTextOptions): GridTextLayout {
  let size = o.fontSize;
  let layout = layoutOnce(text, box, o, size);
  const pad = (o.padding ?? 4) * 2;
  const across = o.vertical ? box.width - pad : box.height - pad;
  const along = o.vertical ? box.height - pad : box.width - pad;
  // Both ways: a reading's base cannot break, so a long one may need a smaller size to fit its
  // line (Codex on #29).
  // The floor and the step are for the largest characters drawn: a run much larger than the box's
  // font still shrinks until it fits, down to 8 (Codex on #38).
  const largest = largestScale(parseRubyNotation(text).plain, o.scaleAt);
  const floor = 8 / largest;
  if (o.fit)
    while (size > floor && (layout.across > across + 1e-6 || layout.along > along + 1e-6)) {
      size = Math.max(floor, size - 1 / largest);
      layout = layoutOnce(text, box, o, size);
    }
  return layout;
}
