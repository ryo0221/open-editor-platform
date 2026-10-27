/**
 * Writing a drawing out of the browser (R2c-5b): the SVG as it is, or a PNG raster of it at a
 * fixed resolution on paper. Hosts need nothing for either: the Surface downloads the file.
 */

/** PNG resolution on paper, and the largest side a canvas is given. */
export const bimPngExport = Object.freeze({ dpi: 150, maxSidePx: 8192 });

/** The SVG's paper size in mm, from its `width` and `height` (`bimDrawingSvg` writes mm). */
export function bimSvgPaperMm(svg: string): [number, number] {
  const head = svg.slice(0, svg.indexOf('>'));
  const size = (name: string) => Number(new RegExp(`\\s${name}="([0-9.]+)mm"`).exec(head)?.[1]);
  return [size('width'), size('height')];
}

/** The PNG's pixel size: the paper at `dpi`, scaled down to fit `maxSidePx`. */
export function bimPngSize(paperMm: [number, number], options = bimPngExport): [number, number] {
  const px = paperMm.map((mm) => (mm / 25.4) * options.dpi);
  const fit = Math.min(1, options.maxSidePx / Math.max(...px));
  return [Math.max(1, Math.round(px[0]! * fit)), Math.max(1, Math.round(px[1]! * fit))];
}

/** The drawing on a white background as a PNG. */
export async function bimSvgToPng(svg: string): Promise<Blob> {
  const [w, h] = bimPngSize(bimSvgPaperMm(svg));
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const image = new Image();
    image.decoding = 'async';
    const loaded = new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('drawing-image-failed'));
    });
    image.src = url;
    await loaded;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext('2d');
    if (!g) throw new Error('drawing-canvas-unavailable');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, w, h);
    g.drawImage(image, 0, 0, w, h);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('drawing-png-failed'))), 'image/png'),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Saves a file through the browser's download. */
export function bimDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  // After the click has handed the URL to the download.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** A file name from a name, without characters files refuse. */
export const bimFileName = (name: string, ext: string) =>
  `${[...name]
    .map((c) => (c.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(c) ? '_' : c))
    .join('')
    .trim()}.${ext}`;

/** A drawing's file name, from the building's and the view's names. */
export const bimDrawingFileName = (building: string, view: string, ext: 'svg' | 'png') =>
  bimFileName(`${building} - ${view}`, ext);
