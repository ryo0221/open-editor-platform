// Japanese line breaking (kinsoku) shared by Document manuscripts and Design text: these
// characters never start a line…
export const kinsokuNoLineStart =
  /[、。，．・：；？！ー～…‥）〕］｝〉》」』】〙〗〟’”｠゛゜ゝゞヽヾ々〻ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶㇰ-ㇿ]/u;
// …and these never end one.
export const kinsokuNoLineEnd = /[（〔［｛〈《「『【〘〖〝‘“｟]/u;
/** Punctuation that may hang one cell past the line end (ぶら下げ). */
const hangable = /^[、。，．]$/u;
/** Pairs that are never split across lines (分離禁止). */
const inseparable = /^(?:—|―|…|‥)$/u;

export interface JapaneseLineOptions {
  /** Line length in cells: one grapheme is one cell unless `measure` says otherwise. */
  lineLength: number;
  /** Let 、。，． hang one cell beyond the line end instead of being pushed out. */
  hanging?: boolean;
  /** Ranges that are never broken inside, such as a ruby base. Offsets are UTF-16 in `text`. */
  unbreakable?: readonly { start: number; end: number }[];
  /** Width in cells of one grapheme; `offset` is its UTF-16 position in `text`. */
  measure?(grapheme: string, offset: number): number;
}
export interface JapaneseLine {
  /** UTF-16 range in `text`, without the `\n` that ended it. */
  start: number;
  end: number;
  /** The last grapheme hangs beyond the line length. */
  hanging: boolean;
}

const graphemes = new Intl.Segmenter('ja', { granularity: 'grapheme' });
type Atom = { start: number; end: number; first: string; last: string; width: number };

function atoms(
  text: string,
  offset: number,
  options: JapaneseLineOptions,
  inside: Uint8Array,
): Atom[] {
  const measure = options.measure ?? (() => 1);
  const result: Atom[] = [];
  for (const { segment, index } of graphemes.segment(text)) {
    const start = offset + index,
      end = start + segment.length,
      width = measure(segment, start);
    const previous = result[result.length - 1];
    const joined =
      previous && ((inseparable.test(segment) && previous.last === segment) || inside[start] === 1);
    if (joined) {
      previous.end = end;
      previous.last = segment;
      previous.width += width;
    } else result.push({ start, end, first: segment, last: segment, width });
  }
  return result;
}

/** Deterministic line breaks for vertical or horizontal Japanese text on a fixed grid. The same
 * input always gives the same lines; it depends on no content model, font or DOM. */
export function breakJapaneseLines(text: string, options: JapaneseLineOptions): JapaneseLine[] {
  const length = options.lineLength;
  if (!Number.isFinite(length) || length < 1) throw new Error('Line length must be at least 1');
  // Positions strictly inside an unbreakable range, indexed once so long texts stay linear.
  const inside = new Uint8Array(text.length + 1);
  for (const r of options.unbreakable ?? [])
    for (let i = Math.max(0, r.start + 1); i < Math.min(r.end, text.length + 1); i++) inside[i] = 1;
  const lines: JapaneseLine[] = [];
  let offset = 0;
  for (const paragraph of text.split('\n')) {
    const units = atoms(paragraph, offset, options, inside);
    if (!units.length) lines.push({ start: offset, end: offset, hanging: false });
    let pos = 0;
    while (pos < units.length) {
      let end = pos,
        used = 0;
      while (end < units.length && used + units[end].width <= length) used += units[end++].width;
      // A unit wider than the line overflows rather than looping.
      if (end === pos) end++;
      let hanging = false;
      if (end < units.length) {
        const next = units[end];
        let after = end + 1;
        while (after < units.length && units[after].width === 0) after++;
        if (
          options.hanging &&
          hangable.test(next.first) &&
          next.start === next.end - next.first.length &&
          // A hanging 。 must not leave a closing bracket to start the next line.
          !(units[after] && kinsokuNoLineStart.test(units[after].first))
        ) {
          // Zero-width units after it (such as the CR of CRLF) stay on this line.
          end = after;
          hanging = true;
        } else {
          // 追い出し: carry up to four units so neither line breaks a rule; give up otherwise.
          for (let carry = 0; carry <= 4 && end - carry > pos; carry++) {
            const at = end - carry;
            if (
              !kinsokuNoLineStart.test(units[at].first) &&
              !kinsokuNoLineEnd.test(units[at - 1].last)
            ) {
              end = at;
              break;
            }
          }
        }
      }
      lines.push({ start: units[pos].start, end: units[end - 1].end, hanging });
      pos = end;
    }
    offset += paragraph.length + 1;
  }
  return lines;
}
