import { referenceExportManifest } from '@editor-platform/artifact-references';
import { PDFDocument } from 'pdf-lib';
import { addPdfText, preparePdfTextFont } from './pdf-text';
import { DocumentPrintRenderer } from './print-renderer';
import { downloadBlob } from '@editor-platform/canvas-ui';
import { isVerticalDocument, type DocumentContent } from './model';
import {
  layoutVerticalDocument,
  paintVerticalPages,
  verticalFigureTypes,
  verticalTextLines,
  type VerticalFigure,
} from './print-vertical';
import type { PrintedTextLine } from './pdf-text';

interface FigureSlice {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  text: PrintedTextLine[];
}
/** Images, tables, diagrams, code and HTML in a vertical document are set upright, as in a
 * vertical book: each is rendered horizontally like a horizontal page, then cropped to its ink. */
async function renderVerticalFigures(
  content: DocumentContent,
  maxWidth: number,
  maxHeight: number,
) {
  const out = new Map<string, FigureSlice[]>();
  for (const block of content.blocks) {
    if (block.hidden || !verticalFigureTypes.has(block.type)) continue;
    const renderer = new DocumentPrintRenderer(maxWidth, maxHeight, 0);
    // Spacing around the figure belongs to the vertical flow, not to its own rendering.
    const { style: _style, ...bare } = block;
    const alone: DocumentContent = { ...content, blocks: [bare] };
    await renderer.preload(alone);
    await renderer.block(alone.blocks, 0);
    const slices: FigureSlice[] = [];
    renderer.pages.forEach((page, index) => {
      const ink = inkExtent(page);
      if (!ink) return;
      const canvas = document.createElement('canvas');
      canvas.width = ink.width * 2;
      canvas.height = ink.height * 2;
      canvas
        .getContext('2d')!
        .drawImage(page, 0, 0, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
      slices.push({
        canvas,
        width: ink.width,
        height: ink.height,
        text: renderer.textPages[index],
      });
    });
    out.set(block.id, slices);
  }
  return out;
}
/** The right and bottom edges of everything painted on a white canvas, in CSS pixels. */
function inkExtent(canvas: HTMLCanvasElement) {
  const { width, height } = canvas;
  const data = canvas.getContext('2d')!.getImageData(0, 0, width, height).data;
  let right = 0,
    bottom = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (data[i] < 250 || data[i + 1] < 250 || data[i + 2] < 250) {
        if (x + 1 > right) right = x + 1;
        bottom = y + 1;
      }
    }
  if (!right) return undefined;
  return { width: Math.ceil(right / 2) + 1, height: Math.ceil(bottom / 2) + 1 };
}
/** Browser font rasterization keeps Unicode and installed fonts consistent in exported PDF. */
export async function renderDocumentLayout(content: DocumentContent) {
  await document.fonts.ready;
  const landscape = content.page?.landscape,
    width = content.page?.size === 'Letter' ? 816 : 794,
    height = content.page?.size === 'Letter' ? 1056 : 1123,
    w = landscape ? height : width,
    h = landscape ? width : height,
    margin = content.page?.margin ?? 64;
  if (isVerticalDocument(content)) {
    const measure = document.createElement('canvas').getContext('2d')!;
    const figures = await renderVerticalFigures(content, w - margin * 2, h - margin * 2);
    const layout = layoutVerticalDocument(
      content,
      { width: w, height: h, margin },
      (text, font) => {
        measure.font = font;
        return measure.measureText(text).width;
      },
      (block) => figures.get(block.id) ?? [],
    );
    const slice = (fig: VerticalFigure) => figures.get(fig.blockId)?.[fig.slice];
    return {
      pages: paintVerticalPages(layout, (fig) => slice(fig)?.canvas),
      textPages: verticalTextLines(layout, (fig) => slice(fig)?.text ?? []),
    };
  }
  const renderer = new DocumentPrintRenderer(w, h, margin);
  await renderer.preload(content);
  const visible = content.blocks.filter((block) => !block.hidden);
  for (const index of visible.keys()) await renderer.block(visible, index);
  renderer.numberPages();
  return { pages: renderer.pages, textPages: renderer.textPages };
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
