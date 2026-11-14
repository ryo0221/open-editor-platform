/**
 * GV6a (docs/cad/gulliver-world.md): the master Houyhnhnm's house and the Yahoos' hut (Part IV
 * chapter 2) as BIM, from the English text (Project Gutenberg #829):
 *
 * - "a long kind of building, made of timber stuck in the ground, and wattled across; the roof was
 *   low and covered with straw ... it was a large room with a smooth clay floor, and a rack and
 *   manger, extending the whole length on one side."
 * - "Beyond this room there were three others, reaching the length of the house, to which you
 *   passed through three doors, opposite to each other, in the manner of a vista."
 * - The third room: the master's family "sitting on their haunches upon mats of straw"; at dinner
 *   (第4篇第2章) "Their mangers were placed circular in the middle of the room, and divided into
 *   several partitions ... In the middle was a large rack".
 * - "led me out into a kind of court, where was another building, at some distance from the
 *   house": the Yahoos "tied by the neck with strong withes fastened to a beam".
 *
 * The text gives no sizes. Here the house is 33 m by 6.5 m, the large room 12 m and the three
 * others 7 m each, with walls 2.6 m to the eaves under a 45° thatch; the hut is 6 by 4 m, 15 m
 * across the court (all 創作). The people are horses: a door is 1.6 m wide and 2.6 m high, and
 * the rooms are for 1,750 mm people's rules (a horse's head is no higher than a tall door).
 */
import type { BimDocument, BimElement, BimType, BimWallJoin } from '@editor-platform/bim-core';
import { box, emptyDoc, look, materials, rect, round, source } from './gulliver-lilliput';

const ch2 = '第4篇第2章';

/** The farmstead's sizes (mm, 創作 unless noted). */
export const farmSizes = {
  /** The house: x along its length from the entrance end, y across. */
  houseWidth: 6_500,
  /** 本文: the large room "and three others, reaching the length of the house". */
  rooms: [12_000, 7_000, 7_000, 7_000] as const,
  /** 本文: "timber stuck in the ground, and wattled across": wattle 150 mm on posts 2 m apart. */
  wattle: 150,
  post: 180,
  postPitch: 2_000,
  /** 本文: "the roof was low and covered with straw": eaves 2.6 m, thatch 300 mm at 45°. */
  eaves: 2_600,
  thatch: 300,
  roofSlopeRad: Math.PI / 4,
  roofOverhang: 600,
  /** 本文: "a smooth clay floor". */
  floor: 120,
  /** A horse's door. */
  door: [1_600, 2_400] as const,
  /** 本文: "a rack and manger, extending the whole length on one side". */
  manger: { top: 900, depth: 600, rackTop: 1_700 },
  /** 本文: the mangers "placed circular in the middle of the room", a rack in the middle. */
  ring: { outer: 1_800, inner: 1_100, top: 700, sides: 16, partitions: 6 },
  /** The hut "at some distance from the house", across a court. */
  hut: { x: 4_000, y: 15_000, length: 6_000, width: 4_000, beamTop: 1_000 },
} as const;

const houseLength = () => farmSizes.rooms.reduce((a, b) => a + b, 0);

