import { referenceExportManifest } from '@editor-platform/artifact-references';
import { PDFDocument } from 'pdf-lib';
import { addPdfText, preparePdfTextFont, type PrintedTextLine } from './pdf-text';
import { layoutPrintTable, tableLineHeight } from './print-layout';
import { downloadBlob } from '@editor-platform/canvas-ui';
import {
  nestedLists,
  styledDocumentSpans,
  type DocumentContent,
  type InlineSpan,
  type DocumentListItem,
} from './model';
/** Browser font rasterization keeps Unicode and installed fonts consistent in exported PDF. */
export async function renderDocumentLayout(content: DocumentContent) {
  await document.fonts.ready;
  const landscape = content.page?.landscape,
    width = content.page?.size === 'Letter' ? 816 : 794,
    height = content.page?.size === 'Letter' ? 1056 : 1123,
    w = landscape ? height : width,
    h = landscape ? width : height,
    margin = content.page?.margin ?? 64,
    usable = w - margin * 2;
  const pages: HTMLCanvasElement[] = [];
  const textPages: PrintedTextLine[][] = [];
  let order = 0;
  let ctx!: CanvasRenderingContext2D,
    y = margin;
  function page() {
    const canvas = document.createElement('canvas');
    canvas.width = w * 2;
    canvas.height = h * 2;
    ctx = canvas.getContext('2d')!;
    ctx.scale(2, 2);
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, w, h);
    pages.push(canvas);
    textPages.push([]);
    y = margin;
  }
  page();
  function ensure(size: number) {
    if (y + size > h - margin && y > margin) page();
  }
  const font = (span: InlineSpan, size: number, family?: string) =>
    `${span.italic ? 'italic ' : ''}${span.bold ? '700' : '400'} ${size}px ${span.code ? 'monospace' : family ? '"' + family + '"' : 'system-ui'}`;
  function text(
    spans: InlineSpan[],
    size = 16,
    indent = 0,
    lineHeight = size * 1.65,
    align = 'left',
    family?: string,
  ) {
    let line: { text: string; span: InlineSpan; width: number }[] = [],
      lineWidth = 0;
    function flush() {
      ensure(lineHeight);
      let x =
        margin +
        indent +
        (align === 'center'
          ? (usable - indent - lineWidth) / 2
          : align === 'right'
            ? usable - indent - lineWidth
            : 0);
      textPages.at(-1)!.push({
        text: line.map((token) => token.text).join(''),
        x,
        y: y + size,
        size,
        width: lineWidth,
        order: order++,
      });
      for (const token of line) {
        ctx.font = font(token.span, size, family);
        ctx.textBaseline = 'alphabetic';
        if (token.span.highlight) {
          ctx.fillStyle = token.span.highlight;
          ctx.fillRect(x, y, token.width, lineHeight);
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
        x += token.width;
      }
      y += lineHeight;
      line = [];
      lineWidth = 0;
    }
    for (const span of spans)
      for (const char of span.text) {
        if (char === '\n') {
          flush();
          continue;
        }
        ctx.font = font(span, size, family);
        const cw = ctx.measureText(char).width;
        if (lineWidth + cw > usable - indent && line.length) flush();
        line.push({ text: char, span, width: cw });
        lineWidth += cw;
      }
    if (line.length || !spans.some((s) => s.text)) flush();
  }
  const images = new Map<string, HTMLImageElement>();
  const diagramSources = new Map<string, string>();
  async function loadImage(src: string) {
    if (!images.has(src)) {
      const img = new Image();
      img.src = src;
      await img.decode();
      images.set(src, img);
    }
    return images.get(src)!;
  }
  function imageSize(img: HTMLImageElement, maxWidth = usable) {
    let iw = Math.min(maxWidth, usable, img.width),
      ih = (img.height * iw) / img.width;
    if (ih > h - margin * 2 - 12) {
      iw *= (h - margin * 2 - 12) / ih;
      ih = h - margin * 2 - 12;
    }
    return { iw, ih };
  }
  async function image(src: string, maxWidth = usable) {
    const img = await loadImage(src);
    const { iw, ih } = imageSize(img, maxWidth);
    ensure(ih + 12);
    ctx.drawImage(img, margin, y, iw, ih);
    y += ih + 12;
  }
  for (const block of content.blocks) {
    if (block.hidden) continue;
    if (block.type === 'image' && block.src) await loadImage(block.src);
    if (block.type === 'mermaid') {
      const { default: mermaid } = await import('mermaid');
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'neutral',
        suppressErrorRendering: true,
      });
      try {
        const { svg } = await mermaid.render(`print-${crypto.randomUUID()}`, block.text);
        const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml'),
          root = parsed.documentElement;
        const box = (root.getAttribute('viewBox') ?? '0 0 800 300').split(/[ ,]+/).map(Number);
        root.setAttribute('width', String(box[2]));
        root.setAttribute('height', String(box[3]));
        const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(root))}`;
        await loadImage(src);
        diagramSources.set(block.id, src);
      } catch {
        /* The same visible source fallback is measured and rendered below. */
      }
    }
  }
  function list(items: DocumentListItem[], numbered: boolean, depth = 0, start = 1) {
    items.forEach((item, i) => {
      text(
        [
          {
            text:
              item.checked === undefined
                ? numbered
                  ? `${i + start}. `
                  : '• '
                : item.checked
                  ? '[x] '
                  : '[ ] ',
          },
          ...item.rich,
        ],
        16,
        depth * 24,
      );
      nestedLists(item).forEach((nested) =>
        list(nested.items, nested.type === 'ordered_list', depth + 1, nested.start),
      );
    });
  }
  function measureText(
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
        ctx.font = font(span, size, family);
        const cw = ctx.measureText(char).width;
        if (width + cw > usable - indent && width > 0) {
          lines++;
          width = 0;
        }
        width += cw;
      }
    if (width > 0 || !spans.some((span) => span.text)) lines++;
    return lines * lineHeight;
  }
  function measuredHeight(block: DocumentContent['blocks'][number]): number {
    let size = 0;
    if (block.type === 'image' && block.src) {
      size = imageSize(images.get(block.src)!, block.width ?? usable).ih + 12;
      if (block.caption) size += measureText([{ text: block.caption }], 12, 0, 20);
    } else if (block.type === 'mermaid') {
      const src = diagramSources.get(block.id);
      size = src
        ? imageSize(images.get(src)!).ih + 12
        : measureText([{ text: 'Mermaid source (diagram unavailable)' }], 14) +
          measureText([{ text: block.text, code: true }], 12);
    } else if (block.type === 'table')
      size = layoutPrintTable(block, usable, (value, span) => {
        ctx.font = font(span, 13);
        return ctx.measureText(value).width;
      }).height;
    else if (['bulleted-list', 'numbered-list', 'check-list'].includes(block.type)) {
      const measureList = (
        items: DocumentListItem[],
        numbered: boolean,
        depth = 0,
        start = 1,
      ): number =>
        items.reduce(
          (sum, item, index) =>
            sum +
            measureText(
              [
                {
                  text:
                    item.checked === undefined
                      ? numbered
                        ? `${index + start}. `
                        : '• '
                      : item.checked
                        ? '[x] '
                        : '[ ] ',
                },
                ...item.rich,
              ],
              16,
              depth * 24,
            ) +
            nestedLists(item).reduce(
              (sum, list) =>
                sum + measureList(list.items, list.type === 'ordered_list', depth + 1, list.start),
              0,
            ),
          0,
        );
      size = measureList(
        block.items ??
          block.text.split('\n').map((value, index) => ({
            id: String(index),
            rich: [{ text: value }],
            ...(block.type === 'check-list' ? { checked: false } : {}),
          })),
        block.type === 'numbered-list',
        0,
        block.start,
      );
    } else if (block.type === 'html') {
      const parsed = new DOMParser().parseFromString(block.text, 'text/html');
      parsed.querySelectorAll('script,style,iframe,object,embed').forEach((node) => node.remove());
      size = measureText([{ text: parsed.body.textContent ?? '' }]);
    } else if (block.type === 'code')
      size = measureText([{ text: block.text, code: true }], 13, 0, 21);
    else {
      const fontSize =
        block.style?.fontSize !== undefined
          ? (block.style.fontSize * 4) / 3
          : block.type === 'heading'
            ? [34, 27, 22, 19, 17, 16][(block.level ?? 1) - 1]
            : 16;
      size = measureText(
        styledDocumentSpans(
          block.rich ?? [{ text: block.text, ...(block.type === 'heading' ? { bold: true } : {}) }],
          block.style,
        ),
        fontSize,
        (block.indent ?? 0) * 24,
        block.style?.lineHeight !== undefined ? block.style.lineHeight * fontSize : undefined,
        block.style?.fontFamily,
      );
    }
    return (
      size +
      ((block.style?.spaceBefore ?? 0) * 4) / 3 +
      (block.style?.spaceAfter !== undefined
        ? (block.style.spaceAfter * 4) / 3
        : block.type === 'heading'
          ? 14
          : 10)
    );
  }
  const visible = content.blocks.filter((block) => !block.hidden);
  for (const [index, block] of visible.entries()) {
    if (block.type === 'heading') {
      let grouped = measuredHeight(block),
        next = index + 1;
      while (visible[next]?.type === 'heading') grouped += measuredHeight(visible[next++]);
      if (visible[next]) {
        const following = measuredHeight(visible[next]);
        const pair = grouped + following;
        if (pair <= h - margin * 2) ensure(pair);
        else
          ensure(
            grouped +
              (visible[next].type === 'table'
                ? tableLineHeight * 2
                : ['image', 'mermaid'].includes(visible[next].type)
                  ? Math.min(following, h - margin * 2 - grouped)
                  : 27),
          );
      }
    }
    if (block.style?.spaceBefore) y += (block.style.spaceBefore * 4) / 3;
    if (block.type === 'image') {
      if (block.src) await image(block.src, block.width ?? usable);
      if (block.caption) text([{ text: block.caption, color: '#6d7683' }], 12, 0, 20, 'center');
    } else if (block.type === 'mermaid') {
      const source = diagramSources.get(block.id);
      if (source) await image(source);
      else {
        text([{ text: 'Mermaid source (diagram unavailable)', bold: true }], 14);
        text([{ text: block.text, code: true }], 12);
      }
    } else if (block.type === 'table') {
      const table = layoutPrintTable(block, usable, (value, span) => {
        ctx.font = font(span, 13);
        return ctx.measureText(value).width;
      });
      let offset = 0;
      while (offset < table.height) {
        if (h - margin - y < tableLineHeight * 2) page();
        const available = Math.floor((h - margin - y) / tableLineHeight) * tableLineHeight;
        let size = Math.min(available, table.height - offset);
        const boundary = table.rows.filter((row) => row > offset && row <= offset + size).at(-1);
        const nextBoundary =
          boundary === undefined ? undefined : table.rows.find((row) => row > boundary);
        if (boundary && nextBoundary !== undefined && nextBoundary - boundary <= h - margin * 2)
          size = boundary - offset;
        // A taller-than-page row is continued at whole text-line boundaries.
        ctx.save();
        ctx.beginPath();
        ctx.rect(margin, y, usable, size);
        ctx.clip();
        for (const cell of table.cells) {
          if (cell.y + cell.height <= offset || cell.y >= offset + size) continue;
          const top = y + cell.y - offset,
            left = margin + cell.x;
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
          cell.lines.forEach((line, i) => {
            const baseline = top + 19 + i * tableLineHeight;
            if (baseline < y || baseline > y + size) return;
            let x = left + 6;
            textPages.at(-1)!.push({
              text: line.map((token) => token.text).join(''),
              x,
              y: baseline,
              size: 13,
              width: line.reduce((sum, token) => sum + token.width, 0),
              order:
                order +
                table.cells
                  .slice(0, table.cells.indexOf(cell))
                  .reduce((sum, cell) => sum + cell.lines.length, 0) +
                i,
            });
            for (const token of line) {
              ctx.font = font(token.span, 13);
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
              x += token.width;
            }
          });
          ctx.restore();
        }
        ctx.restore();
        y += size;
        offset += size;
        if (offset < table.height) page();
      }
      order += table.cells.reduce((sum, cell) => sum + cell.lines.length, 0);
    } else if (['bulleted-list', 'numbered-list', 'check-list'].includes(block.type))
      list(
        block.items ??
          block.text.split('\n').map((value, i) => ({
            id: String(i),
            rich: [{ text: value }],
            ...(block.type === 'check-list' ? { checked: false } : {}),
          })),
        block.type === 'numbered-list',
        0,
        block.start,
      );
    else if (block.type === 'html') {
      const parsed = new DOMParser().parseFromString(block.text, 'text/html');
      parsed.querySelectorAll('script,style,iframe,object,embed').forEach((n) => n.remove());
      text([{ text: parsed.body.textContent ?? '' }]);
    } else if (block.type === 'code') text([{ text: block.text, code: true }], 13, 0, 21);
    else
      text(
        styledDocumentSpans(
          block.rich ?? [{ text: block.text, ...(block.type === 'heading' ? { bold: true } : {}) }],
          block.style,
        ),
        block.style?.fontSize !== undefined
          ? (block.style.fontSize * 4) / 3
          : block.type === 'heading'
            ? [34, 27, 22, 19, 17, 16][(block.level ?? 1) - 1]
            : 16,
        (block.indent ?? 0) * 24,
        block.style?.lineHeight !== undefined
          ? block.style.lineHeight *
              (block.style.fontSize !== undefined
                ? (block.style.fontSize * 4) / 3
                : block.type === 'heading'
                  ? [34, 27, 22, 19, 17, 16][(block.level ?? 1) - 1]
                  : 16)
          : undefined,
        block.align,
        block.style?.fontFamily,
      );
    y +=
      block.style?.spaceAfter !== undefined
        ? (block.style.spaceAfter * 4) / 3
        : block.type === 'heading'
          ? 14
          : 10;
  }
  for (let i = 0; i < pages.length; i++) {
    const context = pages[i].getContext('2d')!;
    context.fillStyle = '#7c8490';
    context.font = '11px system-ui';
    context.fillText(`${i + 1} / ${pages.length}`, w / 2 - 12, h - 28);
  }
  return { pages, textPages };
}
export async function renderDocumentPages(content: DocumentContent) {
  return (await renderDocumentLayout(content)).pages;
}
export async function exportDocumentPdf(content: DocumentContent) {
  const { pages, textPages } = await renderDocumentLayout(content),
    pdf = await PDFDocument.create();
  const manifest = referenceExportManifest(content.blocks.filter((block) => !block.hidden));
  if (manifest)
    await pdf.attach(new TextEncoder().encode(manifest), 'references.json', {
      mimeType: 'application/json',
    });
  const font = await preparePdfTextFont(pdf, textPages);
  for (const [index, canvas] of pages.entries()) {
    const w = canvas.width / 2,
      h = canvas.height / 2;
    const png = await pdf.embedPng(canvas.toDataURL('image/png')),
      p = pdf.addPage([w * 0.75, h * 0.75]);
    p.drawImage(png, { x: 0, y: 0, width: w * 0.75, height: h * 0.75 });
    addPdfText(p, font, h, textPages[index]);
  }
  downloadBlob(
    'document.pdf',
    new Blob([(await pdf.save()) as Uint8Array<ArrayBuffer>], { type: 'application/pdf' }),
  );
}
