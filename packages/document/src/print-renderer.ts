import { type PrintedTextLine } from './pdf-text';
import { layoutPrintTable, tableLineHeight } from './print-layout';
import {
  nestedLists,
  styledDocumentSpans,
  type DocumentBlock,
  type DocumentContent,
  type InlineSpan,
  type DocumentListItem,
} from './model';

type PrintTable = ReturnType<typeof layoutPrintTable>;
type PrintTableCell = PrintTable['cells'][number];
type PrintTableLine = PrintTableCell['lines'][number];

interface PrintToken {
  text: string;
  span: InlineSpan;
  width: number;
}

interface PrintTextStyle {
  size: number;
  indent: number;
  lineHeight: number;
  align: string;
  family?: string;
}

const headingSizes = [34, 27, 22, 19, 17, 16];
const listBlockTypes = ['bulleted-list', 'numbered-list', 'check-list'];

export function printFont(span: InlineSpan, size: number, family?: string) {
  return `${span.italic ? 'italic ' : ''}${span.bold ? '700' : '400'} ${size}px ${span.code ? 'monospace' : family ? '"' + family + '"' : 'system-ui'}`;
}

function blockFontSize(block: DocumentBlock) {
  return block.style?.fontSize !== undefined
    ? (block.style.fontSize * 4) / 3
    : block.type === 'heading'
      ? headingSizes[(block.level ?? 1) - 1]
      : 16;
}

function blockLineHeight(block: DocumentBlock, fontSize: number) {
  return block.style?.lineHeight !== undefined ? block.style.lineHeight * fontSize : undefined;
}

function blockSpans(block: DocumentBlock) {
  return styledDocumentSpans(
    block.rich ?? [{ text: block.text, ...(block.type === 'heading' ? { bold: true } : {}) }],
    block.style,
  );
}

function blockSpaceAfter(block: DocumentBlock) {
  return block.style?.spaceAfter !== undefined
    ? (block.style.spaceAfter * 4) / 3
    : block.type === 'heading'
      ? 14
      : 10;
}

function listMarker(item: DocumentListItem, numbered: boolean, index: number, start: number) {
  return item.checked === undefined
    ? numbered
      ? `${index + start}. `
      : '• '
    : item.checked
      ? '[x] '
      : '[ ] ';
}

function blockListItems(block: DocumentBlock): DocumentListItem[] {
  return (
    block.items ??
    block.text.split('\n').map((value, index) => ({
      id: String(index),
      rich: [{ text: value }],
      ...(block.type === 'check-list' ? { checked: false } : {}),
    }))
  );
}

function htmlPlainText(source: string) {
  const parsed = new DOMParser().parseFromString(source, 'text/html');
  parsed.querySelectorAll('script,style,iframe,object,embed').forEach((node) => node.remove());
  return parsed.body.textContent ?? '';
}

function alignOffset(align: string, available: number) {
  return align === 'center' ? available / 2 : align === 'right' ? available : 0;
}

async function loadPrintMermaid() {
  const { default: mermaid } = await import('mermaid');
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'neutral',
    suppressErrorRendering: true,
  });
  return mermaid;
}

