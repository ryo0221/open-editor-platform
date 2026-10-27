import type {
  BimDocument,
  BimElement,
  BimLevel,
  BimType,
  BimWall,
  BimWallJoin,
  Vec2,
} from './model';

/**
 * Fixtures of docs/cad/r2c-architecture.md (F31 box building, F33 types, F37 office, F39 roofs). They are
 * plain documents; tests derive the expected quantities analytically.
 */

export const emptyBim = (): BimDocument => ({
  schemaVersion: 1,
  units: 'mm',
  axes: 'right-handed-z-up',
  project: { name: 'Project', trueNorthRad: 0, siteElevationMm: 0 },
  levels: [],
  grids: [],
  materials: [],
  types: [],
  elements: [],
  joins: [],
  views: [],
  propertySets: [],
});

const baseTypes = (): Pick<BimDocument, 'materials' | 'types'> => ({
  materials: [
    { id: 'm-concrete', name: 'Concrete', category: 'concrete' },
    { id: 'm-finish', name: 'Plaster', category: 'finish' },
    { id: 'm-steel', name: 'Steel', category: 'metal' },
  ],
  types: [
    {
      id: 't-wall-200',
      kind: 'wall',
      name: 'RC 180 + plaster 20',
      layers: [
        { materialId: 'm-concrete', thicknessMm: 180 },
        { materialId: 'm-finish', thicknessMm: 20 },
      ],
      common: { isExternal: true, loadBearing: true },
    },
    {
      id: 't-slab-200',
      kind: 'slab',
      name: 'RC slab 200',
      layers: [{ materialId: 'm-concrete', thicknessMm: 200 }],
    },
    {
      id: 't-roof-200',
      kind: 'roof',
      name: 'RC roof 200',
      layers: [{ materialId: 'm-concrete', thicknessMm: 200 }],
    },
    {
      id: 't-column-600',
      kind: 'column',
      name: 'RC column 600',
      profile: { shape: 'rect', widthMm: 600, depthMm: 600 },
      materialId: 'm-concrete',
    },
    {
      id: 't-beam-400x700',
      kind: 'beam',
      name: 'RC beam 400×700',
      profile: { shape: 'rect', widthMm: 400, depthMm: 700 },
      materialId: 'm-concrete',
    },
    { id: 't-door-900', kind: 'door', name: 'Door 900', widthMm: 900, heightMm: 2100 },
    { id: 't-window-1800', kind: 'window', name: 'Window 1800', widthMm: 1800, heightMm: 1500 },
  ] satisfies BimType[],
});

/**
 * A new building: the levels 1F, 2F and RF (3,000 mm storeys), the base materials and types,
 * and no elements yet.
 */
export function bimStarter(): BimDocument {
  const doc = emptyBim();
  Object.assign(doc, baseTypes());
  doc.levels = [
    { id: 'l-1f', name: '1F', elevationMm: 0 },
    { id: 'l-2f', name: '2F', elevationMm: 3000 },
    { id: 'l-rf', name: 'RF', elevationMm: 6000 },
  ];
  return doc;
}

const wall = (
  id: string,
  start: Vec2,
  end: Vec2,
  base: string,
  top: string,
  extra: Partial<BimWall> = {},
): BimWall => ({
  id,
  kind: 'wall',
  typeId: 't-wall-200',
  start: { xy: start },
  end: { xy: end },
  location: 'center',
  base: { level: base, offsetMm: 0 },
  top: { level: top, offsetMm: 0 },
  ...extra,
});

/**
 * F31: a two-storey box, 10,000 × 8,000 mm on the wall axes, walls 200 mm from 1F to RF
 * (6,000 mm). The south and north walls run through at the corners (butt).
 */
