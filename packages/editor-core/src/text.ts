import type { TextRun, TextStyle } from './drawing';

/** Runs are optional rich formatting over the same UTF-16 text, never a second text source. */
export function normalizedRuns(text: string, runs?: TextRun[]): TextRun[] {
  if (!runs || runs.map((r) => r.text).join('') !== text) return text ? [{ text }] : [];
  const result: TextRun[] = [];
  for (const run of runs) {
    if (!run.text) continue;
    const style = run.style && Object.keys(run.style).length ? { ...run.style } : undefined;
    const last = result.at(-1);
    if (last && JSON.stringify(last.style) === JSON.stringify(style)) last.text += run.text;
    else result.push({ text: run.text, ...(style ? { style } : {}) });
  }
  return result;
}

export interface TextLine {
  runs: TextRun[];
  height: number;
  ascent: number;
}
const advance = (char: string, style: TextStyle) =>
  ((char.codePointAt(0) ?? 0) > 255 ? 1 : /[il.,' ]/.test(char) ? 0.3 : 0.58) *
    (style.fontSize ?? 24) *
    (style.bold ? 1.03 : 1) +
  (style.letterSpacing ?? 0);

// Japanese line breaking (kinsoku): these never start a line…
const noLineStart =
  /[、。，．・：；？！ー～…‥）〕］｝〉》」』】〙〗〟’”｠゛゜ゝゞヽヾ々〻ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶㇰ-ㇿ]/u;
// …and these never end one.
const noLineEnd = /[（〔［｛〈《「『【〘〖〝‘“｟]/u;
/** How many trailing characters move to the next line so neither line breaks a kinsoku rule.
 * Gives up (0) after a few characters, or when the line would empty, and overflows instead. */
function kinsokuCarry(line: { text: string }[], next: string): number {
  for (let carry = 0; carry < Math.min(line.length, 4); carry++) {
    const start = carry ? line[line.length - carry].text : next;
    if (!noLineStart.test(start) && !noLineEnd.test(line[line.length - carry - 1].text))
      return carry;
  }
  return 0;
}

/** Deterministic line layout is shared by screen SVG and every ordinary canvas export. */
export function layoutTextRuns(
  text: string,
  runs: TextRun[] | undefined,
  width: number,
  base: TextStyle,
): TextLine[] {
  const chars: { text: string; style: TextStyle }[] = [];
  for (const run of normalizedRuns(text, runs))
    for (const char of run.text) chars.push({ text: char, style: { ...base, ...run.style } });
  const tokens: (typeof chars)[] = [];
  for (const char of chars) {
    const last = tokens.at(-1);
    if (last && /[A-Za-z0-9_]/.test(char.text) && /[A-Za-z0-9_]/.test(last.at(-1)!.text))
      last.push(char);
    else tokens.push([char]);
  }
  const lines: TextLine[] = [];
  let current: typeof chars = [],
    used = 0;
  const flush = (next?: string) => {
    const carried =
      next === undefined ? [] : current.splice(current.length - kinsokuCarry(current, next));
    const font = base.fontSize ?? 24;
    lines.push({
      runs: normalizedRuns(current.map((c) => c.text).join(''), current),
      height: Math.max(
        font * (base.lineHeight ?? 1.3),
        ...current.map((c) => (c.style.fontSize ?? font) * (c.style.lineHeight ?? 1.3)),
      ),
      ascent: Math.max(font, ...current.map((c) => c.style.fontSize ?? font)),
    });
    current = carried;
    used = carried.reduce((n, c) => n + advance(c.text, c.style), 0);
  };
  for (const token of tokens) {
    if (token[0].text === '\n') {
      flush();
      continue;
    }
    const size = token.reduce((n, c) => n + advance(c.text, c.style), 0);
    if (used + size > width && current.length) flush(token[0].text);
    for (const char of token) {
      const size = advance(char.text, char.style);
      if (used + size > width && current.length) flush(char.text);
      current.push(char);
      used += size;
    }
  }
  flush();
  return lines;
}
