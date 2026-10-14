import { Schema, Node as PMNode, type NodeSpec, type MarkSpec } from 'prosemirror-model';
import { createEngineJsonWriter } from './engine-json';
import { Step, Mapping, Transform } from 'prosemirror-transform';
import { immutableCommand, type LocalCommandContext } from '@editor-platform/editor-core';
import {
  Plugin,
  TextSelection,
  NodeSelection,
  type Selection,
  type EditorState,
  type Transaction,
} from 'prosemirror-state';
import {
  baseKeymap,
  chainCommands,
  createParagraphNear,
  liftEmptyBlock,
  newlineInCode,
  splitBlock,
  toggleMark,
  setBlockType,
} from 'prosemirror-commands';
import { keymap } from 'prosemirror-keymap';
import {
  tableNodes,
  tableEditing,
  columnResizing,
  goToNextCell,
  addRowAfter,
  selectedRect,
  TableMap,
} from 'prosemirror-tables';
import { sinkListItem, liftListItem, splitListItem, wrapInList } from 'prosemirror-schema-list';
import {
  canonicalJson,
  clone,
  deepFreeze,
  isDeepFrozen,
  newId,
} from '@editor-platform/artifact-core';
import {
  safeLink,
  documentStyleCss,
  isDocument,
  nestedLists,
  type DocumentBlock,
  type DocumentContent,
  type InlineSpan,
  type DocumentListItem,
} from './model';
const textAttrs = {
  id: { default: null },
  align: { default: 'left' },
  indent: { default: 0 },
  style: { default: null },
  styleName: { default: null },
  hidden: { default: false },
};
const tableSpecs = tableNodes({
  tableGroup: 'block',
  cellContent: 'paragraph+',
  cellAttributes: {},
});
const nodes: Record<string, NodeSpec> = {
  doc: { content: 'block+' },
  text: { group: 'inline' },
  hard_break: {
    inline: true,
    group: 'inline',
    selectable: false,
    toDOM: () => ['br'],
    parseDOM: [{ tag: 'br' }],
  },
  paragraph: {
    group: 'block',
    content: 'inline*',
    attrs: textAttrs,
    toDOM: (n) => [
      'p',
      {
        'data-block-id': n.attrs.id,
        style: `text-align:${n.attrs.align};margin-left:${n.attrs.indent * 24}px;${documentStyleCss(n.attrs.style ?? undefined)}`,
        hidden: n.attrs.hidden ? '' : undefined,
        'data-style-name': n.attrs.styleName ?? undefined,
      },
      0,
    ],
    parseDOM: [{ tag: 'p' }],
  },
  heading: {
    group: 'block',
    content: 'inline*',
    defining: true,
    attrs: { ...textAttrs, level: { default: 1 } },
    toDOM: (n) => [
      `h${n.attrs.level}`,
      {
        'data-block-id': n.attrs.id,
        style: `text-align:${n.attrs.align};${documentStyleCss(n.attrs.style ?? undefined)}`,
        hidden: n.attrs.hidden ? '' : undefined,
        'data-style-name': n.attrs.styleName ?? undefined,
      },
      0,
    ],
    parseDOM: Array.from({ length: 6 }, (_, i) => ({ tag: `h${i + 1}`, attrs: { level: i + 1 } })),
  },
  bullet_list: {
    group: 'block',
    content: 'list_item+',
    attrs: { id: { default: null }, check: { default: false } },
    toDOM: (n) => [
      'ul',
      { 'data-block-id': n.attrs.id, 'data-checklist': n.attrs.check ? 'true' : undefined },
      0,
    ],
    parseDOM: [{ tag: 'ul' }],
  },
  ordered_list: {
    group: 'block',
    content: 'list_item+',
    attrs: { id: { default: null }, order: { default: 1 } },
    toDOM: (n) => ['ol', { 'data-block-id': n.attrs.id, start: n.attrs.order }, 0],
    parseDOM: [{ tag: 'ol' }],
  },
  list_item: {
    content: 'paragraph (bullet_list | ordered_list)*',
    defining: true,
    attrs: { id: { default: null }, checked: { default: null } },
    toDOM: (n) => [
      'li',
      { 'data-checked': n.attrs.checked === null ? undefined : String(n.attrs.checked) },
      0,
    ],
    parseDOM: [{ tag: 'li' }],
  },
  code_block: {
    group: 'block',
    content: 'text*',
    marks: '',
    code: true,
    defining: true,
    attrs: { id: { default: null }, language: { default: 'text' } },
    toDOM: (n) => ['pre', { 'data-block-id': n.attrs.id }, ['code', 0]],
    parseDOM: [{ tag: 'pre', preserveWhitespace: 'full' }],
  },
  embedded: {
    group: 'block',
    atom: true,
    selectable: true,
    draggable: true,
    attrs: { id: { default: null }, block: {} },
    toDOM: (n) => [
      'figure',
      { 'data-block-id': n.attrs.id },
      n.attrs.block.type === 'image'
        ? ['img', { src: n.attrs.block.src, alt: n.attrs.block.alt }]
        : ['pre', n.attrs.block.text],
    ],
    parseDOM: [],
  },
  ...tableSpecs,
  table: {
    ...tableSpecs.table,
    attrs: { id: { default: null } },
    toDOM: (n) => ['table', { 'data-block-id': n.attrs.id }, ['tbody', 0]],
  },
};
export function normalizedColor(value: string): string | undefined {
  if (/^#[\da-f]{3,8}$/i.test(value)) return value;
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/i.exec(value);
  if (!rgb || rgb.slice(1, 4).some((n) => Number(n) > 255)) return undefined;
  const channels = rgb.slice(1, 4).map(Number);
  if (rgb[4] !== undefined)
    channels.push(Math.round(Math.max(0, Math.min(1, Number(rgb[4]))) * 255));
  return '#' + channels.map((n) => n.toString(16).padStart(2, '0')).join('');
}
const marks: Record<string, MarkSpec> = {
  bold: {
    excludes: 'bold normal_weight',
    toDOM: () => ['strong', 0],
    parseDOM: [{ tag: 'strong' }, { tag: 'b' }],
  },
  normal_weight: {
    excludes: 'bold normal_weight',
    toDOM: () => ['span', { style: 'font-weight:400' }, 0],
    parseDOM: [{ style: 'font-weight=400' }, { style: 'font-weight=normal' }],
  },
  italic: { toDOM: () => ['em', 0], parseDOM: [{ tag: 'em' }, { tag: 'i' }] },
  underline: { toDOM: () => ['u', 0], parseDOM: [{ tag: 'u' }] },
  strike: { toDOM: () => ['s', 0], parseDOM: [{ tag: 's' }, { tag: 'del' }] },
  code: { code: true, toDOM: () => ['code', 0], parseDOM: [{ tag: 'code' }] },
  link: {
    attrs: { href: {} },
    inclusive: false,
    toDOM: (m) => [
      'a',
      { href: safeLink(m.attrs.href) ? m.attrs.href : '#', rel: 'noopener noreferrer' },
      0,
    ],
    parseDOM: [
      {
        tag: 'a[href]',
        getAttrs: (dom) => {
          const href = (dom as HTMLElement).getAttribute('href') ?? '';
          return safeLink(href) ? { href } : false;
        },
      },
    ],
  },
  color: {
    attrs: { value: {} },
    toDOM: (m) => [
      'span',
      { style: `color:${/^#[\da-f]{3,8}$/i.test(m.attrs.value) ? m.attrs.value : '#253044'}` },
      0,
    ],
    parseDOM: [
      {
        style: 'color',
        getAttrs: (value) => {
          const color = normalizedColor(String(value));
          return color ? { value: color } : false;
        },
      },
    ],
  },
  highlight: {
    attrs: { value: {} },
    toDOM: (m) => [
      'mark',
      {
        style: `background-color:${/^#[\da-f]{3,8}$/i.test(m.attrs.value) ? m.attrs.value : '#fff0a8'}`,
      },
      0,
    ],
    parseDOM: [{ tag: 'mark', getAttrs: () => ({ value: '#fff0a8' }) }],
  },
};
export const documentSchema = new Schema({ nodes, marks });
const engineJson = createEngineJsonWriter(documentSchema);
export function inlineNodes(rich: InlineSpan[], schema = documentSchema): PMNode[] {
  return rich
    .filter((s) => s.text)
    .flatMap((span) => {
      const formatting = Object.entries(span)
        .filter(([k, v]) => k !== 'text' && v)
        .flatMap(([key, value]) => {
          const mark = schema.marks[key];
          return mark
            ? [
                mark.create(
                  key === 'link'
                    ? { href: value }
                    : key === 'color' || key === 'highlight'
                      ? { value }
                      : undefined,
                ),
              ]
            : [];
        });
      if (span.bold === false && schema.marks.normal_weight)
        formatting.push(schema.marks.normal_weight.create());
      return span.text
        .split('\n')
        .flatMap((text, i) => [
          ...(i ? [schema.nodes.hard_break.create()] : []),
          ...(text ? [schema.text(text, formatting)] : []),
        ]);
    });
}
export function spansFromNode(node: PMNode): InlineSpan[] {
  const spans: InlineSpan[] = [];
  node.forEach((child) => {
    if (child.type.name === 'hard_break') {
      spans.push({ text: '\n' });
      return;
    }
    if (!child.isText) return;
    const span: InlineSpan = { text: child.text ?? '' };
    for (const mark of child.marks) {
      if (mark.type.name === 'link') span.link = mark.attrs.href;
      else if (mark.type.name === 'normal_weight') span.bold = false;
      else if (mark.type.name === 'color' || mark.type.name === 'highlight')
        span[mark.type.name] = mark.attrs.value;
      else if (['bold', 'italic', 'underline', 'strike', 'code'].includes(mark.type.name))
        span[mark.type.name as 'bold'] = true;
    }
    spans.push(span);
  });
  return spans;
}
const paragraph = (rich: InlineSpan[], attrs: Record<string, unknown> = {}) =>
  documentSchema.nodes.paragraph.create(attrs, inlineNodes(rich));
function listNodes(items: DocumentListItem[], check: boolean): PMNode[] {
  return items.map((item) =>
    documentSchema.nodes.list_item.create(
      { id: item.id, checked: check ? (item.checked ?? false) : null },
      [
        paragraph(item.rich, { id: item.paragraphId ?? `${item.id}:text` }),
        ...nestedLists(item).map((list) =>
          documentSchema.nodes[list.type].create(
            { id: list.id, check: list.check ?? check, order: list.start ?? 1 },
            listNodes(list.items, list.check ?? check),
          ),
        ),
      ],
    ),
  );
}
export function blockNode(b: DocumentBlock): PMNode {
  const s = documentSchema,
    attrs = {
      id: b.id,
      align: b.align ?? 'left',
      indent: b.indent ?? 0,
      style: b.style ? { ...b.style } : null,
      styleName: b.styleName ?? null,
      hidden: b.hidden ?? false,
    };
  if (b.type === 'paragraph' || b.type === 'heading')
    return s.nodes[b.type].create(
      { ...attrs, level: b.level ?? 1 },
      inlineNodes(b.rich ?? [{ text: b.text }]),
    );
  if (['bulleted-list', 'numbered-list', 'check-list'].includes(b.type)) {
    const items =
      b.items ??
      b.text.split('\n').map((text, i) => ({ id: `${b.id}:item:${i}`, rich: [{ text }] }));
    return s.nodes[b.type === 'numbered-list' ? 'ordered_list' : 'bullet_list'].create(
      { id: b.id, check: b.type === 'check-list', order: b.start ?? 1 },
      listNodes(items, b.type === 'check-list'),
    );
  }
  if (b.type === 'code')
    return s.nodes.code_block.create(
      { id: b.id, language: b.language ?? 'text' },
      b.text ? s.text(b.text) : undefined,
    );
  if (b.type === 'table') {
    const cells = b.cells ?? [
      ['', ''],
      ['', ''],
    ];
    return s.nodes.table.create(
      { id: b.id },
      cells.map((row, r) =>
        s.nodes.table_row.create(
          null,
          row.flatMap((value, c) => {
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
              return [];
            const merge = b.merges?.find((m) => m.row === r && m.col === c);
            return [
              s.nodes[(b.cellHeaders?.[r]?.[c] ?? r === 0) ? 'table_header' : 'table_cell'].create(
                {
                  colspan: merge?.cols ?? 1,
                  rowspan: merge?.rows ?? 1,
                  colwidth: b.columnWidths
                    ? Array.from(
                        { length: merge?.cols ?? 1 },
                        (_, i) => b.columnWidths![c + i] ?? 120,
                      )
                    : null,
                },
                b.cellParagraphs?.[r]?.[c]?.map((p) => paragraph(p.rich, { id: p.id })) ?? [
                  paragraph(b.cellRich?.[r]?.[c] ?? [{ text: value }], {
                    id: b.cellParagraphIds?.[r]?.[c] ?? `${b.id}:cell:${r}:${c}`,
                  }),
                ],
              ),
            ];
          }),
        ),
      ),
    );
  }
  return s.nodes.embedded.create({ id: b.id, block: b });
}
export function contentToNode(content: DocumentContent): PMNode {
  return documentSchema.nodes.doc.create(
    null,
    content.blocks.length
      ? content.blocks.map(blockNode)
      : [paragraph([], { id: 'empty-document-paragraph' })],
  );
}
export const documentAttributeFields = [
  'style',
  'styleName',
  'hidden',
  'align',
  'indent',
  'level',
  'src',
  'alt',
  'width',
  'caption',
] as const;
export type DocumentAttributeField = (typeof documentAttributeFields)[number];
export interface DocumentAttributePatch {
  id: string;
  values: Partial<Record<DocumentAttributeField, unknown>>;
}
export const documentAttributePatchLimit = 500;
/** Stable-node attributes become engine steps without replacing any text or IDs. */
export function documentAttributeTransform(
  content: DocumentContent,
  patches: DocumentAttributePatch[],
): Transform {
  if (
    !Array.isArray(patches) ||
    !patches.length ||
    patches.length > documentAttributePatchLimit ||
    new Set(patches.map((p) => p?.id)).size !== patches.length
  )
    throw new Error('Invalid document attribute patch count/identity');
  const tr = new Transform(contentToNode(content));
  // Attributes preserve node size and position. Index once, including duplicate
  // IDs so this helper retains its existing validation behavior for malformed input.
  const positions = new Map<string, number[]>();
  tr.doc.forEach((node, pos) =>
    positions.set(node.attrs.id, [...(positions.get(node.attrs.id) ?? []), pos]),
  );
  for (const patch of patches) {
    if (
      !patch ||
      typeof patch.id !== 'string' ||
      !patch.values ||
      typeof patch.values !== 'object' ||
      Array.isArray(patch.values) ||
      !Object.keys(patch.values).length ||
      Object.keys(patch.values).some(
        (key) => !documentAttributeFields.includes(key as DocumentAttributeField),
      )
    )
      throw new Error('Unsupported document attribute');
    const matches = positions.get(patch.id);
    if (!matches) throw new Error('Document attribute target is missing');
    for (const pos of matches) {
      const node = tr.doc.nodeAt(pos)!;
      const imageFields = ['src', 'alt', 'width', 'caption'];
      if (node.type.name === 'embedded' && node.attrs.block.type === 'image') {
        if (Object.keys(patch.values).some((field) => !imageFields.includes(field)))
          throw new Error('This image does not support paragraph attributes');
        const block = structuredClone(node.attrs.block);
        for (const [field, value] of Object.entries(patch.values)) {
          if (value === null) delete block[field];
          else block[field] = structuredClone(value);
        }
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, block }, node.marks);
        continue;
      }
      if (
        !['paragraph', 'heading'].includes(node.type.name) ||
        Object.keys(patch.values).some((field) => imageFields.includes(field)) ||
        ('level' in patch.values && node.type.name !== 'heading')
      )
        throw new Error('This node does not support named paragraph attributes');
      const attrs = { ...node.attrs };
      for (const [field, value] of Object.entries(patch.values)) {
        const defaults: Record<string, unknown> = {
          style: null,
          styleName: null,
          hidden: false,
          align: 'left',
          indent: 0,
          level: 1,
        };
        attrs[field] = value === null ? defaults[field] : structuredClone(value);
      }
      tr.setNodeMarkup(pos, undefined, attrs, node.marks);
    }
  }
  if (!isDocument(nodeToContent(tr.doc, content))) throw new Error('Invalid document attributes');
  return tr;
}
function listItems(node: PMNode): DocumentListItem[] {
  const items: DocumentListItem[] = [];
  node.forEach((child) => {
    const nested = Array.from({ length: child.childCount - 1 }, (_, i) => child.child(i + 1));
    items.push({
      id: child.attrs.id ?? newId('item'),
      paragraphId: child.firstChild!.attrs.id,
      rich: spansFromNode(child.firstChild!),
      ...(child.attrs.checked === null ? {} : { checked: child.attrs.checked }),
      ...(nested.length > 1 ||
      (nested.length === 1 && nested[0].type.name === 'ordered_list' && nested[0].attrs.order !== 1)
        ? {
            childLists: nested.map((list) => ({
              id: list.attrs.id,
              type: list.type.name as 'bullet_list' | 'ordered_list',
              ...(list.attrs.check ? { check: true } : {}),
              ...(list.type.name === 'ordered_list' && list.attrs.order !== 1
                ? { start: list.attrs.order }
                : {}),
              items: listItems(list),
            })),
          }
        : nested.length
          ? {
              children: nested.flatMap(listItems),
              childrenId: nested[0].attrs.id,
              childrenType: nested[0].type.name as 'bullet_list' | 'ordered_list',
            }
          : {}),
    });
  });
  return items;
}
export function nodeToContent(node: PMNode, base: DocumentContent): DocumentContent {
  const blocks: DocumentBlock[] = [];
  node.forEach((n) => {
    const id = n.attrs.id ?? newId('block');
    if (n.type.name === 'embedded') {
      blocks.push({ ...n.attrs.block, id });
      return;
    }
    if (n.type.name === 'table') {
      const cells: string[][] = [],
        cellRich: InlineSpan[][][] = [],
        cellParagraphIds: string[][] = [],
        cellHeaders: boolean[][] = [],
        cellParagraphs: NonNullable<DocumentBlock['cellParagraphs']> = [],
        merges: NonNullable<DocumentBlock['merges']> = [],
        widths: number[] = [];
      const occupied = new Set<string>();
      n.forEach((row, _, r) => {
        cells[r] = cells[r] ?? [];
        cellRich[r] = cellRich[r] ?? [];
        cellParagraphIds[r] = cellParagraphIds[r] ?? [];
        cellHeaders[r] = cellHeaders[r] ?? [];
        cellParagraphs[r] = cellParagraphs[r] ?? [];
        let c = 0;
        row.forEach((cell) => {
          while (occupied.has(`${r}:${c}`)) c++;
          const paragraphs = Array.from({ length: cell.childCount }, (_, i) => cell.child(i));
          const rich = paragraphs.flatMap((p, i) => [
              ...(i ? [{ text: '\n' }] : []),
              ...spansFromNode(p),
            ]),
            text = rich.map((s) => s.text).join('');
          cellParagraphs[r][c] = paragraphs.map((p) => ({
            id: p.attrs.id,
            rich: spansFromNode(p),
          }));
          cells[r][c] = text;
          cellRich[r][c] = rich;
          cellParagraphIds[r][c] = cell.firstChild!.attrs.id;
          cellHeaders[r][c] = cell.type.name === 'table_header';
          const rows = cell.attrs.rowspan ?? 1,
            cols = cell.attrs.colspan ?? 1;
          if (rows > 1 || cols > 1) merges.push({ row: r, col: c, rows, cols });
          for (let rr = r; rr < r + rows; rr++)
            for (let cc = c; cc < c + cols; cc++) {
              occupied.add(`${rr}:${cc}`);
              cells[rr] = cells[rr] ?? [];
              cells[rr][cc] = cells[rr][cc] ?? '';
            }
          if (cell.attrs.colwidth)
            cell.attrs.colwidth.forEach((width: number, i: number) => {
              widths[c + i] = width;
            });
          c += cols;
        });
      });
      const count = Math.max(1, ...cells.map((r) => r.length));
      blocks.push({
        id,
        type: 'table',
        text: '',
        cells: cells.map((r) => Array.from({ length: count }, (_, i) => r[i] ?? '')),
        cellRich,
        cellParagraphIds,
        cellHeaders,
        cellParagraphs,
        merges,
        ...(widths.some(Boolean)
          ? { columnWidths: Array.from({ length: count }, (_, i) => widths[i] ?? 120) }
          : {}),
      });
      return;
    }
    if (n.type.name === 'bullet_list' || n.type.name === 'ordered_list') {
      const items = listItems(n),
        texts = (list: DocumentListItem[]): string[] =>
          list.flatMap((i) => [
            i.rich.map((s) => s.text).join(''),
            ...nestedLists(i).flatMap((list) => texts(list.items)),
          ]);
      blocks.push({
        id,
        type:
          n.type.name === 'ordered_list'
            ? 'numbered-list'
            : n.attrs.check
              ? 'check-list'
              : 'bulleted-list',
        items,
        ...(n.type.name === 'ordered_list' && n.attrs.order !== 1 ? { start: n.attrs.order } : {}),
        text: texts(items).join('\n'),
      });
      return;
    }
    const rich = spansFromNode(n);
    blocks.push({
      id,
      type:
        n.type.name === 'heading' ? 'heading' : n.type.name === 'code_block' ? 'code' : 'paragraph',
      text: n.textBetween(0, n.content.size, '\n', '\n'),
      ...(n.attrs.style ? { style: { ...n.attrs.style } } : {}),
      ...(n.attrs.styleName ? { styleName: n.attrs.styleName } : {}),
      ...(n.attrs.hidden ? { hidden: true } : {}),
      ...(n.type.name === 'code_block'
        ? { language: n.attrs.language }
        : { rich, align: n.attrs.align, indent: n.attrs.indent }),
      ...(n.type.name === 'heading' ? { level: n.attrs.level } : {}),
    });
  });
  return { ...base, schemaVersion: 2, blocks };
}
export const stableIds = new Plugin({
  appendTransaction(transactions, _old, state) {
    if (!transactions.some((t) => t.docChanged)) return null;
    let tr: Transaction | undefined;
    const seen = new Set<string>();
    state.doc.descendants((node, pos) => {
      if (!('id' in node.attrs)) return;
      const id = node.attrs.id;
      if (!id || seen.has(id)) {
        tr ??= state.tr;
        tr.setNodeMarkup(pos, undefined, {
          ...node.attrs,
          id: newId(node.type.name === 'list_item' ? 'item' : 'block'),
        });
      } else seen.add(id);
    });
    return tr ?? null;
  },
});
/** Insert and select the new row in one engine transaction, retaining the active column. */
export const addTableRowAndSelect: import('prosemirror-state').Command = (state, dispatch) => {
  if (!addRowAfter(state)) return false;
  const rect = selectedRect(state);
  return addRowAfter(
    state,
    dispatch
      ? (tr) => {
          const table = tr.doc.nodeAt(rect.tableStart - 1)!;
          const map = TableMap.get(table);
          const cell = map.map[rect.bottom * map.width + rect.left];
          dispatch(
            tr
              .setSelection(TextSelection.near(tr.doc.resolve(rect.tableStart + cell + 1)))
              .scrollIntoView(),
          );
        }
      : undefined,
  );
};
export const nextTableCell: import('prosemirror-state').Command = (state, dispatch) => {
  if (goToNextCell(1)(state, dispatch)) return true;
  if (!addRowAfter(state)) return false;
  const rect = selectedRect(state);
  return addRowAfter(
    state,
    dispatch
      ? (tr) => {
          const table = tr.doc.nodeAt(rect.tableStart - 1)!;
          const map = TableMap.get(table);
          dispatch(
            tr
              .setSelection(
                TextSelection.near(
                  tr.doc.resolve(rect.tableStart + map.map[rect.bottom * map.width] + 1),
                ),
              )
              .scrollIntoView(),
          );
        }
      : undefined,
  );
};
export function documentPlugins() {
  return [
    stableIds,
    columnResizing(),
    tableEditing(),
    keymap({
      Enter: chainCommands(
        newlineInCode,
        splitListItem(documentSchema.nodes.list_item),
        createParagraphNear,
        liftEmptyBlock,
        splitBlock,
      ),
      Tab: chainCommands(nextTableCell, sinkListItem(documentSchema.nodes.list_item)),
      'Shift-Tab': chainCommands(goToNextCell(-1), liftListItem(documentSchema.nodes.list_item)),
      'Mod-b': toggleMark(documentSchema.marks.bold),
      'Mod-i': toggleMark(documentSchema.marks.italic),
      'Mod-u': toggleMark(documentSchema.marks.underline),
    }),
    keymap(baseKeymap),
  ];
}
export function activeTextRange(
  state: EditorState,
): { id: string; start: number; end: number } | undefined {
  const $from = state.selection.$from;
  if (!$from.depth) return;
  let depth = $from.depth;
  while (depth > 0 && !$from.node(depth).isTextblock) depth--;
  if (!depth) return;
  const node = $from.node(depth),
    start = $from.start(depth);
  return {
    id: node.attrs.id,
    start: Math.max(0, state.selection.from - start),
    end: Math.min(node.content.size, Math.max(0, state.selection.to - start)),
  };
}
export function activeBlock(
  state: EditorState,
): { id: string; start: number; end: number } | undefined {
  const from = state.selection.$from;
  if (!from.depth) return;
  const node = from.node(1),
    start = from.start(1);
  return {
    id: node.attrs.id,
    start: Math.max(0, state.selection.from - start),
    end: Math.max(0, state.selection.to - start),
  };
}
export function formatBlock(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  type: string,
  level = 1,
) {
  if (type === 'bullet_list' || type === 'ordered_list')
    return wrapInList(documentSchema.nodes[type])(state, dispatch);
  return setBlockType(documentSchema.nodes[type], { ...state.selection.$from.parent.attrs, level })(
    state,
    dispatch,
  );
}
export function jumpToBlock(state: EditorState, id: string): Transaction | undefined {
  let selection: Selection | undefined;
  state.doc.forEach((n, pos) => {
    if (n.attrs.id === id)
      selection = n.isAtom
        ? NodeSelection.create(state.doc, pos)
        : TextSelection.near(state.doc.resolve(pos + 1));
  });
  return selection === undefined ? undefined : state.tr.setSelection(selection).scrollIntoView();
}

