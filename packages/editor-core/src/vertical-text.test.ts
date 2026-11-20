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
});
