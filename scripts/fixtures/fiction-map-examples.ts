/** Authored briefs; editable native geometry, not GIS, simulation or a built-in generator. */
import { stationDistrictContent } from './fiction-map-station-district';
import { createArtifact } from '@editor-platform/artifact-core';
import {
  createFictionMap,
  validateFictionMap,
  type FictionMapFeature,
  type FictionMapPoint,
} from '@editor-platform/fiction-map/model';

export const exampleIds = [
  'agriculture',
  'residential',
  'downtown',
  'medieval',
  'station',
] as const;
export type MapExample = (typeof exampleIds)[number];
export const exampleStages = ['rough', 'structure', 'detailed'] as const;
export type ExampleStage = (typeof exampleStages)[number];
export const exampleBriefs = {
  station: {
    title: '星谷駅周辺 — 渋谷風の繁華街',
    brief:
      '駅西口の交差点から商店街と坂道が放射状に広がる街。実在の渋谷を測量再現した地図ではありません。',
    structure:
      '幹線と線路を先に置き、駅ビル・横路地・公園を接続。西の丘と東の谷で街区の形を変える。',
    detail:
      '細い敷地に沿うビル、3方向の横断歩道、ホーム・軌道・植栽を追加し、均一な碁盤目を避ける。',
    edit: '西口の待ち合わせ位置を歩行者広場内で動かし、駅と交差点への動線を確認。',
    landmark: '西口待ち合わせ広場',
    landmarkId: 'meeting',
    position: [540, 365],
  },
  agriculture: {
    title: '川沿いの農耕地帯',
    brief: '川の低地は畑と用水路、少し高い段丘に集落。市場へ続く道と農地の関係から作る。',
    structure: '川から用水を引き、農道で区画を結ぶ。集落は川から離れた段丘側へ。',
    detail: '畝・果樹園・納屋・橋を追加。四角を並べる前に、水と搬出路のつながりを決める。',
    edit: '集落の市場を北へ移し、畑から橋へ抜ける道との関係を調整。',
    landmark: '段丘の市場',
    landmarkId: 'market',
    position: [720, 330],
  },
  residential: {
    title: '水辺の住宅街',
    brief: '幹線道路の内側に静かな生活道路。学校・公園・商店を徒歩圏でつなぐ住宅地を考える。',
    structure: '通過交通は外周へ。内側の道を公園・学校・駅前へつなぎ、川沿いを緑地として残す。',
    detail: '敷地・家屋・並木・遊歩道を追加。同じ区画でも建物の向きと余白に変化をつける。',
    edit: '公園入口を生活道路側へ移し、住宅街から歩いて入れる位置を調整。',
    landmark: '中央公園入口',
    landmarkId: 'park-entry',
    position: [550, 340],
  },
  downtown: {
    title: '駅と川を結ぶ都心',
    brief: '駅前から川へ続く軸、業務街区と広場、裏通りを重ねる。建物より先に都市の骨格を置く。',
    structure: '駅前大通りと横街路で街区を分け、川側の歩行空間と広場を確保。',
    detail: '大小の建物平面・中庭・路地・街路樹を追加。密度の高い都心と開けた公共空間を対比。',
    edit: '広場の案内所を駅からの動線上へ移し、広場中央の見通しを空ける。',
    landmark: '中央広場案内所',
    landmarkId: 'plaza-info',
    position: [520, 330],
  },
  medieval: {
    title: '渡河交易で育った中世都市',
    brief: '橋と市場から町が育ち、丘の城と城壁が後から街を囲む、という架空の成立史を地図にする。',
    structure: '橋→市場→城門を主軸に、地形に沿う曲がった道と城壁を配置。城外の畑も残す。',
    detail: '城門・塔・教会・職人街・細い路地を追加。近代的な碁盤目にせず、街の成長を表現。',
    edit: '市の掲示場を橋から市場へ向かう道沿いへ移し、人の集まる場所を調整。',
    landmark: '市場の掲示場',
    landmarkId: 'market-board',
    position: [535, 330],
  },
} satisfies Record<
  MapExample,
  {
    title: string;
    brief: string;
    structure: string;
    detail: string;
    edit: string;
    landmark: string;
    landmarkId: string;
    position: [number, number];
  }
