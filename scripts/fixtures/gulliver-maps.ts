/**
 * GV1 (docs/cad/gulliver-world.md): six editable Fiction Maps of Swift's Gulliver's Travels (1726,
 * public domain), drawn from the English text (Project Gutenberg #829) only. Each feature says
 * where it comes from in `category` (本文 = stated in the text, 推定 = derived from the text,
 * 創作 = the author's choice where the text is silent, 参考 = a rough real-world outline) and
 * gives the chapter and the reasoning in `description`. Not GIS, not a projection of the Earth.
 */
import { createArtifact } from '@editor-platform/artifact-core';
import {
  createFictionMap,
  validateFictionMap,
  type FictionMapContent,
  type FictionMapFeature,
  type FictionMapLayer,
  type FictionMapPoint,
} from '@editor-platform/fiction-map/model';

export const gulliverMapIds = [
  'voyages',
  'lilliput',
  'mildendo',
  'brobdingnag',
  'balnibarbi',
  'houyhnhnm',
] as const;
export type GulliverMapId = (typeof gulliverMapIds)[number];
export type GulliverBasis = '本文' | '推定' | '創作' | '参考';
export const gulliverBases: readonly GulliverBasis[] = ['本文', '推定', '創作', '参考'];

/** Lengths in the text, in metres (1 inch = 25.4 mm, 1 league taken as 3 miles). */
export const unitM = {
  inch: 0.0254,
  foot: 0.3048,
  yard: 0.9144,
  mile: 1609.344,
  league: 3 * 1609.344,
} as const;

type Spec = {
  title: string;
  unit: { name: string; distancePerUnit?: { value: number; unit: 'm' | 'km' } };
  bounds: [number, number, number, number];
  layers: [id: string, name: string, purpose: FictionMapLayer['purpose']][];
  views?: [id: string, name: string, bounds: [number, number, number, number]][];
  /** Draw a sea under everything (a display background; the text does not draw it). */
  sea?: boolean;
  /** Features whose labels would cover others in the whole view (named views and the Inspector show them). */
  quiet?: string[];
};

class MapBuilder {
  readonly features: FictionMapFeature[] = [];
  constructor(private readonly spec: Spec) {}
  private add(
    id: string,
    layerId: string,
    featureKind: FictionMapFeature['featureKind'],
    geometry: FictionMapFeature['geometry'],
    name: string,
    basis: GulliverBasis,
    description: string,
    color: string,
    lineWidth: number,
    label: boolean,
  ) {
    this.features.push({
      id,
      layerId,
      featureKind,
      geometry,
      name,
      category: basis,
      description,
      style: { color, lineWidth, label },
    });
  }
  region(
    id: string,
    layer: string,
    name: string,
    basis: GulliverBasis,
    description: string,
    outer: FictionMapPoint[],
    color = '#c9b98f',
    label = true,
    kind: 'region' | 'landform' = 'region',
  ) {
    this.add(
      id,
      layer,
      kind,
      { type: 'polygon', outer: [...outer, outer[0]] },
      name,
      basis,
      description,
      color,
      1,
      label,
    );
  }
  path(
    id: string,
    layer: string,
    name: string,
    basis: GulliverBasis,
    description: string,
    coordinates: FictionMapPoint[],
    color = '#8a5a3c',
    width = 2,
    label = false,
  ) {
    this.add(
      id,
      layer,
      'path',
      { type: 'polyline', coordinates },
      name,
      basis,
      description,
      color,
      width,
      label,
    );
  }
  place(
    id: string,
    layer: string,
    name: string,
    basis: GulliverBasis,
    description: string,
    at: FictionMapPoint,
    color = '#7a3b2e',
  ) {
    this.add(
      id,
      layer,
      'place',
      { type: 'point', coordinates: at },
      name,
      basis,
      description,
      color,
      1,
      true,
    );
  }
  build(): FictionMapContent {
    const [minX, minY, maxX, maxY] = this.spec.bounds;
    const layers = this.spec.layers.map(([id, name, purpose]) => ({
      id,
      name,
      purpose,
      visibleByDefault: true,
    }));
    const views = [
      ['overview', '全体図', this.spec.bounds] as const,
      ...(this.spec.views ?? []),
    ].map(([id, name, [a, b, c, d]]) => ({
      id,
      name,
      extent: { minX: a, minY: b, maxX: c, maxY: d },
      visibleLayerIds: layers.map((l) => l.id),
    }));
    const quiet = new Set(this.spec.quiet ?? []);
    const features = this.features.map((f) =>
      quiet.has(f.id) ? { ...f, style: { ...f.style, label: false } } : f,
    );
    if (this.spec.sea)
      features.unshift({
        id: 'sea',
        layerId: layers[0].id,
        featureKind: 'region',
        geometry: {
          type: 'polygon',
          outer: [
            [minX, minY],
            [maxX, minY],
            [maxX, maxY],
            [minX, maxY],
            [minX, minY],
          ],
        },
        name: '海',
        category: '創作',
        description: '表示のための背景の海（本文に無い）。',
        style: { color: '#9cc3d5', lineWidth: 1, label: false },
      });
    const result = validateFictionMap({
      ...createFictionMap(),
      coordinateSpace: {
        kind: 'local-plane',
        bounds: { minX, minY, maxX, maxY },
        unit: this.spec.unit,
        yAxis: 'up',
      },
      layers,
      features,
      namedViews: views,
    });
    if (!result.ok) throw Error(`${this.spec.title}: ${JSON.stringify(result.diagnostic)}`);
    return result.value;
  }
}

