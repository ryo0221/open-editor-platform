import type {
  BimDocument,
  BimElement,
  BimLevel,
  BimLoop,
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

/**
 * F40 lattice (TW2, docs/cad/bim-tower.md): the inclined members of a lattice tower. GL and L1
 * (6,000 mm), a leaning column, a sloping beam, and four members: a diagonal brace turned
 * 0.3 rad, a vertical one, a horizontal one and one that starts at a grid intersection.
 */
/**
 * F47 (TW5): tapered columns. A square one, a round one, a hollow box one and a leaning square
 * one, each from GL to L1 with a smaller top section.
 */
export function f47Taper(): BimDocument {
  const doc = emptyBim();
  Object.assign(doc, baseTypes());
  doc.project.name = 'Taper';
  doc.types.push(
    {
      id: 't-column-round',
      kind: 'column',
      name: 'RC column round 1200',
      profile: { shape: 'circle', diameterMm: 1200 },
      materialId: 'm-concrete',
    },
    {
      id: 't-column-box',
      kind: 'column',
      name: 'Steel box column 800',
      profile: { shape: 'box', widthMm: 800, depthMm: 800, wallMm: 40 },
      materialId: 'm-steel',
    },
  );
  doc.levels = [
    { id: 'l-gl', name: 'GL', elevationMm: 0 },
    { id: 'l-1', name: 'L1', elevationMm: 6000 },
  ];
  const gl = { level: 'l-gl', offsetMm: 0 };
  const l1 = { level: 'l-1', offsetMm: 0 };
  doc.elements = [
    {
      id: 'c-square',
      kind: 'column',
      typeId: 't-column-600',
      at: { xy: [0, 0] },
      rotationRad: 0.2,
      base: gl,
      top: l1,
      topScale: 0.5,
    },
    {
      id: 'c-round',
      kind: 'column',
      typeId: 't-column-round',
      at: { xy: [4000, 0] },
      rotationRad: 0,
      base: gl,
      top: l1,
      topScale: 0.25,
    },
    {
      id: 'c-box',
      kind: 'column',
      typeId: 't-column-box',
      at: { xy: [8000, 0] },
      rotationRad: 0,
      base: gl,
      top: l1,
      topScale: 0.75,
    },
    {
      id: 'c-lean',
      kind: 'column',
      typeId: 't-column-600',
      at: { xy: [0, 4000] },
      topAt: { xy: [1500, 4000] },
      rotationRad: 0,
      base: gl,
      top: l1,
      topScale: 0.6,
    },
  ];
  return doc;
}

/**
 * F49 (#936): steel pipes (circular hollow sections). A pipe column, a tapered one (the wall
 * scales too), a pipe beam and a leaning pipe brace, from GL to L1.
 */
export function f49Pipes(): BimDocument {
  const doc = emptyBim();
  Object.assign(doc, baseTypes());
  doc.project.name = 'Pipes';
  doc.types.push(
    {
      id: 't-column-pipe',
      kind: 'column',
      name: 'Steel pipe column 600x25',
      profile: { shape: 'pipe', diameterMm: 600, wallMm: 25 },
      materialId: 'm-steel',
    },
    {
      id: 't-beam-pipe',
      kind: 'beam',
      name: 'Steel pipe beam 400x16',
      profile: { shape: 'pipe', diameterMm: 400, wallMm: 16 },
      materialId: 'm-steel',
    },
    {
      id: 't-member-pipe',
      kind: 'member',
      name: 'Steel pipe 300x12',
      profile: { shape: 'pipe', diameterMm: 300, wallMm: 12 },
      materialId: 'm-steel',
    },
  );
  doc.levels = [
    { id: 'l-gl', name: 'GL', elevationMm: 0 },
    { id: 'l-1', name: 'L1', elevationMm: 6000 },
  ];
  const gl = { level: 'l-gl', offsetMm: 0 };
  const l1 = { level: 'l-1', offsetMm: 0 };
  doc.elements = [
    {
      id: 'c-pipe',
      kind: 'column',
      typeId: 't-column-pipe',
      at: { xy: [0, 0] },
      rotationRad: 0,
      base: gl,
      top: l1,
    },
    {
      id: 'c-pipe-taper',
      kind: 'column',
      typeId: 't-column-pipe',
      at: { xy: [6000, 0] },
      rotationRad: 0,
      base: gl,
      top: l1,
      topScale: 0.5,
    },
    {
      id: 'b-pipe',
      kind: 'beam',
      typeId: 't-beam-pipe',
      start: { xy: [0, 0] },
      end: { xy: [6000, 0] },
      top: l1,
    },
    {
      id: 'm-pipe',
      kind: 'member',
      typeId: 't-member-pipe',
      start: { at: { xy: [0, 4000] }, height: gl },
      end: { at: { xy: [6000, 4000] }, height: l1 },
      rotationRad: 0,
    },
  ];
  return doc;
}

/**
 * F50 (LR2): leaning walls, GL to L1 (4,000 mm). A free straight wall leaning 15°; a ring of four
 * quarter arcs of glass leaning out 0.3 rad, meeting end to end (a deck's glass: a cone; tangent
 * arcs need no join); a square of four
 * walls leaning out 0.2 rad, mitred (a frustum); and an L of two walls leaning 0.1 and 0.25 rad,
 * butted (its end faces ruled, not planar).
 */
export function f50Lean(): BimDocument {
  const doc = emptyBim();
  Object.assign(doc, baseTypes());
  doc.project.name = 'Lean';
  doc.materials.push({ id: 'm-glass', name: 'Glass', category: 'glass' });
  doc.types.push({
    id: 't-glass-80',
    kind: 'wall',
    name: 'Glass wall 80',
    layers: [{ materialId: 'm-glass', thicknessMm: 80 }],
  });
  doc.levels = [
    { id: 'l-gl', name: 'GL', elevationMm: 0 },
    { id: 'l-1', name: 'L1', elevationMm: 4000 },
  ];
  const gl = { level: 'l-gl', offsetMm: 0 };
  const l1 = { level: 'l-1', offsetMm: 0 };
  const wall = (
    id: string,
    a: [number, number],
    b: [number, number],
    lean: number,
    extra: Partial<BimWall> = {},
  ): BimWall => ({
    id,
    kind: 'wall',
    typeId: 't-wall-200',
    start: { xy: a },
    end: { xy: b },
    location: 'center',
    base: gl,
    top: l1,
    lean,
    ...extra,
  });
  const q = Math.tan(Math.PI / 8);
  const ring: [number, number][] = [
    [25000, 0],
    [20000, 5000],
    [15000, 0],
    [20000, -5000],
  ];
  const square: [number, number][] = [
    [0, 10000],
    [6000, 10000],
    [6000, 16000],
    [0, 16000],
  ];
  doc.elements = [
    wall('w-free', [0, 0], [6000, 0], Math.PI / 12),
    ...ring.map((p, i) =>
      wall(`w-ring-${i + 1}`, p, ring[(i + 1) % 4]!, 0.3, { typeId: 't-glass-80', bulge: q }),
    ),
    ...square.map((p, i) => wall(`w-sq-${i + 1}`, p, square[(i + 1) % 4]!, 0.2)),
    wall('w-l-1', [12000, 10000], [18000, 10000], 0.1),
    wall('w-l-2', [18000, 10000], [18000, 15000], 0.25),
  ];
  doc.joins = [
    ...[1, 2, 3, 4].map(
      (i): BimWallJoin => ({
        id: `j-sq-${i}`,
        walls: [`w-sq-${i}`, `w-sq-${(i % 4) + 1}`],
        kind: 'miter',
      }),
    ),
    { id: 'j-l', walls: ['w-l-1', 'w-l-2'], kind: 'butt', through: 'w-l-1' },
  ];
  return doc;
}

/**
 * F54 (LS1): F50's leaning walls under roofs. The mitred square rises to 7,000 mm under a
 * mono-pitch roof (15° up towards +y, its underside 4,000 mm at the south eaves); the glass
 * ring under a flat roof 500 mm below L1. Each roof reaches past its walls' tops.
 */
export function f54LeanRoofs(): BimDocument {
  const doc = f50Lean();
  doc.project.name = 'Lean roofs';
  for (const e of doc.elements) {
    if (e.kind !== 'wall') continue;
    if (e.id.startsWith('w-sq-')) {
      e.top = { heightMm: 7000 };
      e.clipBy = 'r-mono';
    } else if (e.id.startsWith('w-ring-')) e.clipBy = 'r-flat';
  }
  doc.elements.push(
    {
      id: 'r-mono',
      kind: 'roof',
      typeId: 't-roof-200',
      base: { level: 'l-1', offsetMm: 0 },
      boundary: [
        [-1500, 8500],
        [7500, 8500],
        [7500, 17500],
        [-1500, 17500],
      ],
      shape: { form: 'mono', slopeRad: Math.PI / 12, directionRad: Math.PI / 2 },
    },
    {
      id: 'r-flat',
      kind: 'roof',
      typeId: 't-roof-200',
      base: { level: 'l-1', offsetMm: -500 },
      boundary: [
        [13000, -7000],
        [27000, -7000],
        [27000, 7000],
        [13000, 7000],
      ],
      shape: { form: 'flat' },
    },
  );
  return doc;
}

/**
 * F54 (LS2): a straight wall leaning 0.2 rad to −y, GL to L1 (4,000 mm), joined to upright walls:
 * mitred at its start to one running north, a T butted on it by another north from its middle
 * (with a window clear of the join), and an L butted at its end by a third that stops on it.
 * Each upright wall's end follows the leaning face up; every face is a plane, so every solid
 * is ruled exactly.
 */
export function f54LeanJoins(): BimDocument {
  const doc = emptyBim();
  Object.assign(doc, baseTypes());
  doc.project.name = 'Lean joins';
  doc.levels = [
    { id: 'l-gl', name: 'GL', elevationMm: 0 },
    { id: 'l-1', name: 'L1', elevationMm: 4000 },
  ];
  const wall = (id: string, a: Vec2, b: Vec2, lean?: number): BimWall => ({
    id,
    kind: 'wall',
    typeId: 't-wall-200',
    start: { xy: a },
    end: { xy: b },
    location: 'center',
    base: { level: 'l-gl', offsetMm: 0 },
    top: { level: 'l-1', offsetMm: 0 },
    ...(lean ? { lean } : {}),
  });
  doc.elements = [
    wall('w-lean', [0, 0], [8000, 0], 0.2),
    wall('w-up-m', [0, 6000], [0, 0]),
    wall('w-up-t', [4000, 0], [4000, 5000]),
    wall('w-up-l', [8000, 0], [8000, 6000]),
    {
      id: 'win-t',
      kind: 'window',
      typeId: 't-window-1800',
      hostId: 'w-up-t',
      alongMm: 1500,
      sillMm: 900,
      flipFacing: false,
    },
  ];
  doc.joins = [
    { id: 'j-m', walls: ['w-up-m', 'w-lean'], kind: 'miter' },
    { id: 'j-t', walls: ['w-lean', 'w-up-t'], kind: 'butt', through: 'w-lean' },
    { id: 'j-l', walls: ['w-lean', 'w-up-l'], kind: 'butt', through: 'w-lean' },
  ];
  return doc;
}

/**
 * F52 (FU3a): openings in F50's leaning walls. A window and a door in the free wall, a window in
 * a wall of the mitred square, and a plain opening in an arc of the glass ring; sills and
 * heights along the faces (FU-U4).
 */
export function f52LeanOpenings(): BimDocument {
  const doc = f50Lean();
  doc.project.name = 'Lean openings';
  doc.elements.push(
    {
      id: 'win-free',
      kind: 'window',
      typeId: 't-window-1800',
      hostId: 'w-free',
      alongMm: 800,
      sillMm: 900,
      flipFacing: false,
    },
    {
      id: 'door-free',
      kind: 'door',
      typeId: 't-door-900',
      hostId: 'w-free',
      alongMm: 4000,
      flipFacing: false,
      flipHand: false,
    },
    {
      id: 'win-sq',
      kind: 'window',
      typeId: 't-window-1800',
      hostId: 'w-sq-1',
      alongMm: 2100,
      sillMm: 1200,
      flipFacing: true,
    },
    {
      id: 'o-ring',
      kind: 'opening',
      hostId: 'w-ring-1',
      wall: { alongMm: 3000, sillMm: 1000, widthMm: 1500, heightMm: 2000 },
    },
  );
  return doc;
}

/**
 * F51 (LR3): spiral ramps. One and a half turns counter-clockwise from GL to L1 around a 2 m
 * core, a clockwise quarter turn rising 1 m, and a half turn going down from L1, all 200 mm
 * slabs.
 */
export function f51Ramps(): BimDocument {
  const doc = emptyBim();
  Object.assign(doc, baseTypes());
  doc.project.name = 'Ramps';
  doc.levels = [
    { id: 'l-gl', name: 'GL', elevationMm: 0 },
    { id: 'l-1', name: 'L1', elevationMm: 4000 },
  ];
  const ramp = (
    id: string,
    center: [number, number],
    radii: [number, number],
    startAngleRad: number,
    sweepRad: number,
    base: { level: string; offsetMm: number },
    top: { level: string; offsetMm: number },
  ): BimElement => ({
    id,
    kind: 'ramp',
    typeId: 't-slab-200',
    center: { xy: center },
    innerRadiusMm: radii[0],
    outerRadiusMm: radii[1],
    startAngleRad,
    sweepRad,
    base,
    top,
  });
  doc.elements = [
    ramp(
      'r-spiral',
      [0, 0],
      [2000, 5000],
      0,
      3 * Math.PI,
      { level: 'l-gl', offsetMm: 0 },
      {
        level: 'l-1',
        offsetMm: 0,
      },
    ),
    ramp(
      'r-quarter',
      [20000, 0],
      [3000, 4500],
      Math.PI / 2,
      -Math.PI / 2,
      {
        level: 'l-gl',
        offsetMm: 0,
      },
      { level: 'l-gl', offsetMm: 1000 },
    ),
    ramp(
      'r-down',
      [0, 20000],
      [1000, 3000],
      Math.PI,
      Math.PI,
      { level: 'l-1', offsetMm: 0 },
      {
        level: 'l-1',
        offsetMm: -2000,
      },
    ),
  ];
  return doc;
}

/**
 * F55 (LS4): openings in F51's ramps, cut upright. A 1,000 mm square over the spiral's north
 * (at 90° it passes both turns there, at 90° and 450°), one over its south (270°, one turn), and
 * an 800 mm square on the quarter ramp at 45° round its centre.
 */
export function f55RampOpenings(): BimDocument {
  const doc = f51Ramps();
  doc.project.name = 'Ramp openings';
  const square = (x: number, y: number, side: number): BimLoop => [
    [x - side / 2, y - side / 2],
    [x + side / 2, y - side / 2],
    [x + side / 2, y + side / 2],
    [x - side / 2, y + side / 2],
  ];
  const c = 3750 * Math.SQRT1_2;
  doc.elements.push(
    {
      id: 'o-north',
      kind: 'opening',
      hostId: 'r-spiral',
      slab: { boundary: square(0, 3500, 1000) },
    },
    {
      id: 'o-south',
      kind: 'opening',
      hostId: 'r-spiral',
      slab: { boundary: square(0, -3500, 1000) },
    },
    {
      id: 'o-quarter',
      kind: 'opening',
      hostId: 'r-quarter',
      slab: { boundary: square(20000 + c, c, 800) },
    },
    // LS5: railings, 50 mm steel bands, along both edges of the spiral and the quarter's outside.
    {
      id: 'rail-in',
      kind: 'railing',
      typeId: 't-rail-50',
      hostId: 'r-spiral',
      side: 'inner',
      heightMm: 1100,
    },
    {
      id: 'rail-out',
      kind: 'railing',
      typeId: 't-rail-50',
      hostId: 'r-spiral',
      side: 'outer',
      heightMm: 1100,
    },
    {
      id: 'rail-quarter',
      kind: 'railing',
      typeId: 't-rail-50',
      hostId: 'r-quarter',
      side: 'outer',
      heightMm: 1200,
    },
  );
  doc.types.push({
    id: 't-rail-50',
    kind: 'wall',
    name: 'Steel railing 50',
    layers: [{ materialId: 'm-steel', thicknessMm: 50 }],
  });
  return doc;
}

/**
 * F55 (LS6): straight stairs. A 1,200 mm flight from GL to L1 (3,000 mm) in 17 risers on a
 * 150 mm waist (its underside meets the floor 7 mm past the first riser), and a 1,000 mm flight
 * turned north rising 1,800 mm in 10 on a 200 mm waist. A 100 mm waist type too thin for them.
 */
export function f55Stairs(): BimDocument {
  const doc = emptyBim();
  Object.assign(doc, baseTypes());
  doc.project.name = 'Stairs';
  doc.levels = [
    { id: 'l-gl', name: 'GL', elevationMm: 0 },
    { id: 'l-1', name: 'L1', elevationMm: 3000 },
  ];
  doc.types.push(
    {
      id: 't-waist-150',
      kind: 'slab',
      name: 'RC waist 150',
      layers: [{ materialId: 'm-concrete', thicknessMm: 150 }],
    },
    {
      id: 't-waist-100',
      kind: 'slab',
      name: 'RC waist 100',
      layers: [{ materialId: 'm-concrete', thicknessMm: 100 }],
    },
  );
  const stair = (
    id: string,
    typeId: string,
    xy: [number, number],
    directionRad: number,
    widthMm: number,
    risers: number,
    treadMm: number,
    top: { level: string; offsetMm: number },
  ): BimElement => ({
    id,
    kind: 'stair',
    typeId,
    start: { xy },
    directionRad,
    widthMm,
    risers,
    treadMm,
    base: { level: 'l-gl', offsetMm: 0 },
    top,
  });
  doc.elements = [
    stair('st-main', 't-waist-150', [0, 0], 0, 1200, 17, 260, { level: 'l-1', offsetMm: 0 }),
    stair('st-north', 't-slab-200', [6000, 0], Math.PI / 2, 1000, 10, 280, {
      level: 'l-gl',
      offsetMm: 1800,
    }),
  ];
  return doc;
}

/**
 * F48 (TW5): sloped slabs (ramps). A straight ramp from GL up to L1 with a hole and an opening,
 * rising square to its west edge, and a half-round ramp falling 1,000 mm from L1 away from its
 * straight edge.
 */
export function f48Ramp(): BimDocument {
  const doc = emptyBim();
  Object.assign(doc, baseTypes());
  doc.project.name = 'Ramp';
  doc.levels = [
    { id: 'l-gl', name: 'GL', elevationMm: 0 },
    { id: 'l-1', name: 'L1', elevationMm: 3000 },
  ];
  doc.elements = [
    {
      id: 's-ramp',
      kind: 'slab',
      typeId: 't-slab-200',
      top: { level: 'l-gl', offsetMm: 200 },
      boundary: [
        [0, 0],
        [12000, 0],
        [12000, 3000],
        [0, 3000],
      ],
      holes: [
        [
          [5000, 1000],
          [7000, 1000],
          [7000, 2000],
          [5000, 2000],
        ],
      ],
      slope: { edge: 3, endTop: { level: 'l-1', offsetMm: 0 } },
    },
    {
      id: 's-half',
      kind: 'slab',
      typeId: 't-slab-200',
      top: { level: 'l-1', offsetMm: 0 },
      boundary: [
        [26000, 0, 1],
        [20000, 0],
        [23000, 0],
      ],
      holes: [],
      slope: { edge: 1, endTop: { level: 'l-1', offsetMm: -1000 } },
    },
    // An opening near the ramp's high end, through its whole thickness.
    {
      id: 'o-ramp',
      kind: 'opening',
      hostId: 's-ramp',
      slab: {
        boundary: [
          [10000, 1000],
          [11000, 1000],
          [11000, 2000],
          [10000, 2000],
        ],
      },
    },
  ];
  return doc;
}

export function f40Lattice(): BimDocument {
  const doc = emptyBim();
  Object.assign(doc, baseTypes());
  doc.project.name = 'Lattice';
  doc.types.push(
    {
      id: 't-member-box',
      kind: 'member',
      name: 'Steel box 300',
      profile: { shape: 'box', depthMm: 300, widthMm: 300, wallMm: 12 },
      materialId: 'm-steel',
    },
    {
      id: 't-member-round',
      kind: 'member',
      name: 'Steel tube 400',
      profile: { shape: 'circle', diameterMm: 400 },
      materialId: 'm-steel',
    },
  );
  doc.levels = [
    { id: 'l-gl', name: 'GL', elevationMm: 0 },
    { id: 'l-1', name: 'L1', elevationMm: 6000 },
  ];
  doc.grids = [
    { id: 'g-a', label: 'A', start: [10000, -2000], end: [10000, 12000] },
    { id: 'g-1', label: '1', start: [-2000, 0], end: [14000, 0] },
  ];
  const gl = (offsetMm = 0) => ({ level: 'l-gl', offsetMm });
  const l1 = (offsetMm = 0) => ({ level: 'l-1', offsetMm });
  doc.elements = [
    {
      id: 'c-lean',
      kind: 'column',
      typeId: 't-column-600',
      at: { xy: [0, 0] },
      topAt: { xy: [2000, 0] },
      rotationRad: 0,
      base: gl(),
      top: l1(),
    },
    {
      id: 'b-slope',
      kind: 'beam',
      typeId: 't-beam-400x700',
      start: { xy: [0, 0] },
      end: { xy: [6000, 0] },
      top: l1(),
      endTop: l1(1500),
    },
    {
      id: 'm-diag',
      kind: 'member',
      typeId: 't-member-box',
      start: { at: { xy: [0, 6000] }, height: gl() },
      end: { at: { xy: [4000, 9000] }, height: l1() },
      rotationRad: 0.3,
    },
    {
      id: 'm-vert',
      kind: 'member',
      typeId: 't-member-round',
      start: { at: { xy: [8000, 0] }, height: gl() },
      end: { at: { xy: [8000, 0] }, height: l1() },
      rotationRad: 0,
    },
    {
      id: 'm-flat',
      kind: 'member',
      typeId: 't-member-box',
      start: { at: { xy: [0, 10000] }, height: l1() },
      end: { at: { xy: [6000, 10000] }, height: l1() },
      rotationRad: 0,
    },
    {
      id: 'm-grid',
      kind: 'member',
      typeId: 't-member-round',
      start: { at: { grid: ['g-a', 'g-1'] }, height: gl() },
      end: { at: { xy: [12000, 3000] }, height: l1() },
      rotationRad: 0,
    },
  ];
  return doc;
}
