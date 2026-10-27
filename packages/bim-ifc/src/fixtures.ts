import {
  deriveBim,
  f31BoxBuilding,
  f33Types,
  f39Roofs,
  type BimDocument,
  type BimElement,
  type BimProfile,
  type BimRoofFace,
  type BimShape,
  type BimType,
  type BimWall,
  type Vec2,
} from '@editor-platform/bim-core';
import type { BimIfcExportOptions, BimIfcPartMesh } from './export';

/** Fixtures shared by the export and import tests (F35). */

export const opts: BimIfcExportOptions = { artifactId: 'art-1', timeStamp: '2026-10-24T12:00:00' };
export const element = <T extends BimElement>(doc: BimDocument, id: string) =>
  doc.elements.find((e) => e.id === id) as T;

/** A 1,000 mm cube (outward triangles) and an open 1,000 mm square sheet. */
export const cube: BimIfcPartMesh = {
  kind: 'solid',
  closed: true,
  // prettier-ignore
  positions: [0,0,0, 1000,0,0, 1000,1000,0, 0,1000,0, 0,0,1000, 1000,0,1000, 1000,1000,1000, 0,1000,1000],
  // prettier-ignore
  triangles: [0,2,1, 0,3,2, 4,5,6, 4,6,7, 0,1,5, 0,5,4, 1,2,6, 1,6,5, 2,3,7, 2,7,6, 3,0,4, 3,4,7],
  deflectionMm: 0.5,
};
/** The cube with a 500 mm cubical cavity: a second shell facing into the cavity. */
export const hollow: BimIfcPartMesh = {
  ...cube,
  positions: [...cube.positions, ...cube.positions.map((v) => 250 + v / 2)],
  triangles: [
    ...cube.triangles,
    ...cube.triangles.map((_, i, t) => t[i - (i % 3) + [0, 2, 1][i % 3]] + 8),
  ],
  // OH-U1: its CAD body's look, on every triangle.
  styles: [{ color: '#f2efe6', opacity: 1 }],
  triangleStyles: Array<number>(24).fill(0),
};
/** What each solid part mesh holds: its volume and its faceted solids (outer and cavity). */
export const solidParts = new Map([
  [cube, { volume: 1e9, breps: 1 }],
  [hollow, { volume: 1e9 - 125e6, breps: 2 }],
]);
export const sheet: BimIfcPartMesh = {
  kind: 'sheet',
  closed: false,
  positions: [0, 0, 0, 1000, 0, 0, 1000, 1000, 0, 0, 1000, 0],
  triangles: [0, 1, 2, 0, 2, 3],
  deflectionMm: 0.5,
  styles: [{ color: '#38bdf8', opacity: 0.4 }],
  triangleStyles: [0, 0],
};

/**
 * F35's export side: F31 with a mono-pitch roof cutting the east wall and a column, an arc wall
 * with an opening, a slab opening, every column profile, user properties and three parts (one
 * with a cavity).
 */