const r = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
/** A closed, star-shaped coastline: `radii` around `c`, evenly spaced from the east, counter-clockwise. */
function coast(c: FictionMapPoint, radii: number[], turn = 0, d = 1): FictionMapPoint[] {
  return radii.map((rad, i) => {
    const a = turn + (2 * Math.PI * i) / radii.length;
    return [r(c[0] + rad * Math.cos(a), d), r(c[1] + rad * Math.sin(a), d)];
  });
}
const square = (cx: number, cy: number, w: number, h = w): FictionMapPoint[] => [
  [cx - w / 2, cy - h / 2],
  [cx + w / 2, cy - h / 2],
  [cx + w / 2, cy + h / 2],
  [cx - w / 2, cy + h / 2],
];
const toward = (from: FictionMapPoint, deg: number, dist: number): FictionMapPoint => [
  r(from[0] + dist * Math.cos((deg * Math.PI) / 180)),
  r(from[1] + dist * Math.sin((deg * Math.PI) / 180)),
];
/** Perimeter of a closed ring (used by the GV1 checks). */
export function ringLength(ring: readonly FictionMapPoint[]) {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const [a, b] = [ring[i], ring[(i + 1) % ring.length]];
    s += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return s;
}

const colors = {
  sea: '#9cc3d5',
  land: '#d9cfa9',
  land2: '#cdd7a6',
  ref: '#bdbdbd',
  mountain: '#8b7355',
  river: '#4f8fb5',
  wall: '#6b5040',
  route1: '#b5523b',
  route2: '#3b6fb5',
  route3: '#7a4fb5',
  route4: '#3b8f5a',
  place: '#7a3b2e',
};

