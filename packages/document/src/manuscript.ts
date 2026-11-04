import {
  breakJapaneseLines,
  type EditorCommand,
  type LocalCommandContext,
} from '@editor-platform/editor-core';
import { contentToNode } from './engine';
import { sameRuby, type DocumentContent, type InlineRuby } from './model';
import {
  documentText,
  documentTextblocks,
  documentTextEditCommand,
  type DocumentTextEdit,
  type DocumentTextSegment,
} from './text-access';

/** How `documentCharacterCount` counts. Every field is echoed in the result. */
export interface DocumentCharacterCountOptions {
  /** 'grapheme' counts user-perceived characters; 'codepoint' counts Unicode scalar values. */
  unit?: 'grapheme' | 'codepoint';
  /** Count spaces, tabs and ideographic spaces. A hard_break is governed by `lineBreaks`. */
  whitespace?: boolean;
  /** Count each hard_break inside a paragraph as one character. */
  lineBreaks?: boolean;
  /** Count text in hidden blocks. */
  hidden?: boolean;
}
export type DocumentCharacterCountRule = Required<DocumentCharacterCountOptions>;
export const defaultCharacterCountRule: DocumentCharacterCountRule = Object.freeze({
  unit: 'grapheme',
  whitespace: false,
  lineBreaks: false,
  hidden: false,
});

