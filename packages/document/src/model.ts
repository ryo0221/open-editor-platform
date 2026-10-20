import {
  validEmbeddedReference,
  validReferenceItems,
  describeReference,
  referenceExportManifest,
  type EmbeddedReference,
} from '@editor-platform/artifact-references';
import {
  clone,
  diffElements,
  isDeepFrozen,
  newId,
  type CompareResult,
} from '@editor-platform/artifact-core';
import { validNativeReuse, type ReuseState } from '@editor-platform/reuse-core';
import {
  command,
  type EditorCommand,
  type ElementAddress,
  type Selection,
} from '@editor-platform/editor-core';
export type BlockType =
  | 'heading'
  | 'paragraph'
  | 'bulleted-list'
  | 'numbered-list'
  | 'check-list'
  | 'table'
  | 'code'
  | 'image'
  | 'mermaid'
  | 'html'
  | 'react-preview';
export interface InlineSpan {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  code?: boolean;
  link?: string;
  color?: string;
  highlight?: string;
}
export interface DocumentListItem {
  id: string;
  rich: InlineSpan[];
  checked?: boolean;
  paragraphId?: string;
  childrenId?: string;
  childrenType?: 'bullet_list' | 'ordered_list';
  children?: DocumentListItem[];
  childLists?: {
    id: string;
    type: 'bullet_list' | 'ordered_list';
    start?: number;
    check?: boolean;
    items: DocumentListItem[];
  }[];
}
export function nestedLists(item: DocumentListItem): NonNullable<DocumentListItem['childLists']> {
  return (
    item.childLists ??
    (item.children?.length
      ? [
          {
            id: item.childrenId ?? `${item.id}:children`,
            type: item.childrenType ?? 'bullet_list',
            items: item.children,
          },
        ]
      : [])
  );
}
export interface DocumentBlock {
  reference?: EmbeddedReference;
  id: string;
  type: BlockType;
  text: string;
  /** Materialized named style. Library identity/base belongs to retained reuse metadata. */
  style?: DocumentTextStyle;
  styleName?: string;
  /** Visibility is independent from deletion and preserves native text/IDs. */
  hidden?: boolean;
  level?: number;
  /** Ordered-list start; absent means one. ADR008. */
  start?: number;
  language?: string;
  cells?: string[][];
  src?: string;
  alt?: string;
  rich?: InlineSpan[];
  items?: DocumentListItem[];
  align?: 'left' | 'center' | 'right' | 'justify';
  indent?: number;
  width?: number;
  caption?: string;
  cellRich?: InlineSpan[][][];
  cellParagraphIds?: string[][];
  cellHeaders?: boolean[][];
  cellParagraphs?: { id: string; rich: InlineSpan[] }[][][];
  merges?: { row: number; col: number; rows: number; cols: number }[];
  columnWidths?: number[];
}
export interface DocumentTextStyle {
  color?: string;
  highlight?: string;
  fontFamily?: 'Noto Sans CJK JP' | 'Noto Sans Mono CJK JP';
  /** Document measures use points, independent of canvas px. */
  fontSize?: number;
  fontWeight?: 400 | 700;
  lineHeight?: number;
  spaceBefore?: number;
  spaceAfter?: number;
}
export function validDocumentTextStyle(value: unknown): value is DocumentTextStyle {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value).every(([key, field]) => {
    if (field === undefined) return true;
    if (key === 'color' || key === 'highlight')
      return typeof field === 'string' && /^#[a-f0-9]{6}$/i.test(field);
    if (key === 'fontFamily')
      return (
        typeof field === 'string' && ['Noto Sans CJK JP', 'Noto Sans Mono CJK JP'].includes(field)
      );
    if (key === 'fontWeight') return field === 400 || field === 700;
    if (typeof field !== 'number' || !Number.isFinite(field)) return false;
    if (key === 'fontSize') return field >= 1 && field <= 384;
    if (key === 'lineHeight') return field >= 0.5 && field <= 5;
    return ['spaceBefore', 'spaceAfter'].includes(key) && field >= 0 && field <= 1000;
  });
}
export function documentStyleCss(style?: DocumentTextStyle): string {
  if (!style) return '';
  if (!validDocumentTextStyle(style)) throw new Error('Unsupported document style');
  const names: Record<string, string> = {
    color: 'color',
    highlight: 'background-color',
    fontFamily: 'font-family',
    fontSize: 'font-size',
    fontWeight: 'font-weight',
    lineHeight: 'line-height',
    spaceBefore: 'margin-top',
    spaceAfter: 'margin-bottom',
  };
  return Object.entries(style)
    .filter(([, value]) => value !== undefined)
    .map(
      ([key, value]) =>
        names[key] +
        ':' +
        (key === 'fontFamily' ? '"' + value + '"' : value) +
        (['fontSize', 'spaceBefore', 'spaceAfter'].includes(key) ? 'pt' : ''),
    )
    .join(';');
}
export function styledDocumentSpans(spans: InlineSpan[], style?: DocumentTextStyle): InlineSpan[] {
  if (!style) return spans;
  return spans.map((span) => ({
    ...(style.color ? { color: style.color } : {}),
    ...(style.highlight ? { highlight: style.highlight } : {}),
    ...(style.fontWeight !== undefined ? { bold: style.fontWeight === 700 } : {}),
    ...span,
  }));
}
export interface DocumentContent {
  schemaVersion: 1 | 2;
  reuse?: ReuseState;
  page?: { size: 'A4' | 'Letter'; margin: number; landscape?: boolean };
  blocks: DocumentBlock[];
}
/** Semantic text addresses include paragraphs inside lists/tables, without engine positions. */
export function documentTextBlocks(d: DocumentContent): Map<string, string> {
  const result = new Map<string, string>();
  const items = (list: DocumentListItem[]) => {
    for (const item of list) {
      const text = item.rich.map((s) => s.text).join('');
      result.set(item.id, text);
      result.set(item.paragraphId ?? `${item.id}:text`, text);
      nestedLists(item).forEach((list) => items(list.items));
    }
  };
  for (const block of d.blocks) {
    result.set(block.id, block.text);
    if (block.items) items(block.items);
    else if (['bulleted-list', 'numbered-list', 'check-list'].includes(block.type))
      items(
        block.text
          .split('\n')
          .map((text, i) => ({ id: `${block.id}:item:${i}`, rich: [{ text }] })),
      );
    if (block.type === 'table')
      block.cells?.forEach((row, r) =>
        row.forEach((text, c) => result.set(`${block.id}:cell:${r}:${c}`, text)),
      );
    block.cellParagraphs?.forEach((row) =>
      row.forEach((paragraphs) =>
        // Covered merge cells may be holes locally and null after JSON transport.
        // Both are accepted by validTableDetails and have no text anchor of their own.
        paragraphs?.forEach((p) => result.set(p.id, p.rich.map((s) => s.text).join(''))),
      ),
    );
    block.cellParagraphIds?.forEach((row, r) =>
      row.forEach((id, c) => {
        if (typeof id === 'string' && id && !result.has(id))
          result.set(id, block.cells?.[r]?.[c] ?? '');
      }),
    );
  }
  return result;
}
export function anchorDocumentSelection(d: DocumentContent, selection: Selection): Selection {
  const texts = documentTextBlocks(d);
  return {
    addresses: selection.addresses.map((a) =>
      a.region?.type === 'text' && texts.has(a.elementId)
        ? {
            ...a,
            region: { ...a.region, sourceText: texts.get(a.elementId)! },
          }
        : a,
    ),
  };
}
export function resolveDocumentAddress(
  d: DocumentContent,
  address: ElementAddress,
): { state: 'Current' | 'Outdated' | 'Orphan'; address: ElementAddress } {
  const text = documentTextBlocks(d).get(address.elementId),
    range = address.region;
  if (text === undefined) return { state: 'Orphan', address };
  if (range?.type !== 'text') return { state: 'Current', address };
  const source = range.sourceText;
  if (source === undefined || source === text)
    return { state: range.end <= text.length ? 'Current' : 'Orphan', address };
  let prefix = 0,
    suffix = 0;
  while (prefix < Math.min(source.length, text.length) && source[prefix] === text[prefix]) prefix++;
  while (
    suffix < Math.min(source.length, text.length) - prefix &&
    source[source.length - 1 - suffix] === text[text.length - 1 - suffix]
  )
    suffix++;
  let start: number | undefined;
  if (range.end <= prefix) start = range.start;
  else if (range.start >= source.length - suffix) start = range.start + text.length - source.length;
  else {
    const quote = source.slice(range.start, range.end),
      matches: number[] = [];
    if (quote)
      for (let at = text.indexOf(quote); at >= 0; at = text.indexOf(quote, at + 1))
        matches.push(at);
    if (matches.length === 1) start = matches[0];
    else if (!matches.length) return { state: 'Orphan', address };
    else {
      const before = source.slice(Math.max(0, range.start - 32), range.start),
        after = source.slice(range.end, range.end + 32);
      const contextual = matches.filter(
        (i) =>
          text.slice(Math.max(0, i - before.length), i) === before &&
          text.slice(i + quote.length, i + quote.length + after.length) === after,
      );
      if (contextual.length === 1) start = contextual[0];
    }
  }
  if (start === undefined) return { state: 'Outdated', address };
  return {
    state: 'Current',
    address: { ...address, region: { ...range, start, end: start + range.end - range.start } },
  };
}
export function makeBlock(type: BlockType): DocumentBlock {
  return {
    id: newId('block'),
    type,
    text:
      type === 'mermaid'
        ? 'graph LR\n  A[Idea] --> B[Draft] --> C[Publish]'
        : type === 'html'
          ? '<h2>A sandboxed preview</h2><p>Edit this HTML safely.</p>'
          : type === 'react-preview'
            ? 'Trusted adapter demo'
            : '',
    ...(type === 'heading' ? { level: 1 } : {}),
    ...(type === 'table'
      ? {
          cells: [
            ['Column 1', 'Column 2'],
            ['', ''],
          ],
        }
      : {}),
    ...(type === 'code' ? { language: 'text' } : {}),
  };
}
export function createDocument(): DocumentContent {
  return {
    schemaVersion: 2,
    blocks: [
      { ...makeBlock('heading'), text: 'Untitled document' },
      { ...makeBlock('paragraph'), text: '' },
    ],
  };
}
export const insertBlock = (type: BlockType): EditorCommand<DocumentContent> => {
  const block = makeBlock(type);
  return command('document.insert', `Add ${type}`, (d) => ({ ...d, blocks: [...d.blocks, block] }));
};
export const updateBlock = (
  id: string,
  patch: Partial<Omit<DocumentBlock, 'id'>>,
): EditorCommand<DocumentContent> =>
  command('document.update', 'Edit block', (d) => ({
    ...d,
    blocks: d.blocks.map((b) =>
      b.id === id
        ? {
            ...b,
            ...patch,
            ...(patch.text !== undefined && patch.rich === undefined && b.rich
              ? { rich: [{ text: patch.text }] }
              : {}),
          }
        : b,
    ),
  }));