/** 1. The four voyages on one diagram of the latitudes and longitudes the text states. */
function voyages() {
  const m = new MapBuilder({
    title: '航海の全図',
    unit: { name: '度' },
    bounds: [0, -55, 260, 66],
    layers: [
      ['reference', '参考の輪郭（実在）', 'terrain'],
      ['lands', '本文の国々', 'political'],
      ['routes', '航路', 'route'],
      ['places', '地名・観測点', 'settlement'],
    ],
    views: [['pacific', '北太平洋（第2・3篇）', [120, 15, 245, 66]]],
    sea: true,
    quiet: ['lagado', 'maldonada'],
  });
  const note =
    '横は経度（ロンドンから東へ度）、縦は緯度。本文の度数を平面に並べただけの図式で、地球の投影ではない。距離・面積は正しくない。';
  m.region(
    'new-holland',
    'reference',
    'ニューホランド（オーストラリア）',
    '参考',
    `実在の大陸の概略の輪郭。${note}`,
    [
      [113, -22],
      [114, -34],
      [118, -35],
      [129, -32],
      [135, -35],
      [140, -38],
      [146, -39],
      [150, -37],
      [153, -28],
      [146, -19],
      [142, -11],
      [136, -12],
      [130, -12],
      [122, -17],
    ],
    colors.ref,
    true,
  );
  m.region(
    'van-diemen',
    'reference',
    'ヴァン・ディーメンズ・ランド',
    '参考',
    '実在（タスマニア）の概略。第1篇第1章で難破の基準に出る。',
    [
      [144.6, -40.7],
      [148.3, -40.9],
      [148, -43.2],
      [146, -43.6],
      [145, -42.2],
    ],
    colors.ref,
    true,
  );
  m.region(
    'japan',
    'reference',
    '日本',
    '参考',
    '実在の概略。第3篇第11章でガリヴァーはザモスキ（日本の南東の港）に上陸する。',
    [
      [130, 31],
      [131.5, 33.5],
      [135, 34],
      [139.8, 35],
      [141, 38],
      [141.5, 41.5],
      [140, 40.5],
      [139, 38],
      [136.5, 36.8],
      [133, 35.5],
      [130.9, 33.9],
    ],
    colors.ref,
    true,
  );
  m.region(
    'africa',
    'reference',
    'アフリカ南部',
    '参考',
    '実在の概略。喜望峰は第1・2篇の航海の寄港地。',
    [
      [9, -2],
      [12, -12],
      [13, -18],
      [17, -29],
      [18.4, -34.3],
      [20, -34.8],
      [25, -34],
      [32, -28],
      [35, -24],
      [40, -15],
      [42, -2],
    ],
    colors.ref,
    true,
  );
  m.region(
    'madagascar',
    'reference',
    'マダガスカル',
    '参考',
    '実在の概略。第2篇第1章「マダガスカル海峡を過ぎ」。',
    [
      [43.3, -25],
      [44, -17],
      [49.3, -12],
      [50.5, -15.5],
      [47, -25],
    ],
    colors.ref,
    false,
  );
  m.place(
    'cape',
    'places',
    '喜望峰',
    '本文',
    '第1篇第1章・第2篇第1章で寄港する（位置は実在）。',
    [18.4, -34.3],
  );
  m.place(
    'moluccas',
    'places',
    'モルッカ諸島の東',
    '本文',
    '第2篇第1章「モルッカ諸島の少し東、赤道の北約3度」へ嵐で流される（5月2日の観測）。',
    [130, 3],
  );
  m.place(
    'wreck-1',
    'places',
    '難破（南緯30度2分）',
    '本文',
    '第1篇第1章「ヴァン・ディーメンズ・ランドの北西…南緯30度2分」。経度は本文に無く、大陸の西の海に作者が置いた（経度110度）。',
    [110, -30.03],
  );
  m.region(
    'lilliput',
    'lands',
    'リリパット・ブレフスキュ',
    '推定',
    '難破の地点から泳ぎ着いた島。この図の縮尺では点に近い（周囲約12 miles、第1篇第3章）。',
    square(108.5, -31.2, 2.4, 1.6),
    colors.land,
    true,
  );
  m.place(
    'rescue-1',
    'places',
    '帰りの船（南緯30度）',
    '本文',
    '第1篇第8章「南緯30度で」英国の商船に拾われる。経度は本文に無い。',
    [101, -30],
  );
  m.region(
    'brobdingnag',
    'lands',
    'ブロブディンナグ',
    '推定',
    '第2篇第4章：日本とカリフォルニアの間の半島。北東は高さ30 milesの火山の山脈、他の三方は海。長さ約6,000 milesは、この図式では表せない（緯度で縮むため）。拾われた地点（北緯44度・経度143度、第2篇第8章）の北東の陸として作者が置いた（鷲が箱を海の上へ運んだ後に拾われたので、海岸から離して置いた）。',
    [
      [146, 50.0],
      [160, 48.5],
      [180, 49.0],
      [200, 51.0],
      [220, 54.0],
      [232, 58.0],
      [226, 63.5],
      [205, 62.0],
      [185, 60.5],
      [165, 58.0],
      [150, 55.0],
    ],
    colors.land2,
    true,
  );
  m.path(
    'brob-mountains',
    'lands',
    '北東の火山の山脈',
    '本文',
    '第2篇第4章「北東は高さ30 milesの山脈で区切られ、頂の火山のため越えられない」。',
    [
      [229, 56.0],
      [231, 59.0],
      [228, 62.5],
    ],
    colors.mountain,
    4,
  );
  m.place(
    'rescue-2',
    'places',
    '箱が拾われた地点（北緯44度・経度143）',
    '本文',
    '第2篇第8章「北東へ流され北緯44度、経度143に」。',
    [143, 44],
  );
  m.place(
    'pirates',
    'places',
    '海賊に襲われた地点（北緯46度・経度183）',
    '本文',
    '第3篇第1章「北緯46度、経度183」。南東にいくつかの島が見えた。',
    [183, 46],
  );
  m.region(
    'rock-island',
    'lands',
    '岩の島（ラピュータに拾われた所）',
    '推定',
    '第3篇第1章：海賊の地点から南東の島々。',
    square(186, 43.6, 1.6, 1.2),
    colors.land,
    false,
  );
  m.region(
    'balnibarbi',
    'lands',
    'バルニバービ',
    '推定',
    '第3篇第7章：大陸は東へカリフォルニアの西のアメリカへ続き、北は太平洋（ラガードから150 miles以内）。南西の港マルドナーダの北西にラグナグ。作者の配置。',
    [
      [150, 29],
      [160, 30],
      [178, 32],
      [196, 34],
      [212, 38],
      [214, 44],
      [205, 47.5],
      [189, 47.8],
      [188.5, 44.5],
      [186, 42.5],
      [182, 42.5],
      [180, 47.5],
      [170, 47],
      [158, 44],
      [151, 38],
      [147.5, 31.5],
    ],
    colors.land,
    true,
  );
  m.place(
    'lagado',
    'places',
    'ラガード',
    '推定',
    '第3篇第2・7章：バルニバービの首都。北の太平洋岸から150 miles以内。',
    [190.5, 46],
  );
  m.place(
    'maldonada',
    'places',
    'マルドナーダ',
    '推定',
    '第3篇第7章：港。ラグナグはその北西。位置は作者の配置。',
    [150, 29.2],
  );
  m.place(
    'luggnagg',
    'places',
    'ラグナグ（北緯29度・経度140）',
    '本文',
    '第3篇第7章「北緯約29度、経度140」、日本の南東約100 leagues。',
    [140, 29],
  );
  m.place(
    'xamoschi',
    'places',
    'ザモスキ（日本）',
    '本文',
    '第3篇第11章：日本の南東の小さな港町。位置は作者の概略。',
    [139.5, 34.8],
  );
  m.place(
    'houyhnhnm-at',
    'places',
    '置き去りにされた地点（推定 南緯45度）',
    '本文',
    '第4篇第11章「喜望峰の南10度、南緯約45度と思った」（水夫の話から、本人も確かでない）。経度は本文に無い。',
    [100, -45],
  );
  m.region(
    'houyhnhnm',
    'lands',
    'フウイヌム国',
    '推定',
    '第4篇第11章：ここからカヌーで出て、ニューホランドの南東の点に着いた（本文のまま）。本文の位置は互いに合わないので、作者はニューホランドの南西の沖に置いた。',
    square(107, -40, 4, 3),
    colors.land2,
    true,
  );
  m.path(
    'voyage-1',
    'routes',
    '第1篇の航海',
    '推定',
    '喜望峰→東インドへ→ヴァン・ディーメンズ・ランドの北西で難破（第1篇第1章）。',
    [
      [18.4, -34.3],
      [50, -33],
      [85, -31],
      [110, -30.03],
    ],
    colors.route1,
    2,
  );
  m.path(
    'voyage-2',
    'routes',
    '第2篇の航海',
    '推定',
    '喜望峰→マダガスカル海峡→南緯5度→嵐でモルッカの東・北緯3度→さらに流され陸へ（第2篇第1章）。帰りは北緯44度で拾われ、ニューホランドの沿岸を通って喜望峰へ（第2篇第8章）。',
    [
      [18.4, -34.3],
      [42, -20],
      [52, -5],
      [90, 1],
      [130, 3],
      [145, 20],
      [150, 50],
      [143, 44],
      [135, 20],
      [115, -5],
      [113, -36],
      [60, -38],
      [18.4, -34.3],
    ],
    colors.route2,
    2,
  );
  m.path(
    'voyage-3',
    'routes',
    '第3篇の航海',
    '推定',
    '海賊（北緯46度・経度183）→岩の島→ラピュータでラガードへ→マルドナーダ→グラブダブドリッブ→ラグナグ→日本（第3篇）。',
    [
      [183, 46],
      [186, 43.6],
      [190.5, 46],
      [150, 29.2],
      [148.5, 28.5],
      [150, 29.2],
      [140, 29],
      [139.5, 34.8],
    ],
    colors.route3,
    2,
  );
  m.path(
    'voyage-4',
    'routes',
    '第4篇の航海',
    '推定',
    '喜望峰の南で置き去り（南緯約45度）→フウイヌム国→カヌーでニューホランドの南東の点へ（第4篇第1・11章）。',
    [
      [18.4, -34.3],
      [60, -42],
      [100, -45],
      [107, -40],
      [140, -38.5],
      [150, -37],
    ],
    colors.route4,
    2,
  );
  return m.build();
}

