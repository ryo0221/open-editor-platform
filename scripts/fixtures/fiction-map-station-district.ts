/** Original, non-georeferenced district inspired by a Shibuya-like station/hill/shopping pattern. */
import {
  createFictionMap,
  validateFictionMap,
  type FictionMapFeature,
  type FictionMapPoint,
} from '@editor-platform/fiction-map/model';

const p = (x: number, y: number): FictionMapPoint => [Math.round(x * 2) / 2, Math.round(y * 2) / 2];
const close = (points: FictionMapPoint[]) => [...points, points[0]];
type Road = { id: string; name: string; points: FictionMapPoint[]; width: number; color: string };
export function stationDistrictContent(stage: 'rough' | 'structure' | 'detailed' = 'detailed') {
  const features: FictionMapFeature[] = [];
  function area(
    id: string,
    name: string,
    layerId: string,
    color: string,
    points: FictionMapPoint[],
    width = 0.7,
  ) {
    features.push({
      id,
      name,
      layerId,
      featureKind: 'region',
      geometry: { type: 'polygon', outer: close(points) },
      style: { color, lineWidth: width, label: false },
    });
  }
  function line(
    id: string,
    name: string,
    layerId: string,
    color: string,
    coordinates: FictionMapPoint[],
    width = 1.5,
    label = false,
  ) {
    features.push({
      id,
      name,
      layerId,
      featureKind: 'path',
      geometry: { type: 'polyline', coordinates },
      style: { color, lineWidth: width, label },
    });
  }
  function place(id: string, name: string, x: number, y: number, color = '#7c6967') {
    features.push({
      id,
      name,
      layerId: 'labels',
      featureKind: 'place',
      geometry: { type: 'point', coordinates: [x, y] },
      style: { color, lineWidth: 1, label: true },
    });
  }
  const main: Road[] = [
    {
      id: 'west-boulevard',
      name: '西の坂道',
      points: [
        [40, 590],
        [170, 505],
        [300, 430],
        [415, 365],
        [510, 315],
      ],
      width: 14,
      color: '#dfbd7e',
    },
    {
      id: 'northwest-avenue',
      name: '丘へ上がる大通り',
      points: [
        [140, 20],
        [255, 130],
        [345, 205],
        [430, 260],
        [510, 315],
      ],
      width: 13,
      color: '#dfbd7e',
    },
    {
      id: 'park-avenue',
      name: '公園坂',
      points: [
        [440, 20],
        [445, 125],
        [480, 220],
        [510, 315],
      ],
      width: 11,
      color: '#dfcba4',
    },
    {
      id: 'south-arterial',
      name: '駅南の大通り',
      points: [
        [510, 315],
        [525, 425],
        [585, 500],
        [690, 575],
        [780, 630],
      ],
      width: 14,
      color: '#dfbd7e',
    },
    {
      id: 'valley-avenue',
      name: '谷沿い大通り',
      points: [
        [705, 20],
        [680, 155],
        [680, 285],
        [700, 410],
        [735, 520],
        [790, 630],
      ],
      width: 13,
      color: '#dfbd7e',
    },
    {
      id: 'center-street',
      name: 'センター商店街',
      points: [
        [100, 265],
        [215, 255],
        [330, 265],
        [420, 280],
        [510, 315],
      ],
      width: 9,
      color: '#e0cdb3',
    },
    {
      id: 'west-shopping',
      name: '路地裏の商店街',
      points: [
        [105, 375],
        [240, 355],
        [350, 345],
        [430, 335],
        [510, 315],
      ],
      width: 7,
      color: '#e0cdb3',
    },
    {
      id: 'east-avenue',
      name: '駅東の大通り',
      points: [
        [680, 285],
        [790, 280],
        [880, 300],
        [970, 330],
      ],
      width: 12,
      color: '#dfbd7e',
    },
  ];
  const lanes: Road[] = [
    {
      id: 'hill-lane',
      name: '坂上の裏道',
      points: [
        [65, 140],
        [155, 170],
        [230, 220],
        [285, 270],
        [310, 345],
      ],
      width: 5,
      color: '#d2c8b7',
    },
    {
      id: 'west-alley',
      name: '飲食店街の路地',
      points: [
        [90, 455],
        [210, 405],
        [305, 390],
        [380, 365],
      ],
      width: 5,
      color: '#d2c8b7',
    },
    {
      id: 'north-alley',
      name: '商業街区の横路地',
      points: [
        [290, 80],
        [355, 115],
        [445, 125],
        [540, 115],
        [590, 70],
      ],
      width: 5,
      color: '#d2c8b7',
    },
    {
      id: 'east-lane',
      name: '東口の裏通り',
      points: [
        [810, 100],
        [845, 195],
        [860, 290],
        [870, 400],
        [925, 465],
      ],
      width: 6,
      color: '#d2c8b7',
    },
    {
      id: 'south-lane',
      name: '駅南の歩行者通り',
      points: [
        [350, 600],
        [395, 515],
        [420, 445],
        [470, 390],
        [555, 365],
      ],
      width: 6,
      color: '#d2c8b7',
    },
  ];
  area('ground', '谷と丘の地表', 'terrain', '#aeb8b4', [
    [15, 15],
    [985, 15],
    [985, 635],
    [15, 635],
  ]);
  area('west-hill', '西の台地', 'terrain', '#bfc3a4', [
    [20, 30],
    [340, 20],
    [395, 90],
    [340, 155],
    [300, 250],
    [235, 320],
    [100, 345],
    [20, 300],
  ]);
  area('west-commerce', '駅西の商業街区', 'blocks', '#b6a19e', [
    [150, 180],
    [350, 150],
    [465, 230],
    [490, 305],
    [440, 360],
    [250, 430],
    [110, 365],
    [85, 270],
  ]);
  area('south-commerce', '坂下の商業街区', 'blocks', '#c5b0a3', [
    [160, 455],
    [430, 360],
    [515, 440],
    [570, 540],
    [445, 625],
    [220, 620],
  ]);
  area('east-commerce', '駅東の業務街区', 'blocks', '#aab8c2', [
    [720, 240],
    [960, 240],
    [970, 565],
    [830, 610],
    [740, 500],
  ]);
  area('sky-park', '線路沿いの緑地', 'green', '#739b83', [
    [720, 40],
    [775, 35],
    [795, 100],
    [790, 175],
    [765, 225],
    [715, 210],
    [725, 130],
  ]);
  line(
    'river',
    '谷を流れる小河川',
    'water',
    '#88b5c6',
    [
      [790, 335],
      [785, 405],
      [810, 460],
      [830, 520],
      [865, 570],
      [885, 630],
    ],
    3.5,
  );
  area('station-square', '西口歩行者広場', 'blocks', '#c7b99e', [
    [470, 270],
    [550, 280],
    [570, 325],
    [555, 380],
    [500, 380],
    [465, 345],
    [460, 305],
  ]);
  area('rail-corridor', '鉄道敷', 'rail', '#85969a', [
    [625, 20],
    [675, 20],
    [650, 145],
    [635, 265],
    [630, 365],
    [648, 490],
    [680, 630],
    [630, 630],
    [600, 500],
    [580, 365],
    [585, 255],
    [600, 140],
  ]);
  const roads = stage === 'rough' ? main : [...main, ...lanes];
  for (const road of roads) {
    line(`${road.id}-casing`, road.name, 'roads', '#ffffff', road.points, road.width + 3);
    line(road.id, road.name, 'roads', road.color, road.points, road.width);
  }
  for (const offset of [-9, 9])
    line(
      `rail-${offset}`,
      '鉄道路線',
      'rail',
      '#586b78',
      [
        [650 + offset, 20],
        [625 + offset, 140],
        [608 + offset, 255],
        [605 + offset, 365],
        [625 + offset, 500],
        [655 + offset, 630],
      ],
      2.3,
    );
  area(
    'station-building',
    '駅ビルと改札棟',
    'buildings',
    '#778d9d',
    [
      [575, 235],
      [630, 240],
      [647, 270],
      [645, 365],
      [630, 400],
      [585, 395],
      [565, 365],
      [565, 275],
    ],
    1.6,
  );
  place('station', '星谷駅', 603, 325, '#5b7e91');
  place('scramble', 'スクランブル交差点', 493, 306, '#b78767');
  place('meeting', '西口待ち合わせ広場', 540, 365, '#a77b6a');
  line(
    'label-shopping',
    'センター商店街',
    'labels',
    '#7c6967',
    [
      [245, 268],
      [245.5, 268],
    ],
    0.5,
    true,
  );
  line(
    'label-hill',
    '丘へ続く坂道',
    'labels',
    '#7c6967',
    [
      [230, 474],
      [230.5, 474],
    ],
    0.5,
    true,
  );
  line(
    'label-park',
    '線路沿いの緑地',
    'labels',
    '#638c75',
    [
      [725, 110],
      [725.5, 110],
    ],
    0.5,
    true,
  );
  if (stage !== 'rough') {
    area('department-store', '交差点前の大型商業施設', 'buildings', '#a3858b', [
      [395, 232],
      [436, 257],
      [423, 280],
      [383, 264],
      [380, 245],
    ]);
    area(
      'east-tower',
      '駅直結の高層棟平面',
      'buildings',
      '#78909b',
      [
        [650, 330],
        [677, 325],
        [688, 365],
        [684, 425],
        [651, 420],
        [645, 375],
      ],
      1.2,
    );
    area('south-tower', '南口再開発街区', 'buildings', '#7d91a1', [
      [650, 470],
      [693, 462],
      [710, 500],
      [690, 530],
      [660, 515],
    ]);
    area('hill-culture', '丘の文化施設', 'buildings', '#a99c91', [
      [365, 45],
      [415, 45],
      [418, 80],
      [401, 96],
      [364, 90],
    ]);
    line(
      'station-access',
      '駅前歩行者動線',
      'details',
      '#928474',
      [
        [510, 330],
        [540, 330],
        [560, 338],
        [575, 338],
      ],
      3,
    );
    for (const offset of [-14, 14])
      line(
        `platform-${offset}`,
        'ホーム',
        'rail',
        '#d7c394',
        [
          [604 + offset, 245],
          [600 + offset, 365],
        ],
        4,
      );
    if (stage === 'detailed') {
      // Frontages are authored with explicit visual setbacks; these are not model precision rules.
      const distance = (q: FictionMapPoint, a: FictionMapPoint, b: FictionMapPoint) => {
        const dx = b[0] - a[0],
          dy = b[1] - a[1];
        const t = Math.max(
          0,
          Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / (dx * dx + dy * dy)),
        );
        return Math.hypot(q[0] - a[0] - t * dx, q[1] - a[1] - t * dy);
      };
      const riverPoints: FictionMapPoint[] = [
        [790, 335],
        [785, 405],
        [810, 460],
        [830, 520],
        [865, 570],
        [885, 630],
      ];
      const placementLines = [...roads.map((road) => road.points), riverPoints];
      const fixedBounds = features
        .filter((f) => f.layerId === 'buildings' && f.geometry.type === 'polygon')
        .map((f) => {
          if (f.geometry.type !== 'polygon') throw Error('Expected polygon');
          return [
            Math.min(...f.geometry.outer.map((p) => p[0])),
            Math.min(...f.geometry.outer.map((p) => p[1])),
            Math.max(...f.geometry.outer.map((p) => p[0])),
            Math.max(...f.geometry.outer.map((p) => p[1])),
          ];
        });
      const lots: { points: FictionMapPoint[]; bounds: number[] }[] = [];
      const candidates = roads.map((road, ri) => {
        const batch: { points: FictionMapPoint[]; bounds: number[] }[] = [];
        for (let si = 1; si < road.points.length; si++) {
          const a = road.points[si - 1],
            b = road.points[si];
          const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
          const ux = (b[0] - a[0]) / length,
            uy = (b[1] - a[1]) / length;
          for (let at = 24; at < length - 16; at += 34)
            for (const side of [-1, 1]) {
              const width = 28 + ((ri + si) % 3) * 3,
                depth = 24 + (ri % 3) * 3;
              const x = a[0] + at * ux - uy * side * 32,
                y = a[1] + at * uy + ux * side * 32;
              const center: FictionMapPoint = [x, y];
              if (x > 530 && x < 705) continue; // railway, station and tower reservations
              if (x > 700 && x < 810 && y < 245) continue; // park
              if (x > 350 && x < 435 && y < 110) continue; // cultural facility
              if (Math.hypot(x - 510, y - 320) < 77) continue; // plaza / crossing
              if (
                placementLines.some((points) =>
                  points
                    .slice(1)
                    .some(
                      (end, i) =>
                        distance(center, points[i], end) < Math.hypot(width, depth) / 2 + 8,
                    ),
                )
              )
                continue;
              const local =
                (ri + si) % 3 === 0
                  ? [
                      [-width / 2, -depth / 2],
                      [width / 2 - 5, -depth / 2],
                      [width / 2, -depth / 2 + 5],
                      [width / 2, depth / 2],
                      [-width / 2, depth / 2],
                    ]
                  : [
                      [-width / 2, -depth / 2],
                      [width / 2, -depth / 2],
                      [width / 2, depth / 2],
                      [-width / 2, depth / 2],
                    ];
              const points = local.map(([dx, dy]) =>
                p(x + ux * dx - uy * dy, y + uy * dx + ux * dy),
              );
              const bounds = [
                Math.min(...points.map((p) => p[0])),
                Math.min(...points.map((p) => p[1])),
                Math.max(...points.map((p) => p[0])),
                Math.max(...points.map((p) => p[1])),
              ];
              if (bounds[0] < 30 || bounds[1] < 30 || bounds[2] > 970 || bounds[3] > 620) continue;
              batch.push({ points, bounds });
            }
        }
        return batch;
      });
      // Interleave districts so the capacity guard cannot fill only one end of the map.
      for (let i = 0; candidates.some((batch) => i < batch.length) && lots.length < 76; i++)
        for (const batch of candidates) {
          const candidate = batch[i];
          if (!candidate || lots.length >= 76) continue;
          const [x0, y0, x1, y1] = candidate.bounds;
          if (
            [...lots, ...fixedBounds.map((bounds) => ({ bounds }))].some(
              (l) =>
                !(
                  x1 + 4 < l.bounds[0] ||
                  x0 - 4 > l.bounds[2] ||
                  y1 + 4 < l.bounds[1] ||
                  y0 - 4 > l.bounds[3]
                ),
            )
          )
            continue;
          lots.push(candidate);
        }
      lots.forEach((lot, i) =>
        area(
          `frontage-${i}`,
          `沿道ビル ${i + 1}`,
          'buildings',
          ['#65717e', '#7b7178', '#697b82', '#8a7970'][i % 4],
          lot.points,
          0.65,
        ),
      );
      // Larger commercial footprints fill block interiors; no extra runtime geometry is introduced.
      let infill = 0;
      for (let row = 0; row < 11 && infill < 18; row++)
        for (const side of [0, 1])
          for (let col = 0; col < 9 && infill < 18; col++) {
            const x = side === 0 ? 65 + col * 50 : 745 + col * 25;
            const y = 65 + row * 50;
            const w = 42 + ((row + col) % 3) * 8,
              h = 32 + (row % 3) * 6;
            if (
              x + w > 960 ||
              y + h > 610 ||
              (x > 700 && y < 245) ||
              Math.hypot(x + w / 2 - 510, y + h / 2 - 320) < 95
            )
              continue;
            const center: FictionMapPoint = [x + w / 2, y + h / 2];
            if (
              placementLines.some((points) =>
                points
                  .slice(1)
                  .some((end, i) => distance(center, points[i], end) < Math.hypot(w, h) / 2 + 8),
              )
            )
              continue;
            const bounds = [x, y, x + w, y + h];
            if (
              [...lots.map((l) => l.bounds), ...fixedBounds].some(
                (b) =>
                  !(
                    bounds[2] + 4 < b[0] ||
                    bounds[0] - 4 > b[2] ||
                    bounds[3] + 4 < b[1] ||
                    bounds[1] - 4 > b[3]
                  ),
              )
            )
              continue;
            const points: FictionMapPoint[] = [
              [x, y + 6],
              [x + 6, y],
              [x + w, y],
              [x + w, y + h - 8],
              [x + w - 8, y + h],
              [x, y + h],
            ];
            area(`infill-${infill++}`, '商業街区の複合棟', 'buildings', '#6b7380', points, 0.7);
            fixedBounds.push(bounds);
          }
      // Three zebra directions make the crossing legible without one uneditable symbol image.
      for (const [axis, angle, cx, cy, count] of [
        ['west', 0, 493, 321, 8],
        ['north', 90, 508, 300, 6],
        ['diagonal', -45, 496, 312, 7],
      ] as const) {
        const a = (angle * Math.PI) / 180;
        for (let i = 0; i < count; i++) {
          const x = cx + (i - (count - 1) / 2) * 6 * Math.cos(a),
            y = cy + (i - (count - 1) / 2) * 6 * Math.sin(a);
          const points = [
            [-1.5, -7],
            [1.5, -7],
            [1.5, 7],
            [-1.5, 7],
          ].map(([dx, dy]) =>
            p(x + dx * Math.cos(a) - dy * Math.sin(a), y + dx * Math.sin(a) + dy * Math.cos(a)),
          );
          area(`crosswalk-${axis}-${i}`, '横断歩道の縞', 'details', '#5b7381', points, 0.4);
        }
      }
      for (let i = 0; i < 12; i++) {
        const x = 739 + (i % 2) * 24,
          y = 57 + Math.floor(i / 2) * 26;
        area(
          `park-tree-${i}`,
          '公園の樹冠',
          'green',
          '#6f967b',
          [
            [x - 5, y],
            [x, y - 5],
            [x + 5, y],
            [x, y + 5],
          ],
          0.65,
        );
      }
      for (let i = 0; i < 12; i++) {
        const y = 40 + i * 48;
        if (y > 225 && y < 410) continue;
        const x = y < 230 ? 650 - (y - 20) * 0.16 : 605 + (y - 365) * 0.18;
        line(`sleeper-${i}`, '軌道の横材', 'rail', '#76858b', [p(x - 14, y), p(x + 14, y)], 1);
      }
      line(
        'park-walk',
        '公園の歩道',
        'details',
        '#b4a58c',
        [
          [750, 48],
          [755, 100],
          [750, 150],
          [745, 205],
        ],
        1.5,
      );
      line(
        'entrance-steps',
        '西口の段差記号',
        'details',
        '#83949b',
        [
          [562, 350],
          [573, 352],
          [573, 357],
          [562, 355],
        ],
        1.1,
      );
    }
  }
  const layers = [
    { id: 'terrain', name: '谷・台地', purpose: 'terrain' as const },
    { id: 'blocks', name: '街区・広場', purpose: 'settlement' as const },
    { id: 'green', name: '緑地・植栽', purpose: 'terrain' as const },
    { id: 'water', name: '小河川', purpose: 'terrain' as const },
    { id: 'roads', name: '幹線・商店街・路地', purpose: 'route' as const },
    { id: 'rail', name: '鉄道・ホーム', purpose: 'route' as const },
    { id: 'buildings', name: '駅ビル・沿道建物', purpose: 'settlement' as const },
    { id: 'details', name: '横断歩道・歩行者動線', purpose: 'annotation' as const },
    { id: 'labels', name: '駅・地名', purpose: 'annotation' as const },
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
      {
        id: 'station-close',
        name: '駅前拡大',
        extent: { minX: 200, minY: 190, maxX: 760, maxY: 460 },
        visibleLayerIds: layers.map((l) => l.id),
      },
    ],
  });
  if (!result.ok) throw Error(`station/${stage}: ${JSON.stringify(result.diagnostic)}`);
  return result.value;
}
