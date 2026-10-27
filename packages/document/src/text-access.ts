import { Fragment, type Node as PMNode } from 'prosemirror-model';
import { Transform } from 'prosemirror-transform';
import { newId } from '@editor-platform/artifact-core';
import type { EditorCommand, LocalCommandContext } from '@editor-platform/editor-core';
import { contentToNode, documentSchema } from './engine';
import { localDocumentCommand } from './local-engine-command';
import type { DocumentContent } from './model';

/** Plain text of every text-bearing element, in document order.
 * A native hard_break is '\n' inside its segment; segments are joined by a blank line.
 * Each character is exactly one engine position, so offsets map to native positions.
 * Embedded blocks (image, Mermaid, HTML, references) contribute no segment. */
export interface DocumentTextSegment {
  /** Stable ID of the paragraph, heading, code block, list paragraph or table-cell paragraph. */
  id: string;
  /** ID of the top-level block that contains it. */
  blockId: string;
  start: number;
  end: number;
}
export interface DocumentText {
  text: string;
  segments: DocumentTextSegment[];
}
export const documentTextSeparator = '\n\n';

const leafText = (node: PMNode) => (node.type.name === 'hard_break' ? '\n' : '');
function textblocks(doc: PMNode) {
  const found: { id: string; blockId: string; node: PMNode; pos: number }[] = [];
  doc.forEach((block, offset) => {
    if (block.isTextblock) {
      found.push({
        id: String(block.attrs.id),
        blockId: String(block.attrs.id),
        node: block,
        pos: offset,
      });
      return;
    }
    block.descendants((node, pos) => {
      if (!node.isTextblock) return true;
      found.push({
        id: String(node.attrs.id),
        blockId: String(block.attrs.id),
        node,
        pos: offset + 1 + pos,
      });
      return false;
    });
  });
  return found;
}

export function documentText(content: DocumentContent): DocumentText {
  const segments: DocumentTextSegment[] = [];
  let text = '';
  for (const block of textblocks(contentToNode(content))) {
    if (segments.length) text += documentTextSeparator;
    const value = block.node.textBetween(0, block.node.content.size, '', leafText);
    segments.push({
      id: block.id,
      blockId: block.blockId,
      start: text.length,
      end: text.length + value.length,
    });
    text += value;
  }
  return { text, segments };
}

/** A replacement inside one segment. Offsets are relative to that segment's text. */
export interface DocumentTextEdit {
  segmentId: string;
  start: number;
  end: number;
  /** The text the caller read at [start, end); a mismatch refuses the edit. */
  expected: string;
  text: string;
}

/** Converts a range of `documentText(...).text` into a segment-relative edit range. */
export function locateDocumentText(
  value: DocumentText,
  start: number,
  end: number,
): Omit<DocumentTextEdit, 'text'> {
  const segment = value.segments.find((s) => start >= s.start && end <= s.end);
  if (!segment || start > end)
    throw new Error('The range must lie inside one paragraph, heading, list item or cell');
  return {
    segmentId: segment.id,
    start: start - segment.start,
    end: end - segment.start,
    expected: value.text.slice(start, end),
  };
}

/** Finds `needle` exactly once inside one segment; zero or several matches are refused. */
export function findDocumentText(content: DocumentContent, needle: string) {
  if (!needle) throw new Error('Search text is empty');
  const value = documentText(content);
  const matches: Omit<DocumentTextEdit, 'text'>[] = [];
  for (const segment of value.segments) {
    const own = value.text.slice(segment.start, segment.end);
    for (let at = own.indexOf(needle); at >= 0; at = own.indexOf(needle, at + 1))
      matches.push({ segmentId: segment.id, start: at, end: at + needle.length, expected: needle });
  }
  if (matches.length !== 1)
    throw new Error(
      matches.length ? `"${needle}" occurs ${matches.length} times` : `"${needle}" was not found`,
    );
  return matches[0];
}

/** Native engine command for text replacements; refuses changed or overlapping ranges. */
export function documentTextEditCommand(
  base: DocumentContent,
  edits: readonly DocumentTextEdit[],
  context: LocalCommandContext = { origin: 'local', transactionId: newId('transaction') },
): EditorCommand<DocumentContent> {
  if (!edits.length) throw new Error('No text edits');
  const doc = contentToNode(base);
  const blocks = new Map(textblocks(doc).map((block) => [block.id, block]));
  const ranges = edits.map((edit) => {
    const block = blocks.get(edit.segmentId);
    if (!block) throw new Error('Unknown text element: ' + edit.segmentId);
    const size = block.node.content.size;
    if (
      !Number.isInteger(edit.start) ||
      !Number.isInteger(edit.end) ||
      edit.start < 0 ||
      edit.start > edit.end ||
      edit.end > size
    )
      throw new Error('Text range is outside ' + edit.segmentId);
    const from = block.pos + 1 + edit.start,
      to = block.pos + 1 + edit.end;
    if (doc.textBetween(from, to, '', leafText) !== edit.expected)
      throw new Error('The text changed after it was read: ' + edit.segmentId);
    return { edit, from, to, code: block.node.type.name === 'code_block' };
  });
  ranges.sort((a, b) => b.from - a.from);
  for (let i = 1; i < ranges.length; i++)
    if (ranges[i].to > ranges[i - 1].from) throw new Error('Text edits overlap');
  const tr = new Transform(doc);
  for (const { edit, from, to, code } of ranges) {
    // Replacement text keeps the formatting of the first replaced character.
    const marks = from < to ? (doc.nodeAt(from)?.marks ?? []) : doc.resolve(from).marks();
    const nodes = code
      ? edit.text
        ? [documentSchema.text(edit.text)]
        : []
      : edit.text
          .split('\n')
          .flatMap((part, i) => [
            ...(i ? [documentSchema.nodes.hard_break.create()] : []),
            ...(part ? [documentSchema.text(part, marks)] : []),
          ]);
    tr.replaceWith(from, to, Fragment.from(nodes));
  }
  return localDocumentCommand(base, tr.doc, context).command;
}

/** For `EditorHostAdapter.text`. */
export const documentTextAccess = { read: documentText };