/** 2. Lilliput and Blefuscu in metres. */
function lilliput() {
  const m = new MapBuilder({
    title: 'リリパットとブレフスキュ',
    unit: { name: 'm', distancePerUnit: { value: 1, unit: 'm' } },
    bounds: [0, 0, 16_000, 15_000],
    layers: [
      ['land', '島', 'terrain'],
      ['political', '国', 'political'],
      ['routes', '道・航跡', 'route'],
      ['places', '町・場所', 'settlement'],
    ],
    views: [['landing', '上陸から首都まで', [3_000, 2_500, 5_200, 4_500]]],
    sea: true,
    quiet: ['mildendo', 'lilliput-state'],
  });
  // 12 miles round (第1篇第3章「5,000 blustrugs、周囲約12 miles」): a ring of radius ≈ 19,312 / 2π.
  const lc: FictionMapPoint = [5_500, 5_000];
  const lr = (12 * unitM.mile) / (2 * Math.PI);
  const lilliputRing = coast(
    lc,
    [1, 0.97, 1, 1.03, 0.96, 1.04, 0.98, 1.02, 1, 0.97, 1.03, 1, 0.98, 1.02, 0.97, 1.03].map((k) =>
      r(k * lr),
    ),
  );
  m.region(
    'lilliput-island',
    'land',
    'リリパット',
    '本文',
    `第1篇第3章「領土は5,000 blustrugs（周囲約12 miles）」。周囲${Math.round(ringLength(lilliputRing))} m。形は作者の創作。`,
    lilliputRing,
    colors.land,
    true,
  );
  // The channel: 800 yards to the north-east (第1篇第5章).
  // Both ends of the channel are coast vertices: Lilliput's at 45° (index 2, radius lr) and
  // Blefuscu's at 225° (index 7 of a ring turned by 15°, radius 2,600 m).
  const ne = lilliputRing[2];
  const channel = 800 * unitM.yard;
  const bc = toward(ne, 45, channel + 2_600);
  const blefuscuRadii = Array.from({ length: 12 }, (_, i) =>
    i === 7 ? 2_600 : 2_600 * (i % 2 ? 0.95 : 1.05),
  );
  const bShore = coast(bc, blefuscuRadii, Math.PI / 12)[7];
  m.region(
    'blefuscu-island',
    'land',
    'ブレフスキュ',
    '本文',
    '第1篇第5章「リリパットの北東、幅800 yardsの海峡で隔てられた島」。大きさは本文に無く、作者の創作（半径2.6 km）。',
    coast(bc, blefuscuRadii, Math.PI / 12),
    colors.land2,
    true,
  );
  m.path(
    'channel',
    'routes',
    '海峡（幅800 yards）',
    '本文',
    `第1篇第5章：幅800 yards（${r(channel)} m）、中央の深さは満潮で70 glumgluffs（約6 feet）。`,
    [ne, bShore],
    colors.sea,
    6,
    true,
  );
  // From where Gulliver woke to the capital: half a mile (第1篇第1章).
  const shore = toward(lc, 225, lr * 0.98);
  const lay = toward(shore, 45, 0.5 * unitM.mile);
  const mildendo = toward(lay, 45, 0.5 * unitM.mile);
  m.place(
    'shore',
    'places',
    '泳ぎ着いた浜',
    '推定',
    '第1篇第1章：浜から内陸へ約半mile歩いて眠った。浜の位置は作者の選択（南西岸）。',
    shore,
  );
  m.place(
    'woke',
    'places',
    'ガリヴァーが縛られて目覚めた所',
    '本文',
    '第1篇第1章：首都から約半mile。',
    lay,
  );
  m.region(
    'mildendo',
    'places',
    'ミルデンドウ（首都）',
    '本文',
    '第1篇第4章：一辺500 feet（152.4 m）の正方形の城壁。詳しくは「ミルデンドウ」の地図。',
    square(mildendo[0], mildendo[1], 500 * unitM.foot),
    colors.wall,
    true,
  );
  const westGate: FictionMapPoint = [r(mildendo[0] - 250 * unitM.foot), mildendo[1]];
  const temple: FictionMapPoint = [r(westGate[0] - 200 * unitM.yard), mildendo[1]];
  m.place(
    'temple',
    'places',
    '古い神殿（ガリヴァーの宿）',
    '本文',
    '第1篇第1章：城門から200 yardsの所で運搬機が止まり、そこに古い神殿があった。どの門かは本文に無く、西門の外に作者が置いた。',
    temple,
  );
  m.path(
    'engine-route',
    'routes',
    '運搬機の道（馬1,500頭）',
    '本文',
    '第1篇第1章：木の枠の運搬機（車輪22）を馬1,500頭が引き、約半mile先の首都へ。',
    [lay, toward(lay, 30, 400), temple],
    colors.route1,
    2,
  );
  // North-east coast, the fleet, the royal ports (第1篇第5章).
  const hillock = toward(lc, 35, lr - 150);
  m.place(
    'hillock',
    'places',
    '北東岸の小山',
    '本文',
    '第1篇第5章：ここに伏せて望遠鏡で敵の艦隊（軍艦約50隻）を見た。',
    hillock,
  );
  // At anchor in the channel, 150 m off Blefuscu's shore (the text does not say how far).
  const fleet = toward(bShore, 225, 150);
  m.place(
    'fleet',
    'places',
    'ブレフスキュの艦隊の停泊地',
    '本文',
    '第1篇第5章：軍艦約50隻と輸送船多数。50本の綱と鉤で引いた。',
    fleet,
    colors.route2,
  );
  const lPort = toward(lc, 60, lr);
  m.place(
    'lilliput-port',
    'places',
    'リリパットの王の港',
    '本文',
    '第1篇第5章：艦隊を引いて歩いて渡り、王の港に着いた。北東岸のどこかは本文に無い（作者の選択）。',
    lPort,
  );
  m.path(
    'fleet-route',
    'routes',
    '艦隊を引いて渡った道',
    '本文',
    '第1篇第5章：満潮の半時間前に海へ入り、泳ぎと徒歩で渡り、綱で艦隊を引いて王の港へ。',
    [hillock, fleet, lPort],
    colors.route2,
    2,
  );
  const bPort = toward(bc, 210, 2_500);
  m.place(
    'blefuscu-port',
    'places',
    'ブレフスキュの王の港',
    '本文',
    '第1篇第7章：歩きと泳ぎで渡り着いた。',
    bPort,
  );
  m.place(
    'blefuscu-city',
    'places',
    'ブレフスキュ（首都）',
    '本文',
    '第1篇第7章：首都は国と同じ名。位置は作者の選択。',
    bc,
  );
  m.place(
    'boat',
    'places',
    '流れ着いたボート',
    '本文',
    '第1篇第8章：ブレフスキュの北東岸の沖約半league（3 milesのleagueで約2.4 km）に見えた。',
    toward(bc, 45, 2_600 + 0.5 * unitM.league),
  );
  m.region(
    'lilliput-state',
    'political',
    'リリパット帝国',
    '推定',
    '島全体（第1篇第3章）。',
    lilliputRing.map(([x, y]) => [r(lc[0] + (x - lc[0]) * 0.99), r(lc[1] + (y - lc[1]) * 0.99)]),
    '#e6b0a0',
    false,
  );
  return m.build();
}