/** Versioned private engine codec. This is an exact-base local update, not a sync protocol. */
export interface DocumentEngineUpdate {
  engine: 'prosemirror';
  schemaVersion: 1;
  before: string;
  after: string;
  steps: unknown[];
  inverseSteps: unknown[];
}
export function captureDocumentUpdate(transactions: readonly Transaction[]): DocumentEngineUpdate {
  if (!transactions.length) throw new Error('Expected an engine transaction');
  return {
    engine: 'prosemirror',
    schemaVersion: 1,
    before: engineJson(transactions[0].before),
    after: engineJson(transactions.at(-1)!.doc),
    steps: transactions.flatMap((tr) => tr.steps.map((step) => step.toJSON())),
    inverseSteps: transactions
      .flatMap((tr) => tr.steps.map((step, i) => step.invert(tr.docs[i]).toJSON()))
      .reverse(),
  };
}
export function replayDocumentUpdate(
  doc: PMNode,
  update: DocumentEngineUpdate,
  inverse = false,
): { doc: PMNode; mapping: Mapping } {
  if (update.engine !== 'prosemirror' || update.schemaVersion !== 1)
    throw new Error('Unsupported document engine schema');
  if (engineJson(doc) !== (inverse ? update.after : update.before))
    throw new Error('Document engine update has a stale base');
  const mapping = new Mapping();
  for (const json of inverse ? update.inverseSteps : update.steps) {
    const step = Step.fromJSON(documentSchema, json);
    const result = step.apply(doc);
    if (result.failed || !result.doc) throw new Error(result.failed ?? 'Invalid engine update');
    doc = result.doc;
    mapping.appendMap(step.getMap());
  }
  doc.check();
  if (engineJson(doc) !== (inverse ? update.before : update.after))
    throw new Error('Engine update result does not match its fingerprint');
  return { doc, mapping };
}
export function documentUpdateCommand(
  base: DocumentContent,
  update: DocumentEngineUpdate,
  context: LocalCommandContext,
) {
  const basis = isDeepFrozen(base) ? base : deepFreeze(clone(base));
  let fingerprint: string | undefined;
  // Fix all generated IDs and validate the complete transaction before exposing a command.
  const result = replayDocumentUpdate(
    PMNode.fromJSON(documentSchema, JSON.parse(update.before)),
    update,
  );
  return immutableCommand<DocumentContent>(
    'document.engine',
    'Edit document',
    (current) => {
      if (current !== basis && canonicalJson(current) !== (fingerprint ??= canonicalJson(basis)))
        throw new Error('Document draft changed before the engine update was committed');
      return nodeToContent(result.doc, current);
    },
    context,
  );
}
