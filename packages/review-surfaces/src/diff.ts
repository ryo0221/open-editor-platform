import type { DiffLine } from './model';

/** Patience anchors keep large source files bounded; small unmatched islands use LCS. */
export function patienceDiff(before: string, after: string): DiffLine[] {
  const a = before === '' ? [] : before.split('\n'),
    b = after === '' ? [] : after.split('\n');
  const result: DiffLine[] = [];
  const context = (i: number, j: number) =>
    result.push({ type: 'context', text: a[i], oldLine: i + 1, newLine: j + 1 });
  function replaced(lo: number, end: number, from: number, stop: number) {
    for (let i = lo; i < end; i++) result.push({ type: 'removed', text: a[i], oldLine: i + 1 });
    for (let j = from; j < stop; j++) result.push({ type: 'added', text: b[j], newLine: j + 1 });
  }
  function lcs(lo: number, end: number, from: number, stop: number) {
    const rows = Array.from({ length: end - lo + 1 }, () => new Uint32Array(stop - from + 1));
    for (let i = end - lo - 1; i >= 0; i--)
      for (let j = stop - from - 1; j >= 0; j--)
        rows[i][j] =
          a[lo + i] === b[from + j]
            ? rows[i + 1][j + 1] + 1
            : Math.max(rows[i + 1][j], rows[i][j + 1]);
    let i = lo,
      j = from;
    while (i < end || j < stop) {
      if (i < end && j < stop && a[i] === b[j]) context(i++, j++);
      else if (i < end && (j === stop || rows[i - lo + 1][j - from] >= rows[i - lo][j - from + 1]))
        result.push({ type: 'removed', text: a[i], oldLine: ++i });
      else result.push({ type: 'added', text: b[j], newLine: ++j });
    }
  }
  function anchorsOf(lo: number, end: number, from: number, stop: number) {
    const unique = (lines: string[], start: number, end: number) => {
      const map = new Map<string, number>();
      for (let i = start; i < end; i++) map.set(lines[i], map.has(lines[i]) ? -1 : i);
      return map;
    };
    const left = unique(a, lo, end),
      right = unique(b, from, stop);
    const pairs = [...left]
      .filter(([text, i]) => i >= 0 && (right.get(text) ?? -1) >= 0)
      .map(([text, i]) => [i, right.get(text)!]);
    const tails: number[] = [],
      previous = new Int32Array(pairs.length).fill(-1);
    pairs.forEach((pair, i) => {
      let l = 0,
        r = tails.length;
      while (l < r) {
        const m = (l + r) >> 1;
        if (pairs[tails[m]][1] < pair[1]) l = m + 1;
        else r = m;
      }
      if (l) previous[i] = tails[l - 1];
      tails[l] = i;
    });
    const anchors: number[][] = [];
    for (let i = tails.at(-1) ?? -1; i >= 0; i = previous[i]) anchors.push(pairs[i]);
    anchors.reverse();
    return anchors;
  }
  function patience(lo: number, end: number, from: number, stop: number) {
    const anchors = anchorsOf(lo, end, from, stop);
    if (!anchors.length) {
      replaced(lo, end, from, stop);
      return;
    }
    let i = lo,
      j = from;
    for (const [x, y] of anchors) {
      visit(i, x, j, y);
      context(x, y);
      i = x + 1;
      j = y + 1;
    }
    visit(i, end, j, stop);
  }
  function visit(lo: number, hi: number, from: number, to: number) {
    while (lo < hi && from < to && a[lo] === b[from]) context(lo++, from++);
    let suffix = 0;
    while (lo < hi - suffix && from < to - suffix && a[hi - suffix - 1] === b[to - suffix - 1])
      suffix++;
    const end = hi - suffix,
      stop = to - suffix;
    if (end === lo || stop === from) replaced(lo, end, from, stop);
    else if ((end - lo) * (stop - from) <= 250000) lcs(lo, end, from, stop);
    else patience(lo, end, from, stop);
    for (let n = suffix; n > 0; n--) context(hi - n, to - n);
  }
  visit(0, a.length, 0, b.length);
  return result;
}