/** 3. Mildendo, the capital, in feet. */
function mildendo() {
  const m = new MapBuilder({
    title: 'ミルデンドウ',
    unit: { name: 'foot', distancePerUnit: { value: unitM.foot, unit: 'm' } },
    bounds: [0, 0, 1_300, 800],
    layers: [
      ['ground', '地面', 'terrain'],
      ['walls', '城壁・門・塔', 'political'],
      ['streets', '大通り', 'route'],
      ['blocks', '街区・建物', 'settlement'],
      ['notes', '注記', 'annotation'],
    ],
    views: [['palace', '王宮', [860, 310, 1_040, 490]]],
    quiet: ['quarter-ne', 'quarter-nw', 'quarter-sw', 'quarter-se', 'gate-north', 'gate-south'],
  });
  const c: FictionMapPoint = [950, 400];
  const half = 250;
  const [x0, y0, x1, y1] = [c[0] - half, c[1] - half, c[0] + half, c[1] + half];
  m.region(
    'wall',
    'walls',
    '城壁（一辺500 feet）',
    '本文',
    '第1篇第4章「町は正確な正方形で、城壁の一辺は500 feet」。壁の高さ2.5 feet・幅11 inches以上で、馬車で上を回れる。',
    square(c[0], c[1], 2 * half),
    colors.wall,
    false,
  );
  for (const [id, name, x, y] of [
    ['tower-sw', '塔（南西の角）', x0, y0],
    ['tower-se', '塔（南東の角）', x1, y0],
    ['tower-ne', '塔（北東の角）', x1, y1],
    ['tower-nw', '塔（北西の角）', x0, y1],
  ] as const)
    m.place(
      id,
      'walls',
      name,
      '本文',
      '第1篇第4章：城壁は10 feetごとの強い塔で守られる（全部で200基。地図には角の4基だけ）。',
      [x, y],
      colors.wall,
    );
  m.place(
    'gate-west',
    'walls',
    '大きな西門',
    '本文',
    '第1篇第4章：ガリヴァーは西の大門をまたいで入った。',
    [x0, c[1]],
    colors.wall,
  );
  for (const [id, name, at] of [
    ['gate-north', '北門', [c[0], y1]],
    ['gate-east', '東門', [x1, c[1]]],
    ['gate-south', '南門', [c[0], y0]],
  ] as const)
    m.place(
      id,
      'walls',
      name,
      '推定',
      '十字の大通りの端に門があると作者が推定した（本文には西門だけで、他の門は本文に無い）。',
      at as FictionMapPoint,
      colors.wall,
    );
  m.region(
    'street-ns',
    'streets',
    '南北の大通り（幅5 feet）',
    '本文',
    '第1篇第4章「町を四つに分ける二本の大通りは幅5 feet」。',
    [
      [c[0] - 2.5, y0],
      [c[0] + 2.5, y0],
      [c[0] + 2.5, y1],
      [c[0] - 2.5, y1],
    ],
    '#a08060',
    false,
  );
  m.region(
    'street-ew',
    'streets',
    '東西の大通り（幅5 feet）',
    '本文',
    '第1篇第4章。',
    [
      [x0, c[1] - 2.5],
      [x1, c[1] - 2.5],
      [x1, c[1] + 2.5],
      [x0, c[1] + 2.5],
    ],
    '#a08060',
    false,
  );
  const q = half - 2.5;
  for (const [id, name, sx, sy] of [
    ['quarter-ne', '北東の街区', 1, 1],
    ['quarter-nw', '北西の街区', -1, 1],
    ['quarter-sw', '南西の街区', -1, -1],
    ['quarter-se', '南東の街区', 1, -1],
  ] as const)
    m.region(
      id,
      'blocks',
      name,
      '本文',
      '第1篇第4章：家は3〜5階、店と市場はよく整い、50万人が住める。路地は幅12〜18 inchesで、ガリヴァーは入れなかった。',
      square(c[0] + sx * (2.5 + q / 2 + 6), c[1] + sy * (2.5 + q / 2 + 6), q - 12),
      '#e3d3b4',
      true,
    );
  // The palace (第1篇第4章): outward court 40 ft square; a 2 ft wall 20 ft from the buildings.
  m.region(
    'palace-wall',
    'walls',
    '王宮の囲い（高さ2 feet）',
    '本文',
    '第1篇第4章「建物から20 feet離れた高さ2 feetの壁で囲む」。建物の幅は本文に無く、作者は20 feetとした（囲いは120 feet四方）。',
    square(c[0], c[1], 120),
    colors.wall,
    false,
  );
  m.region(
    'palace',
    'blocks',
    '王宮（皇帝の宮殿）',
    '本文',
    '第1篇第4章：二本の大通りが交わる町の中心。外庭は40 feet四方で、その中にさらに二つの庭、いちばん内側に王の住まい。',
    square(c[0], c[1], 80),
    '#c58f6b',
    true,
  );
  m.region(
    'outer-court',
    'blocks',
    '外庭（40 feet四方）',
    '本文',
    '第1篇第4章。ガリヴァーは王の庭の木で作った高さ約3 feetの腰掛け2つを使って建物をまたぎ、第1と第2の庭の間（幅8 feet）に下ろして内庭へ進んだ。',
    square(c[0], c[1], 40),
    '#efe2c8',
    false,
  );
  const temple: FictionMapPoint = [x0 - 600, c[1]];
  m.region(
    'temple',
    'blocks',
    '古い神殿（ガリヴァーの宿）',
    '本文',
    '第1篇第1章：城門から200 yards（600 feet）。国で最大の神殿だが、殺人があって使われなくなっていた。平面の大きさは本文に無い（作者は40×30 feet）。',
    square(temple[0], temple[1], 40, 30),
    '#c58f6b',
    true,
  );
  m.place(
    'temple-gate',
    'blocks',
    '神殿の大門（高さ4 feet・幅2 feet弱、北向き）',
    '本文',
    '第1篇第1章：ここを這って出入りした。左の小窓（地面から6 inches以下）から91本の鎖で左脚をつながれた。',
    [temple[0], temple[1] + 15],
  );
  m.path(
    'temple-road',
    'streets',
    '神殿から西門への道',
    '推定',
    '第1篇第1章：神殿と城門の間（200 yards）。道の形は作者の選択。',
    [
      [temple[0], temple[1] + 15],
      [temple[0], temple[1] + 40],
      [x0 - 60, c[1] + 40],
      [x0, c[1]],
    ],
    '#a08060',
    2,
  );
  m.path(
    'gulliver-walk',
    'notes',
    'ガリヴァーの歩いた道',
    '本文',
    '第1篇第4章：西門をまたぎ、二本の大通りを横向きにそっと歩いて中心の王宮へ。',
    [
      [x0 - 30, c[1] - 12],
      [c[0] - 60, c[1] - 12],
    ],
    colors.route1,
    1.5,
  );
  return m.build();
}

