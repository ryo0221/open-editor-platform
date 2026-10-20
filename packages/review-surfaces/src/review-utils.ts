import { newId } from '@editor-platform/artifact-core';
import { command, type EditorCommand, type ElementAddress } from '@editor-platform/editor-core';
import {
  replaceComparison,
  reviewAddressRevision,
  type DiffLine,
  type ReviewContent,
  type ReviewResolvedSource,
} from './model';

export type ReviewRow = { id: string; line?: DiffLine; index: number; count?: number };
export type ReviewSide = 'old' | 'new';
export type ReviewRange = { start: number; end: number; side: ReviewSide };
export type ReviewSources = { id: string; name: string; oldText: string; newText: string };
export type ResolvedReviewSource = { source: ReviewResolvedSource; address: ElementAddress };
export type ReviewViewSettings = { split?: boolean; wrap?: boolean; annotations?: boolean };

const KEYWORD_PATTERN =
  /^(export|function|return|const|let|import|from|if|string|number|class|async|await)$/;

export function tokenClass(token: string) {
  if (KEYWORD_PATTERN.test(token)) return 'ep-token-keyword';
  return /^["'`]/.test(token) ? 'ep-token-string' : '';
}

export function sourceExcerpt(resolved: ResolvedReviewSource | undefined) {
  const region = resolved?.address.region;
  if (!resolved || region?.type !== 'lines') return undefined;
  const lines = resolved.source.text.split('\n');
  return {
    before: region.start > 1 ? lines.slice(0, region.start - 1).join('\n') + '\n' : '',
    selected: lines.slice(region.start - 1, region.end).join('\n'),
    after: region.end < lines.length ? '\n' + lines.slice(region.end).join('\n') : '',
  };
}

function charWidth(char: string) {
  if (char === '\t') return 8;
  return char.codePointAt(0)! > 255 ? 2 : 1;
}

export function diffLineWidth(lines: DiffLine[]) {
  return (
    Math.max(
      0,
      ...lines.map((line) => Array.from(line.text).reduce((n, char) => n + charWidth(char), 0)),
    ) * 8
  );
}

export function diffHunks(lines: DiffLine[]) {
  return lines.reduce<number[]>((all, line, i) => {
    if (line.type !== 'context' && (i === 0 || lines[i - 1].type === 'context')) all.push(i);
    return all;
  }, []);
}

export function diffMatches(lines: DiffLine[], query: string) {
  return query
    ? lines.flatMap((l, i) =>
        l.text.toLocaleLowerCase().includes(query.toLocaleLowerCase()) ? [i] : [],
      )
    : [];
}

function keepAround(keep: Set<number>, center: number, length: number) {
  for (let j = Math.max(0, center - 3); j <= Math.min(length - 1, center + 3); j++) keep.add(j);
}

function visibleLines(lines: DiffLine[], query: string, target: number | undefined) {
  const keep = new Set<number>();
  if (target !== undefined) keepAround(keep, target, lines.length);
  lines.forEach((l, i) => {
    if (
      l.type !== 'context' ||
      (query && l.text.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
    )
      keepAround(keep, i, lines.length);
  });
  return keep;
}

export function reviewRows(
  lines: DiffLine[],
  expanded: Set<string>,
  query: string,
  target: number | undefined,
) {
  const keep = visibleLines(lines, query, target);
  const result: ReviewRow[] = [];
  let i = 0;
  while (i < lines.length) {
    if (keep.has(i)) {
      result.push({ id: `line-${i}`, line: lines[i], index: i });
      i++;
    } else {
      const start = i;
      while (i < lines.length && !keep.has(i)) i++;
      const id = `gap-${start}-${i}`;
      if (expanded.has(id))
        for (let j = start; j < i; j++) result.push({ id: `line-${j}`, line: lines[j], index: j });
      else result.push({ id, index: start, count: i - start });
    }
  }
  return result;
}

export function sideLine(line: DiffLine, side: ReviewSide | undefined) {
  return side === 'old' ? line.oldLine : line.newLine;
}

export function lineIndexOf(lines: DiffLine[], r: { start: number; side?: ReviewSide }) {
  return lines.findIndex((l) => sideLine(l, r.side) === r.start);
}

export function extendRange(
  range: ReviewRange | undefined,
  number: number,
  side: ReviewSide,
  shift: boolean,
): ReviewRange {
  return shift && range?.side === side
    ? { start: Math.min(range.start, number), end: Math.max(range.end, number), side }
    : { start: number, end: number, side };
}

export function inRange(range: ReviewRange | undefined, side: ReviewSide, n: number) {
  return range?.side === side && n >= range.start && n <= range.end;
}

export function isRetainedSource(
  source: ReviewResolvedSource | undefined,
  address: ElementAddress,
): source is ReviewResolvedSource {
  const r = address.region;
  return Boolean(
    source &&
      r?.type === 'lines' &&
      source.revisionId === reviewAddressRevision(address) &&
      source.side === (r.side ?? 'new') &&
      Number.isInteger(r.start) &&
      Number.isInteger(r.end) &&
      r.start >= 1 &&
      r.end >= r.start &&
      r.end <= source.text.split('\n').length,
  );
}

export function regionLinesLabel(address: ElementAddress) {
  return address.region?.type === 'lines' ? `${address.region.start}–${address.region.end}` : '';
}

export function comparisonCommand(
  content: ReviewContent,
  sources: ReviewSources,
): EditorCommand<ReviewContent> {
  if (content.files.some((f) => f.id === sources.id))
    return replaceComparison(sources.id, sources.oldText, sources.newText, sources.name);
  const added = {
    ...sources,
    oldRevision: newId('source'),
    newRevision: newId('source'),
  };
  return command('review.file.add', 'Add comparison file', (d) => ({
    ...d,
    schemaVersion: 2,
    files: [...d.files, added],
  }));
}

export function pastedText(input: HTMLTextAreaElement, pasted: string) {
  return (
    input.value.slice(0, input.selectionStart) + pasted + input.value.slice(input.selectionEnd)
  );
}
