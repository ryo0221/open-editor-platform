import { zipSync, strToU8 } from 'fflate';
async function checkSvgImages(svg: string) {
  const document = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const sources = [
    ...new Set(
      Array.from(document.querySelectorAll('image')).map(
        (image) => image.getAttribute('href') ?? image.getAttribute('xlink:href') ?? '',
      ),
    ),
  ];
  await Promise.all(
    sources.map(async (src) => {
      const image = new Image();
      if (!src.startsWith('data:')) image.crossOrigin = 'anonymous';
      image.src = src;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          image.decode(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Image load timed out')), 10000);
          }),
        ]);
      } catch {
        throw new Error(
          'Export stopped: an image could not be loaded. Replace it or allow its origin through CORS.',
        );
      } finally {
        clearTimeout(timer);
      }
    }),
  );
}
export function downloadBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob),
    a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function rasterizeSvg(
  svg: string,
  width: number,
  height: number,
  scale = 1,
): Promise<Uint8Array> {
  await document.fonts.ready;
  await checkSvgImages(svg);
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('An image or font could not be rendered for export'));
      image.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas is unavailable');
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG export failed'))), 'image/png'),
    );
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    URL.revokeObjectURL(url);
  }
}
export interface ExportPage {
  name: string;
  svg: string;
  width: number;
  height: number;
}
export async function exportPages(
  pages: ExportPage[],
  format: 'svg' | 'png' | 'pdf',
  scale = 1,
  name = 'export',
  referenceManifest?: string,
) {
  if (!pages.length) throw new Error('Choose at least one page to export');
  if (format === 'pdf') {
    const { PDFDocument } = await import('pdf-lib');
    const pdf = await PDFDocument.create();
    for (const source of pages) {
      const image = await pdf.embedPng(
        await rasterizeSvg(source.svg, source.width, source.height, Math.max(2, scale)),
      );
      const page = pdf.addPage([source.width * 0.75, source.height * 0.75]);
      page.drawImage(image, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
    }
    if (referenceManifest)
      await pdf.attach(strToU8(referenceManifest), 'references.json', {
        mimeType: 'application/json',
        description: 'Exact committed artifact sources used by this export',
      });
    // Classic cross-reference tables keep every /Type /Page visible to simple page counters
    // in external tools; object streams would compress them away (#801).
    const bytes = await pdf.save({ useObjectStreams: false });
    downloadBlob(`${name}.pdf`, new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }));
    return;
  }
  const files: Record<string, Uint8Array> = {};
  if (referenceManifest) files['references.json'] = strToU8(referenceManifest);
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    files[
      `${String(i + 1).padStart(3, '0')}-${page.name.replace(/[^\p{L}\p{N}_-]/gu, '_')}.${format}`
    ] =
      format === 'svg'
        ? (await checkSvgImages(page.svg), strToU8(page.svg))
        : await rasterizeSvg(page.svg, page.width, page.height, scale);
  }
  const entries = Object.entries(files);
  if (entries.length === 1)
    downloadBlob(
      entries[0][0],
      new Blob([new Uint8Array(entries[0][1])], {
        type: format === 'svg' ? 'image/svg+xml' : 'image/png',
      }),
    );
  else
    downloadBlob(
      `${name}-${format}.zip`,
      new Blob([new Uint8Array(zipSync(files))], { type: 'application/zip' }),
    );
}
/**
 * Image import limits (#22). An image is kept in the content as a data URL (about 4/3 of the file
 * size), in the draft and again in each version. Slides, boards and documents keep the Host's
 * 64 MiB native record, so one image stays at 16 MiB there. A design (manga pages) has a larger
 * native record and keeps its images apart in storage, so page art and references of 20–60 MiB fit:
 * one image may be up to 64 MiB.
 */
export const imageImportLimits = Object.freeze({
  bytes: 16 * 1024 * 1024,
  design: 64 * 1024 * 1024,
});
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
/** Why an image file cannot be imported, or undefined when it can. */
export function imageImportRefusal(
  file: { type: string; size: number },
  limit: number = imageImportLimits.bytes,
): string | undefined {
  if (!IMAGE_TYPES.includes(file.type))
    return 'Choose a PNG, JPEG, WebP or GIF image. SVG imports require sanitizing before use.';
  if (file.size > limit)
    return `Image exceeds ${limit / 1024 / 1024} MiB (this one is ${(file.size / 1024 / 1024).toFixed(1)} MiB)`;
  return undefined;
}
/** Reads an image file as a data URL; `limit` is the consuming editor's per-image limit. */
export async function readImage(
  file: File,
  limit: number = imageImportLimits.bytes,
): Promise<string> {
  const refused = imageImportRefusal(file, limit);
  if (refused) throw new Error(refused);
  const result = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('Could not read image'));
    r.readAsDataURL(file);
  });
  const image = new Image();
  image.src = result;
  await image.decode();
  return result;
}
