import { decodeDesignPng } from '@editor-platform/design/raster-canvas';
import { artLayers, type LayeredArtRequest, type LayeredArtResult } from './layered-art';

const palette = [
  [0, 255, 255],
  [0, 255, 0],
  [255, 255, 0],
  [255, 0, 0],
  [255, 0, 255],
  [0, 0, 255],
  [255, 255, 255],
  [0, 0, 0],
];
/** Host image-generation adapter: partition actual pixels using an AI semantic map. */
export async function splitLayeredArtImage(
  request: LayeredArtRequest,
  raw: unknown,
): Promise<LayeredArtResult> {
  if (request.schemaVersion !== 1)
    throw Error('複数人物・動物は個別の透過PNGで返してください。8色領域マップは従来版専用です。');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw Error('画像生成結果が不正です。');
  const value = raw as Record<string, unknown>;
  if (
    value.requestId !== request.id ||
    typeof value.sourcePng !== 'string' ||
    typeof value.segmentationPng !== 'string' ||
    typeof value.source !== 'string' ||
    !value.source.trim() ||
    value.source.length > 300
  )
    throw Error('生成画像とAI領域マップを同じ依頼に対応させてください。');
  const sourceLabel = value.source;
  const [source, mask] = await Promise.all([
    decodeDesignPng(value.sourcePng),
    decodeDesignPng(value.segmentationPng),
  ]);
  if ([source, mask].some((p) => p.width !== request.width || p.height !== request.height))
    throw Error('生成画像・領域マップ・ラフを同じ画素サイズにしてください。');
  const canvas = document.createElement('canvas');
  canvas.width = request.width;
  canvas.height = request.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(source.image, 0, 0);
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(mask.image, 0, 0);
  const labels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const output = artLayers.map(() => new Uint8ClampedArray(pixels.length)),
    counts = artLayers.map(() => 0);
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] !== 255 || labels[i + 3] !== 255)
      throw Error('領域分離には透過のない全体画像と領域マップを使ってください。');
    // Generated maps may shade a label. Preserve its hue instead of treating dark blue as hair.
    const rgb = [labels[i], labels[i + 1], labels[i + 2]],
      low = Math.min(...rgb),
      spread = Math.max(...rgb) - low;
    const color = spread > 24 ? rgb.map((v) => ((v - low) * 255) / spread) : rgb;
    let nearest = 0,
      distance = Infinity;
    for (let j = 0; j < palette.length; j++) {
      if (spread > 24 && j >= 6) continue;
      const p = palette[j],
        d = (color[0] - p[0]) ** 2 + (color[1] - p[1]) ** 2 + (color[2] - p[2]) ** 2;
      if (d < distance) {
        distance = d;
        nearest = j;
      }
    }
    const layer = output[nearest];
    for (let c = 0; c < 4; c++) layer[i + c] = pixels[i + c];
    counts[nearest]++;
    // Facial features need white skin beneath them so moving an eye does not punch a hole.
    if (nearest === 6) {
      output[3][i] = output[3][i + 1] = output[3][i + 2] = output[3][i + 3] = 255;
    }
  }
  if (counts.some((n) => !n)) throw Error('AI領域マップに8種類すべての領域が必要です。');
  const layers = artLayers.map((plan, j) => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.putImageData(new ImageData(output[j], canvas.width, canvas.height), 0, 0);
    return {
      id: plan.id,
      src: canvas.toDataURL('image/png'),
      source: sourceLabel + ' / AI semantic partition: ' + plan.id,
    };
  });
  return { requestId: request.id, layers: layers as LayeredArtResult['layers'] };
}