export interface DocumentSegmentCount extends Pick<DocumentTextSegment, 'id' | 'blockId'> {
  count: number;
}
export interface DocumentCharacterCount {
  total: number;
  /** Counted segments in document order; segments of excluded hidden blocks are omitted. */
  segments: DocumentSegmentCount[];
  rule: DocumentCharacterCountRule;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const characters = (text: string, unit: DocumentCharacterCountRule['unit']) =>
  unit === 'codepoint' ? [...text] : Array.from(graphemes.segment(text), (part) => part.segment);

function countRule(options: DocumentCharacterCountOptions): DocumentCharacterCountRule {
  const given = Object.entries(options).filter(([, value]) => value !== undefined);
  const rule = { ...defaultCharacterCountRule, ...Object.fromEntries(given) };
  if (rule.unit !== 'grapheme' && rule.unit !== 'codepoint')
    throw new Error('Unsupported character count unit');
  for (const key of ['whitespace', 'lineBreaks', 'hidden'] as const)
    if (typeof rule[key] !== 'boolean') throw new Error(`Character count ${key} must be boolean`);
  return rule;
}

const hiddenBlockIds = (content: DocumentContent, include: boolean) =>
  new Set(include ? [] : content.blocks.filter((block) => block.hidden).map((block) => block.id));

/** Text segments of `documentText`, without those in hidden blocks unless requested. */
function countedSegments(content: DocumentContent, hidden: boolean) {
  const value = documentText(content);
  const skipped = hiddenBlockIds(content, hidden);
  return value.segments
    .filter((segment) => !skipped.has(segment.blockId))
    .map((segment) => ({
      segment,
      // Authored CRLF survives before a hard_break; count it as the one line break it is.
      text: value.text.slice(segment.start, segment.end).replaceAll('\r\n', '\n'),
    }));
}

/** Pure character count of a Document. Ruby readings are never part of `documentText`, so only
 * base text is counted. Embedded blocks contribute nothing; code blocks count as text.
 * The same content and options always give the same result. */
export function documentCharacterCount(
  content: DocumentContent,
  options: DocumentCharacterCountOptions = {},
): DocumentCharacterCount {
  const rule = countRule(options);
  const segments = countedSegments(content, rule.hidden).map(({ segment, text }) => ({
    id: segment.id,
    blockId: segment.blockId,
    count: characters(text, rule.unit).filter((char) =>
      char === '\n' ? rule.lineBreaks : rule.whitespace || !/^\s+$/u.test(char),
    ).length,
  }));
  return { total: segments.reduce((sum, s) => sum + s.count, 0), segments, rule: { ...rule } };
}

export interface ManuscriptPaperOptions {
  /** Cells per line. Japanese manuscript paper is 20. */
  columns?: number;
  /** Lines per sheet. Japanese manuscript paper is 20. */
  rows?: number;
  hidden?: boolean;
  /** 'kinsoku' (default) applies line-start/line-end rules, hanging 、。 and unbroken ruby bases
   * with `breakJapaneseLines`; 'none' fills every line to the last cell. */
  lineBreaking?: 'kinsoku' | 'none';
}
export interface ManuscriptPaperEstimate {
  sheets: number;
  lines: number;
  columns: number;
  rows: number;
  lineBreaking: 'kinsoku' | 'none';
  /** Always true: the grid ignores fonts, upright digits and page layout. */
  approximate: true;
}

/** Approximate manuscript-paper (genkō yōshi) size. Every grapheme, including spaces, fills one
 * cell; each paragraph and each hard_break starts a new line; an empty paragraph is one line.
 * Kinsoku and hanging punctuation are ignored, so this is not the final layout. */
export function manuscriptPaperEstimate(
  content: DocumentContent,
  options: ManuscriptPaperOptions = {},
): ManuscriptPaperEstimate {
  const { columns = 20, rows = 20, hidden = false, lineBreaking = 'kinsoku' } = options;
  for (const [name, value] of [
    ['columns', columns],
    ['rows', rows],
  ] as const)
    if (!Number.isInteger(value) || value < 1 || value > 1000)
      throw new Error(`Manuscript ${name} must be an integer from 1 to 1000`);
  if (typeof hidden !== 'boolean') throw new Error('Manuscript hidden must be boolean');
  if (lineBreaking !== 'kinsoku' && lineBreaking !== 'none')
    throw new Error('Manuscript line breaking must be kinsoku or none');
  const value = documentText(content);
  const skipped = hiddenBlockIds(content, hidden);
  const rubies = new Map<string, RubyFinding[]>();
  for (const run of rubyRuns(content, true))
    rubies.set(run.segmentId, [...(rubies.get(run.segmentId) ?? []), run]);
  let lines = 0;
  for (const segment of value.segments) {
    if (skipped.has(segment.blockId)) continue;
    const text = value.text.slice(segment.start, segment.end);
    lines +=
      lineBreaking === 'none'
        ? text
            .replaceAll('\r\n', '\n')
            .split('\n')
            .reduce(
              (n, line) =>
                n + Math.max(1, Math.ceil(characters(line, 'grapheme').length / columns)),
              0,
            )
        : breakJapaneseLines(text, {
            lineLength: columns,
            hanging: true,
            unbreakable: rubies.get(segment.id) ?? [],
            // An authored CR before a line break takes no cell.
            measure: (grapheme) => (grapheme === '\r' ? 0 : 1),
          }).length;
  }
  return { sheets: Math.ceil(lines / rows), lines, columns, rows, lineBreaking, approximate: true };
}

/** One entry of a Host-supplied notation dictionary: write `preferred`, not any of `avoid`. */
export interface NotationRule {
  /** Host-owned identifier of the term, echoed in findings. */
  id: string;
  preferred: string;
  avoid: readonly string[];
}
export interface NotationFinding {
  ruleId: string;
  blockId: string;
  found: string;
  preferred: string;
  /** Segment-relative replacement for `documentTextEditCommand`; nothing is applied here. */
  edit: DocumentTextEdit;
}

function validNotationRules(rules: readonly NotationRule[]) {
  const ids = new Set<string>();
  for (const rule of rules) {
    if (!rule || typeof rule.id !== 'string' || !rule.id || ids.has(rule.id))
      throw new Error('Notation rules need unique non-empty ids');
    ids.add(rule.id);
    if (typeof rule.preferred !== 'string' || !rule.preferred)
      throw new Error('Notation rule has no preferred form: ' + rule.id);
    if (
      !Array.isArray(rule.avoid) ||
      !rule.avoid.length ||
      rule.avoid.some((form) => typeof form !== 'string' || !form || form === rule.preferred)
    )
      throw new Error('Notation rule has an invalid avoided form: ' + rule.id);
  }
}

const occurrences = (text: string, needle: string) => {
  const found: number[] = [];
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) found.push(at);
  return found;
};

