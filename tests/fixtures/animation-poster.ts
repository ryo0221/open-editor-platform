import {
  createAnimation2,
  createAnimationLayer2,
  encodeAnimationBase64,
  hashAnimationBytes2,
} from '@editor-platform/animation-core/v2';
/** Valid source whose embedded images and expanded geometry exceed the SVG output limit. */
export function posterLimitAnimation(png: Uint8Array) {
  const content = createAnimation2(),
    root = content.compositions[0];
  content.assets = Array.from({ length: 2 }, (_, i) => {
    const bytes = new Uint8Array(2 * 1024 * 1024);
    bytes.set(png);
    bytes[bytes.length - 1] = i;
    return {
      id: `image-${i}`,
      contentHash: hashAnimationBytes2(bytes),
      mediaType: 'image/png' as const,
      base64: encodeAnimationBase64(bytes),
      attribution: 'Repository padded PNG fixture',
      license: 'Test fixture',
    };
  });
  root.layers = content.assets.map((asset, i) => ({
    ...createAnimationLayer2('group', `picture-${i}`, root.duration),
    type: 'image' as const,
    assetId: asset.id,
    width: 100,
    height: 100,
  }));
  const geometry = createAnimationLayer2('path', 'geometry', root.duration);
  if (geometry.type !== 'path') throw Error('Fixture path');
  geometry.path = [['M', 0, 0]];
  for (let i = 0; i < 511; i++)
    geometry.path.push([
      'C',
      999999.123456789,
      999999.123456789,
      999999.123456789,
      999999.123456789,
      999999.123456789,
      999999.123456789,
    ]);
  content.compositions.push({ ...structuredClone(root), id: 'child', layers: [geometry] });
  for (let i = 0; i < 60; i++)
    root.layers.push({
      ...createAnimationLayer2('group', `instance-${i}`, root.duration),
      type: 'composition',
      source: { type: 'local', compositionId: 'child' },
      time: {
        sourceIn: 0,
        sourceOut: root.duration,
        rate: { numerator: 1, denominator: 1 },
        after: 'hold',
      },
    });
  return content;
}

/** Initial frame fits; a legal private text override crosses the renderer's own bound. */
export function playerInputLimitAnimation(png: Uint8Array) {
  const content = posterLimitAnimation(png),
    root = content.compositions[0];
  root.layers = root.layers.slice(0, 42);
  const caption = createAnimationLayer2('text', 'caption', root.duration);
  if (caption.type !== 'text') throw Error('Fixture text');
  caption.text = 'A';
  root.layers.push(caption);
  content.publicInputs = [
    {
      id: 'caption-input',
      name: 'Caption',
      kind: 'text',
      default: 'A',
      min: 0,
      max: 20000,
      target: { compositionId: root.id, layerId: caption.id, property: 'text' },
    },
  ];
  return content;
}

/** Tick zero exceeds SVG output, while the requested poster contains only a light rectangle. */
export function playerPosterLimitAnimation(png: Uint8Array) {
  const content = posterLimitAnimation(png),
    root = content.compositions[0];
  for (const layer of root.layers) layer.end = 240000;
  const poster = createAnimationLayer2('rect', 'poster-box', root.duration);
  if (poster.type !== 'rect') throw Error('Fixture rectangle');
  poster.fill = '#229955';
  root.layers.push(poster);
  return content;
}