/** 4. Brobdingnag and Lorbrulgrud, in miles. */
function brobdingnag() {
  const m = new MapBuilder({
    title: 'ブロブディンナグ',
    unit: { name: 'mile', distancePerUnit: { value: unitM.mile / 1000, unit: 'km' } },
    bounds: [0, 0, 7_400, 5_600],
    layers: [
      ['land', '国土・山脈', 'terrain'],
      ['water', '川', 'terrain'],
      ['routes', '旅の道', 'route'],
      ['places', '都市・場所', 'settlement'],
    ],
    views: [['capital', 'ロルブルグラッド', [3_560, 2_540, 3_720, 2_660]]],
    sea: true,
    quiet: ['palace', 'temple-tower', 'seaside'],
  });
  // A peninsula about 6,000 miles long and 3,000–5,000 broad (第2篇第4章), long axis SW→NE.
  const land: FictionMapPoint[] = [
    [400, 1_600],
    [1_400, 500],
    [3_000, 300],
    [4_600, 900],
    [6_000, 1_900],
    [6_900, 3_000],
    [6_700, 4_300],
    [5_800, 5_100],
    [4_300, 5_000],
    [2_900, 4_600],
    [1_500, 3_800],
    [600, 2_800],
  ];
  m.region(
    'brobdingnag',
    'land',
    'ブロブディンナグ',
    '本文',
    '第2篇第4章「領土は長さ約6,000 miles、幅3,000〜5,000 miles」の半島。輪郭は作者の創作（長さ約6,500 miles）。',
    land,
    colors.land2,
    true,
  );
  m.path(
    'ne-mountains',
    'land',
    '北東の山脈（高さ30 miles）',
    '本文',
    '第2篇第4章：頂に火山があり越えられない。その向こうに誰が住むかは学者も知らない。',
    [
      [6_900, 3_000],
      [6_700, 4_300],
      [5_800, 5_100],
    ],
    colors.mountain,
    6,
    true,
  );
  m.place(
    'farm',
    'places',
    '農夫の家（最初の主人）',
    '本文',
    '第2篇第1・2章：首都から約3,000 miles。海岸の近くに上陸し、麦畑で刈り手に見つかった。国に港は一つも無い（第2篇第4章）。位置は作者の選択（南西の海岸寄り）。',
    [900, 1_500],
  );
  const city: FictionMapPoint = [3_640, 2_600];
  m.region(
    'lorbrulgrud',
    'places',
    'ロルブルグラッド（首都）',
    '本文',
    '第2篇第4章：国のほぼ中央。長さ3 glomglungs（約54 miles）・幅2.5（約45 miles）、家8万以上・人口60万。',
    [
      [city[0] - 27, city[1] - 22.5],
      [city[0] + 27, city[1] - 22.5],
      [city[0] + 27, city[1] + 22.5],
      [city[0] - 27, city[1] + 22.5],
    ],
    '#d9a07a',
    true,
  );
  m.path(
    'city-river',
    'water',
    '首都を流れる川',
    '本文',
    '第2篇第4章：町は川の両岸にほぼ等しく分かれる。川の流れの向きは作者の選択。',
    [
      [city[0] - 60, city[1] - 50],
      [city[0] - 10, city[1] - 5],
      [city[0] + 10, city[1] + 8],
      [city[0] + 60, city[1] + 45],
    ],
    colors.river,
    2,
  );
  m.place(
    'palace',
    'places',
    '王宮（周囲約7 miles）',
    '本文',
    '第2篇第4章：規則的な建物でなく建物の集まり。主な部屋の高さは240 feet。',
    [city[0] + 8, city[1] + 6],
  );
  m.place(
    'temple-tower',
    'places',
    '寺院の塔（3,000 feet）',
    '本文',
    '第2篇第4章：国で最も高い塔だが3,000 feetを超えない。',
    [city[0] - 12, city[1] - 8],
  );
  m.path(
    'journey',
    'routes',
    '首都への旅（10週間）',
    '本文',
    '第2篇第2章：8月17日に出発、10週間で18の大きな町と多くの村で見せ物にされ、10月26日に首都へ。幅がナイルやガンジスより広い川を5〜6本渡った。道筋は作者の選択。',
    [[900, 1_500], [1_500, 1_650], [2_100, 1_900], [2_700, 2_150], [3_200, 2_400], city],
    colors.route1,
    2,
  );
  const rivers: FictionMapPoint[][] = [
    [
      [1_200, 900],
      [1_350, 1_700],
      [1_200, 2_600],
    ],
    [
      [1_900, 700],
      [1_800, 1_900],
      [2_000, 3_200],
    ],
    [
      [2_600, 600],
      [2_500, 2_100],
      [2_700, 3_600],
    ],
    [
      [3_300, 700],
      [3_000, 2_300],
      [3_200, 4_000],
    ],
    [
      [3_900, 1_000],
      [3_700, 2_000],
      [city[0] - 60, city[1] - 50],
    ],
  ];
  for (const [i, pts] of rivers.entries())
    m.path(
      `river-${i + 1}`,
      'water',
      `大河 ${i + 1}`,
      '本文',
      '第2篇第2章：旅で渡った5〜6本の大河の一つ。流路は作者の創作。',
      pts,
      colors.river,
      2.5,
    );
  // On the north-west shore (from [1500, 3800] to [2900, 4600]), 12 miles inland.
  const shoreAt: FictionMapPoint = [2_200, 4_200];
  const flan = toward(shoreAt, (Math.atan2(-1_400, 800) * 180) / Math.PI, 12);
  m.place(
    'flanflasnic',
    'places',
    'フランフラスニック',
    '本文',
    '第2篇第8章：王の離宮がある町。海岸から18 miles以内。どの海岸かは本文に無い（作者は北西岸）。',
    flan,
  );
  m.place(
    'seaside',
    'places',
    '鷲が箱をさらった海岸',
    '本文',
    '第2篇第8章：小姓が箱を海辺の岩に置き、鷲が箱の環をくわえて飛び去った。',
    shoreAt,
  );
  return m.build();
}