export const deleteBlock = (id: string): EditorCommand<DocumentContent> =>
  command('document.delete', 'Delete block', (d) => ({
    ...d,
    blocks: d.blocks.filter((b) => b.id !== id),
  }));
export const moveBlock = (id: string, delta: number): EditorCommand<DocumentContent> =>
  command('document.move', 'Move block', (d) => {
    const blocks = [...d.blocks],
      index = blocks.findIndex((b) => b.id === id),
      target = index + delta;
    if (index < 0 || target < 0 || target >= blocks.length) return d;
    blocks.splice(target, 0, blocks.splice(index, 1)[0]);
    return { ...d, blocks };
  });
export function documentDiff(a: DocumentContent, b: DocumentContent): CompareResult {
  const formatting = (block: DocumentBlock) => {
    const spans: InlineSpan[] = [...(block.rich ?? [])];
    const visit = (items: DocumentListItem[]) => {
      for (const item of items) {
        spans.push(...item.rich);
        for (const list of nestedLists(item)) visit(list.items);
      }
    };
    visit(block.items ?? []);
    for (const row of block.cellRich ?? []) for (const cell of row) spans.push(...(cell ?? []));
    for (const row of block.cellParagraphs ?? [])
      for (const cell of row) for (const p of cell ?? []) spans.push(...p.rich);
    const notes = new Set(
      spans.flatMap((span) => {
        const style = [
          span.underline ? 'underline' : '',
          span.color ? `color ${span.color}` : '',
          span.highlight ? `highlight ${span.highlight}` : '',
        ].filter(Boolean);
        return style.length ? [`“${span.text}”: ${style.join(', ')}`] : [];
      }),
    );
    return notes.size ? `\nFormatting: ${[...notes].join('; ')}` : '';
  };
  const describe = (block: DocumentBlock | undefined) =>
    !block
      ? undefined
      : exportMarkdown({ schemaVersion: 2, blocks: [block] }).trim() +
        describeReference(block) +
        formatting(block) +
        `\n[${block.type}; alignment: ${block.align ?? 'left'}; indent: ${block.indent ?? 0}${block.width ? `; width: ${block.width}` : ''}${block.columnWidths ? `; columns: ${block.columnWidths.join(', ')}` : ''}${block.merges?.length ? `; merged cells: ${block.merges.map((m) => `${m.row + 1}:${m.col + 1} (${m.rows}×${m.cols})`).join(', ')}` : ''}]`;
  return {
    changes: diffElements(a.blocks, b.blocks).changes.map((change) => {
      const old = a.blocks.find((block) => block.id === change.elementId),
        next = b.blocks.find((block) => block.id === change.elementId);
      const block = next ?? old!;
      return {
        ...change,
        path: `${block.type} block`,
        before: describe(old),
        after: describe(next),
      };
    }),
  };
}
export function safeAssetUrl(url: string): boolean {
  return /^(data:image\/(png|jpeg|gif|webp|svg\+xml);base64,|https?:\/\/)/i.test(url);
}
export const escapeHtml = (s: string) =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
export function exportMarkdown(doc: DocumentContent): string {
  return (
    doc.blocks
      .map((b) => {
        if (b.type === 'heading')
          return `${'#'.repeat(b.level ?? 1)} ${spansMarkdown(b.rich ?? [{ text: b.text }])}`;
        if (['bulleted-list', 'numbered-list', 'check-list'].includes(b.type))
          return listMarkdown(
            b.items ??
              b.text.split('\n').map((text, i) => ({
                id: String(i),
                rich: [{ text }],
                ...(b.type === 'check-list' ? { checked: false } : {}),
              })),
            b.type === 'numbered-list',
            0,
            b.start,
          );
        if (b.type === 'table')
          return (b.cells ?? [])
            .map(
              (row, i) =>
                `| ${row.map((c) => c.replaceAll('|', '\\|').replaceAll('\n', ' ')).join(' | ')} |${i === 0 ? `\n| ${row.map(() => '---').join(' | ')} |` : ''}`,
            )
            .join('\n');
        if (b.type === 'image') return `![${(b.alt ?? '').replaceAll(']', '\\]')}](${b.src ?? ''})`;
        if (['code', 'mermaid', 'html'].includes(b.type)) {
          const fence = '`'.repeat(
            Math.max(3, ...[...b.text.matchAll(/`+/g)].map((m) => m[0].length + 1)),
          );
          return `${fence}${b.type === 'code' ? (b.language ?? '') : b.type}\n${b.text}\n${fence}`;
        }
        return spansMarkdown(b.rich ?? [{ text: b.text }]);
      })
      .join('\n\n') + '\n'
  );
}
export function importMarkdown(text: string): DocumentContent {
  const lines = text.replaceAll('\r\n', '\n').split('\n'),
    blocks: DocumentBlock[] = [];
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = line.match(/^(`{3,})([^`]*)$/);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith(fence[1])) body.push(lines[i++]);
      i++;
      const language = fence[2].trim();
      const type = language === 'mermaid' || language === 'html' ? language : 'code';
      blocks.push({ ...makeBlock(type), text: body.join('\n'), language });
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      blocks.push({
        ...makeBlock('heading'),
        level: heading[1].length,
        text: markdownBreaks(heading[2]),
      });
      i++;
      continue;
    }
    const image = line.match(/^!\[(.*)\]\((.*)\)$/);
    if (image) {
      blocks.push({
        ...makeBlock('image'),
        alt: image[1],
        src: safeAssetUrl(image[2]) ? image[2] : '',
        text: '',
      });
      i++;
      continue;
    }
    if (line.startsWith('|') && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? '')) {
      const parseRow = (s: string) =>
        s
          .trim()
          .replace(/^\||\|$/g, '')
          .split(/(?<!\\)\|/)
          .map((c) => c.trim().replaceAll('\\|', '|'));
      const cells = [parseRow(line)];
      i += 2;
      while (i < lines.length && lines[i].startsWith('|')) cells.push(parseRow(lines[i++]));
      blocks.push({ ...makeBlock('table'), cells });
      continue;
    }
    const list = line.match(/^(?:([-*])|\d+\.)\s+(.*)$/);
    if (list) {
      const items: string[] = [];
      const numbered = !list[1];
      const re = numbered ? /^\d+\.\s+(.*)$/ : /^[-*]\s+(.*)$/;
      while (i < lines.length) {
        const m = lines[i].match(re);
        if (!m) break;
        items.push(m[1]);
        i++;
      }
      const checked = items.every((item) => /^\[[ x]\] /.test(item));
      const parsedItems = items.map((item) => ({
        id: newId('item'),
        ...(checked ? { checked: item.startsWith('[x]') } : {}),
        rich: [{ text: markdownBreaks(item.replace(/^\[[ x]\] /, '')) }],
      }));
      blocks.push({
        ...makeBlock(numbered ? 'numbered-list' : checked ? 'check-list' : 'bulleted-list'),
        text: parsedItems.map((item) => item.rich[0].text).join('\n'),
        items: parsedItems,
        ...(numbered && Number(line.match(/^\d+/)![0]) !== 1
          ? { start: Number(line.match(/^\d+/)![0]) }
          : {}),
      });
      continue;
    }
    const paragraph = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !/^(#|`{3}|[-*] |\d+\. |!\[|\|)/.test(lines[i]))
      paragraph.push(lines[i++]);
    blocks.push({ ...makeBlock('paragraph'), text: markdownBreaks(paragraph.join('\n')) });
  }
  return { schemaVersion: 1, blocks };
}
function listHtml(items: DocumentListItem[], numbered = false, start = 1): string {
  const tag = numbered ? 'ol' : 'ul';
  return `<${tag}${numbered && start !== 1 ? ` start="${start}"` : ''}>${items
    .map(
      (i) =>
        `<li>${i.checked === undefined ? '' : i.checked ? '☑ ' : '☐ '}${spansHtml(i.rich)}${nestedLists(
          i,
        )
          .map((list) => listHtml(list.items, list.type === 'ordered_list', list.start))
          .join('')}</li>`,
    )
    .join('')}</${tag}>`;
}
function listMarkdown(items: DocumentListItem[], numbered = false, depth = 0, start = 1): string {
  return items
    .map(
      (item, i) =>
        `${'  '.repeat(depth)}${numbered ? `${i + start}.` : '-'} ${item.checked === undefined ? '' : item.checked ? '[x] ' : '[ ] '}${spansMarkdown(item.rich)}${nestedLists(
          item,
        )
          .map(
            (list) =>
              '\n' + listMarkdown(list.items, list.type === 'ordered_list', depth + 1, list.start),
          )
          .join('')}`,
    )
    .join('\n');
}
export function exportHtml(doc: DocumentContent): string {
  const body = doc.blocks
    .filter((b) => !b.hidden)
    .map((b) => {
      const text = spansHtml(b.rich ?? [{ text: b.text }]);
      const style = `text-align:${b.align ?? 'left'};margin-left:${(b.indent ?? 0) * 24}px${b.style ? ';' + escapeHtml(documentStyleCss(b.style)) : ''}`;
      if (b.type === 'heading')
        return `<h${b.level ?? 1} style="${style}">${text}</h${b.level ?? 1}>`;
      if (b.type === 'image')
        return b.src && safeAssetUrl(b.src)
          ? `<figure><img src="${escapeHtml(b.src)}" alt="${escapeHtml(b.alt ?? '')}"${b.width ? ` width="${b.width}"` : ''}/>${b.caption ? `<figcaption>${escapeHtml(b.caption)}</figcaption>` : ''}</figure>`
          : '';
      if (b.type === 'table')
        return `<table>${(b.cells ?? [])
          .map(
            (row, r) =>
              `<tr>${row
                .map((value, c) => {
                  if (
                    b.merges?.some(
                      (m) =>
                        r >= m.row &&
                        r < m.row + m.rows &&
                        c >= m.col &&
                        c < m.col + m.cols &&
                        (r !== m.row || c !== m.col),
                    )
                  )
                    return '';
                  const m = b.merges?.find((m) => m.row === r && m.col === c),
                    tag = (b.cellHeaders?.[r]?.[c] ?? r === 0) ? 'th' : 'td';
                  return `<${tag}${m ? ` rowspan="${m.rows}" colspan="${m.cols}"` : ''}${b.columnWidths ? ` style="width:${b.columnWidths[c]}px"` : ''}>${b.cellParagraphs?.[r]?.[c]?.map((p) => `<p>${spansHtml(p.rich)}</p>`).join('') ?? spansHtml(b.cellRich?.[r]?.[c] ?? [{ text: value }])}</${tag}>`;
                })
                .join('')}</tr>`,
          )
          .join('')}</table>`;
      if (['bulleted-list', 'numbered-list', 'check-list'].includes(b.type))
        return listHtml(
          b.items ??
            b.text.split('\n').map((text, i) => ({
              id: String(i),
              rich: [{ text }],
              ...(b.type === 'check-list' ? { checked: false } : {}),
            })),
          b.type === 'numbered-list',
          b.start,
        );
      if (['code', 'mermaid', 'html'].includes(b.type))
        return `<pre><code>${escapeHtml(b.text)}</code></pre>`;
      return `<p style="${style}">${text}</p>`;
    })
    .join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https:; style-src 'unsafe-inline'"><title>Document</title>${referenceExportManifest(doc.blocks.filter((block) => !block.hidden)) ? `<meta name="artifact-references" content="${escapeHtml(referenceExportManifest(doc.blocks.filter((block) => !block.hidden))!)}"/>` : ''}<style>body{max-width:800px;margin:40px auto;font:16px/1.6 system-ui;padding:16px}table{border-collapse:collapse;max-width:100%}td,th{border:1px solid #aaa;padding:8px}th{background:#f1f4f9}img{max-width:100%;height:auto}figure{margin:16px 0}figcaption{color:#667085;font-size:13px}pre{white-space:pre-wrap}a{color:#3957bd}code{font-family:monospace}</style></head><body>${body}</body></html>`;
}
function validSpans(value: unknown): value is InlineSpan[] {
  return (
    Array.isArray(value) &&
    value.every(
      (s) =>
        s &&
        typeof s.text === 'string' &&
        ['bold', 'italic', 'underline', 'strike', 'code'].every(
          (k) => s[k] === undefined || typeof s[k] === 'boolean',
        ) &&
        (s.link === undefined || (typeof s.link === 'string' && safeLink(s.link))) &&
        ['color', 'highlight'].every(
          (k) => s[k] === undefined || (typeof s[k] === 'string' && /^#[0-9a-f]{3,8}$/i.test(s[k])),
        ),
    )
  );
}
const validListStart = (n: unknown) =>
  n === undefined || (typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 1_000_000);
function validItems(value: unknown, seen = new Set<string>(), depth = 0): boolean {
  return (
    depth < 30 &&
    Array.isArray(value) &&
    value.every((i) => {
      if (
        !i ||
        typeof i.id !== 'string' ||
        seen.has(i.id) ||
        !validSpans(i.rich) ||
        (i.checked !== undefined && typeof i.checked !== 'boolean')
      )
        return false;
      seen.add(i.id);
      return (
        (i.childrenType === undefined ||
          ['bullet_list', 'ordered_list'].includes(i.childrenType)) &&
        (i.children === undefined || validItems(i.children, seen, depth + 1)) &&
        (i.childLists === undefined ||
          (Array.isArray(i.childLists) &&
            i.children === undefined &&
            i.childLists.every(
              (list: NonNullable<DocumentListItem['childLists']>[number]) =>
                list &&
                typeof list.id === 'string' &&
                ['bullet_list', 'ordered_list'].includes(list.type) &&
                validListStart(list.start) &&
                (list.start === undefined || list.type === 'ordered_list') &&
                (list.check === undefined || typeof list.check === 'boolean') &&
                validItems(list.items, seen, depth + 1),
            )))
      );
    })
  );
}
function validMerges(b: DocumentBlock): boolean {
  if (!Array.isArray(b.merges) || !Array.isArray(b.cells)) return false;
  const used = new Set<string>();
  return b.merges.every((m) => {
    if (
      !m ||
      ![m.row, m.col, m.rows, m.cols].every(Number.isInteger) ||
      m.row < 0 ||
      m.col < 0 ||
      m.rows < 1 ||
      m.cols < 1 ||
      m.row + m.rows > b.cells!.length ||
      m.col + m.cols > (b.cells![0]?.length ?? 0)
    )
      return false;
    for (let r = m.row; r < m.row + m.rows; r++)
      for (let c = m.col; c < m.col + m.cols; c++) {
        const key = `${r}:${c}`;
        if (used.has(key)) return false;
        used.add(key);
      }
    return true;
  });
}
function validTableDetails(block: DocumentBlock): boolean {
  const cells = block.cells;
  if (!Array.isArray(cells) || !cells.length || !Array.isArray(cells[0]) || !cells[0].length)
    return false;
  const count = cells[0].length;
  if (
    !cells.every(
      (row) =>
        Array.isArray(row) && row.length === count && row.every((cell) => typeof cell === 'string'),
    )
  )
    return false;
  const matrix = (value: unknown, valid: (cell: unknown) => boolean) =>
    value === undefined ||
    (Array.isArray(value) &&
      value.length <= cells.length &&
      value.every(
        (row) =>
          Array.isArray(row) &&
          row.length <= count &&
          row.every((cell) => cell === null || cell === undefined || valid(cell)),
      ));
  return (
    matrix(block.cellRich, validSpans) &&
    matrix(block.cellHeaders, (value) => typeof value === 'boolean') &&
    matrix(block.cellParagraphIds, (value) => typeof value === 'string') &&
    matrix(
      block.cellParagraphs,
      (value) =>
        Array.isArray(value) &&
        value.every(
          (paragraph) =>
            paragraph && typeof paragraph.id === 'string' && validSpans(paragraph.rich),
        ),
    ) &&
    (block.columnWidths === undefined || block.columnWidths.length === count)
  );
}
export function isDocument(value: unknown): value is DocumentContent {
  if (!value || typeof value !== 'object') return false;
  const d = value as DocumentContent;
  return (
    (d.schemaVersion === 1 || d.schemaVersion === 2) &&
    Array.isArray(d.blocks) &&
    validNativeReuse(d.reuse, 'document') &&
    (d.page === undefined ||
      (d.page &&
        ['A4', 'Letter'].includes(d.page.size) &&
        Number.isFinite(d.page.margin) &&
        d.page.margin >= 24 &&
        d.page.margin <= 160)) &&
    validBlocks(d.blocks) &&
    validReferenceItems(d.blocks)
  );
}
const checkedBlockLists = new WeakSet<DocumentBlock[]>();
const textOnlyBlockTypes = ['paragraph', 'heading'];
const knownBlockTypes = [
  'heading',
  'paragraph',
  'bulleted-list',
  'numbered-list',
  'check-list',
  'table',
  'code',
  'image',
  'mermaid',
  'html',
  'react-preview',
];
function validTextBlockFields(b: DocumentBlock) {
  return (
    (b.hidden === undefined ||
      (textOnlyBlockTypes.includes(b.type) && typeof b.hidden === 'boolean')) &&
    (b.styleName === undefined ||
      (textOnlyBlockTypes.includes(b.type) &&
        typeof b.styleName === 'string' &&
        b.styleName.length <= 160)) &&
    (b.style === undefined ||
      (textOnlyBlockTypes.includes(b.type) && validDocumentTextStyle(b.style)))
  );
}
function validContentFields(b: DocumentBlock) {
  return (
    (b.rich === undefined || validSpans(b.rich)) &&
    (b.items === undefined || validItems(b.items)) &&
    validListStart(b.start) &&
    (b.start === undefined || b.type === 'numbered-list') &&
    (b.align === undefined || ['left', 'center', 'right', 'justify'].includes(b.align)) &&
    (b.indent === undefined || (Number.isInteger(b.indent) && b.indent >= 0 && b.indent <= 20))
  );
}
function validLayoutFields(b: DocumentBlock) {
  return (
    (b.width === undefined || (Number.isFinite(b.width) && b.width > 0)) &&
    (b.columnWidths === undefined ||
      (Array.isArray(b.columnWidths) &&
        b.columnWidths.every((w) => Number.isFinite(w) && w > 0))) &&
    (b.merges === undefined || validMerges(b)) &&
    (b.level === undefined || (Number.isInteger(b.level) && b.level >= 1 && b.level <= 6))
  );
}
function validSourceFields(b: DocumentBlock) {
  return (
    (b.src === undefined || (typeof b.src === 'string' && (!b.src || safeAssetUrl(b.src)))) &&
    (b.reference === undefined || (b.type === 'image' && validEmbeddedReference(b.reference))) &&
    knownBlockTypes.includes(b.type) &&
    (b.type !== 'table' || validTableDetails(b))
  );
}
function validBlock(b: DocumentBlock) {
  return (
    b &&
    typeof b.id === 'string' &&
    typeof b.text === 'string' &&
    validTextBlockFields(b) &&
    validContentFields(b) &&
    validLayoutFields(b) &&
    validSourceFields(b)
  );
}
function validBlocks(blocks: DocumentBlock[]): boolean {
  if (checkedBlockLists.has(blocks)) return true;
  const d = { blocks };
  const valid =
    new Set(d.blocks.map((b) => b?.id)).size === d.blocks.length && d.blocks.every(validBlock);
  if (valid && isDeepFrozen(blocks)) checkedBlockLists.add(blocks);
  return valid;
}

export function safeLink(url: string) {
  return /^(https?:\/\/|mailto:|#)/i.test(url);
}
export function spansHtml(spans: InlineSpan[]): string {
  return spans
    .map((s) => {
      let value = escapeHtml(s.text).replaceAll('\n', '<br/>');
      if (s.code) value = `<code>${value}</code>`;
      if (s.bold) value = `<strong>${value}</strong>`;
      if (s.italic) value = `<em>${value}</em>`;
      if (s.underline) value = `<u>${value}</u>`;
      if (s.strike) value = `<s>${value}</s>`;
      const style = [
        s.bold === false ? 'font-weight:400' : '',
        s.color && /^#[0-9a-f]{3,8}$/i.test(s.color) ? `color:${s.color}` : '',
        s.highlight && /^#[0-9a-f]{3,8}$/i.test(s.highlight)
          ? `background-color:${s.highlight}`
          : '',
      ]
        .filter(Boolean)
        .join(';');
      if (style) value = `<span style="${style}">${value}</span>`;
      if (s.link && safeLink(s.link))
        value = `<a href="${escapeHtml(s.link)}" rel="noopener noreferrer">${value}</a>`;
      return value;
    })
    .join('');
}
export function spansMarkdown(spans: InlineSpan[]): string {
  return spans
    .map((s) =>
      s.text
        .split('\n')
        .map((text) => {
          if (!text) return '';
          let value = s.code
            ? text
            : text
                .replaceAll('\\', '\\\\')
                .replaceAll('`', '\\`')
                .replaceAll('&', '&amp;')
                .replaceAll('<', '&lt;');
          if (s.code) {
            const runs = text.match(/`+/g) ?? [];
            const delimiter = '`'.repeat(
              runs.reduce((length, run) => Math.max(length, run.length + 1), 1),
            );
            // Code spans do not interpret backslash escapes. Padding keeps edge
            // backticks apart and preserves content with spaces at both ends.
            const pad =
              text.startsWith('`') ||
              text.endsWith('`') ||
              (text.startsWith(' ') && text.endsWith(' ') && /[^ ]/.test(text))
                ? ' '
                : '';
            value = delimiter + pad + text + pad + delimiter;
          }
          if (s.bold) value = `**${value}**`;
          if (s.italic) value = `*${value}*`;
          if (s.strike) value = `~~${value}~~`;
          if (s.link && safeLink(s.link)) value = `[${value}](${s.link.replaceAll(')', '%29')})`;
          return value;
        })
        .join('<br/>'),
    )
    .join('');
}
/** Inline HTML breaks keep ATX headings and list items on one Markdown line. */
function markdownBreaks(text: string): string {
  // Consume escaped backticks/backslashes before recognizing code spans. Decode
  // once so literal entities never turn into generated breaks on re-import.
  return text.replace(
    /\\([\\`])|(`+)[^\n]*?\2|<br\s*\/?>|&(?:lt|amp);/gi,
    (token, escaped) =>
      escaped ??
      (token.startsWith('`')
        ? token
        : token.toLowerCase() === '&lt;'
          ? '<'
          : token.toLowerCase() === '&amp;'
            ? '&'
            : '\n'),
  );
}
export function migrateDocument(d: DocumentContent): DocumentContent {
  return d.schemaVersion === 2
    ? d
    : {
        ...clone(d),
        schemaVersion: 2,
        blocks: d.blocks.map((b) => ({
          ...b,
          ...(['heading', 'paragraph'].includes(b.type) ? { rich: [{ text: b.text }] } : {}),
        })),
      };
}