export function f31BoxBuilding(): BimDocument {
  const doc = emptyBim();
  Object.assign(doc, baseTypes());
  doc.levels = [
    { id: 'l-1f', name: '1F', elevationMm: 0 },
    { id: 'l-2f', name: '2F', elevationMm: 3000 },
    { id: 'l-rf', name: 'RF', elevationMm: 6000 },
  ];
  doc.elements = [
    wall('w-south', [0, 0], [10000, 0], 'l-1f', 'l-rf'),
    wall('w-east', [10000, 0], [10000, 8000], 'l-1f', 'l-rf'),
    wall('w-north', [10000, 8000], [0, 8000], 'l-1f', 'l-rf'),
    wall('w-west', [0, 8000], [0, 0], 'l-1f', 'l-rf'),
    {
      id: 's-1f',
      kind: 'slab',
      typeId: 't-slab-200',
      top: { level: 'l-1f', offsetMm: 0 },
      boundary: [
        [-100, -100],
        [10100, -100],
        [10100, 8100],
        [-100, 8100],
      ],
      holes: [],
    },
    {
      id: 's-2f',
      kind: 'slab',
      typeId: 't-slab-200',
      top: { level: 'l-2f', offsetMm: 0 },
      boundary: [
        [100, 100],
        [9900, 100],
        [9900, 7900],
        [100, 7900],
      ],
      holes: [
        [
          [6000, 5000],
          [9000, 5000],
          [9000, 7000],
          [6000, 7000],
        ],
      ],
    },
    {
      id: 'r-roof',
      kind: 'roof',
      typeId: 't-roof-200',
      base: { level: 'l-rf', offsetMm: 0 },
      boundary: [
        [-100, -100],
        [10100, -100],
        [10100, 8100],
        [-100, 8100],
      ],
      shape: { form: 'flat' },
    },
    {
      id: 'd-entrance',
      kind: 'door',
      typeId: 't-door-900',
      hostId: 'w-south',
      alongMm: 2000,
      flipFacing: false,
      flipHand: false,
    },
    ...[1000, 4000, 7000].map(
      (alongMm, i): BimElement => ({
        id: `win-n${i + 1}`,
        kind: 'window',
        typeId: 't-window-1800',
        hostId: 'w-north',
        alongMm,
        sillMm: 900,
        flipFacing: false,
      }),
    ),
    {
      id: 'win-e1',
      kind: 'window',
      typeId: 't-window-1800',
      hostId: 'w-east',
      alongMm: 3000,
      sillMm: 900,
      flipFacing: false,
    },
    {
      id: 'sp-hall',
      kind: 'space',
      number: '101',
      name: 'Hall',
      base: { level: 'l-1f', offsetMm: 0 },
      boundary: [
        [100, 100],
        [9900, 100],
        [9900, 7900],
        [100, 7900],
      ],
    },
  ];
  doc.joins = [
    { id: 'j-se', walls: ['w-south', 'w-east'], kind: 'butt', through: 'w-south' },
    { id: 'j-ne', walls: ['w-east', 'w-north'], kind: 'butt', through: 'w-north' },
    { id: 'j-nw', walls: ['w-north', 'w-west'], kind: 'butt', through: 'w-north' },
    { id: 'j-sw', walls: ['w-west', 'w-south'], kind: 'butt', through: 'w-south' },
  ];
  return doc;
}

/** F33: one 40,000 mm wall with 40 windows of one 600 mm type, spaced 1,000 mm. */
/**
 * F39: F31 under a gable roof (ridge along X) or a hip roof, 30° on every side. The outer walls
 * and a 600 mm column on the ridge line rise to 12,000 mm and the roof's underside cuts them:
 * the gable ends become pentagons, the column's top a ridge.
 */
export function f39Roofs(form: 'gable' | 'hip'): BimDocument {
  const doc = f31BoxBuilding();
  const slopeRad = Math.PI / 6;
  for (const e of doc.elements) {
    if (e.kind === 'roof')
      e.shape = form === 'gable' ? { form, slopeRad, ridgeRad: 0 } : { form, slopeRad };
    if (e.kind === 'wall') {
      e.top = { heightMm: 12000 };
      e.clipBy = 'r-roof';
    }
  }
  doc.elements.push({
    id: 'c-ridge',
    kind: 'column',
    typeId: 't-column-600',
    at: { xy: [5000, 4000] },
    rotationRad: 0,
    base: { level: 'l-1f', offsetMm: 0 },
    top: { heightMm: 12000 },
    clipBy: 'r-roof',
  });
  return doc;
}

