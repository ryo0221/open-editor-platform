import { contentHash } from '@editor-platform/artifact-core';
import {
  assertGeo,
  GEO_RENDERER_VERSION,
  renderGeoSvg,
  type Budgets,
  type GeoDocument,
  type OutputReceipt,
  type Pin,
} from '@editor-platform/geo-core';

export interface GeoPngBundle {
  bytes: Uint8Array;
  receipt: OutputReceipt;
  dataUrl: string;
}
/** Browser rasterizer of our escaped, network-free SVG. Host rechecks authority at every await. */
export async function createGeoPng(
  doc: Document,
  capture: { content: GeoDocument; pin: Pin },
  viewId: string,
  pixels: [number, number],
  budgets: Budgets,
  current: () => void,
): Promise<GeoPngBundle> {
  current();
  assertGeo(capture.content, budgets);
  const owned = structuredClone(capture),
    size: [number, number] = [...pixels];
  if (
    !size.every((n) => Number.isSafeInteger(n) && n >= 240 && n <= 2048) ||
    size[0] < 700 ||
    size[0] * size[1] > 4_000_000
  )
    throw Error('PNG pixel budget');
  const view = owned.content.workspace?.views.find((v) => v.id === viewId);
  if (!view) throw Error('Save a named view and its native version before PNG export');
  if ('sha256:' + (await contentHash(owned.content)) !== owned.pin.contentHash)
    throw Error('PNG native hash mismatch');
  current();
  const svg = renderGeoSvg(
    owned.content,
    { extent: view.extent, view, width: size[0], height: size[1] },
    budgets,
  );
  const image = doc.createElement('img'),
    url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    image.src = url;
    await image.decode();
    current();
    const canvas = doc.createElement('canvas');
    canvas.width = size[0];
    canvas.height = size[1];
    const context = canvas.getContext('2d');
    if (!context) throw Error('PNG canvas unavailable');
    context.drawImage(image, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (value) => (value ? resolve(value) : reject(Error('PNG encoding failed'))),
        'image/png',
      ),
    );
    current();
    if (blob.size > 16_000_000) throw Error('PNG byte budget');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    current();
    const outputBytesHash =
      'sha256:' +
      Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
        b.toString(16).padStart(2, '0'),
      ).join('');
    current();
    const styleHash =
      'sha256:' + (await contentHash({ styles: view.styles, annotations: view.annotations }));
    current();
    return {
      bytes,
      dataUrl: canvas.toDataURL('image/png'),
      receipt: {
        input: owned.pin,
        derivedInputs: (owned.content.workspace?.joins ?? []).flatMap((j) => [
          j.inputs.left,
          j.inputs.right,
        ]),
        sources: owned.content.sources,
        namedViewId: viewId,
        rendererVersion: GEO_RENDERER_VERSION,
        transformerVersion: 'crs84-no-coordinate-transform@1',
        styleHash,
        extent: view.extent,
        displayProjection:
          'longitude-latitude equirectangular; geographic coordinates, no distance/area measurement',
        pixels: size,
        attribution: owned.content.sources.map((s) => s.attribution),
        outputBytesHash,
      },
    };
  } finally {
    URL.revokeObjectURL(url);
    image.removeAttribute('src');
  }
}