export function f35Export() {
  const doc = f31BoxBuilding();
  const slope = Math.PI / 12;
  element<Extract<BimElement, { kind: 'roof' }>>(doc, 'r-roof').shape = {
    form: 'mono',
    slopeRad: slope,
    directionRad: Math.PI / 2,
  };
  // Every outer wall rises to 9,000 mm and the roof's underside cuts it.
  for (const id of ['w-south', 'w-east', 'w-north', 'w-west']) {
    const w = element<BimWall>(doc, id);
    w.top = { heightMm: 9000 };
    w.clipBy = 'r-roof';
  }
  const profiles: BimProfile[] = [
    { shape: 'circle', diameterMm: 500 },
    { shape: 'h', depthMm: 400, widthMm: 200, webMm: 8, flangeMm: 13 },
    { shape: 'l', depthMm: 200, widthMm: 150, thicknessMm: 15 },
    { shape: 'channel', depthMm: 300, widthMm: 90, webMm: 9, flangeMm: 13 },
    { shape: 'box', depthMm: 300, widthMm: 250, wallMm: 12 },
  ];
  doc.types.push(
    ...profiles.map(
      (profile): BimType => ({
        id: `t-col-${profile.shape}`,
        kind: 'column',
        name: `Column ${profile.shape}`,
        profile,
        materialId: 'm-steel',
      }),
    ),
    {
      id: 't-part',
      kind: 'part',
      name: 'Fixture',
      source: { artifactId: 'cad-1', versionId: 'v3', contentHash: 'c0ffee'.repeat(10) + 'c0ff' },
      hintBounds: { min: [0, 0, 0], max: [1000, 1000, 1000] },
    },
  );
  doc.propertySets.push({
    id: 'ps-fire',
    name: 'Fire safety',
    properties: [
      { name: 'Rating', type: 'string' },
      { name: 'Minutes', type: 'number' },
      { name: 'Tested', type: 'boolean' },
      { name: 'Cover', type: 'length' },
    ],
  });
  const south = element<BimWall>(doc, 'w-south');
  south.common = { isExternal: true, loadBearing: true, reference: 'EW-1' };
  south.properties = { 'ps-fire': { Rating: 'EI60', Minutes: 60, Tested: true, Cover: 30 } };
  doc.elements.push(
    ...profiles.map(
      (p, i): BimElement => ({
        id: `c-${p.shape}`,
        kind: 'column',
        typeId: `t-col-${p.shape}`,
        at: { xy: [2000 + i * 1500, 2000] },
        rotationRad: 0.3 * i,
        base: { level: 'l-1f', offsetMm: 0 },
        top: { level: 'l-2f', offsetMm: -200 },
      }),
    ),
    {
      id: 'c-clip',
      kind: 'column',
      typeId: 't-column-600',
      at: { xy: [5000, 4000] },
      rotationRad: 0,
      base: { level: 'l-1f', offsetMm: 0 },
      top: { heightMm: 9000 },
      clipBy: 'r-roof',
    },
    {
      id: 'w-arc',
      kind: 'wall',
      typeId: 't-wall-200',
      start: { xy: [13000, 0] },
      end: { xy: [18000, 5000] },
      bulge: Math.tan(Math.PI / 8),
      location: 'center',
      base: { level: 'l-1f', offsetMm: 0 },
      top: { level: 'l-2f', offsetMm: 0 },
    },
    {
      id: 'o-arc',
      kind: 'opening',
      hostId: 'w-arc',
      wall: { alongMm: 2000, sillMm: 500, widthMm: 1000, heightMm: 1500 },
    },
    {
      id: 'o-stair',
      kind: 'opening',
      hostId: 's-2f',
      slab: {
        boundary: [
          [1000, 1000],
          [3000, 1000],
          [3000, 2000],
          [1000, 2000],
        ],
      },
    },
    {
      id: 'p-box',
      kind: 'part',
      typeId: 't-part',
      at: { xy: [2000, 5000] },
      base: { level: 'l-1f', offsetMm: 0 },
      rotationRad: 0.5,
    },
    {
      // Rising towards −Y, highest inside the semicircle, not at a vertex.
      id: 'r-arc',
      kind: 'roof',
      typeId: 't-roof-200',
      base: { level: 'l-rf', offsetMm: 0 },
      boundary: [
        [20000, 0, 1],
        [30000, 0],
        [30000, 1000],
        [20000, 1000],
      ],
      shape: { form: 'mono', slopeRad: Math.PI / 4, directionRad: -Math.PI / 2 },
    },
    {
      id: 'p-hollow',
      kind: 'part',
      typeId: 't-part',
      at: { xy: [7000, 2000] },
      base: { level: 'l-1f', offsetMm: 0 },
      rotationRad: 0,
    },
    {
      id: 'p-sheet',
      kind: 'part',
      typeId: 't-part',
      at: { xy: [5000, 6000] },
      base: { level: 'l-1f', offsetMm: 0 },
      rotationRad: 0,
    },
  );
  // Kernel volumes of the clipped elements.
  const d = deriveBim(doc);
  const roof = d.shapes.get('r-roof') as Extract<BimShape, { kind: 'roof' }>;
  const kernelQuantities = new Map<string, Record<string, number>>([
    [
      'c-clip',
      {
        netVolume: volumeUnderRoof(
          [
            [4700, 3700],
            [5300, 3700],
            [5300, 4300],
            [4700, 4300],
          ],
          0,
          Infinity,
          roof,
        ),
      },
    ],
  ]);
  for (const id of ['w-south', 'w-east', 'w-north', 'w-west']) {
    const wall = d.shapes.get(id) as Extract<BimShape, { kind: 'wall' }>;
    const footprint = wall.footprint.map((v) => [v[0], v[1]] as Vec2);
    const gross = volumeUnderRoof(footprint, wall.zBase, wall.zTop, roof);
    const openings = wall.openings.reduce((n, o) => n + o.widthMm * 200 * o.heightMm, 0);
    kernelQuantities.set(id, { grossVolume: gross, netVolume: gross - openings });
  }
  const parts = new Map([
    ['p-box', cube],
    ['p-hollow', hollow],
    ['p-sheet', sheet],
  ]);
  return { doc, options: { ...opts, kernelQuantities, parts } };
}

