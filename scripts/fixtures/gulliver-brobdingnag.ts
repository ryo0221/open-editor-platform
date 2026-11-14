/**
 * GV4a (docs/cad/gulliver-world.md): Brobdingnag's buildings at true size (Gulliver's
 * millimetres), from the English text (Project Gutenberg #829, Part II chapter 4). Both are for
 * 21,000 mm people (12 : 1, GV2b `inhabitantHeightMm`), so the BIM body rules check them at the
 * giants' size.
 *
 * Where the text gives a size it is used as written; where it is silent the size is the author's
 * choice, said so in each element's `Gulliver_Source` (本文 = the text, 推定 = derived from the
 * text, 創作 = the author's choice).
 */
import type { BimDocument, BimElement, BimType, BimWallJoin } from '@editor-platform/bim-core';
import { box, emptyDoc, foot, look, materials, rect, round, source } from './gulliver-lilliput';

/** Brobdingnagians are twelve times Gulliver (GV1: the text gives 12 : 1 for Lilliput only). */
export const brobdingnagianMm = 21_000;
const k = brobdingnagianMm / 1_750;
const ch4 = '第2篇第4章';

/** The numbers the text gives and the ones the author chose (all mm). */
export const towerSizes = {
  /** "the height is not above three thousand feet, reckoning from the ground to the highest pinnacle top". */
  height: 3_000 * foot,
  /** "the walls are near a hundred feet thick, built of hewn stone, whereof each is about forty feet square". */
  wallThickness: 100 * foot,
  stone: 40 * foot,
  /** 創作: the tower is 300 ft square at the foot (a tenth of its height, like a spire's tower). */
  base: 300 * foot,
  /**
   * 創作: three stages, each narrower and thinner, and a pyramid roof at the BIM's steepest (60°).
   * [top of the stage above the ground, outer side, wall thickness].
   */
  stages: [
    [1_200 * foot, 300 * foot, 100 * foot],
    [2_000 * foot, 220 * foot, 60 * foot],
  ] as const,
  /** The last stage: 160 ft outside, 30 ft walls, up to the roof's eaves. */
  top: { outer: 160 * foot, wall: 30 * foot },
  roofSlopeRad: Math.PI / 3,
  /** "I measured a little finger which had fallen down from one of these statues ... four feet and an inch". */
  statueFinger: 4 * foot + 25.4,
} as const;

export const palaceSizes = {
  /** "the chief rooms are generally two hundred and forty feet high, and broad and long in proportion". */
  height: 240 * foot,
  /** 創作: "in proportion": 480 × 360 ft (a room 12 × 9 × 6 m at 1,750 mm, twelve times over). */
  length: 480 * foot,
  width: 360 * foot,
  /** 創作: stone walls 7.2 m (600 mm twelve times over). */
  wall: 7_200,
} as const;

/** The doors and windows of 1,750 mm people, twelve times over. */
const doorW = 900 * k,
  doorH = 2_100 * k;

function giantTypes(): BimType[] {
  const t = towerSizes;
  return [
    {
      id: 't-tower-wall-0',
      kind: 'wall',
      name: 'Tower wall, hewn stone 100 ft',
      layers: [{ materialId: 'm-stone', thicknessMm: round(t.wallThickness) }],
      common: { isExternal: true, loadBearing: true },
    },
    {
      id: 't-tower-wall-1',
      kind: 'wall',
      name: 'Tower wall, hewn stone 60 ft',
      layers: [{ materialId: 'm-stone', thicknessMm: round(t.stages[1][2]) }],
      common: { isExternal: true, loadBearing: true },
    },
    {
      id: 't-tower-wall-2',
      kind: 'wall',
      name: 'Tower wall, hewn stone 30 ft',
      layers: [{ materialId: 'm-stone', thicknessMm: round(t.top.wall) }],
      common: { isExternal: true, loadBearing: true },
    },
    {
      id: 't-palace-wall',
      kind: 'wall',
      name: 'Palace wall, stone 6.6 m + plaster 0.6 m',
      layers: [
        { materialId: 'm-stone', thicknessMm: 6_600 },
        { materialId: 'm-plaster', thicknessMm: 600 },
      ],
      common: { isExternal: true, loadBearing: true },
    },
    {
      id: 't-stone-floor',
      kind: 'slab',
      name: 'Stone floor 2.4 m',
      layers: [{ materialId: 'm-paving', thicknessMm: 2_400 }],
    },
    {
      id: 't-slate-roof',
      kind: 'roof',
      name: 'Slate roof 1.2 m',
      layers: [{ materialId: 'm-slate', thicknessMm: roofThicknessMm }],
    },
    {
      id: 't-giant-door',
      kind: 'door',
      name: 'Door 10.8 × 25.2 m (900 × 2,100 × 12)',
      widthMm: doorW,
      heightMm: doorH,
    },
    {
      id: 't-giant-window',
      kind: 'window',
      name: 'Window 14.4 × 21.6 m (1,200 × 1,800 × 12)',
      widthMm: 1_200 * k,
      heightMm: 1_800 * k,
    },
    {
      id: 't-niche',
      kind: 'window',
      name: 'Statue niche opening 9 × 48 m',
      widthMm: 9_000,
      heightMm: 48_000,
    },
  ];
}

