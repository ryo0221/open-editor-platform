/**
 * GV5c (docs/cad/gulliver-world.md): the grand academy of Lagado (Part III chapter 5) as BIM, for
 * people of our size (1,750 mm), from the English text (Project Gutenberg #829):
 *
 * - F118: "This academy is not an entire single building, but a continuation of several houses on
 *   both sides of a street, which growing waste, was purchased and applied to that use"; "Every
 *   room has in it one or more projectors; and I believe I could not be in fewer than five
 *   hundred rooms." Two rows of ten houses face each other across a street; each house has five
 *   storeys of five rooms: 500 rooms. The houses of Lagado are "very strangely built, and most of
 *   them out of repair" (第3篇第4章): the rows step and lean a little out of line (創作).
 *
 * House sizes, storeys, room plans, doors and windows are the author's (創作).
 */
import type { BimDocument, BimElement, BimType, BimWallJoin } from '@editor-platform/bim-core';
import { box, emptyDoc, look, materials, rect, round, source } from './gulliver-lilliput';

const ch5 = '第3篇第5章';
const ch4 = '第3篇第4章';

/** The academy's sizes (mm). */
export const academySizes = {
  /** 創作: ten houses a side, 10 m of frontage and 12 m deep, five storeys of 3.2 m. */
  housesPerSide: 10,
  frontage: 10_000,
  depth: 12_000,
  storeys: 5,
  storey: 3_200,
  /** 創作: the street between the rows is 9 m wide (front wall to front wall). */
  street: 9_000,
  /** 創作: brick walls 450 mm, partitions 120 mm, floors 200 mm. */
  wall: 450,
  partition: 120,
  floor: 200,
  /** 創作: five rooms a storey: two to the street, three behind. */
  roomsPerStorey: 5,
  /** 創作: hip roofs at 40°. */
  roofSlopeRad: (40 * Math.PI) / 180,
  roofOverhang: 500,
} as const;

export const academyRooms = (): number => {
  const a = academySizes;
  return 2 * a.housesPerSide * a.storeys * a.roomsPerStorey;
};

function academyTypes(): BimType[] {
  const a = academySizes;
  return [
    {
      id: 't-brick-wall',
      kind: 'wall',
      name: 'Brick wall 450',
      layers: [{ materialId: 'm-brick', thicknessMm: a.wall }],
      common: { isExternal: true, loadBearing: true },
    },
    {
      id: 't-partition',
      kind: 'wall',
      name: 'Lath and plaster partition 120',
      layers: [{ materialId: 'm-plaster', thicknessMm: a.partition }],
      common: { isExternal: false, loadBearing: false },
    },
    {
      id: 't-floor',
      kind: 'slab',
      name: 'Timber floor 200',
      layers: [{ materialId: 'm-timber', thicknessMm: a.floor }],
    },
    {
      id: 't-tile-roof',
      kind: 'roof',
      name: 'Tile roof 200',
      layers: [{ materialId: 'm-tile', thicknessMm: 200 }],
    },
    {
      id: 't-street-door',
      kind: 'door',
      name: 'Street door 1,100 × 2,400',
      widthMm: 1_100,
      heightMm: 2_400,
    },
    {
      id: 't-room-door',
      kind: 'door',
      name: 'Room door 800 × 2,000',
      widthMm: 800,
      heightMm: 2_000,
    },
    {
      id: 't-sash',
      kind: 'window',
      name: 'Sash window 900 × 1,500',
      widthMm: 900,
      heightMm: 1_500,
    },
  ];
}

/** One house's rooms in its own frame (x along the street from its left party wall, y inward). */
function roomPlan(): { name: string; rect: [number, number, number, number] }[] {
  const a = academySizes;
  // Inside the outer walls' inner faces (the walls' axes run half a wall inside the plot).
  const i = a.wall,
    p = a.partition / 2;
  const W = a.frontage,
    D = a.depth,
    mid = D / 2;
  const third = (W - 2 * i) / 3;
  return [
    { name: 'front left', rect: [i, i, W / 2 - p, mid - p] },
    { name: 'front right', rect: [W / 2 + p, i, W - i, mid - p] },
    { name: 'back left', rect: [i, mid + p, i + third - p, D - i] },
    { name: 'back middle', rect: [i + third + p, mid + p, i + 2 * third - p, D - i] },
    { name: 'back right', rect: [i + 2 * third + p, mid + p, W - i, D - i] },
  ];
}