export function f33Types(): BimDocument {
  const doc = emptyBim();
  Object.assign(doc, baseTypes());
  doc.types.push({
    id: 't-window-600',
    kind: 'window',
    name: 'Window 600',
    widthMm: 600,
    heightMm: 1200,
  });
  doc.levels = [
    { id: 'l-1f', name: '1F', elevationMm: 0 },
    { id: 'l-2f', name: '2F', elevationMm: 3000 },
  ];
  doc.elements = [
    wall('w-long', [0, 0], [40000, 0], 'l-1f', 'l-2f'),
    ...Array.from(
      { length: 40 },
      (_, i): BimElement => ({
        id: `win-${i + 1}`,
        kind: 'window',
        typeId: 't-window-600',
        hostId: 'w-long',
        alongMm: 200 + i * 1000,
        sillMm: 900,
        flipFacing: false,
      }),
    ),
  ];
  return doc;
}

/**
 * F37 office: 1F–RF (6 levels, 4,000 mm), a 7 × 5 grid at 7,200 mm, columns at every grid
 * intersection on 1F–5F, beams on 2F–RF, slabs, exterior walls joined at the corners, a
 * partition per storey with 12 doors (T joins), 200 windows, two spaces per storey and a flat
 * roof. Columns and wall ends follow the grid.
 */