/** 5. Balnibarbi and the flight of Laputa, in miles. */
function balnibarbi() {
  const m = new MapBuilder({
    title: 'バルニバービとラピュータの航路',
    unit: { name: 'mile', distancePerUnit: { value: unitM.mile / 1000, unit: 'km' } },
    bounds: [0, 0, 900, 640],
    layers: [
      ['land', '陸と海', 'terrain'],
      ['dominions', 'ラピュータの王の領土', 'political'],
      ['routes', '島と船の航路', 'route'],
      ['places', '町・場所', 'settlement'],
    ],
    views: [['lagado', 'ラガードの周り', [540, 420, 640, 500]]],
    sea: true,
    quiet: ['academy', 'ruined-mill'],
  });
  const lagado: FictionMapPoint = [580, 460];
  // The Pacific shore lies within 150 miles north of Lagado (第3篇第7章).
  const north = lagado[1] + 150;
  m.region(
    'balnibarbi',
    'land',
    'バルニバービ',
    '本文',
    '第3篇第7章：大陸は東へカリフォルニアの西の未知のアメリカへ続き、北は太平洋でラガードから150 miles以内。輪郭は作者の創作。',
    [
      [300, 500],
      [420, 420],
      [480, 300],
      [600, 180],
      [880, 120],
      [880, north],
      [700, north - 10],
      [520, north + 5],
      [380, north - 30],
    ],
    colors.land,
    true,
  );
  m.region(
    'dominions',
    'dominions',
    'ラピュータの王の領土',
    '本文',
    '第3篇第3章：島は王の領土の外へは動けない。境界は作者の創作。',
    [
      [300, 300],
      [420, 250],
      [600, 160],
      [860, 140],
      [860, north - 20],
      [520, north - 15],
      [330, 540],
      [280, 420],
    ],
    '#e6b0a0',
    false,
  );
  m.place(
    'lagado',
    'places',
    'ラガード（首都）',
    '本文',
    '第3篇第4章：家は奇妙に建てられ、多くが壊れかけ。人々は急ぎ足で、ぼろを着ていた。',
    lagado,
  );
  m.place(
    'academy',
    'places',
    'ラガードの学士院',
    '本文',
    '第3篇第5章：少なくとも500の部屋に計画者がいる。20 feet四方の文章を作る枠もここ。',
    [lagado[0] + 3, lagado[1] - 2],
  );
  // Laputa flew north-east by east to the point over Lagado, about 90 leagues (第3篇第2章).
  const bearing = 90 - 56.25; // NE by E is 56¼° east of north.
  const start = toward(lagado, 180 + bearing, 90 * 3);
  m.place(
    'laputa-start',
    'places',
    'ラピュータがガリヴァーを拾った所',
    '推定',
    '第3篇第2章「ラガードへ北東微東に約90 leagues、4日半」から逆算した位置（leagueは3 milesと仮定）。',
    start,
  );
  m.path(
    'laputa-flight',
    'routes',
    'ラピュータの航路（4日半）',
    '本文',
    '第3篇第2章：北東微東へ約90 leagues。途中、町や村の上で止まって請願を受けた（糸で降ろす）。動いている感じはまったくしなかった。',
    [start, toward(start, bearing, 90), toward(start, bearing, 180), lagado],
    colors.route3,
    2.5,
    true,
  );
  m.place(
    'pacific-port',
    'places',
    '北岸の良港',
    '本文',
    '第3篇第7章：太平洋岸の良い港でラグナグと交易。ラガードから150 miles以内。',
    [lagado[0] + 40, north - 6],
  );
  const munodi = toward(lagado, -40, 20);
  m.place(
    'munodi',
    'places',
    'ムノーディ卿の田舎の屋敷',
    '本文',
    '第3篇第4章：ラガードから約20 miles。領地に入るとぶどう畑・麦畑・牧草地が広がり、周りの荒れた土地と違った。方角は本文に無い（作者の選択）。',
    munodi,
  );
  m.place(
    'ruined-mill',
    'places',
    '山腹の壊れた水車小屋',
    '本文',
    '第3篇第4章：屋敷から約3 milesの山腹。もとは家の半mile以内の水車を、学士院の計画で山の上へ移して失敗した。',
    toward(munodi, 30, 3),
  );
  const maldonada: FictionMapPoint = [360, 460];
  m.place(
    'maldonada',
    'places',
    'マルドナーダ（港）',
    '本文',
    '第3篇第7章：ポーツマスほどの大きさの港。ラグナグ行きの船を待った。位置は作者の選択（南西岸）。',
    maldonada,
  );
  const glubb = toward(maldonada, 225, 5 * 3);
  m.region(
    'glubbdubdrib',
    'land',
    'グラブダブドリッブ',
    '本文',
    '第3篇第7章：マルドナーダの南西約5 leaguesの小島。魔術師の島で、ワイト島の約3分の1の大きさ（形は作者の創作）。',
    coast(glubb, [4, 3.6, 4.2, 3.8, 4, 3.5]),
    colors.land2,
    true,
  );
  m.path(
    'to-glubb',
    'routes',
    'グラブダブドリッブへの船',
    '本文',
    '第3篇第7章：小さな帆船で往復。',
    [maldonada, glubb],
    colors.route2,
    1.5,
  );
  m.path(
    'to-maldonada',
    'routes',
    'ラガードからマルドナーダへ',
    '本文',
    '第3篇第7章：何事もない旅だった。道筋は作者の選択。',
    [lagado, [470, 470], maldonada],
    colors.route1,
    1.5,
  );
  m.path(
    'to-luggnagg',
    'routes',
    'ラグナグへ（北西）',
    '本文',
    '第3篇第7章：ラグナグはマルドナーダの北西。この図の外。',
    [maldonada, toward(maldonada, 135, 100)],
    colors.route2,
    1.5,
  );
  return m.build();
}