async function renderMermaidSource(
  mermaid: Awaited<ReturnType<typeof loadPrintMermaid>>,
  text: string,
) {
  const { svg } = await mermaid.render(`print-${crypto.randomUUID()}`, text);
  const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml'),
    root = parsed.documentElement;
  const box = (root.getAttribute('viewBox') ?? '0 0 800 300').split(/[ ,]+/).map(Number);
  root.setAttribute('width', String(box[2]));
  root.setAttribute('height', String(box[3]));
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(root))}`;
}

/** Paginated canvas output with the PDF text layer recorded per page. */
export class DocumentPrintRenderer {
  readonly pages: HTMLCanvasElement[] = [];
  readonly textPages: PrintedTextLine[][] = [];
  readonly usable: number;
  private order = 0;
  private ctx!: CanvasRenderingContext2D;
  private y: number;
  private readonly images = new Map<string, HTMLImageElement>();
  private readonly diagramSources = new Map<string, string>();

  constructor(
    readonly w: number,
    readonly h: number,
    readonly margin: number,
  ) {
    this.usable = w - margin * 2;
    this.y = margin;
    this.page();
  }

  page() {
    const canvas = document.createElement('canvas');
    canvas.width = this.w * 2;
    canvas.height = this.h * 2;
    this.ctx = canvas.getContext('2d')!;
    this.ctx.scale(2, 2);
    this.ctx.fillStyle = 'white';
    this.ctx.fillRect(0, 0, this.w, this.h);
    this.pages.push(canvas);
    this.textPages.push([]);
    this.y = this.margin;
  }

  ensure(size: number) {
    if (this.y + size > this.h - this.margin && this.y > this.margin) this.page();
  }

  private drawToken(token: PrintToken, x: number, style: PrintTextStyle) {
    const { ctx, y } = this;
    const { size } = style;
    ctx.font = printFont(token.span, size, style.family);
    ctx.textBaseline = 'alphabetic';
    if (token.span.highlight) {
      ctx.fillStyle = token.span.highlight;
      ctx.fillRect(x, y, token.width, style.lineHeight);
    }
    ctx.fillStyle = token.span.color ?? '#253044';
    ctx.fillText(token.text, x, y + size);
    if (token.span.underline || token.span.link || token.span.strike) {
      ctx.strokeStyle = ctx.fillStyle;
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(x, y + (token.span.strike ? size * 0.65 : size + 2));
      ctx.lineTo(x + token.width, y + (token.span.strike ? size * 0.65 : size + 2));
      ctx.stroke();
    }
  }

  private flushLine(line: { tokens: PrintToken[]; width: number }, style: PrintTextStyle) {
    this.ensure(style.lineHeight);
    let x =
      this.margin +
      style.indent +
      alignOffset(style.align, this.usable - style.indent - line.width);
    this.textPages.at(-1)!.push({
      text: line.tokens.map((token) => token.text).join(''),
      x,
      y: this.y + style.size,
      size: style.size,
      width: line.width,
      order: this.order++,
    });
    for (const token of line.tokens) {
      this.drawToken(token, x, style);
      x += token.width;
    }
    this.y += style.lineHeight;
    line.tokens = [];
    line.width = 0;
  }

  text(
    spans: InlineSpan[],
    size = 16,
    indent = 0,
    lineHeight = size * 1.65,
    align = 'left',
    family?: string,
  ) {
    const style = { size, indent, lineHeight, align, family };
    const line = { tokens: [] as PrintToken[], width: 0 };
    for (const span of spans)
      for (const char of span.text) {
        if (char === '\n') {
          this.flushLine(line, style);
          continue;
        }
        this.ctx.font = printFont(span, size, family);
        const cw = this.ctx.measureText(char).width;
        if (line.width + cw > this.usable - indent && line.tokens.length)
          this.flushLine(line, style);
        line.tokens.push({ text: char, span, width: cw });
        line.width += cw;
      }
    if (line.tokens.length || !spans.some((s) => s.text)) this.flushLine(line, style);
  }

  async loadImage(src: string) {
    if (!this.images.has(src)) {
      const img = new Image();
      img.src = src;
      await img.decode();
      this.images.set(src, img);
    }
    return this.images.get(src)!;
  }

  private imageSize(img: HTMLImageElement, maxWidth = this.usable) {
    const { h, margin } = this;
    let iw = Math.min(maxWidth, this.usable, img.width),
      ih = (img.height * iw) / img.width;
    if (ih > h - margin * 2 - 12) {
      iw *= (h - margin * 2 - 12) / ih;
      ih = h - margin * 2 - 12;
    }
    return { iw, ih };
  }

  private async image(src: string, maxWidth = this.usable) {
    const img = await this.loadImage(src);
    const { iw, ih } = this.imageSize(img, maxWidth);
    this.ensure(ih + 12);
    this.ctx.drawImage(img, this.margin, this.y, iw, ih);
    this.y += ih + 12;
  }

  /** Decodes images and renders Mermaid diagrams before any block is measured. */
  async preload(content: DocumentContent) {
    for (const block of content.blocks) {
      if (block.hidden) continue;
      if (block.type === 'image' && block.src) await this.loadImage(block.src);
      if (block.type === 'mermaid') {
        const mermaid = await loadPrintMermaid();
        try {
          const src = await renderMermaidSource(mermaid, block.text);
          await this.loadImage(src);
          this.diagramSources.set(block.id, src);
        } catch {
          /* The same visible source fallback is measured and rendered below. */
        }
      }
    }
  }

  private list(items: DocumentListItem[], numbered: boolean, depth = 0, start = 1) {
    items.forEach((item, i) => {
      this.text([{ text: listMarker(item, numbered, i, start) }, ...item.rich], 16, depth * 24);
      nestedLists(item).forEach((nested) =>
        this.list(nested.items, nested.type === 'ordered_list', depth + 1, nested.start),
      );
    });
  }

  private measureText(
    spans: InlineSpan[],
    size = 16,
    indent = 0,
    lineHeight = size * 1.65,
    family?: string,
  ) {
    let lines = 0,
      width = 0;
    for (const span of spans)
      for (const char of span.text) {
        if (char === '\n') {
          lines++;
          width = 0;
          continue;
        }
        this.ctx.font = printFont(span, size, family);
        const cw = this.ctx.measureText(char).width;
        if (width + cw > this.usable - indent && width > 0) {
          lines++;
          width = 0;
        }
        width += cw;
      }
    if (width > 0 || !spans.some((span) => span.text)) lines++;
    return lines * lineHeight;
  }

  private measureList(items: DocumentListItem[], numbered: boolean, depth = 0, start = 1): number {
    return items.reduce(
      (sum, item, index) =>
        sum +
        this.measureText(
          [{ text: listMarker(item, numbered, index, start) }, ...item.rich],
          16,
          depth * 24,
        ) +
        nestedLists(item).reduce(
          (sum, list) =>
            sum + this.measureList(list.items, list.type === 'ordered_list', depth + 1, list.start),
          0,
        ),
      0,
    );
  }

  private layoutTable(block: DocumentBlock) {
    return layoutPrintTable(block, this.usable, (value, span) => {
      this.ctx.font = printFont(span, 13);
      return this.ctx.measureText(value).width;
    });
  }

  private measureImage(block: DocumentBlock) {
    let size = this.imageSize(this.images.get(block.src!)!, block.width ?? this.usable).ih + 12;
    if (block.caption) size += this.measureText([{ text: block.caption }], 12, 0, 20);
    return size;
  }

  private measureMermaid(block: DocumentBlock) {
    const src = this.diagramSources.get(block.id);
    return src
      ? this.imageSize(this.images.get(src)!).ih + 12
      : this.measureText([{ text: 'Mermaid source (diagram unavailable)' }], 14) +
          this.measureText([{ text: block.text, code: true }], 12);
  }

  private measureTextBlock(block: DocumentBlock) {
    const fontSize = blockFontSize(block);
    return this.measureText(
      blockSpans(block),
      fontSize,
      (block.indent ?? 0) * 24,
      blockLineHeight(block, fontSize),
      block.style?.fontFamily,
    );
  }

  private measureBlockBody(block: DocumentBlock): number {
    if (block.type === 'image' && block.src) return this.measureImage(block);
    if (block.type === 'mermaid') return this.measureMermaid(block);
    if (block.type === 'table') return this.layoutTable(block).height;
    if (listBlockTypes.includes(block.type))
      return this.measureList(
        blockListItems(block),
        block.type === 'numbered-list',
        0,
        block.start,
      );
    if (block.type === 'html') return this.measureText([{ text: htmlPlainText(block.text) }]);
    if (block.type === 'code')
      return this.measureText([{ text: block.text, code: true }], 13, 0, 21);
    return this.measureTextBlock(block);
  }

  measuredHeight(block: DocumentBlock): number {
    return (
      this.measureBlockBody(block) +
      ((block.style?.spaceBefore ?? 0) * 4) / 3 +
      blockSpaceAfter(block)
    );
  }

  /** Keeps a heading run on the page of the block that follows it. */
  keepHeadingWithNext(visible: DocumentBlock[], index: number) {
    const { h, margin } = this;
    let grouped = this.measuredHeight(visible[index]),
      next = index + 1;
    while (visible[next]?.type === 'heading') grouped += this.measuredHeight(visible[next++]);
    if (!visible[next]) return;
    const following = this.measuredHeight(visible[next]);
    const pair = grouped + following;
    if (pair <= h - margin * 2) this.ensure(pair);
    else
      this.ensure(
        grouped +
          (visible[next].type === 'table'
            ? tableLineHeight * 2
            : ['image', 'mermaid'].includes(visible[next].type)
              ? Math.min(following, h - margin * 2 - grouped)
              : 27),
      );
  }

  private tableSliceSize(table: PrintTable, offset: number) {
    const { h, margin } = this;
    const available = Math.floor((h - margin - this.y) / tableLineHeight) * tableLineHeight;
    let size = Math.min(available, table.height - offset);
    const boundary = table.rows.filter((row) => row > offset && row <= offset + size).at(-1);
    const nextBoundary =
      boundary === undefined ? undefined : table.rows.find((row) => row > boundary);
    if (boundary && nextBoundary !== undefined && nextBoundary - boundary <= h - margin * 2)
      size = boundary - offset;
    return size;
  }

  private drawTableToken(token: PrintToken, x: number, baseline: number) {
    const { ctx } = this;
    ctx.font = printFont(token.span, 13);
    if (token.span.highlight) {
      ctx.fillStyle = token.span.highlight;
      ctx.fillRect(x, baseline - 13, token.width, 17);
    }
    ctx.fillStyle = token.span.color ?? '#253044';
    ctx.fillText(token.text, x, baseline);
    for (const mark of ['underline', 'strike'] as const)
      if (token.span[mark] || (mark === 'underline' && token.span.link)) {
        ctx.strokeStyle = ctx.fillStyle;
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        const yy = baseline + (mark === 'strike' ? -4 : 2);
        ctx.moveTo(x, yy);
        ctx.lineTo(x + token.width, yy);
        ctx.stroke();
      }
  }

  private drawTableLine(
    table: PrintTable,
    cell: PrintTableCell,
    line: PrintTableLine,
    i: number,
    position: { top: number; left: number; size: number },
  ) {
    const baseline = position.top + 19 + i * tableLineHeight;
    if (baseline < this.y || baseline > this.y + position.size) return;
    let x = position.left + 6;
    this.textPages.at(-1)!.push({
      text: line.map((token) => token.text).join(''),
      x,
      y: baseline,
      size: 13,
      width: line.reduce((sum, token) => sum + token.width, 0),
      order:
        this.order +
        table.cells
          .slice(0, table.cells.indexOf(cell))
          .reduce((sum, cell) => sum + cell.lines.length, 0) +
        i,
    });
    for (const token of line) {
      this.drawTableToken(token, x, baseline);
      x += token.width;
    }
  }

  private drawTableCell(table: PrintTable, cell: PrintTableCell, offset: number, size: number) {
    const { ctx, y } = this;
    const top = y + cell.y - offset,
      left = this.margin + cell.x;
    ctx.fillStyle = cell.header ? '#f1f4f9' : 'white';
    ctx.fillRect(left, top, cell.width, cell.height);
    ctx.strokeStyle = '#c6ced9';
    ctx.strokeRect(left, top, cell.width, cell.height);
    ctx.save();
    ctx.beginPath();
    ctx.rect(
      left + 1,
      Math.max(y, top),
      cell.width - 2,
      Math.min(y + size, top + cell.height) - Math.max(y, top),
    );
    ctx.clip();
    cell.lines.forEach((line, i) => this.drawTableLine(table, cell, line, i, { top, left, size }));
    ctx.restore();
  }

  private table(block: DocumentBlock) {
    const { h, margin } = this;
    const table = this.layoutTable(block);
    let offset = 0;
    while (offset < table.height) {
      if (h - margin - this.y < tableLineHeight * 2) this.page();
      const size = this.tableSliceSize(table, offset);
      // A taller-than-page row is continued at whole text-line boundaries.
      this.ctx.save();
      this.ctx.beginPath();
      this.ctx.rect(margin, this.y, this.usable, size);
      this.ctx.clip();
      for (const cell of table.cells) {
        if (cell.y + cell.height <= offset || cell.y >= offset + size) continue;
        this.drawTableCell(table, cell, offset, size);
      }
      this.ctx.restore();
      this.y += size;
      offset += size;
      if (offset < table.height) this.page();
    }
    this.order += table.cells.reduce((sum, cell) => sum + cell.lines.length, 0);
  }

  private async imageBlock(block: DocumentBlock) {
    if (block.src) await this.image(block.src, block.width ?? this.usable);
    if (block.caption) this.text([{ text: block.caption, color: '#6d7683' }], 12, 0, 20, 'center');
  }

  private async mermaidBlock(block: DocumentBlock) {
    const source = this.diagramSources.get(block.id);
    if (source) await this.image(source);
    else {
      this.text([{ text: 'Mermaid source (diagram unavailable)', bold: true }], 14);
      this.text([{ text: block.text, code: true }], 12);
    }
  }

  private textBlock(block: DocumentBlock) {
    const fontSize = blockFontSize(block);
    this.text(
      blockSpans(block),
      fontSize,
      (block.indent ?? 0) * 24,
      blockLineHeight(block, fontSize),
      block.align,
      block.style?.fontFamily,
    );
  }

  private async blockBody(block: DocumentBlock) {
    if (block.type === 'image') await this.imageBlock(block);
    else if (block.type === 'mermaid') await this.mermaidBlock(block);
    else if (block.type === 'table') this.table(block);
    else if (listBlockTypes.includes(block.type))
      this.list(blockListItems(block), block.type === 'numbered-list', 0, block.start);
    else if (block.type === 'html') this.text([{ text: htmlPlainText(block.text) }]);
    else if (block.type === 'code') this.text([{ text: block.text, code: true }], 13, 0, 21);
    else this.textBlock(block);
  }

  async block(visible: DocumentBlock[], index: number) {
    const block = visible[index];
    if (block.type === 'heading') this.keepHeadingWithNext(visible, index);
    if (block.style?.spaceBefore) this.y += (block.style.spaceBefore * 4) / 3;
    await this.blockBody(block);
    this.y += blockSpaceAfter(block);
  }

  numberPages() {
    for (let i = 0; i < this.pages.length; i++) {
      const context = this.pages[i].getContext('2d')!;
      context.fillStyle = '#7c8490';
      context.font = '11px system-ui';
      context.fillText(`${i + 1} / ${this.pages.length}`, this.w / 2 - 12, this.h - 28);
    }
  }
}