function giantDoc(name: string): BimDocument {
  const doc = emptyDoc(name, brobdingnagianMm);
  doc.materials = [
    ...materials.map((m) => ({ ...m })),
    { id: 'm-marble', name: 'Marble', category: 'masonry', appearance: look('#e6e1d6', 0.4) },
  ];
  doc.types = giantTypes();
  return doc;
}

/** Where the outside of the pyramid roof's apex stands above the ground (for the test and the docs). */
export function towerTopMm(): number {
  const t = towerSizes;
  return round(
    eavesMm() + (t.top.outer / 2 + roofOverhang) * Math.tan(t.roofSlopeRad) + roofRiseMm(),
  );
}
/** The roof slab's thickness, 1,200 mm across the slab. */
const roofThicknessMm = 1_200;
/** How far the roof's top surface stands above its underside, measured upright (as bimRoofPlanes). */
function roofRiseMm(): number {
  return roofThicknessMm / Math.cos(towerSizes.roofSlopeRad);
}
/** The roof overhangs the top stage's outer face by 2 ft. */
const roofOverhang = 2 * foot;
/** The top stage stops where its roof, at 60°, reaches 3,000 ft on the outside of the apex. */
function eavesMm(): number {
  const t = towerSizes;
  return t.height - (t.top.outer / 2 + roofOverhang) * Math.tan(t.roofSlopeRad) - roofRiseMm();
}

/**
 * F109: the tower of the chief temple of Lorbrulgrud (第2篇第4章), 3,000 ft to the pinnacle top,
 * walls 100 ft thick at the foot, statues in niches. The plan, the stages and the roof are the
 * author's (創作). The tower stands on the origin, its door to −y.
 */
export function f109TempleTower(): { doc: BimDocument; summary: { topMm: number } } {
  const t = towerSizes;
  const doc = giantDoc('Temple tower of Lorbrulgrud');
  const eaves = eavesMm();
  doc.levels = [
    { id: 'l-0', name: 'Ground', elevationMm: 0 },
    { id: 'l-1', name: 'Stage 2', elevationMm: round(t.stages[0][0]) },
    { id: 'l-2', name: 'Stage 3', elevationMm: round(t.stages[1][0]) },
    { id: 'l-3', name: 'Eaves', elevationMm: round(eaves) },
  ];
  const els: BimElement[] = [];
  const joins: BimWallJoin[] = [];
  // Each stage: four walls whose axes run half a wall inside the outer face, standing on the stage
  // below (each stage's wall sits within the one below it).
  const stages: { outer: number; wall: number; base: string; heightMm: number; clip?: string }[] = [
    { outer: t.stages[0][1], wall: t.stages[0][2], base: 'l-0', heightMm: t.stages[0][0] },
    {
      outer: t.stages[1][1],
      wall: t.stages[1][2],
      base: 'l-1',
      heightMm: t.stages[1][0] - t.stages[0][0],
    },
    {
      outer: t.top.outer,
      wall: t.top.wall,
      base: 'l-2',
      // Up past the apex; the roof's underside cuts the walls (no gap under the eaves).
      heightMm: t.height - t.stages[1][0] + 30 * foot,
      clip: 'tower-roof',
    },
  ];
  stages.forEach((s, i) => {
    const a = (s.outer - s.wall) / 2;
    const b = box(
      `tower-${i}`,
      [-a, -a, a, a].map(round) as [number, number, number, number],
      `t-tower-wall-${i}`,
      s.base,
      { heightMm: round(s.heightMm) },
      s.clip ? { clipBy: s.clip } : {},
    );
    els.push(
      ...b.walls.map((w) => ({
        ...w,
        properties: source(i === 0 ? '本文' : '創作', ch4),
      })),
    );
    joins.push(...b.joins);
    // A floor inside each stage (closing the stage below), inside the walls' inner faces.
    const inner = a - s.wall / 2;
    els.push({
      id: `tower-floor-${i}`,
      kind: 'slab',
      typeId: 't-stone-floor',
      top: { level: s.base, offsetMm: 0 },
      boundary: rect(-inner, -inner, inner, inner).map(([x, y]) => [round(x), round(y)]),
      holes: [],
      properties: source('創作', ch4),
    });
  });
  // The door to −y at the foot (the south wall, box order s, e, n, w), twelve times ours.
  const a0 = (t.stages[0][1] - t.stages[0][2]) / 2;
  els.push({
    id: 'tower-door',
    name: 'Tower door',
    kind: 'door',
    typeId: 't-giant-door',
    hostId: 'tower-0-s',
    alongMm: round(a0 - doorW / 2),
    flipFacing: false,
    flipHand: false,
    properties: source('創作', ch4),
  });
  // "adorned on all sides with statues of gods and emperors ... placed in their several niches":
  // two niches a side on the first two stages (openings standing for the niches), clear of the
  // corners, where the thick walls meet; none beside the door.
  const nicheW = 9_000;
  for (const i of [0, 1]) {
    const s = stages[i]!;
    const a = (s.outer - s.wall) / 2;
    const from = s.wall / 2 + 1_000,
      span = 2 * a - s.wall - 2_000;
    for (const side of ['s', 'e', 'n', 'w'])
      for (let n = 0; n < 2; n++) {
        if (i === 0 && side === 's') continue; // the door is there
        els.push({
          id: `tower-${i}-${side}-niche-${n}`,
          name: 'Statue niche',
          kind: 'window',
          typeId: 't-niche',
          hostId: `tower-${i}-${side}`,
          alongMm: round(from + ((n + 1) * span) / 3 - nicheW / 2),
          sillMm: round(s.heightMm * 0.35),
          flipFacing: false,
          properties: source('本文', ch4),
        });
      }
  }
  const r = t.top.outer / 2 + roofOverhang;
  els.push({
    id: 'tower-roof',
    name: 'Pinnacle',
    kind: 'roof',
    typeId: 't-slate-roof',
    base: { level: 'l-3', offsetMm: 0 },
    boundary: rect(-r, -r, r, r).map(([x, y]) => [round(x), round(y)]),
    shape: { form: 'hip', slopeRad: t.roofSlopeRad },
    properties: source('推定', ch4),
  });
  doc.elements = els;
  doc.joins = joins;
  return { doc, summary: { topMm: towerTopMm() } };
}

