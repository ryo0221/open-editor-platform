/**
 * GV3 (docs/cad/gulliver-world.md): Lilliput's buildings at true size (Gulliver's millimetres),
 * from the English text (Project Gutenberg #829, Part I). Every building is for 146 mm people
 * (GV2b `inhabitantHeightMm`), so the BIM body rules check them at Lilliput's size.
 *
 * Where the text gives a size it is used as written; where it is silent the size is the author's
 * choice, said so in the element's `properties.Source` (本文 = the text, 推定 = derived from the
 * text, 創作 = the author's choice).
 */
import type {
  BimDocument,
  BimElement,
  BimLevel,
  BimLoop,
  BimMaterial,
  BimRoofShape,
  BimType,
  BimWall,
  BimWallJoin,
} from '@editor-platform/bim-core';

export const inch = 25.4;
export const foot = 304.8;
/** Lilliputians are "not six inches high" (第1篇第1章); Gulliver 1,750 mm gives 146 mm at 12 : 1. */
export const lilliputianMm = 146;

export type Basis = '本文' | '推定' | '創作';

export function emptyDoc(name: string, inhabitantHeightMm = lilliputianMm): BimDocument {
  return {
    schemaVersion: 1,
    units: 'mm',
    axes: 'right-handed-z-up',
    project: { name, trueNorthRad: 0, siteElevationMm: 0 },
    levels: [],
    grids: [],
    materials: [],
    types: [],
    elements: [],
    joins: [],
    views: [],
    propertySets: [
      {
        id: 'ps-gulliver',
        name: 'Gulliver_Source',
        properties: [
          { name: 'Source', type: 'string' },
          { name: 'Chapter', type: 'string' },
        ],
      },
    ],
    inhabitantHeightMm,
  };
}

export const look = (color: string, roughness = 0.85) => ({
  color,
  opacity: 1,
  roughness,
  metalness: 0,
});
export const materials: BimMaterial[] = [
  { id: 'm-stone', name: 'Stone', category: 'masonry', appearance: look('#b9ad97') },
  { id: 'm-brick', name: 'Brick', category: 'masonry', appearance: look('#b97a5a') },
  { id: 'm-plaster', name: 'Plaster', category: 'finish', appearance: look('#e8dcc4') },
  { id: 'm-tile', name: 'Roof tile', category: 'other', appearance: look('#8a3f2c', 0.7) },
  { id: 'm-slate', name: 'Slate', category: 'other', appearance: look('#4f5866', 0.6) },
  { id: 'm-paving', name: 'Paving', category: 'masonry', appearance: look('#9a8f80') },
  { id: 'm-timber', name: 'Timber', category: 'wood', appearance: look('#7a5634') },
];

export const source = (basis: Basis, chapter: string) => ({
  'ps-gulliver': { Source: basis, Chapter: chapter },
});

export const rect = (x0: number, y0: number, x1: number, y1: number): BimLoop => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

/** Four walls round a rectangle (counter-clockwise, centred on the axes) with butt corners. */
export function box(
  id: string,
  [x0, y0, x1, y1]: [number, number, number, number],
  typeId: string,
  base: string,
  top: BimWall['top'],
  extra: Partial<BimWall> = {},
): { walls: BimWall[]; joins: BimWallJoin[] } {
  const corners: [number, number][] = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
  const sides = ['s', 'e', 'n', 'w'];
  const walls = sides.map(
    (side, i): BimWall => ({
      id: `${id}-${side}`,
      kind: 'wall',
      typeId,
      start: { xy: corners[i] },
      end: { xy: corners[(i + 1) % 4] },
      location: 'center',
      base: { level: base, offsetMm: 0 },
      top,
      ...extra,
    }),
  );
  const joins = sides.map(
    (side, i): BimWallJoin => ({
      id: `${id}-j${i}`,
      walls: [walls[i].id, walls[(i + 1) % 4].id],
      kind: 'butt',
      through: i % 2 === 0 ? walls[i].id : walls[(i + 1) % 4].id,
    }),
  );
  return { walls, joins };
}