function farmTypes(): BimType[] {
  const f = farmSizes;
  return [
    {
      id: 't-wattle',
      kind: 'wall',
      name: 'Wattle 150',
      layers: [{ materialId: 'm-wattle', thicknessMm: f.wattle }],
      common: { isExternal: true, loadBearing: false },
    },
    {
      id: 't-wattle-inner',
      kind: 'wall',
      name: 'Wattle partition 150',
      layers: [{ materialId: 'm-wattle', thicknessMm: f.wattle }],
      common: { isExternal: false, loadBearing: false },
    },
    {
      id: 't-clay',
      kind: 'slab',
      name: 'Clay floor 120',
      layers: [{ materialId: 'm-clay', thicknessMm: f.floor }],
    },
    {
      id: 't-straw-mat',
      kind: 'slab',
      name: 'Straw mat 60',
      layers: [{ materialId: 'm-straw', thicknessMm: 60 }],
    },
    {
      id: 't-manger',
      kind: 'slab',
      name: 'Manger 150',
      layers: [{ materialId: 'm-timber', thicknessMm: 150 }],
    },
    {
      id: 't-thatch',
      kind: 'roof',
      name: 'Straw thatch 300',
      layers: [{ materialId: 'm-straw', thicknessMm: f.thatch }],
    },
    {
      id: 't-post',
      kind: 'column',
      name: 'Timber post 180',
      profile: { shape: 'circle', diameterMm: f.post },
      materialId: 'm-timber',
    },
    {
      id: 't-rail',
      kind: 'beam',
      name: 'Rack rail 100 × 100',
      profile: { shape: 'rect', widthMm: 100, depthMm: 100 },
      materialId: 'm-timber',
    },
    {
      id: 't-tether-beam',
      kind: 'beam',
      name: 'Tether beam 200 × 200',
      profile: { shape: 'rect', widthMm: 200, depthMm: 200 },
      materialId: 'm-timber',
    },
    {
      id: 't-horse-door',
      kind: 'door',
      name: 'Horse door 1,600 × 2,400',
      widthMm: f.door[0],
      heightMm: f.door[1],
    },
    {
      id: 't-hut-door',
      kind: 'door',
      name: 'Hut door 900 × 1,900',
      widthMm: 900,
      heightMm: 1_900,
    },
    {
      id: 't-shutter',
      kind: 'window',
      name: 'Shuttered hole 700 × 600',
      widthMm: 700,
      heightMm: 600,
    },
  ];
}

/** A regular polygon (counter-clockwise) about (cx, cy). */
const ring = (cx: number, cy: number, r: number, n: number): [number, number][] =>
  Array.from({ length: n }, (_, k) => {
    const t = (2 * Math.PI * k) / n;
    return [round(cx + r * Math.cos(t)), round(cy + r * Math.sin(t))];
  });

/** A wattled building: walls up past a gable thatch (clipped by it), posts inside the wattle. */
function wattled(
  id: string,
  [x0, y0, x1, y1]: [number, number, number, number],
  els: BimElement[],
  joins: BimWallJoin[],
) {
  const f = farmSizes;
  const rise = ((y1 - y0) / 2 + f.roofOverhang) * Math.tan(f.roofSlopeRad) + 1_000;
  const b = box(
    id,
    [x0, y0, x1, y1],
    't-wattle',
    'l-0',
    { heightMm: round(f.eaves + rise) },
    {
      clipBy: `${id}-roof`,
    },
  );
  els.push(...b.walls.map((w) => ({ ...w, properties: source('本文', ch2) })));
  joins.push(...b.joins);
  // Posts "stuck in the ground" just inside the wattle, along the long sides (from the floor up:
  // the part in the ground is not modelled, as the viewer shows no earth to hide it).
  const inset = f.wattle / 2 + f.post / 2;
  const posts: [number, number][] = [];
  const nx = Math.max(1, Math.round((x1 - x0) / f.postPitch));
  for (let k = 0; k <= nx; k++) {
    const x = x0 + inset + ((x1 - x0 - 2 * inset) * k) / nx;
    posts.push([x, y0 + inset], [x, y1 - inset]);
  }
  posts.forEach(([x, y], k) =>
    els.push({
      id: `${id}-post-${k}`,
      kind: 'column',
      typeId: 't-post',
      at: { xy: [round(x), round(y)] },
      rotationRad: 0,
      base: { level: 'l-0', offsetMm: 0 },
      top: { level: 'l-eaves', offsetMm: 0 },
      properties: source('本文', ch2),
    }),
  );
  els.push({
    id: `${id}-roof`,
    name: 'Straw roof',
    kind: 'roof',
    typeId: 't-thatch',
    base: { level: 'l-eaves', offsetMm: 0 },
    boundary: rect(
      x0 - f.roofOverhang,
      y0 - f.roofOverhang,
      x1 + f.roofOverhang,
      y1 + f.roofOverhang,
    ),
    shape: { form: 'gable', slopeRad: f.roofSlopeRad, ridgeRad: 0 },
    properties: source('本文', ch2),
  });
  els.push({
    id: `${id}-floor`,
    kind: 'slab',
    typeId: 't-clay',
    top: { level: 'l-0', offsetMm: 0 },
    boundary: rect(x0 + f.wattle / 2, y0 + f.wattle / 2, x1 - f.wattle / 2, y1 - f.wattle / 2),
    holes: [],
    properties: source('本文', ch2),
  });
}