/**
 * F118: the academy. The street runs along x through the origin; the south row (side 0) faces
 * north across it and the north row (side 1) faces south. Each house is a box of brick walls up
 * past its hip roof (clipped by it), five floors, four partitions and five rooms a storey, a
 * street door, room doors and sash windows.
 */
export function f118Academy(): { doc: BimDocument } {
  const a = academySizes;
  const doc = emptyDoc('Grand academy of Lagado', 1_750);
  doc.materials = materials.map((m) => ({ ...m }));
  doc.materials.push({
    id: 'm-sooty',
    name: 'Sooty plaster',
    category: 'finish',
    appearance: look('#8d8577'),
  });
  doc.types = academyTypes();
  doc.levels = [
    ...Array.from({ length: a.storeys }, (_, k) => ({
      id: `l-${k}`,
      name: k === 0 ? 'Ground storey' : `Storey ${k + 1}`,
      elevationMm: k * a.storey,
    })),
    { id: 'l-eaves', name: 'Eaves', elevationMm: a.storeys * a.storey },
  ];
  const els: BimElement[] = [];
  const joins: BimWallJoin[] = [];
  const rise = (a.frontage / 2 + a.roofOverhang) * Math.tan(a.roofSlopeRad) + 1_000;
  for (const side of [0, 1] as const)
    for (let n = 0; n < a.housesPerSide; n++) {
      const h = `h${side}-${n}`;
      // The house's frame: origin at its front-left corner on the street; y away from the street.
      const x0 = (n - a.housesPerSide / 2) * a.frontage;
      // "out of repair": every other house stands a little back from the line (創作).
      const back = n % 3 === 1 ? 600 : n % 3 === 2 ? 250 : 0;
      const yFront = a.street / 2 + back;
      const toWorld = ([x, y]: [number, number]): [number, number] =>
        side === 0
          ? [round(x0 + x), round(-(yFront + y))]
          : [round(x0 + a.frontage - x), round(yFront + y)];
      const loop = (r: [number, number, number, number]) => {
        const [p0, p1] = [toWorld([r[0], r[1]]), toWorld([r[2], r[3]])];
        return rect(
          Math.min(p0[0], p1[0]),
          Math.min(p0[1], p1[1]),
          Math.max(p0[0], p1[0]),
          Math.max(p0[1], p1[1]),
        );
      };
      // Outer walls: the box's south side runs along the street for side 1, the far side for side 0.
      const outer = loop([a.wall / 2, a.wall / 2, a.frontage - a.wall / 2, a.depth - a.wall / 2]);
      const [ox0, oy0] = outer[0]!,
        [ox1, oy1] = outer[2]!;
      const b = box(
        h,
        [ox0, oy0, ox1, oy1],
        't-brick-wall',
        'l-0',
        { heightMm: round(a.storeys * a.storey + rise) },
        {
          clipBy: `${h}-roof`,
        },
      );
      els.push(...b.walls.map((w) => ({ ...w, properties: source('本文', ch5) })));
      joins.push(...b.joins);
      const streetWall = side === 0 ? `${h}-n` : `${h}-s`;
      const backWall = side === 0 ? `${h}-s` : `${h}-n`;
      // The street wall runs west→east for side 1 (box order s), east→west for side 0 (box order n).
      const along = (xLocal: number) => (side === 0 ? a.frontage - xLocal : xLocal) - a.wall / 2;
      els.push({
        id: `${h}-door`,
        name: 'Street door',
        kind: 'door',
        typeId: 't-street-door',
        hostId: streetWall,
        alongMm: round(along(a.frontage / 2) - 550),
        flipFacing: false,
        flipHand: false,
        properties: source('創作', ch5),
      });
      for (let k = 0; k < a.storeys; k++) {
        const lv = `l-${k}`;
        // The floor of this storey, inside the outer walls.
        els.push({
          id: `${h}-floor-${k}`,
          kind: 'slab',
          typeId: 't-floor',
          top: { level: lv, offsetMm: 0 },
          boundary: loop([a.wall, a.wall, a.frontage - a.wall, a.depth - a.wall]),
          holes: [],
          properties: source('創作', ch5),
        });
        // Partitions: one along the house's middle, one across the front, two across the back.
        const i = a.wall,
          mid = a.depth / 2,
          third = (a.frontage - 2 * i) / 3;
        const parts: [string, [number, number], [number, number]][] = [
          ['mid', [i, mid], [a.frontage - i, mid]],
          ['front', [a.frontage / 2, i], [a.frontage / 2, mid - a.partition / 2]],
          ['back-1', [i + third, mid + a.partition / 2], [i + third, a.depth - i]],
          ['back-2', [i + 2 * third, mid + a.partition / 2], [i + 2 * third, a.depth - i]],
        ];
        for (const [name, s, e] of parts) {
          const id = `${h}-${k}-${name}`;
          els.push({
            id,
            kind: 'wall',
            typeId: 't-partition',
            start: { xy: toWorld(s) },
            end: { xy: toWorld(e) },
            location: 'center',
            base: { level: lv, offsetMm: 0 },
            top: { heightMm: a.storey - a.floor },
            properties: source('創作', ch5),
          });
          // A door in each partition, near its middle.
          const len = Math.hypot(e[0] - s[0], e[1] - s[1]);
          els.push({
            id: `${id}-door`,
            name: 'Room door',
            kind: 'door',
            typeId: 't-room-door',
            hostId: id,
            alongMm: round(
              name === 'mid' ? len / 2 - 400 + (k % 2 ? 1_500 : -1_500) : len / 2 - 400,
            ),
            flipFacing: false,
            flipHand: false,
            properties: source('創作', ch5),
          });
        }
        // Rooms: "Every room has in it one or more projectors".
        roomPlan().forEach((r, j) =>
          els.push({
            id: `${h}-${k}-room-${j}`,
            kind: 'space',
            number: `${side === 0 ? 'S' : 'N'}${n + 1}-${k + 1}${j + 1}`,
            name: `Projector's room (${r.name})`,
            base: { level: lv, offsetMm: 0 },
            top: { heightMm: a.storey - a.floor },
            boundary: loop(r.rect),
            properties: source('本文', ch5),
          }),
        );
        // Sash windows: two to the street (none beside the street door on the ground storey),
        // three to the back.
        const streetAt = k === 0 ? [] : [2_200, a.frontage - 3_100];
        for (const [host, at, tag] of [
          ...streetAt.map((x) => [streetWall, along(x) - (side === 0 ? 900 : 0), 'f'] as const),
          ...[1_400, 4_550, 7_700].map(
            (x) => [backWall, (side === 0 ? x : a.frontage - x - 900) - a.wall / 2, 'b'] as const,
          ),
        ])
          els.push({
            id: `${h}-${k}-win-${tag}-${Math.round(at as number)}`,
            name: 'Sash window',
            kind: 'window',
            typeId: 't-sash',
            hostId: host as string,
            alongMm: round(at as number),
            // The sill above this storey's floor (a sill counts from the wall's foot).
            sillMm: k * a.storey + 900,
            flipFacing: false,
            properties: source('創作', ch5),
          });
      }
      // The roof: a hip over the house, from the eaves.
      const r = loop([
        -a.roofOverhang,
        -a.roofOverhang,
        a.frontage + a.roofOverhang,
        a.depth + a.roofOverhang,
      ]);
      els.push({
        id: `${h}-roof`,
        name: 'Roof',
        kind: 'roof',
        typeId: 't-tile-roof',
        base: { level: 'l-eaves', offsetMm: 0 },
        boundary: r,
        shape: { form: 'hip', slopeRad: a.roofSlopeRad },
        properties: source('創作', ch4),
      });
    }
  // The street's paving between the rows.
  const L = a.housesPerSide * a.frontage;
  els.push({
    id: 'street',
    name: 'Street',
    kind: 'slab',
    typeId: 't-floor',
    top: { level: 'l-0', offsetMm: -1 },
    boundary: rect(-L / 2 - 2_000, -a.street / 2 + 1, L / 2 + 2_000, a.street / 2 - 1),
    holes: [],
    properties: source('本文', ch5),
  });
  doc.elements = els;
  doc.joins = joins;
  return { doc };
}