export const round = (v: number) => Math.round(v * 10) / 10;

/** The numbers the text gives for Mildendo and the ones the author chose (all mm). */
export const mildendoSizes = {
  /** 第1篇第4章: "The town is an exact square, each side of the wall being five hundred feet long." */
  side: 500 * foot,
  /** "The wall which encompassed it is two feet and a half high, and at least eleven inches broad". */
  wallHeight: 2.5 * foot,
  wallThickness: 11 * inch,
  /** "flanked with strong towers at ten feet distance". */
  towerPitch: 10 * foot,
  /** 創作: a tower 2 ft square and 3.5 ft high. */
  tower: 2 * foot,
  towerHeight: 3.5 * foot,
  /** "The two great streets, which run across and divide it into four quarters, are five feet wide." */
  street: 5 * foot,
  /** "The lanes and alleys ... are from twelve to eighteen inches." */
  lane: 18 * inch,
  /** "The houses are from three to five stories." 創作: a storey of 250 mm (3 m at 1,750 mm). */
  storey: 250,
  /** 第1篇第4章: "The emperor's palace is in the centre of the city where the two great streets meet. It is enclosed by a wall of two feet high, and twenty feet distant from the buildings." */
  palaceWallHeight: 2 * foot,
  palaceWallGap: 20 * foot,
  /** "The outward court is a square of forty feet". */
  outerCourt: 40 * foot,
  /** "the buildings of the outer court being at least five feet high". */
  palaceBuildingHeight: 5 * foot,
  /** "between the first and second court, which was eight feet wide". */
  courtGap: 8 * foot,
  /** 創作: a terrace house 8 ft wide and 10 ft deep. */
  houseWidth: 8 * foot,
  houseDepth: 10 * foot,
} as const;

function lilliputTypes(): BimType[] {
  const s = mildendoSizes;
  return [
    {
      id: 't-city-wall',
      kind: 'wall',
      name: 'City wall, stone 11 in',
      layers: [{ materialId: 'm-stone', thicknessMm: round(s.wallThickness) }],
      common: { isExternal: true, loadBearing: true },
    },
    {
      id: 't-palace-wall',
      kind: 'wall',
      name: 'Palace enclosure, stone 8 in',
      layers: [{ materialId: 'm-stone', thicknessMm: round(8 * inch) }],
      common: { isExternal: true, loadBearing: true },
    },
    {
      id: 't-palace',
      kind: 'wall',
      name: 'Palace wall, stone 4 in',
      layers: [
        { materialId: 'm-stone', thicknessMm: round(3.5 * inch) },
        { materialId: 'm-plaster', thicknessMm: round(0.5 * inch) },
      ],
      common: { isExternal: true, loadBearing: true },
    },
    {
      id: 't-house-wall',
      kind: 'wall',
      name: 'House wall, brick 30 + plaster 5',
      layers: [
        { materialId: 'm-brick', thicknessMm: 30 },
        { materialId: 'm-plaster', thicknessMm: 5 },
      ],
      common: { isExternal: true, loadBearing: true },
    },
    {
      id: 't-street',
      kind: 'slab',
      name: 'Street paving 30',
      layers: [{ materialId: 'm-paving', thicknessMm: 30 }],
    },
    {
      id: 't-floor',
      kind: 'slab',
      name: 'Ground floor 20',
      layers: [{ materialId: 'm-timber', thicknessMm: 20 }],
    },
    {
      id: 't-tile-roof',
      kind: 'roof',
      name: 'Tile roof 15',
      layers: [{ materialId: 'm-tile', thicknessMm: 15 }],
    },
    {
      id: 't-slate-roof',
      kind: 'roof',
      name: 'Slate roof 25',
      layers: [{ materialId: 'm-slate', thicknessMm: 25 }],
    },
    {
      id: 't-tower',
      kind: 'column',
      name: 'Wall tower 2 ft',
      profile: { shape: 'rect', widthMm: round(s.tower), depthMm: round(s.tower) },
      materialId: 'm-stone',
    },
    // 1,750 mm people's 900 × 2,100 door and 1,200 × 1,200 window at 146 / 1,750.
    { id: 't-house-door', kind: 'door', name: 'House door 75 × 175', widthMm: 75, heightMm: 175 },
    {
      id: 't-house-window',
      kind: 'window',
      name: 'House window 100 × 100',
      widthMm: 100,
      heightMm: 100,
    },
    {
      id: 't-palace-gate',
      kind: 'door',
      name: 'Palace gate 1 × 2 ft',
      widthMm: round(1 * foot),
      heightMm: round(2 * foot),
    },
    {
      id: 't-palace-window',
      kind: 'window',
      name: 'Palace window 4 × 6 in',
      widthMm: round(4 * inch),
      heightMm: round(6 * inch),
    },
  ];
}