export function f37Office(): BimDocument {
  const doc = emptyBim();
  Object.assign(doc, baseTypes());
  doc.project.name = 'Office';
  const names = ['1F', '2F', '3F', '4F', '5F', 'RF'];
  doc.levels = names.map(
    (name, i): BimLevel => ({ id: `l-${name.toLowerCase()}`, name, elevationMm: i * 4000 }),
  );
  const xs = Array.from({ length: 7 }, (_, i) => i * 7200);
  const ys = Array.from({ length: 5 }, (_, i) => i * 7200);
  const [W, D] = [xs[6], ys[4]];
  doc.grids = [
    ...xs.map((x, i) => ({
      id: `g-x${i + 1}`,
      label: `X${i + 1}`,
      start: [x, -3000] as Vec2,
      end: [x, D + 3000] as Vec2,
    })),
    ...ys.map((y, i) => ({
      id: `g-y${i + 1}`,
      label: `Y${i + 1}`,
      start: [-3000, y] as Vec2,
      end: [W + 3000, y] as Vec2,
    })),
  ];
  const gp = (i: number, j: number) => ({
    grid: [`g-x${i + 1}`, `g-y${j + 1}`] as [string, string],
  });
  const elements: BimElement[] = [];
  const joins: BimWallJoin[] = [];
  const outline: Vec2[] = [
    [-100, -100],
    [W + 100, -100],
    [W + 100, D + 100],
    [-100, D + 100],
  ];
  for (let s = 0; s < 5; s++) {
    const lv = doc.levels[s].id;
    const up = doc.levels[s + 1].id;
    xs.forEach((_, i) =>
      ys.forEach((_, j) =>
        elements.push({
          id: `c-${s + 1}-${i + 1}-${j + 1}`,
          kind: 'column',
          typeId: 't-column-600',
          at: gp(i, j),
          rotationRad: 0,
          base: { level: lv, offsetMm: 0 },
          top: { level: up, offsetMm: 0 },
        }),
      ),
    );
    for (let i = 0; i < 7; i++)
      for (let j = 0; j < 5; j++) {
        if (i < 6)
          elements.push({
            id: `b-${s + 2}-x${i + 1}-${j + 1}`,
            kind: 'beam',
            typeId: 't-beam-400x700',
            start: gp(i, j),
            end: gp(i + 1, j),
            top: { level: up, offsetMm: 0 },
          });
        if (j < 4)
          elements.push({
            id: `b-${s + 2}-y${i + 1}-${j + 1}`,
            kind: 'beam',
            typeId: 't-beam-400x700',
            start: gp(i, j),
            end: gp(i, j + 1),
            top: { level: up, offsetMm: 0 },
          });
      }
    if (s < 4)
      elements.push({
        id: `s-${s + 2}`,
        kind: 'slab',
        typeId: 't-slab-200',
        top: { level: up, offsetMm: 0 },
        boundary: outline,
        holes: [],
      });
    const w = (id: string, a: [number, number], b: [number, number]) =>
      elements.push({
        ...wall(`${id}-${s + 1}`, [0, 0], [0, 0], lv, up),
        start: gp(...a),
        end: gp(...b),
      });
    w('w-s', [0, 0], [6, 0]);
    w('w-e', [6, 0], [6, 4]);
    w('w-n', [6, 4], [0, 4]);
    w('w-w', [0, 4], [0, 0]);
    w('w-p', [0, 2], [6, 2]);
    const n = s + 1;
    joins.push(
      { id: `j-se-${n}`, walls: [`w-s-${n}`, `w-e-${n}`], kind: 'butt', through: `w-s-${n}` },
      { id: `j-ne-${n}`, walls: [`w-e-${n}`, `w-n-${n}`], kind: 'butt', through: `w-n-${n}` },
      { id: `j-nw-${n}`, walls: [`w-n-${n}`, `w-w-${n}`], kind: 'butt', through: `w-n-${n}` },
      { id: `j-sw-${n}`, walls: [`w-w-${n}`, `w-s-${n}`], kind: 'butt', through: `w-s-${n}` },
      { id: `j-pw-${n}`, walls: [`w-w-${n}`, `w-p-${n}`], kind: 'butt', through: `w-w-${n}` },
      { id: `j-pe-${n}`, walls: [`w-e-${n}`, `w-p-${n}`], kind: 'butt', through: `w-e-${n}` },
    );
    const windows = (host: string, count: number) => {
      for (let k = 0; k < count; k++)
        elements.push({
          id: `win-${host}-${k + 1}`,
          kind: 'window',
          typeId: 't-window-1800',
          hostId: host,
          alongMm: 900 + k * 3600,
          sillMm: 900,
          flipFacing: false,
        });
    };
    windows(`w-s-${n}`, 12);
    windows(`w-n-${n}`, 12);
    windows(`w-e-${n}`, 8);
    windows(`w-w-${n}`, 8);
    for (let k = 0; k < 12; k++)
      elements.push({
        id: `d-${n}-${k + 1}`,
        kind: 'door',
        typeId: 't-door-900',
        hostId: `w-p-${n}`,
        alongMm: 1500 + k * 3600,
        flipFacing: k % 2 === 1,
        flipHand: false,
      });
    const half = (y0: number, y1: number): Vec2[] => [
      [100, y0],
      [W - 100, y0],
      [W - 100, y1],
      [100, y1],
    ];
    elements.push(
      {
        id: `sp-${n}-s`,
        kind: 'space',
        number: `${n}01`,
        base: { level: lv, offsetMm: 0 },
        boundary: half(100, D / 2 - 100),
      },
      {
        id: `sp-${n}-n`,
        kind: 'space',
        number: `${n}02`,
        base: { level: lv, offsetMm: 0 },
        boundary: half(D / 2 + 100, D - 100),
      },
    );
  }
  elements.push({
    id: 's-1f',
    kind: 'slab',
    typeId: 't-slab-200',
    top: { level: 'l-1f', offsetMm: 0 },
    boundary: outline,
    holes: [],
  });
  elements.push({
    id: 'r-roof',
    kind: 'roof',
    typeId: 't-roof-200',
    base: { level: 'l-rf', offsetMm: 0 },
    boundary: outline,
    shape: { form: 'flat' },
  });
  doc.elements = elements;
  doc.joins = joins;
  return doc;
}
