import {
  createAnimation2,
  createAnimationLayer2,
  encodeAnimationBase64,
  hashAnimationBytes2,
  type Layer2,
} from '@editor-platform/animation-core/v2';
export function animation2DFixture(font: Uint8Array, image: Uint8Array, license: string) {
  const content = createAnimation2(),
    c = content.compositions[0];
  content.assets = [
    {
      id: 'font',
      contentHash: hashAnimationBytes2(font),
      mediaType: 'font/otf',
      base64: encodeAnimationBase64(font),
      attribution: 'Noto Sans CJK JP, retained Office fixture subset',
      license,
    },
    {
      id: 'image',
      contentHash: hashAnimationBytes2(image),
      mediaType: 'image/png',
      base64: encodeAnimationBase64(image),
      attribution: 'Repository quadrants fixture',
      license: 'Repository fixture terms',
    },
  ];
  const group = createAnimationLayer2('group', 'group', c.duration);
  group.transform.x = 100;
  group.transform.y = 40;
  const mask = createAnimationLayer2('path', 'mask', c.duration);
  if (mask.type !== 'path') throw Error();
  mask.path = [['M', 0, 0], ['L', 280, 0], ['L', 280, 180], ['L', 0, 180], ['Z']];
  mask.transform.x = 0;
  mask.transform.y = 0;
  mask.parentId = 'group';
  mask.maskOnly = true;
  const text = createAnimationLayer2('text', 'caption', c.duration);
  if (text.type !== 'text') throw Error();
  text.text = '日本語アニメーション';
  text.fontAssetId = 'font';
  text.width = 280;
  text.height = 50;
  text.parentId = 'group';
  text.transform.x = 10;
  text.transform.y = 10;
  text.clipId = 'mask';
  const moving = createAnimationLayer2('rect', 'moving', c.duration);
  moving.parentId = 'group';
  moving.clipId = 'mask';
  moving.transform.x = 40;
  moving.transform.y = 80;
  moving.transform.scaleX = -1;
  moving.transform.anchorX = 60;
  moving.motion = {
    path: [
      ['M', 0, 0],
      ['C', 30, -30, 100, 40, 160, 0],
    ],
    start: 0,
    end: 480000,
    orient: true,
  };
  const imageBase = createAnimationLayer2('group', 'picture', c.duration);
  if (imageBase.type !== 'group') throw Error();
  const picture: Layer2 = { ...imageBase, type: 'image', assetId: 'image', width: 64, height: 64 };
  picture.parentId = 'group';
  picture.transform.x = 310;
  picture.transform.y = 30;
  const child = {
    ...structuredClone(c),
    id: 'child',
    name: 'Fractional child',
    duration: 960960,
    frameRate: { numerator: 24000, denominator: 1001 },
    layers: [createAnimationLayer2('rect', 'child-box', 960960)],
  };
  child.layers[0].transform.x = 470;
  child.layers[0].transform.y = 210;
  const nestedBase = createAnimationLayer2('group', 'nested', c.duration);
  if (nestedBase.type !== 'group') throw Error();
  const nested: Layer2 = {
    ...nestedBase,
    type: 'composition',
    source: { type: 'local', compositionId: 'child' },
    time: {
      sourceIn: 0,
      sourceOut: 960960,
      rate: { numerator: 1001, denominator: 1000 },
      after: 'loop',
    },
  };
  nested.transform.x = 0;
  nested.transform.y = 0;
  c.layers = [group, mask, text, moving, picture, nested];
  c.tracks = [
    {
      id: 'fade',
      layerId: 'moving',
      property: 'opacity',
      keys: [
        { id: 'fade-first', tick: 0, value: 0.4, easing: { type: 'linear' } },
        { id: 'fade-last', tick: 480000, value: 1, easing: { type: 'hold' } },
      ],
    },
  ];
  content.compositions.push(child);
  content.publicInputs = [
    {
      id: 'caption-input',
      name: 'Caption',
      kind: 'text',
      default: text.text,
      min: 0,
      max: 0,
      target: { compositionId: 'root', layerId: 'caption', property: 'text' },
    },
  ];
  return content;
}