/** A tiny deterministic generator, so the town is the same on every run. */
function mulberry(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface MildendoSummary {
  towers: number;
  gates: number;
  houses: number;
  blocks: number;
  storeys: Record<3 | 4 | 5, number>;
}

/**
 * F105: Mildendo, the capital (第1篇第4章), centred on the origin with the great streets on the
 * axes: the 500 ft square wall (2.5 ft high, 11 in thick) with a gate where each great street
 * meets it (the text names only the great western gate), towers every 10 ft, the two 5 ft
 * streets, terraces of 3–5 storey houses between 18 in lanes, and the palace where the streets
 * meet inside its 2 ft wall 20 ft from the buildings: the outward court 40 ft square and an
 * 8 ft gap to the second court, the royal apartments in the inmost.
 */
export function f105Mildendo(): { doc: BimDocument; summary: MildendoSummary } {
  const s = mildendoSizes;
  const doc = emptyDoc('Mildendo');
  doc.materials = materials.map((m) => ({ ...m }));
  doc.types = lilliputTypes();
  doc.levels = [0, 1, 2, 3, 4, 5].map(
    (i): BimLevel => ({ id: `l-${i + 1}`, name: `${i + 1}F`, elevationMm: i * s.storey }),
  );
  doc.levels[5].name = 'R5';
  const els: BimElement[] = [];
  const joins: BimWallJoin[] = [];
  const half = s.side / 2;
  const gateHalf = s.street / 2;
  const ch4 = '第1篇第4章';

  // The city wall: each side in two runs, the gap between them a gate on a great street.
  const corners: [number, number][] = [
    [-half, -half],
    [half, -half],
    [half, half],
    [-half, half],
  ];
  const sideNames = ['south', 'east', 'north', 'west'];
  for (let i = 0; i < 4; i++) {
    const a = corners[i],
      b = corners[(i + 1) % 4];
    const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const dir: [number, number] = [Math.sign(b[0] - a[0]), Math.sign(b[1] - a[1])];
    const g1: [number, number] = [mid[0] - dir[0] * gateHalf, mid[1] - dir[1] * gateHalf];
    const g2: [number, number] = [mid[0] + dir[0] * gateHalf, mid[1] + dir[1] * gateHalf];
    for (const [k, start, end] of [
      ['1', a, g1],
      ['2', g2, b],
    ] as const)
      els.push({
        id: `cw-${sideNames[i]}-${k}`,
        name: `City wall ${sideNames[i]} ${k}`,
        kind: 'wall',
        typeId: 't-city-wall',
        start: { xy: [round(start[0]), round(start[1])] },
        end: { xy: [round(end[0]), round(end[1])] },
        location: 'center',
        base: { level: 'l-1', offsetMm: 0 },
        top: { heightMm: round(s.wallHeight) },
        properties: source('本文', ch4),
      });
  }
  for (let i = 0; i < 4; i++) {
    const here = `cw-${sideNames[i]}-2`,
      next = `cw-${sideNames[(i + 1) % 4]}-1`;
    joins.push({ id: `cw-j${i}`, walls: [here, next], kind: 'butt', through: here });
  }
  // Towers every 10 ft along the wall; at a gate the tower would stand in the road, so a tower
  // flanks the gate on each side instead (創作).
  let towers = 0;
  const perSide = Math.round(s.side / s.towerPitch);
  const tower = (id: string, x: number, y: number, basis: Basis) => {
    towers++;
    els.push({
      id,
      kind: 'column',
      typeId: 't-tower',
      at: { xy: [round(x), round(y)] },
      rotationRad: 0,
      base: { level: 'l-1', offsetMm: 0 },
      top: { heightMm: round(s.towerHeight) },
      properties: source(basis, ch4),
    });
  };
  for (let i = 0; i < 4; i++) {
    const a = corners[i],
      b = corners[(i + 1) % 4];
    for (let k = 0; k < perSide; k++) {
      const t = k / perSide;
      const x = a[0] + (b[0] - a[0]) * t,
        y = a[1] + (b[1] - a[1]) * t;
      if (k === perSide / 2) {
        const dx = Math.sign(b[0] - a[0]),
          dy = Math.sign(b[1] - a[1]);
        const off = gateHalf + s.tower / 2;
        tower(`tw-${sideNames[i]}-gate-a`, x - dx * off, y - dy * off, '創作');
        tower(`tw-${sideNames[i]}-gate-b`, x + dx * off, y + dy * off, '創作');
        continue;
      }
      tower(`tw-${sideNames[i]}-${k}`, x, y, '本文');
    }
  }

  // The palace: its enclosure, 2 ft high, 20 ft from the buildings, gates on the great streets.
  const ring1 = s.outerCourt + 2 * 20 * foot; // the outer court's buildings, 20 ft deep (創作)
  const enclosure = ring1 + 2 * s.palaceWallGap;
  {
    const h = enclosure / 2;
    const pc: [number, number][] = [
      [-h, -h],
      [h, -h],
      [h, h],
      [-h, h],
    ];
    for (let i = 0; i < 4; i++) {
      const a = pc[i],
        b = pc[(i + 1) % 4];
      const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const dir: [number, number] = [Math.sign(b[0] - a[0]), Math.sign(b[1] - a[1])];
      const g1: [number, number] = [mid[0] - dir[0] * gateHalf, mid[1] - dir[1] * gateHalf];
      const g2: [number, number] = [mid[0] + dir[0] * gateHalf, mid[1] + dir[1] * gateHalf];
      for (const [k, start, end] of [
        ['1', a, g1],
        ['2', g2, b],
      ] as const)
        els.push({
          id: `pw-${sideNames[i]}-${k}`,
          name: `Palace enclosure ${sideNames[i]} ${k}`,
          kind: 'wall',
          typeId: 't-palace-wall',
          start: { xy: [round(start[0]), round(start[1])] },
          end: { xy: [round(end[0]), round(end[1])] },
          location: 'center',
          base: { level: 'l-1', offsetMm: 0 },
          top: { heightMm: round(s.palaceWallHeight) },
          properties: source('本文', ch4),
        });
    }
    for (let i = 0; i < 4; i++) {
      const here = `pw-${sideNames[i]}-2`,
        next = `pw-${sideNames[(i + 1) % 4]}-1`;
      joins.push({ id: `pw-j${i}`, walls: [here, next], kind: 'butt', through: here });
    }
  }
  // The outward court's buildings: a ring 20 ft deep round the 40 ft court, 5 ft high, a gate
  // through each side, windows on the outer faces.
  const palaceBlock = (
    id: string,
    outer: number,
    inner: number,
    height: number,
    basis: Basis,
    windows: number,
  ) => {
    const o = outer / 2,
      n = inner / 2;
    const ob = box(`${id}-out`, [-o, -o, o, o], 't-palace', 'l-1', { heightMm: round(height) });
    const ib = box(`${id}-in`, [-n, -n, n, n], 't-palace', 'l-1', { heightMm: round(height) });
    for (const w of [...ob.walls, ...ib.walls]) els.push({ ...w, properties: source(basis, ch4) });
    joins.push(...ob.joins, ...ib.joins);
    const len = outer;
    for (const w of ob.walls) {
      els.push({
        id: `${w.id}-gate`,
        kind: 'door',
        typeId: 't-palace-gate',
        hostId: w.id,
        alongMm: round(len / 2 - foot / 2),
        flipFacing: false,
        flipHand: false,
      });
      for (let k = 0; k < windows; k++) {
        const along = ((k + 0.5) / windows) * len;
        if (Math.abs(along - len / 2) < 2 * foot) continue;
        for (const sill of [height * 0.25, height * 0.62])
          els.push({
            id: `${w.id}-win-${k}-${Math.round(sill)}`,
            kind: 'window',
            typeId: 't-palace-window',
            hostId: w.id,
            alongMm: round(along - 2 * inch),
            sillMm: round(sill),
            flipFacing: false,
          });
      }
    }
    for (const w of ib.walls)
      els.push({
        id: `${w.id}-gate`,
        kind: 'door',
        typeId: 't-palace-gate',
        hostId: w.id,
        alongMm: round(inner / 2 - foot / 2),
        flipFacing: false,
        flipHand: false,
      });
    // Roof strips over the ring (flat; the text does not say).
    const strips: BimLoop[] = [
      rect(-o, -o, o, -n),
      rect(-o, n, o, o),
      rect(-o, -n, -n, n),
      rect(n, -n, o, n),
    ];
    strips.forEach((boundary, k) =>
      els.push({
        id: `${id}-roof-${k}`,
        kind: 'roof',
        typeId: 't-slate-roof',
        base: { level: 'l-1', offsetMm: round(height) },
        boundary: boundary.map(([x, y]) => [round(x), round(y)]),
        shape: { form: 'flat' },
      }),
    );
  };
  palaceBlock('pal-outer', ring1, s.outerCourt, s.palaceBuildingHeight, '本文', 12);
  // The second court's buildings 8 ft inside the outward court (the gap Gulliver stood in), 4 ft
  // deep round a 16 ft inmost court (創作 apart from the 8 ft).
  const ring2 = s.outerCourt - 2 * s.courtGap;
  palaceBlock('pal-second', ring2, ring2 - 2 * 4 * foot, s.palaceBuildingHeight, '推定', 4);
  // The royal apartments in the inmost court: 10 ft square, 6 ft to the eaves, a hip roof (創作).
  {
    const a = 5 * foot;
    // The walls rise past the hip's apex and the roof's underside cuts them (no gap under the
    // eaves, which overhang 150 mm).
    const apt = box(
      'pal-royal',
      [-a, -a, a, a],
      't-palace',
      'l-1',
      { heightMm: round(6 * foot + (a + 150) + 300) },
      { clipBy: 'pal-royal-roof' },
    );
    for (const w of apt.walls) {
      els.push({ ...w, properties: source('創作', ch4) });
      for (const sill of [1.5 * foot, 3.8 * foot])
        for (const along of [2.5 * foot, 7.5 * foot])
          els.push({
            id: `${w.id}-win-${Math.round(along)}-${Math.round(sill)}`,
            kind: 'window',
            typeId: 't-palace-window',
            hostId: w.id,
            alongMm: round(along - 2 * inch),
            sillMm: round(sill),
            flipFacing: false,
          });
    }
    joins.push(...apt.joins);
    els.push({
      id: 'pal-royal-roof',
      kind: 'roof',
      typeId: 't-slate-roof',
      base: { level: 'l-1', offsetMm: round(6 * foot) },
      boundary: rect(-a - 150, -a - 150, a + 150, a + 150).map(([x, y]) => [round(x), round(y)]),
      shape: { form: 'hip', slopeRad: Math.PI / 4 },
    });
  }

  // The great streets, gate to palace gate, 5 ft wide.
  const eh = enclosure / 2;
  for (const [id, loop] of [
    ['st-west', rect(-half, -gateHalf, -eh, gateHalf)],
    ['st-east', rect(eh, -gateHalf, half, gateHalf)],
    ['st-south', rect(-gateHalf, -half, gateHalf, -eh)],
    ['st-north', rect(-gateHalf, eh, gateHalf, half)],
  ] as const)
    els.push({
      id,
      kind: 'slab',
      typeId: 't-street',
      top: { level: 'l-1', offsetMm: 0 },
      boundary: loop.map(([x, y]) => [round(x), round(y)]),
      holes: [],
      properties: source('本文', ch4),
    });

  // The quarters: terraces of houses, back to back, 8 ft a house, 7 to a block; 18 in lanes
  // between blocks; a 4 ft way inside the wall (創作) and the great streets' edge.
  const rand = mulberry(1726);
  const storeys: Record<3 | 4 | 5, number> = { 3: 0, 4: 0, 5: 0 };
  let houses = 0,
    blocks = 0;
  const inner = half - s.wallThickness / 2 - 4 * foot;
  const start = gateHalf + 2 * foot;
  const depth = 2 * s.houseDepth;
  const perBlock = 7;
  const length = perBlock * s.houseWidth;
  const keepOut = eh + 4 * foot;
  const roofPitch = (40 * Math.PI) / 180;
  const gableRise = (depth / 2 + 40) * Math.tan(roofPitch);
  for (const [qx, qy, q] of [
    [1, 1, 'ne'],
    [-1, 1, 'nw'],
    [-1, -1, 'sw'],
    [1, -1, 'se'],
  ] as const) {
    for (let row = 0; ; row++) {
      const y0 = start + row * (depth + s.lane);
      if (y0 + depth > inner) break;
      for (let col = 0; ; col++) {
        const x0 = start + col * (length + s.lane);
        if (x0 + length > inner) break;
        // Leave the palace and its 20 ft-wide surroundings clear.
        if (x0 < keepOut && y0 < keepOut) continue;
        const n = (3 + Math.floor(rand() * 3)) as 3 | 4 | 5;
        storeys[n] += 2 * perBlock;
        houses += 2 * perBlock;
        blocks++;
        const xa = qx * x0,
          xb = qx * (x0 + length),
          ya = qy * y0,
          yb = qy * (y0 + depth);
        const id = `h-${q}-${row}-${col}`;
        const b = box(
          id,
          [Math.min(xa, xb), Math.min(ya, yb), Math.max(xa, xb), Math.max(ya, yb)].map(round) as [
            number,
            number,
            number,
            number,
          ],
          't-house-wall',
          'l-1',
          // The walls rise past the ridge and the roof's underside cuts them: the gable ends
          // close (the roof is a surface, not a filled wedge).
          { level: `l-${n + 1}`, offsetMm: round(gableRise + 300) },
          { clipBy: `${id}-roof` },
        );
        for (const w of b.walls) els.push({ ...w, properties: source('本文', ch4) });
        joins.push(...b.joins);
        // Long walls (south and north) carry a door per house and a window per house on the
        // first floor up (both faces: the terraces are back to back).
        for (const side of ['s', 'n']) {
          const host = `${id}-${side}`;
          for (let k = 0; k < perBlock; k++) {
            const along = (k + 0.5) * s.houseWidth;
            els.push({
              id: `${host}-d${k}`,
              kind: 'door',
              typeId: 't-house-door',
              hostId: host,
              alongMm: round(along - 75 - 40),
              flipFacing: false,
              flipHand: false,
            });
            els.push({
              id: `${host}-w${k}`,
              kind: 'window',
              typeId: 't-house-window',
              hostId: host,
              alongMm: round(along + 40),
              sillMm: s.storey + 80,
              flipFacing: false,
            });
          }
        }
        const [rx0, ry0, rx1, ry1] = [
          Math.min(xa, xb),
          Math.min(ya, yb),
          Math.max(xa, xb),
          Math.max(ya, yb),
        ];
        const ridge: BimRoofShape = { form: 'gable', slopeRad: roofPitch, ridgeRad: 0 };
        els.push({
          id: `${id}-roof`,
          kind: 'roof',
          typeId: 't-tile-roof',
          base: { level: `l-${n + 1}`, offsetMm: 0 },
          boundary: rect(rx0 - 40, ry0 - 40, rx1 + 40, ry1 + 40).map(([x, y]) => [
            round(x),
            round(y),
          ]),
          shape: ridge,
        });
      }
    }
  }
  // Everything not sized by the text above is the author's: roofs, doors, windows, palace gates.
  for (const e of els) e.properties ??= source('創作', ch4);
  doc.elements = els;
  doc.joins = joins;
  return { doc, summary: { towers, gates: 4, houses, blocks, storeys } };
}

/**
 * F106: the ancient temple outside the west gate where Gulliver was lodged (第1篇第1章), with
 * the turret across the highway. The text: the largest in the kingdom; its great gate "fronting
 * to the north was about four feet high, and almost two feet wide"; "on each side of the gate
 * was a small window, not above six inches from the ground"; Gulliver could creep in and lie at
 * full length; the turret "at least five feet high" stood "on the other side of the great
 * highway, at twenty feet distance". The plan (40 × 30 ft), the 10 ft walls, the roof and the
 * turret's 4 ft square are the author's (創作). The gate sits on the origin's north wall.
 */
export function f106Temple(): BimDocument {
  const doc = emptyDoc('Ancient temple');
  doc.materials = materials.map((m) => ({ ...m }));
  doc.types = [
    {
      id: 't-temple-wall',
      kind: 'wall',
      name: 'Temple wall, stone 1 ft',
      layers: [{ materialId: 'm-stone', thicknessMm: round(foot) }],
      common: { isExternal: true, loadBearing: true },
    },
    {
      id: 't-temple-floor',
      kind: 'slab',
      name: 'Temple floor, paving 2 in',
      layers: [{ materialId: 'm-paving', thicknessMm: round(2 * inch) }],
    },
    {
      id: 't-temple-roof',
      kind: 'roof',
      name: 'Temple roof, slate 3 in',
      layers: [{ materialId: 'm-slate', thicknessMm: round(3 * inch) }],
    },
    {
      id: 't-temple-gate',
      kind: 'door',
      name: 'Great gate 23 in × 4 ft',
      widthMm: round(23 * inch),
      heightMm: round(4 * foot),
    },
    {
      id: 't-temple-window',
      kind: 'window',
      name: 'Small window 8 × 10 in',
      widthMm: round(8 * inch),
      heightMm: round(10 * inch),
    },
    {
      id: 't-turret-wall',
      kind: 'wall',
      name: 'Turret wall, stone 3 in',
      layers: [{ materialId: 'm-stone', thicknessMm: round(3 * inch) }],
    },
    {
      id: 't-turret-door',
      kind: 'door',
      name: 'Turret door 75 × 175',
      widthMm: 75,
      heightMm: 175,
    },
    {
      id: 't-highway',
      kind: 'slab',
      name: 'Highway',
      layers: [{ materialId: 'm-paving', thicknessMm: 30 }],
    },
  ];
  const w = 40 * foot,
    d = 30 * foot,
    h = 10 * foot;
  doc.levels = [
    { id: 'l-ground', name: 'Ground', elevationMm: 0 },
    { id: 'l-eaves', name: 'Eaves', elevationMm: round(h) },
  ];
  const ch1 = '第1篇第1章';
  // The walls rise past the ridge and the roof's underside cuts them: the gable ends close.
  const t = box(
    'temple',
    [round(-w / 2), round(-d), round(w / 2), 0],
    't-temple-wall',
    'l-ground',
    { heightMm: round(h + (d / 2 + 300) * Math.tan(Math.PI / 6) + 600) },
    { clipBy: 'temple-roof' },
  );
  const els: BimElement[] = t.walls.map((x) => ({ ...x, properties: source('創作', ch1) }));
  // The north wall runs east → west (box order s, e, n, w): the gate in its middle.
  const gateW = round(23 * inch);
  els.push({
    id: 'temple-gate',
    name: 'Great gate',
    kind: 'door',
    typeId: 't-temple-gate',
    hostId: 'temple-n',
    alongMm: round(w / 2 - gateW / 2),
    flipFacing: false,
    flipHand: false,
    properties: source('本文', ch1),
  });
  for (const [id, off] of [
    ['temple-window-east', -gateW / 2 - 8 * inch - 6 * inch],
    ['temple-window-west', gateW / 2 + 6 * inch],
  ] as const)
    els.push({
      id,
      name: id === 'temple-window-west' ? 'Small window (the chains)' : 'Small window',
      kind: 'window',
      typeId: 't-temple-window',
      hostId: 'temple-n',
      alongMm: round(w / 2 + off),
      sillMm: round(5 * inch),
      flipFacing: false,
      properties: source('本文', ch1),
    });
  els.push(
    {
      id: 'temple-floor',
      kind: 'slab',
      typeId: 't-temple-floor',
      top: { level: 'l-ground', offsetMm: 0 },
      boundary: rect(-w / 2, -d, w / 2, 0).map(([x, y]) => [round(x), round(y)]),
      holes: [],
    },
    {
      id: 'temple-roof',
      kind: 'roof',
      typeId: 't-temple-roof',
      base: { level: 'l-eaves', offsetMm: 0 },
      boundary: rect(-w / 2 - 300, -d - 300, w / 2 + 300, 300).map(([x, y]) => [
        round(x),
        round(y),
      ]),
      shape: { form: 'gable', slopeRad: Math.PI / 6, ridgeRad: 0 },
      properties: source('創作', ch1),
    },
    {
      id: 'temple-space',
      kind: 'space',
      number: '1',
      name: 'Temple (Gulliver lodged here)',
      base: { level: 'l-ground', offsetMm: 0 },
      boundary: rect(-w / 2 + 160, -d + 160, w / 2 - 160, -160).map(([x, y]) => [
        round(x),
        round(y),
      ]),
    },
  );
  // The great highway north of the gate (5 ft, 創作) and the turret 20 ft across it.
  const hw = 5 * foot;
  const gap = 20 * foot;
  els.push({
    id: 'highway',
    kind: 'slab',
    typeId: 't-highway',
    top: { level: 'l-ground', offsetMm: 0 },
    boundary: rect(-w, 6 * foot, w, 6 * foot + hw).map(([x, y]) => [round(x), round(y)]),
    holes: [],
    properties: source('本文', ch1),
  });
  const ts = 4 * foot;
  const tb = box(
    'turret',
    [round(-ts / 2), round(gap), round(ts / 2), round(gap + ts)],
    't-turret-wall',
    'l-ground',
    // Up past the apex, cut by the roof's underside (the eaves overhang 80 mm).
    { heightMm: round(5 * foot + (ts / 2 + 80) * Math.tan(Math.PI / 3) + 300) },
    { clipBy: 'turret-roof' },
  );
  els.push(...tb.walls.map((x) => ({ ...x, properties: source('本文', ch1) })));
  els.push(
    {
      id: 'turret-door',
      kind: 'door',
      typeId: 't-turret-door',
      hostId: 'turret-s',
      alongMm: round(ts / 2 - 37.5),
      flipFacing: false,
      flipHand: false,
    },
    {
      id: 'turret-roof',
      kind: 'roof',
      typeId: 't-temple-roof',
      base: { level: 'l-ground', offsetMm: round(5 * foot) },
      boundary: rect(-ts / 2 - 80, gap - 80, ts / 2 + 80, gap + ts + 80).map(([x, y]) => [
        round(x),
        round(y),
      ]),
      shape: { form: 'hip', slopeRad: Math.PI / 3 },
    },
  );
  for (const e of els) e.properties ??= source(e.id === 'temple-space' ? '本文' : '創作', ch1);
  doc.elements = els;
  doc.joins = [...t.joins, ...tb.joins];
  return doc;
}
