import { describe, expect, it } from 'vitest';
import { breakJapaneseLines, type JapaneseLineOptions } from './japanese-lines';
import { layoutTextRuns } from './text';

const lines = (text: string, options: JapaneseLineOptions) =>
  breakJapaneseLines(text, options).map((l) => text.slice(l.start, l.end) + (l.hanging ? '|' : ''));

describe('Japanese line breaking on a grid', () => {
  it('fills lines and keeps forced breaks and empty lines', () => {
    expect(lines('あいうえおかきく\n\nけこ', { lineLength: 4 })).toEqual([
      'あいうえ',
      'おかきく',
      '',
      'けこ',
    ]);
  });

  it('never starts a line with 、。」 or small kana, nor ends one with 「', () => {
    // Without hanging, 。 is pushed out together with the character before it.
    expect(lines('あいうえ。かき', { lineLength: 4 })).toEqual(['あいう', 'え。かき']);
    expect(lines('あいうえっか', { lineLength: 4 })).toEqual(['あいう', 'えっか']);
    expect(lines('あいう「えお」', { lineLength: 4 })).toEqual(['あいう', '「えお」']);
  });

  it('hangs 、。 one cell past the line end, but not before a closing bracket', () => {
    expect(lines('あいうえ。かき', { lineLength: 4, hanging: true })).toEqual([
      'あいうえ。|',
      'かき',
    ]);
    expect(lines('「あいう。」か', { lineLength: 4, hanging: true })).toEqual([
      '「あい',
      'う。」か',
    ]);
  });

  it('keeps ruby bases, ——, …… and surrogate pairs whole', () => {
    expect(lines('あいう東京へ', { lineLength: 4, unbreakable: [{ start: 3, end: 5 }] })).toEqual([
      'あいう',
      '東京へ',
    ]);
    expect(lines('あいう——か', { lineLength: 4 })).toEqual(['あいう', '——か']);
    // …… may not start a line either, so the character before it comes along.
    expect(lines('あいう……か', { lineLength: 4 })).toEqual(['あい', 'う……か']);
    expect(lines('𠮟𠮟𠮟𠮟𠮟', { lineLength: 2 })).toEqual(['𠮟𠮟', '𠮟𠮟', '𠮟']);
  });

  it('is deterministic, overflows a unit wider than the line and gives up after four carries', () => {
    const text = '」」」」」」あ';
    expect(breakJapaneseLines(text, { lineLength: 3 })).toEqual(
      breakJapaneseLines(text, { lineLength: 3 }),
    );
    expect(lines('あいうえお', { lineLength: 2, unbreakable: [{ start: 0, end: 5 }] })).toEqual([
      'あいうえお',
    ]);
    expect(() => breakJapaneseLines('あ', { lineLength: 0 })).toThrow('Line length');
  });

  it('may leave one unit on a line to keep the rules, and keeps a CR with hanging punctuation', () => {
    expect(lines('あ「いう', { lineLength: 2 })).toEqual(['あ', '「い', 'う']);
    expect(lines('あい」う', { lineLength: 2 })).toEqual(['あ', 'い」', 'う']);
    const measure = (g: string) => (g === '\r' ? 0 : 1);
    expect(lines('あいうえ。\r\nか', { lineLength: 4, hanging: true, measure })).toEqual([
      'あいうえ。\r|',
      'か',
    ]);
  });

  it('shares its rules with canvas text layout', () => {
    const laid = layoutTextRuns('あいうえ。かき', undefined, 4 * 24, { fontSize: 24 });
    expect(laid.map((l) => l.runs.map((r) => r.text).join(''))).toEqual(['あいう', 'え。かき']);
  });
});