>;

// Deliberate authoring grid, not an import repair or a change to the numeric contract.
const point = (x: number, y: number): FictionMapPoint => [
  Math.round(x * 2) / 2,
  Math.round(y * 2) / 2,
];
const closed = (points: FictionMapPoint[]) => [...points, points[0]];
const rectangle = (x: number, y: number, w: number, h: number, angle = 0) => {
  const a = (angle * Math.PI) / 180;
  return closed(
    [
      [0, 0],
      [w, 0],
      [w, h],
      [0, h],
    ].map(([dx, dy]) =>
      point(x + dx * Math.cos(a) - dy * Math.sin(a), y + dx * Math.sin(a) + dy * Math.cos(a)),
    ),
  );
};
export function exampleContent(id: MapExample, stage: ExampleStage = 'detailed') {
  if (id === 'station') return stationDistrictContent(stage);
  const features: FictionMapFeature[] = [];
  const structured = stage !== 'rough',
    detailed = stage === 'detailed';
  function area(
    key: string,
    name: string,
    layerId: string,
    color: string,
    outer: FictionMapPoint[],
  ) {
    features.push({
      id: key,
      name,
      layerId,
      featureKind: 'region',
      geometry: { type: 'polygon', outer },
      style: { color, lineWidth: 1, label: false },
    });
  }
  function line(
    key: string,
    name: string,
    layerId: string,
    color: string,
    coordinates: FictionMapPoint[],
    width = 2,
  ) {
    features.push({
      id: key,
      name,
      layerId,
      featureKind: 'path',
      geometry: { type: 'polyline', coordinates },
      style: { color, lineWidth: width, label: false },
    });
  }
  function place(key: string, name: string, coordinates: FictionMapPoint, color = '#835f42') {
    features.push({
      id: key,
      name,
      layerId: 'places',
      featureKind: 'place',
      geometry: { type: 'point', coordinates },
      style: { color, lineWidth: 1, label: true },
    });
  }
  function building(
    key: string,
    x: number,
    y: number,
    w = 18,
    h = 12,
    angle = 0,
    color = '#9d7360',
  ) {
    area(key, '建物平面', 'buildings', color, rectangle(x, y, w, h, angle));
  }
  function tree(key: string, x: number, y: number) {
    line(
      key,
      '樹木記号',
      'details',
      '#668364',
      [
        [x - 4, y + 5],
        [x, y - 6],
        [x + 4, y + 5],
        [x - 4, y + 5],
      ],
      1.2,
    );
  }
  area(
    'ground',
    '地表',
    'terrain',
    '#c7c299',
    closed([
      [20, 20],
      [980, 20],
      [980, 630],
      [20, 630],
    ]),
  );
  if (id === 'agriculture') {
    area(
      'terrace',
      '集落の段丘',
      'landuse',
      '#c1ad8b',
      closed([
        [550, 85],
        [920, 75],
        [950, 570],
        [660, 590],
        [580, 440],
      ]),
    );
    line(
      'river',
      '曲流する川',
      'water',
      '#6f9eb6',
      [
        [135, 20],
        [150, 85],
        [125, 145],
        [170, 220],
        [150, 285],
        [200, 350],
        [180, 420],
        [220, 490],
        [200, 550],
        [245, 630],
      ],
      12,
    );
    line(
      'market-road',
      '市場と橋を結ぶ道',
      'roads',
      '#b69968',
      [
        [90, 355],
        [200, 350],
        [380, 360],
        [580, 345],
        [720, 330],
        [930, 300],
      ],
      5,
    );
    area(
      'farmland',
      '沖積低地の耕作域',
      'landuse',
      '#b7b474',
      closed([
        [235, 85],
        [510, 75],
        [560, 510],
        [280, 570],
        [245, 440],
        [255, 290],
        [210, 180],
      ]),
    );
    place('bridge', '石橋', [200, 350]);
    place('granary', '共同穀倉', [790, 205]);
    if (structured) {
      line(
        'main-canal',
        '幹線用水路',
        'water',
        '#7eacb4',
        [
          [160, 180],
          [260, 195],
          [285, 285],
          [300, 390],
          [340, 555],
        ],
        2.5,
      );
      for (let r = 0; r < 4; r++) {
        const y = 115 + r * 108;
        line(
          `farm-road-${r}`,
          '農道',
          'roads',
          '#b5a080',
          [
            [290, y + 75],
            [545, y + 60],
            [625, y + 45],
          ],
          2,
        );
        for (let c = 0; c < 5; c++) {
          const x = 300 + c * 47;
          area(
            `field-${r}-${c}`,
            '輪作区画',
            'landuse',
            ['#bdad66', '#9da471', '#c3b17d'][(r + c) % 3],
            closed([
              [x, y],
              [x + 39, y - 4],
              [x + 43, y + 61],
              [x + 3, y + 66],
            ]),
          );
          if (detailed)
            for (let k = 1; k < 3; k++)
              line(
                `furrow-${r}-${c}-${k}`,
                '畝',
                'details',
                '#ac9e72',
                [
                  [x + 12 * k, y + 5],
                  [x + 12 * k + 3, y + 55],
                ],
                0.7,
              );
        }
      }
      area('orchard', '段丘の果樹園', 'landuse', '#9aa674', rectangle(680, 430, 170, 115, -5));
      line(
        'village-lane',
        '集落の生活道',
        'roads',
        '#bba688',
        [
          [630, 150],
          [660, 230],
          [690, 300],
          [730, 390],
          [795, 430],
          [910, 410],
        ],
        3,
      );
      if (detailed) {
        for (let r = 0; r < 4; r++)
          for (let c = 0; c < 5; c++) tree(`orchard-tree-${r}-${c}`, 700 + c * 29, 447 + r * 23);
        for (let r = 0; r < 4; r++)
          for (let c = 0; c < 6; c++)
            building(
              `village-house-${r}-${c}`,
              675 + c * 33 + r * 8,
              170 + r * 57,
              21,
              14,
              r * 3 - 8,
            );
        building('mill', 220, 315, 30, 18, 12);
        line(
          'mill-race',
          '水車への分流',
          'water',
          '#7eacb4',
          [
            [175, 270],
            [235, 300],
            [240, 340],
            [195, 365],
          ],
          1.5,
        );
      }
    }
  } else if (id === 'residential') {
    area(
      'river-green',
      '水辺の緑地',
      'landuse',
      '#8ea78c',
      closed([
        [815, 20],
        [980, 20],
        [980, 630],
        [835, 630],
        [855, 470],
        [820, 310],
        [845, 150],
      ]),
    );
    line(
      'river',
      '東の川',
      'water',
      '#72a4b7',
      [
        [930, 20],
        [900, 120],
        [935, 220],
        [910, 330],
        [950, 450],
        [925, 630],
      ],
      20,
    );
    line(
      'collector',
      '外周幹線',
      'roads',
      '#b29d7a',
      [
        [100, 565],
        [100, 95],
        [300, 70],
        [600, 90],
        [805, 110],
        [805, 560],
        [100, 565],
      ],
      6,
    );
    area(
      'park',
      '中央公園',
      'landuse',
      '#83a27c',
      closed([
        [470, 235],
        [625, 220],
        [675, 275],
        [655, 405],
        [500, 420],
        [460, 350],
      ]),
    );
    place('school', '小学校', [305, 400]);
    place('station', '駅前商店', [730, 150]);
    if (structured) {
      for (const [key, pts] of [
        [
          'north-street',
          [
            [130, 190],
            [400, 180],
            [610, 175],
            [780, 205],
          ],
        ],
        [
          'middle-street',
          [
            [130, 320],
            [400, 320],
            [445, 290],
            [470, 235],
          ],
        ],
        [
          'south-street',
          [
            [130, 470],
            [430, 470],
            [680, 465],
            [780, 470],
          ],
        ],
        [
          'west-street',
          [
            [400, 90],
            [400, 180],
            [400, 320],
            [430, 470],
            [430, 555],
          ],
        ],
        [
          'east-street',
          [
            [700, 100],
            [700, 215],
            [725, 340],
            [700, 465],
            [710, 560],
          ],
        ],
      ] as [string, FictionMapPoint[]][])
        line(key, '生活道路', 'roads', '#c0ac8a', pts, 3);
      area('school-site', '学校敷地', 'landuse', '#c1b392', rectangle(220, 355, 145, 85));
      line(
        'riverside',
        '水辺の遊歩道',
        'roads',
        '#b1a682',
        [
          [850, 80],
          [830, 210],
          [845, 330],
          [845, 440],
          [865, 575],
        ],
        1.5,
      );
      if (detailed) {
        for (let r = 0; r < 5; r++)
          for (let c = 0; c < 7; c++) {
            const x = 145 + c * 80,
              y = 115 + r * 86;
            if ((x > 450 && y > 200 && y < 430) || (x < 380 && y > 350 && y < 440)) continue;
            area(
              `lot-${r}-${c}`,
              '住宅敷地',
              'landuse',
              '#b5b199',
              rectangle(x - 5, y - 7, 58, 65),
            );
            building(`house-${r}-${c}`, x + 6, y + 7, 28, 20, (r + c) % 2 ? 6 : -4);
            building(`shed-${r}-${c}`, x + 31, y + 40, 12, 9);
          }
        building('school-building', 235, 369, 80, 24, 0, '#998d7b');
        line(
          'park-path',
          '公園の散策路',
          'roads',
          '#b9ac8a',
          [
            [490, 250],
            [530, 275],
            [610, 265],
            [635, 320],
            [605, 385],
            [525, 390],
            [485, 345],
          ],
          1.5,
        );
        for (let i = 0; i < 16; i++)
          tree(`park-tree-${i}`, 490 + (i % 4) * 40, 250 + Math.floor(i / 4) * 43);
        for (let i = 0; i < 13; i++) tree(`riverside-tree-${i}`, 865 + (i % 2) * 10, 90 + i * 38);
      }
    }
  } else if (id === 'downtown') {
    area('riverfront', '河岸の公共空間', 'landuse', '#8fa8a0', rectangle(830, 20, 150, 610));
    line(
      'river',
      '運河',
      'water',
      '#709eae',
      [
        [930, 20],
        [925, 180],
        [945, 360],
        [930, 630],
      ],
      26,
    );
    line(
      'central-axis',
      '駅前大通り',
      'roads',
      '#b89a70',
      [
        [95, 330],
        [300, 330],
        [520, 330],
        [735, 330],
        [855, 330],
      ],
      9,
    );
    area(
      'plaza',
      '中央広場',
      'landuse',
      '#c6b28c',
      closed([
        [455, 265],
        [570, 255],
        [600, 315],
        [580, 395],
        [460, 395],
        [440, 340],
      ]),
    );
    place('station', '中央駅', [100, 330]);
    place('wharf', '船着場', [875, 445]);
    if (structured) {
      for (let c = 0; c < 5; c++)
        line(
          `avenue-${c}`,
          '縦街路',
          'roads',
          '#c4ae8c',
          [
            [210 + c * 140, 55],
            [210 + c * 140, 595],
          ],
          4,
        );
      for (let r = 0; r < 4; r++)
        line(
          `street-${r}`,
          '横街路',
          'roads',
          '#c4ae8c',
          [
            [90, 55 + r * 140],
            [830, 55 + r * 140],
          ],
          4,
        );
      line(
        'quay',
        '河岸プロムナード',
        'roads',
        '#afaa8a',
        [
          [860, 60],
          [850, 230],
          [865, 420],
          [855, 590],
        ],
        2,
      );
      if (detailed) {
        for (let r = 0; r < 4; r++)
          for (let c = 0; c < 4; c++) {
            const x = 225 + c * 140,
              y = [70, 210, 370, 510][r];
            if (c === 2 && (r === 1 || r === 2)) continue;
            // Courtyard blocks: four separate footprints, keeping the courtyard genuinely empty.
            building(`block-${r}-${c}-n`, x, y, 105, 22, 0, '#8e817c');
            building(`block-${r}-${c}-w`, x, y + 30, 23, 60, 0, '#9c8a7e');
            building(`block-${r}-${c}-e`, x + 80, y + 30, 25, 65, 0, '#a28e80');
            building(`block-${r}-${c}-s`, x + 30, y + 75, 42, 22, 0, '#93878b');
            line(
              `alley-${r}-${c}`,
              '街区内路地',
              'details',
              '#c4b79e',
              [
                [x + 45, y + 25],
                [x + 45, y + 65],
                [x + 75, y + 65],
              ],
              1,
            );
          }
        building('station-hall', 55, 260, 105, 44, -4, '#867c78');
        line(
          'railway',
          '鉄道路線',
          'roads',
          '#827e7c',
          [
            [70, 40],
            [75, 225],
            [70, 420],
            [80, 610],
          ],
          3,
        );
        for (let i = 0; i < 12; i++) tree(`quay-tree-${i}`, 885, 75 + i * 44);
        for (let i = 0; i < 8; i++)
          tree(`plaza-tree-${i}`, 470 + (i % 4) * 30, 280 + Math.floor(i / 4) * 95);
      }
    }
  } else {
    area(
      'castle-hill',
      '城の丘',
      'landuse',
      '#b4a782',
      closed([
        [620, 95],
        [740, 70],
        [835, 125],
        [845, 200],
        [755, 240],
        [640, 190],
      ]),
    );
    line(
      'river',
      '渡河交易の川',
      'water',
      '#709cb0',
      [
        [80, 30],
        [120, 125],
        [185, 210],
        [205, 315],
        [160, 410],
        [195, 520],
        [150, 630],
      ],
      18,
    );
    line(
      'trade-road',
      '橋から市場への道',
      'roads',
      '#b59b73',
      [
        [55, 365],
        [180, 365],
        [305, 350],
        [420, 330],
        [535, 330],
        [635, 290],
        [730, 195],
      ],
      5,
    );
    place('castle', '丘の城', [750, 155]);
    place('bridge', '旧石橋', [180, 365]);
    if (structured) {
      const wall: FictionMapPoint[] = [
        [300, 200],
        [380, 140],
        [480, 105],
        [600, 90],
        [720, 100],
        [825, 160],
        [865, 255],
        [875, 360],
        [825, 455],
        [730, 510],
        [610, 540],
        [480, 520],
        [375, 470],
        [305, 390],
        [280, 290],
      ];
      line('city-wall', '増築された城壁', 'roads', '#8b8174', closed(wall), 4);
      area(
        'market-square',
        '市の立つ広場',
        'landuse',
        '#c9b58e',
        closed([
          [460, 295],
          [540, 275],
          [580, 310],
          [555, 365],
          [470, 380],
          [435, 345],
        ]),
      );
      for (const [key, pts] of [
        [
          'north-lane',
          [
            [330, 225],
            [420, 235],
            [510, 210],
            [610, 220],
            [730, 195],
          ],
        ],
        [
          'east-lane',
          [
            [540, 330],
            [645, 360],
            [750, 350],
            [850, 330],
          ],
        ],
        [
          'south-lane',
          [
            [420, 330],
            [445, 410],
            [535, 455],
            [655, 470],
            [760, 480],
          ],
        ],
        [
          'ring-lane',
          [
            [365, 420],
            [350, 310],
            [400, 205],
            [530, 165],
            [680, 160],
            [780, 230],
            [800, 350],
            [740, 425],
            [600, 490],
          ],
        ],
      ] as [string, FictionMapPoint[]][])
        line(key, '曲がる生活道', 'roads', '#bda784', pts, 2.6);
      area(
        'outer-field',
        '城外の畑',
        'landuse',
        '#a5ab7c',
        closed([
          [320, 535],
          [480, 570],
          [720, 580],
          [840, 535],
          [900, 610],
          [300, 610],
        ]),
      );
      if (detailed) {
        for (let i = 0; i < wall.length; i++) {
          const [x, y] = wall[i];
          building(`wall-tower-${i}`, x - 7, y - 7, 14, 14, i * 7, '#84796d');
        }
        // Houses follow two irregular belts around the market, rather than a modern grid.
        for (let belt = 0; belt < 2; belt++)
          for (let i = 0; i < 32; i++) {
            const angle = (i * Math.PI) / 16 + belt * 0.06;
            const x = 565 + (150 + belt * 70) * Math.cos(angle) + 6 * Math.sin(i * 3);
            const y = 330 + (90 + belt * 55) * Math.sin(angle) + 7 * Math.cos(i * 2);
            if (
              (x > 640 && y < 235) ||
              (x > 645 && x < 740 && y > 240 && y < 330) ||
              (x > 450 && x < 580 && y > 275 && y < 385)
            )
              continue;
            const rotation = (angle * 180) / Math.PI + 90;
            building(`town-house-${belt}-${i}`, x, y, 24, 15, rotation);
            building(`town-shed-${belt}-${i}`, x + 12, y + 16, 12, 9, rotation);
          }
        area(
          'castle-keep',
          '城の主郭',
          'buildings',
          '#8a7d71',
          closed([
            [705, 125],
            [790, 125],
            [790, 185],
            [760, 185],
            [760, 170],
            [705, 170],
          ]),
        );
        area(
          'church',
          '教会平面',
          'buildings',
          '#978a79',
          closed([
            [660, 265],
            [685, 265],
            [685, 245],
            [705, 245],
            [705, 265],
            [730, 265],
            [730, 285],
            [705, 285],
            [705, 325],
            [685, 325],
            [685, 285],
            [660, 285],
          ]),
        );
        for (let i = 0; i < 7; i++)
          line(
            `field-strip-${i}`,
            '城外の細長い耕作帯',
            'details',
            '#959e74',
            [
              [365 + i * 65, 565],
              [350 + i * 65, 600],
            ],
            1,
          );
        for (let i = 0; i < 10; i++) tree(`hill-tree-${i}`, 860 + (i % 2) * 35, 75 + i * 43);
      }
    }
  }
  const brief = exampleBriefs[id];
  place(brief.landmarkId, brief.landmark, brief.position);
  const layers = [
    { id: 'terrain', name: '地形', purpose: 'terrain' as const },
    { id: 'landuse', name: '土地利用', purpose: 'terrain' as const },
    { id: 'water', name: '河川・水路', purpose: 'terrain' as const },
    { id: 'roads', name: '道・城壁', purpose: 'route' as const },
    { id: 'buildings', name: '建物平面', purpose: 'settlement' as const },
    { id: 'details', name: '耕作・植栽・路地', purpose: 'annotation' as const },
    { id: 'places', name: '地名・施設', purpose: 'settlement' as const },
  ].map((layer) => ({ ...layer, visibleByDefault: true }));
  const result = validateFictionMap({
    ...createFictionMap(),
    coordinateSpace: {
      kind: 'local-plane',
      bounds: { minX: 0, minY: 0, maxX: 1000, maxY: 650 },
      unit: { name: 'map-unit' },
      yAxis: 'down',
    },
    layers,
    features,
    namedViews: [
      {
        id: 'overview',
        name: '全体図',
        extent: { minX: 0, minY: 0, maxX: 1000, maxY: 650 },
        visibleLayerIds: layers.map((l) => l.id),
      },
    ],
  });
  if (!result.ok) throw Error(`${id}/${stage}: ${JSON.stringify(result.diagnostic)}`);
  return result.value;
}
export function exampleArtifact(id: MapExample, stage: ExampleStage = 'rough') {
  return createArtifact('fiction-map', exampleBriefs[id].title, exampleContent(id, stage));
}
