import { describe, expect, it } from 'vitest';
import { layoutGridText, parseRubyNotation, verticalGlyphKind } from './vertical-text';
import { drawingPrimitives, serializeSvg, type Drawing } from './drawing';

const box = { x: 0, y: 0, width: 200, height: 260 };
const text = (l: ReturnType<typeof layoutGridText>) =>
  l.lines.map((line) => line.glyphs.map((g) => g.text).join(''));

describe('#20 ruby notation', () => {
  it('reads explicit and kanji-run ruby and removes the notation', () => {
    expect(parseRubyNotation('｜小人国《リリパット》の王')).toEqual({
      plain: '小人国の王',
      ruby: [{ start: 0, end: 3, text: 'リリパット' }],
    });
    expect(parseRubyNotation('巨人《きょじん》が|来た《きた》')).toEqual({
      plain: '巨人が来た',
      ruby: [
        { start: 0, end: 2, text: 'きょじん' },
        { start: 3, end: 5, text: 'きた' },
      ],
    });
    // Brackets without a base stay as written
    expect(parseRubyNotation('《題》').ruby).toEqual([]);
  });
});

describe('#20 vertical writing', () => {
  it('sets columns right to left, top to bottom, with kinsoku', () => {
    const l = layoutGridText('あいうえおかきくけこ。さしす', box, {
      vertical: true,
      fontSize: 20,
      padding: 0,
    });
    // 260 / 20 = 13 cells; 。 hangs at the end of the first column instead of starting the next
    expect(text(l)).toEqual(['あいうえおかきくけこ。さし', 'す']);
    const [first, second] = l.lines;
    expect(first.glyphs[0].x).toBeGreaterThan(second.glyphs[0].x);
    expect(first.glyphs[0].y).toBeLessThan(first.glyphs[1].y);
    expect(first.glyphs[0].x).toBe(200 - 10);
  });

  it('turns brackets and long vowels, raises 、。, stands two digits upright', () => {
    expect(['「', 'ー', 'A', '、', 'ゃ', '人'].map(verticalGlyphKind)).toEqual([
      'rotated',
      'rotated',
      'rotated',
      'punctuation',
      'small',
      'plain',
    ]);
    const l = layoutGridText('第12話', box, { vertical: true, fontSize: 20, padding: 0 });
    expect(l.lines[0].glyphs.map((g) => [g.text, g.kind])).toEqual([
      ['第', 'plain'],
      ['12', 'upright'],
      ['話', 'plain'],
    ]);
  });

  it('places ruby beside its base and keeps the base on one column', () => {
    const l = layoutGridText('あいうえおかきくけこさし｜巨人《きょじん》', box, {
      vertical: true,
      fontSize: 20,
      padding: 0,
    });
    expect(text(l)).toEqual(['あいうえおかきくけこさし', '巨人']);
    const base = l.lines[1].glyphs;
    expect(l.ruby.map((r) => r.text).join('')).toBe('きょじん');
    for (const r of l.ruby) expect(r.x).toBeGreaterThan(base[0].x + 10);
    // The reading is centred on its base
    const mid = (l.ruby[0].y + l.ruby.at(-1)!.y) / 2;
    expect(mid).toBeCloseTo((base[0].y + base[1].y) / 2);
  });

  it('shrinks to fit, centres the block, and puts horizontal ruby above the base', () => {
    const long = 'あ'.repeat(200);
    const fit = layoutGridText(long, box, { vertical: true, fontSize: 28, padding: 0, fit: true });
    expect(fit.fontSize).toBeLessThan(28);
    expect(fit.across).toBeLessThanOrEqual(200);
    const centred = layoutGridText('あい', box, {
      vertical: true,
      fontSize: 20,
      padding: 0,
      align: 'center',
    });
    expect(centred.lines[0].glyphs[0].x).toBeCloseTo(100);
    const flat = layoutGridText('｜漢字《かんじ》', box, {
      vertical: false,
      fontSize: 20,
      padding: 0,
    });
    expect(flat.ruby.every((r) => r.y < flat.lines[0].glyphs[0].y)).toBe(true);
  });

  it('draws the same glyphs in every SVG output', () => {
    const d: Drawing = {
      id: 'balloon-text',
      kind: 'text',
      bounds: box,
      text: '「巨人《きょじん》だ！」',
      fill: '#111',
      typography: { fontSize: 20, writingMode: 'vertical-rl' },
    } as Drawing;
    const svg = serializeSvg(drawingPrimitives(d, 'x'));
    expect(svg).toContain('data-writing-mode="vertical-rl"');
    expect(svg).toContain('aria-label="「巨人だ！」"');
    expect(svg).toContain('rotate(90');
    expect(svg).toContain('>き</text>');
    expect(svg).not.toContain('《');
  });

  it('keeps readings inside the box, fits a long base, survives no advance (Codex on #29)', () => {
    const l = layoutGridText('漢字《かんじ》', box, { vertical: true, fontSize: 28 });
    for (const r of l.ruby) expect(r.x + r.size / 2).toBeLessThanOrEqual(box.width + 1e-6);
    const flat = layoutGridText('｜漢字《かんじ》', box, { vertical: false, fontSize: 28 });
    for (const r of flat.ruby) expect(r.y - r.size / 2).toBeGreaterThanOrEqual(-1e-6);
    // A reading longer than its base at the start of the line stays inside the box too.
    for (const vertical of [true, false]) {
      const over = layoutGridText('志《こころざし》', box, { vertical, fontSize: 28 });
      expect(over.ruby).toHaveLength(5);
      for (const r of over.ruby) {
        const along = vertical ? r.y : r.x;
        expect(along - r.size / 2).toBeGreaterThanOrEqual(-1e-6);
        expect(along + r.size / 2).toBeLessThanOrEqual((vertical ? box.height : box.width) + 1e-6);
      }
    }
    // Neighbouring readings longer than their bases do not overlap (Codex on #29).
    for (const vertical of [true, false]) {
      const pair = layoutGridText('志《こころざし》志《こころざし》', box, {
        vertical,
        fontSize: 28,
      });
      expect(pair.ruby).toHaveLength(10);
      const along = pair.ruby.map((r) => (vertical ? r.y : r.x));
      for (let k = 1; k < along.length; k++)
        expect(along[k]! - along[k - 1]!).toBeGreaterThanOrEqual(
          (pair.ruby[k]!.size + pair.ruby[k - 1]!.size) / 2 - 1e-6,
        );
    }
    // An unbreakable base longer than the column shrinks until it fits the column.
    const tall = { x: 0, y: 0, width: 200, height: 100 };
    const fit = layoutGridText('｜あいうえおかきくけこ《よみ》', tall, {
      vertical: true,
      fontSize: 28,
      fit: true,
    });
    expect(fit.fontSize).toBeLessThan(28);
    expect(fit.along).toBeLessThanOrEqual(100 - 8 + 1e-6);
    // A letter spacing of minus the font size still lays out.
    expect(() =>
      layoutGridText('台詞', box, { vertical: true, fontSize: 28, letterSpacing: -28 }),
    ).not.toThrow();
  });

  it("keeps the box's underline and strike on grid text (Codex on #29)", () => {
    const lines = (writingMode?: 'vertical-rl') => {
      const d = {
        id: 't',
        kind: 'text',
        bounds: box,
        text: '漢字《かんじ》',
        fill: '#111',
        typography: { fontSize: 20, underline: true, strike: true, writingMode },
      } as unknown as Drawing;
      const svg = serializeSvg(drawingPrimitives(d, 'x'));
      expect(svg).toContain('data-text-decoration="underline line-through"');
      return [
        ...svg.matchAll(/<line x1="([\d.-]+)" y1="([\d.-]+)" x2="([\d.-]+)" y2="([\d.-]+)"/g),
      ].map((m) => m.slice(1).map(Number));
    };
    // Horizontal: two lines along the row, 2 cells long
    const row = lines();
    expect(row).toHaveLength(2);
    for (const [x1, y1, x2, y2] of row) {
      expect(y1).toBe(y2);
      expect(x2 - x1).toBeCloseTo(40);
    }
    // Vertical: two lines down the column
    const column = lines('vertical-rl');
    expect(column).toHaveLength(2);
    for (const [x1, y1, x2, y2] of column) {
      expect(x1).toBe(x2);
      expect(y2 - y1).toBeCloseTo(40);
    }
    // No decoration, no lines
    const plain = serializeSvg(
      drawingPrimitives(
        { id: 't', kind: 'text', bounds: box, text: '漢字《かんじ》', fill: '#111' } as Drawing,
        'x',
      ),
    );
    expect(plain).not.toContain('<line');
  });

  it('keeps formatted horizontal runs on the ordinary layout', () => {
    const d = {
      id: 't',
      kind: 'text',
      bounds: box,
      text: '漢字《かんじ》と太字',
      fill: '#111',
      typography: { fontSize: 20 },
      runs: [{ text: '漢字《かんじ》と' }, { text: '太字', style: { color: '#c00' } }],
    } as unknown as Drawing;
    const svg = serializeSvg(drawingPrimitives(d, 'x'));
    expect(svg).not.toContain('data-writing-mode');
    expect(svg).toContain('#c00');
  });

  it('keeps plain runs on the grid and bullets on a grid list (Codex on #29)', () => {
    const d = {
      id: 't',
      kind: 'text',
      bounds: box,
      text: '漢字《かんじ》',
      fill: '#111',
      typography: { fontSize: 20 },
      runs: [{ text: '漢字《かんじ》' }],
    } as unknown as Drawing;
    const svg = serializeSvg(drawingPrimitives(d, 'x'));
    expect(svg).toContain('data-writing-mode');
    expect(svg).not.toContain('《');
    const list = serializeSvg(
      drawingPrimitives({ ...d, typography: { fontSize: 20, list: true } } as Drawing, 'x'),
    );
    expect(list).toContain('•');
  });

  it('keeps a reading on a digit that starts or ends inside an upright pair (Codex on #29)', () => {
    for (const [notation, readings] of [
      ['1｜2《に》', ['に']],
      ['｜1《いち》｜2《に》', ['いち', 'に']],
    ] as const) {
      const l = layoutGridText(notation, box, { vertical: true, fontSize: 20, padding: 0 });
      expect(l.ruby.map((r) => r.text).join('')).toBe(readings.join(''));
      expect(text(l).join('')).toBe('12');
    }
  });
});
