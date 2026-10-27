import {
  changedKeys,
  orderChanged,
  sameValue,
  textRange,
  type FallbackChange,
  type ProposalDiffAdapter,
  type SemanticChange,
} from '@editor-platform/editor-core';
import {
  documentTextBlocks,
  nestedLists,
  type DocumentBlock,
  type DocumentContent,
  type DocumentListItem,
  type InlineSpan,
} from './model';

const label = (text: string) => (text.length > 60 ? text.slice(0, 59) + '…' : text);
/** Formatting runs with their lengths, so moving a mark boundary is a change. */
const marks = (spans: InlineSpan[] | undefined) =>
  spans?.map(({ text, ...rest }) => ({ ...rest, length: text.length }));
/** Stable text addresses of one block: list items and table paragraphs, else the block. */
type TextAddress = { text: string; marks?: unknown; attrs?: Record<string, unknown> };
function textAddresses(block: DocumentBlock): Map<string, TextAddress> {
  const result = new Map<string, TextAddress>();
  const items = (list: DocumentListItem[]) => {
    for (const item of list) {
      const { id: _id, rich, children: _c, childLists: _l, ...own } = item;
      // Nested list type, numbering and checklist settings belong to the item that holds them.
      const lists = nestedLists(item).map(({ items: _i, ...meta }) => meta);
      const attrs = lists.length ? { ...own, lists } : own;
      result.set(item.id, {
        text: rich.map((s) => s.text).join(''),
        marks: marks(rich),
        ...(Object.keys(attrs).length ? { attrs } : {}),
      });
      nestedLists(item).forEach((nested) => items(nested.items));
    }
  };
  if (block.items) items(block.items);
  else if (block.type === 'table' || block.cellParagraphs)
    for (const p of tableParagraphs(block))
      result.set(p.id, {
        text: p.rich.map((s) => s.text).join(''),
        ...(p.plain ? {} : { marks: marks(p.rich) }),
      });
  // The engine renders `rich` when present, so its text is what the reader sees.
  else
    result.set(block.id, {
      text: block.rich ? block.rich.map((s) => s.text).join('') : block.text,
      marks: marks(block.rich),
    });
  return result;
}
/**
 * The paragraphs of each table cell, resolved per cell as the native engine does: the cell's
 * paragraphs, else one paragraph from `cellRich` or `cells` with the stored or a positional ID.
 */
function tableParagraphs(block: DocumentBlock) {
  const rows = block.cells ?? block.cellParagraphs?.map((row) => row.map(() => '')) ?? [];
  return rows.flatMap((row, r) =>
    row.flatMap((value, c) => {
      const own = block.cellParagraphs?.[r]?.[c];
      if (own) return own.map((p) => ({ id: p.id, rich: p.rich, r, c, plain: false }));
      const rich = block.cellRich?.[r]?.[c];
      return [
        {
          id: block.cellParagraphIds?.[r]?.[c] ?? `${block.id}:cell:${r}:${c}`,
          rich: rich ?? [{ text: value }],
          r,
          c,
          plain: !rich,
        },
      ];
    }),
  );
}
/** Where each text address sits: `parentItem/list` ('' at top level), or the table cell `row:col`. */
function nesting(block: DocumentBlock): [string, string][] {
  const result: [string, string][] = [];
  const walk = (list: DocumentListItem[], parent: string) => {
    for (const item of list) {
      result.push([item.id, parent]);
      nestedLists(item).forEach((nested) => walk(nested.items, `${item.id}/${nested.id}`));
    }
  };
  walk(block.items ?? [], '');
  if (block.type === 'table' || block.cellParagraphs)
    for (const p of tableParagraphs(block)) result.push([p.id, `${p.r}:${p.c}`]);
  return result;
}
const formatted = (spans: InlineSpan[] | undefined) =>
  !!spans?.some((span) => Object.keys(span).some((key) => key !== 'text'));
/** Plain text for an unformatted text block; else the native block (formatting, level, tables, images). */
const blockValue = (block: DocumentBlock) =>
  Object.keys(block).every((key) => ['id', 'type', 'text', 'rich'].includes(key)) &&
  !formatted(block.rich)
    ? block.text
    : block;
/** Plain text, or text with its formatting runs and item attributes when it has any. */
function addressValue(address: TextAddress) {
  const runs = (address.marks ?? []) as Record<string, unknown>[];
  const formatted = runs.some((run) => Object.keys(run).some((key) => key !== 'length'));
  return formatted || address.attrs
    ? {
        text: address.text,
        ...(formatted ? { marks: address.marks } : {}),
        ...(address.attrs ? { attrs: address.attrs } : {}),
      }
    : address.text;
}
/** One formatting key per UTF-16 unit, from runs with lengths. */
function charMarks(address: TextAddress): string[] {
  if (!address.marks) return Array<string>(address.text.length).fill('{}');
  const runs = address.marks as ({ length: number } & Record<string, unknown>)[];
  return runs.flatMap(({ length, ...rest }) => Array<string>(length).fill(JSON.stringify(rest)));
}
/** Formatting changed outside the text edit, or the inserted text differs from its neighbour. */
function formattingChanged(x: TextAddress, y: TextAddress) {
  if (sameValue(x.marks, y.marks)) return false;
  if (x.text === y.text) return true;
  const a = charMarks(x),
    b = charMarks(y);
  const r = textRange(x.text, y.text)!;
  const keptBefore = [...a.slice(0, r.start), ...a.slice(r.beforeEnd)],
    keptAfter = [...b.slice(0, r.start), ...b.slice(r.afterEnd)];
  if (!sameValue(keptBefore, keptAfter)) return true;
  const neighbour = b[r.start - 1] ?? b[r.afterEnd] ?? JSON.stringify({});
  return b.slice(r.start, r.afterEnd).some((key) => key !== neighbour);
}
const structural = ['text', 'rich', 'items', 'cells', 'cellRich', 'cellParagraphs'];