/**
 * F120: the farmstead. The house runs along +x from its entrance end at x = 0, centred on y = 0;
 * the hut lies across the court to the north. The entrance door and the three doors between the
 * rooms stand on the house's centre line, so they look through one another ("a vista").
 */
export function f120Farmstead(): { doc: BimDocument } {
  const f = farmSizes;
  const doc = emptyDoc("The master Houyhnhnm's house", 1_750);
  doc.materials = materials.map((m) => ({ ...m }));
  doc.materials.push(
    { id: 'm-wattle', name: 'Wattle', category: 'wood', appearance: look('#8b7552') },
    { id: 'm-clay', name: 'Clay', category: 'other', appearance: look('#a88a66') },
    { id: 'm-straw', name: 'Straw', category: 'other', appearance: look('#c9a95c') },
  );
  doc.types = farmTypes();
  doc.levels = [
    { id: 'l-0', name: 'Ground', elevationMm: 0 },
    { id: 'l-eaves', name: 'Eaves', elevationMm: f.eaves },
  ];
  const els: BimElement[] = [];
  const joins: BimWallJoin[] = [];
  const L = houseLength(),
    W = f.houseWidth,
    w2 = W / 2;
  wattled('house', [0, -w2, L, w2], els, joins);
  // The entrance: in the west end wall (box order s, e, n, w; the west wall runs north → south).
  els.push({
    id: 'house-entrance',
    name: 'Entrance',
    kind: 'door',
    typeId: 't-horse-door',
    hostId: 'house-w',
    alongMm: round(w2 - f.door[0] / 2),
    flipFacing: false,
    flipHand: false,
    properties: source('本文', ch2),
  });
  // Three partitions, each with a door on the centre line: "three doors, opposite to each other".
  let x = 0;
  const names = ['Large room', 'Second room', 'Third room', 'Fourth room'];
  f.rooms.forEach((len, k) => {
    const x0 = x,
      x1 = x + len;
    x = x1;
    const i = f.wattle / 2;
    els.push({
      id: `room-${k + 1}`,
      kind: 'space',
      number: `${k + 1}`,
      name: names[k],
      base: { level: 'l-0', offsetMm: 0 },
      top: { level: 'l-eaves', offsetMm: 0 },
      boundary: rect(x0 + i, -w2 + i, x1 - i, w2 - i),
      properties: source('本文', ch2),
    });
    // Two shuttered holes in each long side (創作: the text names no windows).
    for (const [side, host] of [
      ['s', 'house-s'],
      ['n', 'house-n'],
    ] as const)
      for (const t of [0.3, 0.7]) {
        const at = x0 + len * t;
        els.push({
          id: `room-${k + 1}-win-${side}-${t * 10}`,
          kind: 'window',
          typeId: 't-shutter',
          hostId: host,
          // The south wall runs west → east, the north wall east → west.
          alongMm: round(side === 's' ? at - 350 : L - at - 350),
          sillMm: 1_400,
          flipFacing: false,
          properties: source('創作', ch2),
        });
      }
    if (k === f.rooms.length - 1) return;
    const id = `partition-${k + 1}`;
    els.push({
      id,
      kind: 'wall',
      typeId: 't-wattle-inner',
      start: { xy: [x1, -w2] },
      end: { xy: [x1, w2] },
      location: 'center',
      base: { level: 'l-0', offsetMm: 0 },
      top: { level: 'l-eaves', offsetMm: 0 },
      properties: source('本文', ch2),
    });
    els.push({
      id: `${id}-door`,
      kind: 'door',
      typeId: 't-horse-door',
      hostId: id,
      alongMm: round(w2 - f.door[0] / 2),
      flipFacing: false,
      flipHand: false,
      properties: source('本文', ch2),
    });
  });
  // "a rack and manger, extending the whole length on one side" of the large room: a manger
  // along the south wall and a rack rail above it.
  const m = f.manger,
    r1 = f.rooms[0];
  const inner = -w2 + f.wattle / 2 + f.post;
  els.push({
    id: 'manger',
    name: 'Manger',
    kind: 'slab',
    typeId: 't-manger',
    top: { level: 'l-0', offsetMm: m.top },
    boundary: rect(f.wattle / 2 + 300, inner, r1 - f.wattle / 2 - 300, inner + m.depth),
    holes: [],
    properties: source('本文', ch2),
  });
  els.push({
    id: 'rack',
    name: 'Rack',
    kind: 'beam',
    typeId: 't-rail',
    start: { xy: [f.wattle / 2 + 300, inner + 50] },
    end: { xy: [r1 - f.wattle / 2 - 300, inner + 50] },
    top: { level: 'l-0', offsetMm: m.rackTop },
    properties: source('本文', ch2),
  });
  // The third room: the dining mangers in a ring about a rack, and mats of straw.
  const c3 = f.rooms[0] + f.rooms[1] + f.rooms[2] / 2;
  const rg = f.ring;
  els.push({
    id: 'dining-manger',
    name: 'Mangers in a ring',
    kind: 'slab',
    typeId: 't-manger',
    top: { level: 'l-0', offsetMm: rg.top },
    boundary: ring(c3, 0, rg.outer, rg.sides),
    holes: [ring(c3, 0, rg.inner, rg.sides).reverse()],
    properties: source('本文', ch2),
  });
  els.push({
    id: 'dining-rack',
    name: 'Rack',
    kind: 'column',
    typeId: 't-post',
    at: { xy: [c3, 0] },
    rotationRad: 0,
    base: { level: 'l-0', offsetMm: 0 },
    top: { level: 'l-0', offsetMm: 1_600 },
    properties: source('本文', ch2),
  });
  for (let k = 0; k < rg.partitions; k++) {
    const t = (2 * Math.PI * (k + 0.5)) / rg.partitions;
    const [cx, cy] = [c3 + 2_500 * Math.cos(t), 2_200 * Math.sin(t)];
    els.push({
      id: `mat-${k + 1}`,
      name: 'Mat of straw',
      kind: 'slab',
      typeId: 't-straw-mat',
      top: { level: 'l-0', offsetMm: 60 },
      boundary: rect(round(cx - 450), round(cy - 450), round(cx + 450), round(cy + 450)),
      holes: [],
      properties: source('本文', ch2),
    });
  }
  // The hut across the court, with the beam the Yahoos are tied to.
  const h = f.hut;
  const hx1 = h.x + h.length,
    hy0 = h.y,
    hy1 = h.y + h.width;
  wattled('hut', [h.x, hy0, hx1, hy1], els, joins);
  els.push({
    id: 'hut-door',
    name: 'Hut door',
    kind: 'door',
    typeId: 't-hut-door',
    hostId: 'hut-s',
    alongMm: round(h.length / 2 - 450),
    flipFacing: false,
    flipHand: false,
    properties: source('創作', ch2),
  });
  els.push({
    id: 'tether-beam',
    name: 'Beam (the Yahoos are tied to it by withes)',
    kind: 'beam',
    typeId: 't-tether-beam',
    start: { xy: [h.x + 600, hy1 - 700] },
    end: { xy: [hx1 - 600, hy1 - 700] },
    top: { level: 'l-0', offsetMm: h.beamTop },
    properties: source('本文', ch2),
  });
  els.push({
    id: 'hut-space',
    kind: 'space',
    number: 'Y',
    name: "Yahoos' hut",
    base: { level: 'l-0', offsetMm: 0 },
    top: { level: 'l-eaves', offsetMm: 0 },
    boundary: rect(h.x + 75, hy0 + 75, hx1 - 75, hy1 - 75),
    properties: source('本文', ch2),
  });
  // The court between them, beaten earth.
  els.push({
    id: 'court',
    name: 'Court',
    kind: 'slab',
    typeId: 't-clay',
    top: { level: 'l-0', offsetMm: -1 },
    boundary: rect(-2_000, w2 + f.roofOverhang + 100, L + 2_000, hy0 - f.roofOverhang - 100),
    holes: [],
    properties: source('本文', ch2),
  });
  doc.elements = els;
  doc.joins = joins;
  return { doc };
}
