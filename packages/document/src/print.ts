import { referenceExportManifest } from '@editor-platform/artifact-references';
import { PDFDocument } from 'pdf-lib';
import { addPdfText, preparePdfTextFont } from './pdf-text';
import { DocumentPrintRenderer } from './print-renderer';
import { downloadBlob } from '@editor-platform/canvas-ui';
import { type DocumentContent } from './model';
/** Browser font rasterization keeps Unicode and installed fonts consistent in exported PDF. */
export async function renderDocumentLayout(content: DocumentContent) {
  await document.fonts.ready;
  const landscape = content.page?.landscape,
    width = content.page?.size === 'Letter' ? 816 : 794,
    height = content.page?.size === 'Letter' ? 1056 : 1123,
    w = landscape ? height : width,
    h = landscape ? width : height,
    margin = content.page?.margin ?? 64;
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