/**
 * F110: one of the chief rooms of the king's palace (第2篇第4章): 240 ft high, "broad and long in
 * proportion" (480 × 360 ft, 創作), with the doors and windows of 21 m people. The room stands
 * on the origin, its long walls along x.
 */
export function f110PalaceRoom(): { doc: BimDocument } {
  const p = palaceSizes;
  const doc = giantDoc('Chief room of the palace');
  const slope = Math.PI / 6;
  const over = 3_000;
  const rise = (p.width / 2 + over) * Math.tan(slope);
  doc.levels = [
    { id: 'l-0', name: 'Floor', elevationMm: 0 },
    { id: 'l-1', name: 'Eaves', elevationMm: round(p.height) },
  ];
  const b = box(
    'room',
    [-p.length / 2, -p.width / 2, p.length / 2, p.width / 2].map(round) as [
      number,
      number,
      number,
      number,
    ],
    't-palace-wall',
    'l-0',
    // Up past the ridge; the roof's underside cuts the walls and closes the gable ends.
    { heightMm: round(p.height + rise + 3_000) },
    { clipBy: 'room-roof' },
  );
  const els: BimElement[] = b.walls.map((w) => ({ ...w, properties: source('本文', ch4) }));
  // A door in the middle of each short wall; six windows along each long wall.
  for (const side of ['e', 'w'])
    els.push({
      id: `room-${side}-door`,
      kind: 'door',
      typeId: 't-giant-door',
      hostId: `room-${side}`,
      alongMm: round(p.width / 2 - doorW / 2),
      flipFacing: false,
      flipHand: false,
      properties: source('創作', ch4),
    });
  for (const side of ['s', 'n'])
    for (let n = 0; n < 6; n++)
      els.push({
        id: `room-${side}-window-${n}`,
        kind: 'window',
        typeId: 't-giant-window',
        hostId: `room-${side}`,
        alongMm: round(((n + 0.5) * p.length) / 6 - (1_200 * k) / 2),
        sillMm: round(900 * k),
        flipFacing: false,
        properties: source('創作', ch4),
      });
  const inner = (x: number) => x / 2 - p.wall / 2;
  els.push(
    {
      id: 'room-floor',
      kind: 'slab',
      typeId: 't-stone-floor',
      top: { level: 'l-0', offsetMm: 0 },
      boundary: rect(-inner(p.length), -inner(p.width), inner(p.length), inner(p.width)).map(
        ([x, y]) => [round(x), round(y)],
      ),
      holes: [],
      properties: source('創作', ch4),
    },
    {
      id: 'room-roof',
      kind: 'roof',
      typeId: 't-slate-roof',
      base: { level: 'l-1', offsetMm: 0 },
      boundary: rect(
        -p.length / 2 - over,
        -p.width / 2 - over,
        p.length / 2 + over,
        p.width / 2 + over,
      ).map(([x, y]) => [round(x), round(y)]),
      shape: { form: 'gable', slopeRad: slope, ridgeRad: 0 },
      properties: source('創作', ch4),
    },
    {
      id: 'room-space',
      kind: 'space',
      number: '1',
      name: 'Chief room',
      base: { level: 'l-0', offsetMm: 0 },
      boundary: rect(-inner(p.length), -inner(p.width), inner(p.length), inner(p.width)).map(
        ([x, y]) => [round(x), round(y)],
      ),
      properties: source('本文', ch4),
    },
  );
  doc.elements = els;
  doc.joins = b.joins;
  return { doc };
}