/** F39's export: the gable or hip roof with the kernel volumes of what it cuts. */
export function f39Export(form: 'gable' | 'hip') {
  const doc = f39Roofs(form);
  const d = deriveBim(doc);
  const roof = d.shapes.get('r-roof') as Extract<BimShape, { kind: 'roof' }>;
  const kernelQuantities = new Map<string, Record<string, number>>();
  for (const e of doc.elements) {
    const s = d.shapes.get(e.id)!;
    if (s.kind === 'wall' && s.clipBy) {
      const footprint = s.footprint.map((v) => [v[0], v[1]] as Vec2);
      const gross = volumeUnderRoof(footprint, s.zBase, s.zTop, roof);
      const openings = s.openings.reduce((n, o) => n + o.widthMm * 200 * o.heightMm, 0);
      kernelQuantities.set(e.id, { grossVolume: gross, netVolume: gross - openings });
    } else if (s.kind === 'column' && s.clipBy) {
      const [x, y] = s.at;
      const square: Vec2[] = [
        [x - 300, y - 300],
        [x + 300, y - 300],
        [x + 300, y + 300],
        [x - 300, y + 300],
      ];
      kernelQuantities.set(e.id, { netVolume: volumeUnderRoof(square, s.zBase, s.zTop, roof) });
    }
  }
  return { doc, options: { ...opts, kernelQuantities } };
}

/**
 * What a kernel measures for a prism over a polygon from `zBase`, cut above at `zTop` and by a
 * roof's underside (the lowest of its planes). Exact: over the part where one plane is the
 * lowest and below `zTop`, the height is linear, so the part holds its area times the height
 * over its centroid.
 */
export function volumeUnderRoof(
  poly: Vec2[],
  zBase: number,
  zTop: number,
  roof: Extract<BimShape, { kind: 'roof' }>,
): number {
  const h = (f: BimRoofFace, p: Vec2) =>
    roof.zBase +
    f.slope * ((p[0] - f.origin[0]) * f.direction[0] + (p[1] - f.origin[1]) * f.direction[1]);
  let v = 0;
  roof.faces.forEach((f, i) => {
    let part = poly;
    roof.faces.forEach((g, j) => {
      if (j !== i) part = keepWhere(part, (p) => h(g, p) - h(f, p));
    });
    const below = keepWhere(part, (p) => zTop - h(f, p));
    const above = keepWhere(part, (p) => h(f, p) - zTop);
    const a = Math.abs(polygonArea(below));
    if (a > 0) v += a * (h(f, polygonCentroid(below)) - zBase);
    if (Number.isFinite(zTop)) v += Math.abs(polygonArea(above)) * (zTop - zBase);
  });
  return v;
}
/** The part of a polygon where a linear function is not negative (Sutherland–Hodgman). */
function keepWhere(poly: Vec2[], g: (p: Vec2) => number): Vec2[] {
  const out: Vec2[] = [];
  poly.forEach((p, i) => {
    const q = poly[(i + 1) % poly.length];
    const [gp, gq] = [g(p), g(q)];
    if (gp >= 0) out.push(p);
    if (gp >= 0 !== gq >= 0) {
      const t = gp / (gp - gq);
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  });
  return out;
}
const polygonArea = (poly: Vec2[]) =>
  poly.reduce((a, p, i) => {
    const q = poly[(i + 1) % poly.length];
    return a + (p[0] * q[1] - q[0] * p[1]) / 2;
  }, 0);
function polygonCentroid(poly: Vec2[]): Vec2 {
  const a = polygonArea(poly);
  let cx = 0;
  let cy = 0;
  poly.forEach((p, i) => {
    const q = poly[(i + 1) % poly.length];
    const c = p[0] * q[1] - q[0] * p[1];
    cx += ((p[0] + q[0]) * c) / 6;
    cy += ((p[1] + q[1]) * c) / 6;
  });
  return [cx / a, cy / a];
}

/**
 * OH-U3: arc walls joined at their ends. A straight wall with an arc wall butting on it (L), and
 * two arc walls mitred: their footprints' face arcs start and end where the faces meet.
 */
export function arcJoinsExport() {
  const doc = f33Types();
  const wall = (id: string, s: Vec2, e: Vec2, bulge?: number): BimElement => ({
    id,
    kind: 'wall',
    typeId: 't-wall-200',
    start: { xy: s },
    end: { xy: e },
    ...(bulge ? { bulge } : {}),
    location: 'center',
    base: { level: 'l-1f', offsetMm: 0 },
    top: { level: 'l-2f', offsetMm: 0 },
  });
  doc.elements = [
    wall('w-1', [0, 0], [5000, 0]),
    wall('w-2', [5000, 0], [5000, 4000], 0.2),
    wall('w-3', [0, 8000], [6000, 8000], -0.3),
    wall('w-4', [6000, 8000], [6000, 14000], 0.3),
  ];
  doc.joins = [
    { id: 'j-1', walls: ['w-1', 'w-2'], kind: 'butt', through: 'w-1' },
    { id: 'j-2', walls: ['w-3', 'w-4'], kind: 'miter' },
  ];
  return { doc, options: opts };
}