/** 6. The country of the Houyhnhnms, in miles. */
function houyhnhnm() {
  const m = new MapBuilder({
    title: 'フウイヌム国',
    unit: { name: 'mile', distancePerUnit: { value: unitM.mile / 1000, unit: 'km' } },
    bounds: [0, 0, 40, 28],
    sea: true,
    quiet: ['kennel'],
    layers: [
      ['land', '陸', 'terrain'],
      ['routes', '道', 'route'],
      ['places', '場所', 'settlement'],
    ],
  });
  m.region(
    'land',
    'land',
    'フウイヌム国（ガリヴァーが歩いた範囲）',
    '創作',
    '第4篇：国の大きさ・形は本文に無い。作者の創作。',
    [
      [3, 3],
      [14, 1.5],
      [27, 2.5],
      [37, 5],
      [38.5, 14],
      [35, 24],
      [22, 26.5],
      [9, 25],
      [2, 17],
    ],
    colors.land2,
    true,
  );
  const beach: FictionMapPoint = [4, 6];
  m.place(
    'beach',
    'places',
    '置き去りにされた浜',
    '本文',
    '第4篇第1章：船員にボートで浜へ降ろされた。',
    beach,
  );
  const field: FictionMapPoint = [7, 8.5];
  m.place(
    'yahoo-field',
    'places',
    'ヤフーに出会った野',
    '本文',
    '第4篇第1章：木の多い道で、ヤフーの群れに囲まれ、木に寄って身を守った。',
    field,
  );
  m.place(
    'grey',
    'places',
    '灰色の馬（後の主人）に会った所',
    '本文',
    '第4篇第1章：ヤフーが急に逃げ、灰色の馬が現れた。',
    [8.5, 9.2],
  );
  const house = toward([8.5, 9.2], 25, 3);
  m.place(
    'house',
    'places',
    '主人の家（枝を編んだ長い建物）',
    '本文',
    '第4篇第2章：約3 miles歩いて着いた。地面に立てた木に枝を編み渡した長い建物で、屋根は低く藁葺き。',
    house,
  );
  m.place(
    'kennel',
    'places',
    'ヤフーの犬小屋',
    '本文',
    '第4篇第2章：家から少し離れた所。そこからろばの肉を持って来た。距離は作者の選択。',
    toward(house, -60, 0.2),
  );
  m.path(
    'walk',
    'routes',
    '主人の家までの道（約3 miles）',
    '本文',
    '第4篇第1・2章。道筋は作者の選択。',
    [[8.5, 9.2], toward([8.5, 9.2], 10, 1.5), house],
    colors.route4,
    2,
  );
  const creek: FictionMapPoint = [37.6, 9];
  m.place(
    'departure',
    'places',
    'カヌーで出発した浜',
    '本文',
    '第4篇第10・11章：6週間でヤフーの皮で覆ったカヌーを作り、主人の家の近くの池で試してから出た。浜の位置は作者の選択（東岸）。',
    creek,
  );
  m.path(
    'to-departure',
    'routes',
    '出発の浜への道',
    '創作',
    '本文に無い。',
    [house, [20, 12], [30, 10], creek],
    colors.route4,
    1.5,
  );
  return m.build();
}

const builders: Record<GulliverMapId, () => FictionMapContent> = {
  voyages,
  lilliput,
  mildendo,
  brobdingnag,
  balnibarbi,
  houyhnhnm,
};
export const gulliverMapTitles: Record<GulliverMapId, string> = {
  voyages: '航海の全図',
  lilliput: 'リリパットとブレフスキュ',
  mildendo: 'ミルデンドウ',
  brobdingnag: 'ブロブディンナグ',
  balnibarbi: 'バルニバービとラピュータの航路',
  houyhnhnm: 'フウイヌム国',
};
export function gulliverMapContent(id: GulliverMapId): FictionMapContent {
  return builders[id]();
}
export function gulliverMapArtifact(id: GulliverMapId) {
  return createArtifact('fiction-map', gulliverMapTitles[id], gulliverMapContent(id));
}