/** Finds avoided forms of the Host dictionary, in document order, without changing the content.
 * At one position the longest avoided form wins and findings never overlap. A match that lies
 * inside an occurrence of any rule's preferred form is not reported. Hidden blocks are skipped
 * unless requested. Apply a chosen subset with `notationEditCommand` as a reviewed proposal. */
export function checkDocumentNotation(
  content: DocumentContent,
  rules: readonly NotationRule[],
  options: { hidden?: boolean } = {},
): NotationFinding[] {
  validNotationRules(rules);
  const { hidden = false } = options;
  if (typeof hidden !== 'boolean') throw new Error('Notation hidden must be boolean');
  const value = documentText(content);
  const skipped = hiddenBlockIds(content, hidden);
  const findings: NotationFinding[] = [];
  for (const segment of value.segments) {
    if (skipped.has(segment.blockId)) continue;
    const text = value.text.slice(segment.start, segment.end);
    const correct = rules.flatMap((rule) =>
      occurrences(text, rule.preferred).map((at) => [at, at + rule.preferred.length]),
    );
    const candidates = rules.flatMap((rule) =>
      rule.avoid.flatMap((form) =>
        occurrences(text, form)
          .map((start) => ({ rule, form, start, end: start + form.length }))
          .filter(({ start, end }) => !correct.some(([from, to]) => from <= start && end <= to)),
      ),
    );
    candidates.sort((a, b) => a.start - b.start || b.end - a.end);
    let covered = 0;
    for (const { rule, form, start, end } of candidates) {
      if (start < covered) continue;
      covered = end;
      findings.push({
        ruleId: rule.id,
        blockId: segment.blockId,
        found: form,
        preferred: rule.preferred,
        edit: { segmentId: segment.id, start, end, expected: form, text: rule.preferred },
      });
    }
  }
  return findings;
}

/** Native text command that replaces the chosen findings with their preferred forms. Pass it to
 * `ArtifactEditor.propose`; the manuscript changes only when the author accepts the proposal. */
export function notationEditCommand(
  base: DocumentContent,
  findings: readonly NotationFinding[],
  context?: LocalCommandContext,
): EditorCommand<DocumentContent> {
  return documentTextEditCommand(
    base,
    findings.map((finding) => finding.edit),
    context,
  );
}

/** A ruby whose base text no longer matches the text it was set on. */
export interface RubyFinding {
  segmentId: string;
  blockId: string;
  /** Offsets inside the segment text, as in `documentText`. */
  start: number;
  end: number;
  /** The base text now carrying the reading. */
  found: string;
  ruby: InlineRuby;
}

/** Reports rubies whose base was partly edited (e.g. 「東京」→「東」 keeps 「とうきょう」).
 * Nothing is changed; the author re-sets or removes the reading. */
export function checkDocumentRuby(
  content: DocumentContent,
  options: { hidden?: boolean } = {},
): RubyFinding[] {
  return rubyRuns(content, options.hidden ?? false).filter((run) => run.found !== run.ruby.base);
}

/** Every ruby run with its segment range and current base text. */
function rubyRuns(content: DocumentContent, hidden: boolean): RubyFinding[] {
  const skipped = hiddenBlockIds(content, hidden);
  const runs: RubyFinding[] = [];
  for (const block of documentTextblocks(contentToNode(content))) {
    if (skipped.has(block.blockId)) continue;
    let offset = 0;
    let open: RubyFinding | undefined;
    block.node.forEach((child) => {
      const text = child.isText ? (child.text ?? '') : child.type.name === 'hard_break' ? '\n' : '';
      const mark = child.marks.find((m) => m.type.name === 'ruby');
      const ruby = mark && {
        text: String(mark.attrs.text),
        base: String(mark.attrs.base),
        ...(mark.attrs.id ? { id: String(mark.attrs.id) } : {}),
      };
      if (open && ruby && sameRuby(open.ruby, ruby)) {
        open.found += text;
        open.end += text.length;
      } else {
        open = ruby && {
          segmentId: block.id,
          blockId: block.blockId,
          start: offset,
          end: offset + text.length,
          found: text,
          ruby,
        };
        if (open) runs.push(open);
      }
      offset += text.length;
    });
  }
  return runs;
}
