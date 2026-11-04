/** Authored cartographic scenario: editable native shapes, not a raster backdrop or simulation. */
import { createArtifact } from '@editor-platform/artifact-core';
import {
  createFictionMap,
  validateFictionMap,
  type FictionMapFeature,
  type FictionMapPoint,
} from '@editor-platform/fiction-map/model';
const p = (x: number, y: number): FictionMapPoint => [Math.round(x * 2) / 2, Math.round(y * 2) / 2];
/** Positive radial variation and increasing angles retain a simple closed contour. */
function contour(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  n = 24,
  phase = 0,
): FictionMapPoint[] {
  const points = Array.from({ length: n }, (_, i) => {
    const a = (i * 2 * Math.PI) / n,
      r = 0.9 + 0.065 * Math.sin(3 * a + phase) + 0.035 * Math.cos(7 * a - phase);
    return p(cx + rx * r * Math.cos(a), cy + ry * r * Math.sin(a));
  });
  return [...points, points[0]];
}
export type SettingDemoStage = 'rough' | 'terrain' | 'detailed';
export function settingDemoContent(stage: SettingDemoStage = 'detailed') {
  const features: FictionMapFeature[] = [];
  function shape(
    id: string,
    name: string,
    layerId: string,
    color: string,
    outer: FictionMapPoint[],
    description: string,
    kind: 'region' | 'landform' = 'region',
  ) {
    features.push({
      id,
      name,
      layerId,
      featureKind: kind,
      geometry: { type: 'polygon', outer },
      style: { color, lineWidth: 1.2, label: false },
      description,
    });
  }
  function line(
    id: string,
    name: string,
    layerId: string,
    color: string,
    coordinates: FictionMapPoint[],
    width = 1.5,
    kind: 'path' | 'landform' = 'path',
    category?: string,
  ) {
    features.push({
      id,
      name,
      layerId,
      featureKind: kind,
      geometry: { type: 'polyline', coordinates },
      style: { color, lineWidth: width, label: false },
      ...(category ? { category } : {}),
    });
  }
  const coast: FictionMapPoint[] = [
    [178, 0],
    [174, 26],
    [190, 47],
    [185, 70],
    [204, 91],
    [195, 111],
    [173, 123],
    [171, 143],
    [191, 159],
    [185, 175],
    [208, 188],
    [210, 209],
    [190, 230],
    [202, 250],
    [182, 271],
    [170, 293],
    [179, 312],
    [162, 330],
    [172, 351],
    [158, 371],
    [170, 395],
    [183, 412],
    [188, 426],
    [178, 439],
    [193, 450],
    [186, 464],
    [202, 481],
    [206, 504],
    [223, 521],
    [215, 538],
    [232, 550],
    [222, 568],
    [241, 589],
    [228, 607],
    [246, 628],
    [238, 650],
  ];
  shape(
    'mainland',
    '西風地方の陸地',
    'terrain',
    '#ddc9a1',
    [...coast, [1000, 650], [1000, 0], coast[0]],
    '複雑な海岸線を持つ作者定義の平面。大陸全体ではなく沿岸地方。',
    'landform',
  );
  shape(
    'western-sea',
    '西海',
    'terrain',
    '#78acc1',
    [[0, 0], ...coast, [0, 650], [0, 0]],
    '湾と岬のある西海。実在の海岸の転写ではない。',
  );
  line(
    'coastal-sounding',
    '沿岸の浅瀬線',
    'relief',
    '#a5bbc0',
    coast.map(([x, y]) => p(x - 12, y)),
    0.8,
    'landform',
    'cartographic-decoration',
  );
  shape(
    'wet-forest',
    '西風の森',
    'terrain',
    '#93ad79',
    contour(350, 185, 145, 105, 28, 0.5),
    '西風と雨陰を踏まえた作者の植生配置。降雨simulationではない。',
  );
  shape(
    'dry-basin',
    '東の盆地',
    'terrain',
    '#d3bb8c',
    contour(770, 300, 200, 220, 30, 1),
    '雨陰の盆地。大まかな地形範囲を不規則な等高状の輪郭で表す。',
  );
  shape(
    'eastern-lake',
    '東の湖',
    'water',
    '#6c9fba',
    contour(848, 438, 58, 38, 22, 0.8),
    '東水系の終点。標高と水収支は作者設定。',
    'landform',
  );
  shape(
    'old-border',
    '旧王国の領域',
    'political',
    '#a99275',
    [
      [240, 315],
      [269, 302],
      [293, 318],
      [328, 296],
      [370, 294],
      [404, 278],
      [435, 286],
      [470, 263],
      [505, 272],
      [532, 291],
      [548, 321],
      [578, 339],
      [601, 370],
      [589, 403],
      [610, 435],
      [584, 467],
      [590, 501],
      [562, 529],
      [547, 565],
      [515, 578],
      [481, 605],
      [441, 592],
      [402, 611],
      [368, 594],
      [327, 600],
      [301, 576],
      [273, 562],
      [262, 528],
      [241, 501],
      [250, 468],
      [233, 440],
      [244, 406],
      [229, 371],
      [240, 315],
    ],
    '尾根・川沿いの旧境界。和約による変更は保存版2で明示する。',
  );
  // Mountains are native landform polylines, not Point circles or an uneditable image.
  for (let i = 0; i < 23; i++) {
    const y = 60 + i * 22,
      x = 510 + 24 * Math.sin(i * 0.75),
      size = 16 + (i % 4) * 3;
    line(
      `peak-${i}`,
      `稜線 ${i + 1}`,
      'relief',
      '#807665',
      [
        p(x - size, y + 16),
        p(x, y - size),
        p(x + size * 0.4, y - 2),
        p(x + size * 0.55, y - 8),
        p(x + size, y + 16),
      ],
      1.3,
      'landform',
      'mountain-symbol',
    );
    if (i % 3 === 0)
      line(
        `ridge-hatching-${i}`,
        `山腹 ${i + 1}`,
        'relief',
        '#b1a38b',
        [p(x, y - size), p(x - 2, y + 1), p(x + 6, y + 9)],
        0.8,
        'landform',
        'cartographic-decoration',
      );
  }
  for (let row = 0; row < 5; row++)
    for (let col = 0; col < 7; col++) {
      const x = 248 + col * 30 + (row % 2) * 8,
        y = 120 + row * 29 + 6 * Math.sin(col);
      if (((x - 350) / 130) ** 2 + ((y - 185) / 92) ** 2 > 1) continue;
      line(
        `tree-${row}-${col}`,
        '西側の樹林',
        'relief',
        '#6d8e63',
        [
          p(x - 6, y + 5),
          p(x, y - 8),
          p(x + 6, y + 5),
          p(x - 4, y + 1),
          p(x + 4, y + 1),
          p(x, y - 5),
          p(x, y + 11),
        ],
        1,
        'landform',
        'forest-symbol',
      );
    }
  for (let i = 0; i < 3; i++)
    line(
      `basin-contour-${i}`,
      `盆地の地形線 ${i + 1}`,
      'relief',
      '#c9b998',
      contour(780, 300, 150 - i * 20, 175 - i * 21, 26, i * 0.4).slice(0, 22),
      0.8,
      'landform',
      'cartographic-decoration',
    );
  line(
    'west-river',
    '西へ流れる川',
    'water',
    '#528da4',
    [
      [502, 210],
      [486, 217],
      [474, 234],
      [459, 238],
      [447, 252],
      [430, 260],
      [417, 278],
      [402, 282],
      [394, 299],
      [379, 309],
      [370, 320],
      [349, 326],
      [330, 342],
      [310, 344],
      [294, 360],
      [275, 368],
      [263, 387],
      [245, 390],
      [232, 410],
      [213, 416],
      [200, 433],
      [184, 438],
    ],
    3,
  );
  line(
    'east-river',
    '東へ流れる川',
    'water',
    '#528da4',
    [
      [553, 303],
      [565, 316],
      [578, 319],
      [589, 335],
      [608, 341],
      [624, 354],
      [647, 352],
      [665, 362],
      [687, 357],
      [709, 370],
      [727, 369],
      [749, 385],
      [767, 387],
      [783, 402],
      [807, 414],
    ],
    2.7,
  );
  for (const [id, points] of [
    [
      'north-tributary',
      [
        [459, 156],
        [450, 178],
        [463, 196],
        [451, 216],
        [459, 238],
      ],
    ],
    [
      'forest-tributary',
      [
        [302, 234],
        [318, 257],
        [345, 271],
        [356, 296],
        [379, 309],
      ],
    ],
    [
      'south-tributary',
      [
        [480, 411],
        [454, 393],
        [431, 371],
        [408, 354],
        [379, 309],
      ],
    ],
    [
      'east-tributary',
      [
        [625, 227],
        [642, 259],
        [654, 282],
        [647, 318],
        [647, 352],
      ],
    ],
  ] as [string, FictionMapPoint[]][])
    line(id, '支流', 'water', '#689eb2', points, 1.4);
  line(
    'trade-road',
    '峠越え交易路',
    'routes',
    '#ae8a57',
    [
      [205, 440],
      [221, 425],
      [242, 415],
      [261, 398],
      [278, 380],
      [302, 363],
      [324, 349],
      [346, 337],
      [370, 320],
      [398, 307],
      [415, 291],
      [440, 281],
      [461, 266],
      [483, 261],
      [505, 252],
      [520, 250],
      [547, 260],
      [565, 251],
      [588, 265],
      [611, 260],
      [638, 276],
      [665, 269],
      [690, 280],
      [722, 275],
      [753, 286],
      [782, 277],
      [810, 280],
    ],
    2.2,
  );
  line(
    'old-road',
    '旧要塞への道',
    'routes',
    '#a39b88',
    [
      [370, 320],
      [378, 292],
      [401, 277],
      [408, 254],
      [432, 236],
      [435, 215],
      [461, 196],
      [478, 171],
      [507, 154],
      [540, 130],
    ],
    1.5,
  );
  line(
    'southern-track',
    '南の渡し道',
    'routes',
    '#b5a17e',
    [
      [370, 320],
      [350, 350],
      [340, 378],
      [314, 402],
      [310, 430],
      [285, 453],
      [279, 483],
      [249, 506],
      [230, 540],
    ],
    1.4,
  );
  const towns: [string, string, FictionMapPoint, string][] = [
    ['harbor', '西海港', [205, 440], '湾奥の海運拠点。'],
    ['ford', '渡河市場', [370, 320], '渡河点と街道の交差点。'],
    ['pass', '風の峠', [520, 250], '南北の稜線にある通行可能な鞍部。'],
    ['fort', '王朝の要塞', [540, 130], '峠の北を監視する旧王朝の拠点。'],
    ['new-port', '南の渡し', [230, 540], '和約後に新港へ育つ同一地物。'],
    ['basin-market', '盆地市', [810, 280], '盆地東側の交易市場。'],
    ['lake', '湖畔の村', [841, 400], '湖の北岸。'],
    ['forest-village', '森の村', [300, 200], '西側森林の集落。'],
    ['granary', '穀倉の町', [300, 420], '河川沿いの耕作地。'],
    ['ruins', '古い関所', [650, 520], '旧道と歴史の痕跡。'],
  ];
  for (const [id, name, coordinates, description] of towns)
    features.push({
      id,
      name,
      description,
      layerId: 'places',
      featureKind: 'place',
      geometry: { type: 'point', coordinates },
      style: { color: '#5e5245' },
      ...(id === 'new-port'
        ? { worldEntityRef: { namespace: 'demo-world', entityId: 'southern-port' } }
        : {}),
    });
  for (const [id, name, anchor, color] of [
    ['sea-title', '西 海', [54, 290], '#608b9e'],
    ['forest-title', '西風の森', [285, 96], '#657b55'],
    ['mountain-title', '中央山脈', [548, 70], '#87775b'],
    ['basin-title', '雨陰の盆地', [742, 110], '#9a875e'],
    ['realm-title', '西風辺境国', [345, 548], '#8f7358'],
  ] as [string, string, FictionMapPoint, string][]) {
    features.push({
      id,
      name,
      layerId: 'annotation',
      featureKind: 'landform',
      geometry: { type: 'polyline', coordinates: [anchor, p(anchor[0] + 1, anchor[1])] },
      style: { color, lineWidth: 0.25, label: true },
      category: 'map-label',
    });
  }
  line(
    'ridge',
    '中央稜線',
    'relief',
    '#c0b298',
    [
      [500, 40],
      [540, 130],
      [505, 210],
      [550, 300],
      [520, 400],
      [560, 570],
    ],
    0.8,
    'landform',
    'watershed',
  );
  const coarse: Record<string, FictionMapFeature['geometry']> = {
    'western-sea': {
      type: 'polygon',
      outer: [
        [0, 0],
        [180, 0],
        [190, 220],
        [160, 400],
        [230, 650],
        [0, 650],
        [0, 0],
      ],
    },
    'wet-forest': {
      type: 'polygon',
      outer: [
        [220, 90],
        [460, 80],
        [480, 200],
        [420, 290],
        [240, 280],
        [220, 90],
      ],
    },
    'dry-basin': {
      type: 'polygon',
      outer: [
        [620, 90],
        [930, 120],
        [940, 490],
        [720, 540],
        [630, 390],
        [620, 90],
      ],
    },
    'old-border': {
      type: 'polygon',
      outer: [
        [240, 315],
        [500, 270],
        [610, 350],
        [570, 600],
        [290, 600],
        [240, 315],
      ],
    },
    'west-river': {
      type: 'polyline',
      coordinates: [
        [500, 210],
        [445, 240],
        [370, 320],
        [285, 355],
        [184, 438],
      ],
    },
    'east-river': {
      type: 'polyline',
      coordinates: [
        [550, 300],
        [630, 350],
        [740, 360],
        [807, 414],
      ],
    },
    'trade-road': {
      type: 'polyline',
      coordinates: [
        [205, 440],
        [370, 320],
        [520, 250],
        [670, 260],
        [810, 280],
      ],
    },
    'old-road': {
      type: 'polyline',
      coordinates: [
        [370, 320],
        [435, 215],
        [540, 130],
      ],
    },
  };
  const baseIds = new Set([...Object.keys(coarse), 'ridge', ...towns.map(([id]) => id)]);
  const staged =
    stage === 'rough'
      ? features
          .filter((f) => baseIds.has(f.id))
          .map((f) => ({ ...f, geometry: coarse[f.id] ?? f.geometry }))
      : stage === 'terrain'
        ? features
            .filter((f) => f.id !== 'southern-track')
            .map((f) => ({
              ...f,
              geometry: ['old-border', 'trade-road', 'old-road'].includes(f.id)
                ? coarse[f.id]
                : f.geometry,
            }))
        : features;
  const layers = [
    { id: 'terrain', name: '地形', purpose: 'terrain' as const, visibleByDefault: true },
    { id: 'political', name: '政治境界', purpose: 'political' as const, visibleByDefault: true },
    { id: 'relief', name: '山地・樹林記号', purpose: 'terrain' as const, visibleByDefault: true },
    { id: 'water', name: '河川・湖', purpose: 'terrain' as const, visibleByDefault: true },
    { id: 'routes', name: '街道', purpose: 'route' as const, visibleByDefault: true },
    { id: 'places', name: '集落', purpose: 'settlement' as const, visibleByDefault: true },
    { id: 'annotation', name: '地誌', purpose: 'annotation' as const, visibleByDefault: true },
  ];
  const result = validateFictionMap({
    ...createFictionMap(),
    coordinateSpace: {
      kind: 'local-plane',
      bounds: { minX: 0, minY: 0, maxX: 1000, maxY: 650 },
      unit: { name: 'map-unit' },
      yAxis: 'down',
    },
    layers,
    features: staged,
    namedViews: [
      {
        id: 'kingdom',
        name: '王国全図',
        extent: { minX: 0, minY: 0, maxX: 1000, maxY: 650 },
        visibleLayerIds: layers.map((l) => l.id),
      },
    ],
  });
  if (!result.ok) throw Error(JSON.stringify(result.diagnostic));
  return result.value;
}
export function settingDemoArtifact(stage: SettingDemoStage = 'detailed') {
  return createArtifact('fiction-map', '西風と交易の辺境国', settingDemoContent(stage));
}