function blockChanges(old: DocumentBlock, next: DocumentBlock): SemanticChange[] {
  const changes: SemanticChange[] = [];
  const a = textAddresses(old),
    b = textAddresses(next);
  for (const id of [...new Set([...a.keys(), ...b.keys()])]) {
    const x = a.get(id),
      y = b.get(id);
    const base = {
      domain: 'document',
      elementId: id,
      elementLabel: label((x ?? y)!.text),
    };
    if (!x || !y) {
      changes.push({
        ...base,
        kind: x ? 'removed' : 'added',
        property: 'text',
        ...(x ? { before: addressValue(x) } : { after: addressValue(y!) }),
      });
    } else if (x.text !== y.text) {
      changes.push({
        ...base,
        kind: 'text',
        property: 'text',
        before: x.text,
        after: y.text,
        units: 'utf16',
        range: textRange(x.text, y.text),
      });
    }
    if (x && y && !sameValue(x.attrs, y.attrs))
      changes.push({
        ...base,
        kind: 'property',
        property: 'item',
        before: x.attrs,
        after: y.attrs,
      });
    if (x && y && formattingChanged(x, y))
      changes.push({
        ...base,
        kind: 'property',
        property: 'formatting',
        before: x.marks,
        after: y.marks,
      });
  }
  // Table shape and other structure without stable text IDs.
  if (old.type === 'table' && !sameValue(old.cells?.length, next.cells?.length))
    changes.push({
      domain: 'document',
      kind: 'property',
      elementId: old.id,
      property: 'rows',
      before: old.cells?.length ?? 0,
      after: next.cells?.length ?? 0,
    });
  // Order and nesting of addresses with unchanged text (list items moved or reparented).
  const parents = (block: DocumentBlock, keep: Map<string, TextAddress>) =>
    nesting(block).filter(([id]) => keep.has(id));
  if (
    orderChanged([...a.keys()], [...b.keys()]) ||
    !sameValue(Object.fromEntries(parents(old, b)), Object.fromEntries(parents(next, a)))
  )
    changes.push({
      domain: 'document',
      kind: 'order',
      elementId: old.id,
      elementLabel: label(old.text),
      property: 'items',
      before: nesting(old),
      after: nesting(next),
    });
  // Anything else in the structure that no change above names stays visible as JSON-like values.
  if (!changes.length)
    for (const key of changedKeys(old, next).filter((k) => structural.includes(k)))
      changes.push({
        domain: 'document',
        kind: 'property',
        elementId: old.id,
        elementLabel: label(old.text),
        property: key,
        before: (old as unknown as Record<string, unknown>)[key],
        after: (next as unknown as Record<string, unknown>)[key],
      });
  for (const key of changedKeys(old, next, structural))
    changes.push({
      domain: 'document',
      kind: 'property',
      elementId: old.id,
      elementLabel: label(old.text),
      property: key,
      before: (old as unknown as Record<string, unknown>)[key],
      after: (next as unknown as Record<string, unknown>)[key],
    });
  return changes;
}

/** Text ranges per stable block/list-item/table-paragraph ID, plus block structure. */
export const documentProposalDiff: ProposalDiffAdapter<DocumentContent> = {
  domain: 'document',
  has: (d, id) => d.blocks.some((b) => b.id === id) || documentTextBlocks(d).has(id),
  diff(before, after) {
    const changes: SemanticChange[] = [],
      fallback: FallbackChange[] = [];
    const am = new Map(before.blocks.map((b) => [b.id, b])),
      bm = new Map(after.blocks.map((b) => [b.id, b]));
    for (const block of before.blocks)
      if (!bm.has(block.id))
        changes.push({
          domain: 'document',
          kind: 'removed',
          elementId: block.id,
          elementLabel: label(block.text),
          property: block.type,
          before: blockValue(block),
        });
    for (const block of after.blocks) {
      const old = am.get(block.id);
      if (!old)
        changes.push({
          domain: 'document',
          kind: 'added',
          elementId: block.id,
          elementLabel: label(block.text),
          property: block.type,
          after: blockValue(block),
        });
      else changes.push(...blockChanges(old, block));
    }
    const ids = (d: DocumentContent) => d.blocks.map((b) => b.id);
    if (orderChanged(ids(before), ids(after)))
      changes.push({
        domain: 'document',
        kind: 'order',
        elementId: '',
        property: 'blocks',
        before: ids(before),
        after: ids(after),
      });
    if (!sameValue(before.page, after.page))
      changes.push({
        domain: 'document',
        kind: 'property',
        elementId: '',
        property: 'page',
        before: before.page,
        after: after.page,
      });
    for (const key of changedKeys(before, after, ['blocks', 'page']))
      fallback.push({
        path: key,
        before: (before as unknown as Record<string, unknown>)[key],
        after: (after as unknown as Record<string, unknown>)[key],
        reason: 'no-semantic-diff',
      });
    return { changes, view: [], fallback };
  },
};
