import { f31BoxBuilding, type BimWall } from '@editor-platform/bim-core';

type BimDoorish = { alongMm: number; kind: string; typeId: string; sillMm: number };
import { describe, expect, it } from 'vitest';
import {
  applyFactoryOperation,
  checkFactoryBuilding,
  factoryFootprint,
  factoryObjectSize,
  factoryObstacles,
  newFactory,
  validateFactory,
  type FactoryDocument,
  type FactoryObject,
} from './index';

const c = (sec: number) => ({ type: 'const' as const, value: sec * 1000 });
const station = (id: string, x: number, y: number, extra = {}): FactoryObject => ({
  id,
  name: id,
  kind: 'station',
  processTime: c(10),
  at: { x, y },
  ...extra,
});
/** F31 (10 × 8 m box, 200 mm walls, a 900 mm door in the south wall from x 2,000 to 2,900). */
function inBox(objects: FactoryObject[], extra: Partial<FactoryDocument> = {}): FactoryDocument {
  const doc = newFactory('box');
  doc.objects = objects;
  doc.building = { artifactId: 'b', versionId: 'v1', contentHash: 'h' };
  return { ...doc, ...extra };
}
const codes = (doc: FactoryDocument) =>
  checkFactoryBuilding(doc, f31BoxBuilding()).map((d) => `${d.code}@${d.path}`);

// TS-2659: FT4a the factory in its building.
describe('FT4a building checks (TS-2659)', () => {
  it('sizes objects by kind, their own size or a conveyor length', () => {
    expect(factoryObjectSize(station('a', 0, 0))).toEqual({
      widthMm: 2400,
      depthMm: 1600,
      heightMm: 2000,
    });
    const conveyor: FactoryObject = {
      id: 'c',
      name: 'c',
      kind: 'conveyor',
      lengthMm: 6000,
      speedMmS: 200,
      partLengthMm: 500,
      accumulating: true,
    };
    expect(factoryObjectSize(conveyor).widthMm).toBe(6000);
    const turned = factoryFootprint(
      station('a', 0, 0, { size: { widthMm: 2000, depthMm: 1000, heightMm: 1 } }),
      { x: 100, y: 0, angle: 90 },
    );
    expect(turned.map(([x, y]) => [Math.round(x), Math.round(y)])).toEqual([
      [600, -1000],
      [600, 1000],
      [-400, 1000],
      [-400, -1000],
    ]);
  });

  it('finds the walls on the floor and the door in them', () => {
    const obstacles = factoryObstacles(f31BoxBuilding());
    expect(obstacles.map((o) => o.elementId).sort()).toEqual([
      'w-east',
      'w-north',
      'w-south',
      'w-west',
    ]);
    const south = obstacles.find((o) => o.elementId === 'w-south')!;
    expect(south.passages).toHaveLength(1);
    expect(south.passages[0]!.heightMm).toBeGreaterThanOrEqual(2000);
  });

  it('reports objects that run into a wall', () => {
    expect(codes(inBox([station('a', 5000, 4000)]))).toEqual([]);
    // 2,400 mm wide, centred 1,000 mm from the west wall's axis.
    expect(codes(inBox([station('a', 5000, 4000), station('b', 1000, 4000)]))).toEqual([
      'object-clash@$.objects.1',
    ]);
    // Objects without a place are not checked.
    expect(codes(inBox([{ ...station('a', 0, 0), at: undefined }]))).toEqual([]);
  });

  it('takes a column at its section and finds one wholly inside an object', () => {
    // A 600 mm column in the middle of the F31 box.
    const bim = f31BoxBuilding();
    bim.elements.push({
      id: 'c-1',
      kind: 'column',
      typeId: 't-column-600',
      at: { xy: [5000, 4000] },
      rotationRad: 0,
      base: { level: 'l-1f', offsetMm: 0 },
      top: { level: 'l-2f', offsetMm: 0 },
    });
    const column = factoryObstacles(bim).find((o) => o.elementId === 'c-1')!;
    const xs = column.outline.map((p) => p[0]);
    expect([Math.min(...xs), Math.max(...xs)]).toEqual([4700, 5300]);
    const box = { size: { widthMm: 1000, depthMm: 1000, heightMm: 1000 } };
    const at = (objects: FactoryObject[]) =>
      checkFactoryBuilding(inBox(objects), bim).map((d) => `${d.code}@${d.path}`);
    // 600 mm clear of the column's face: no clash.
    expect(at([station('a', 6400, 4000, box)])).toEqual([]);
    // A station around the column (no side crosses it) still clashes.
    expect(at([station('a', 5000, 4000)])).toEqual(['object-clash@$.objects.0']);
    // A lane over the column clashes too.
    const lane = inBox([], {
      paths: {
        nodes: [
          { id: 'p-a', x: 3000, y: 4000 },
          { id: 'p-b', x: 7000, y: 4000 },
        ],
        segments: [{ id: 's', from: 'p-a', to: 'p-b' }],
      },
      fleets: [
        {
          id: 'agv',
          name: 'AGV',
          count: 1,
          speedMmS: 1000,
          loadMs: 0,
          unloadMs: 0,
          homeNodeId: 'p-a',
          widthMm: 1200,
        },
      ],
    });
    expect(checkFactoryBuilding(lane, bim).map((d) => d.code)).toEqual(['path-clash']);
  });

  it('checks a short, steeply leaning column where it stands, and doors of raised walls', () => {
    // 600 mm square, from (3,000, 4,000) at the floor to (4,000, 4,000) 200 mm up.
    const bim = f31BoxBuilding();
    bim.elements.push({
      id: 'c-short',
      kind: 'column',
      typeId: 't-column-600',
      at: { xy: [3000, 4000] },
      topAt: { xy: [4000, 4000] },
      rotationRad: 0,
      base: { level: 'l-1f', offsetMm: 0 },
      top: { level: 'l-1f', offsetMm: 200 },
    } as never);
    const tiny = { size: { widthMm: 20, depthMm: 20, heightMm: 10 } };
    const at = (objects: FactoryObject[], b = bim) =>
      checkFactoryBuilding(inBox(objects), b).map((d) => d.message);
    // Its floor section reaches x 3,000 to 4,040 (the cut, not the middle carried down).
    expect(at([station('a', 4000, 4000, tiny)])).toEqual(['a runs into column c-short']);
    expect(at([station('a', 2400, 4000, tiny)])).toEqual([]);
    // Its tilted base cap leans back over the floor only 2 mm by 10 mm up: a station from
    // x 2,950 to 2,970 is clear (the hull of the whole cap reached x ≈ 2,941).
    expect(at([station('a', 2960, 4000, tiny)])).toEqual([]);
    expect(at([station('a', 2995, 4000, tiny)])).toEqual(['a runs into column c-short']);
    // Below the floor but for its tilted top cap: the cap still stands in the way.
    const sunk = f31BoxBuilding();
    sunk.elements.push({
      id: 'c-sunk',
      kind: 'column',
      typeId: 't-column-600',
      at: { xy: [3000, 4000] },
      topAt: { xy: [4000, 4000] },
      rotationRad: 0,
      base: { level: 'l-1f', offsetMm: -1000 },
      top: { level: 'l-1f', offsetMm: -100 },
    } as never);
    expect(at([station('a', 3800, 4000, tiny)], sunk)).toEqual(['a runs into column c-sunk']);
    expect(at([station('a', 2400, 4000, tiny)], sunk)).toEqual([]);
    // The south wall raised 1,000 mm above the floor: its door still lets a lane through.
    const raised = f31BoxBuilding();
    const south = raised.elements.find((e) => e.id === 'w-south')! as {
      base: { offsetMm: number };
    };
    south.base.offsetMm = 1000;
    const lane = inBox([], {
      paths: {
        nodes: [
          { id: 'p-a', x: 2450, y: -2000 },
          { id: 'p-b', x: 2450, y: 2000 },
        ],
        segments: [{ id: 's', from: 'p-a', to: 'p-b' }],
      },
      fleets: [
        {
          id: 'agv',
          name: 'AGV',
          count: 1,
          speedMmS: 1000,
          loadMs: 0,
          unloadMs: 0,
          homeNodeId: 'p-a',
          widthMm: 700,
        },
      ],
    });
    const wall = factoryObstacles(raised).find((o) => o.elementId === 'w-south')!;
    expect(wall.zBase).toBe(1000);
    expect(wall.passages).toHaveLength(1);
    expect(checkFactoryBuilding(lane, raised).map((d) => d.message)).toEqual([]);
    // Off the door it still meets the wall.
    const off = structuredClone(lane);
    off.paths!.nodes = off.paths!.nodes.map((n) => ({ ...n, x: 5000 }));
    expect(checkFactoryBuilding(off, raised).map((d) => d.message)).toEqual([
      's runs into wall w-south',
    ]);
    // A 1,000 mm wall with a 1,000 mm door: nothing above the door, so the lane passes.
    const low = f31BoxBuilding();
    const lw = low.elements.find((e) => e.id === 'w-south')! as { top: unknown };
    lw.top = { level: 'l-1f', offsetMm: 1000 };
    (low.types.find((t) => t.id === 't-door-900')! as { heightMm: number }).heightMm = 1000;
    expect(checkFactoryBuilding(lane, low).map((d) => d.message)).toEqual([]);
    expect(checkFactoryBuilding(off, low).map((d) => d.message)).toEqual([
      's runs into wall w-south',
    ]);
  });

  it('keeps the recesses of a leaning H column beside its tilted base cap', () => {
    // 600 × 600 mm H (50 mm web and flanges), leaning 600 mm over 6,000 mm.
    const bim = f31BoxBuilding();
    bim.types.push({
      id: 't-h',
      kind: 'column',
      name: 'H 600',
      profile: { shape: 'h', depthMm: 600, widthMm: 600, webMm: 50, flangeMm: 50 },
      materialId: 'm-concrete',
    } as never);
    bim.elements.push({
      id: 'c-h',
      kind: 'column',
      typeId: 't-h',
      at: { xy: [5000, 4000] },
      topAt: { xy: [5600, 4000] },
      rotationRad: 0,
      base: { level: 'l-1f', offsetMm: 0 },
      top: { level: 'l-1f', offsetMm: 6000 },
    } as never);
    const tiny = { size: { widthMm: 20, depthMm: 20, heightMm: 10 } };
    const at = (x: number, y: number) =>
      checkFactoryBuilding(inBox([station('a', x, y, tiny)]), bim).map((d) => d.message);
    // In a recess between the flanges, clear of the web: clear; on the web: a clash.
    expect(at(5200, 4000)).toEqual([]);
    expect(at(5000, 4200)).toEqual(['a runs into column c-h']);
    expect(at(5000, 4000)).toEqual(['a runs into column c-h']);
  });

  it('lets objects stand in a hollow column void, not in its walls', () => {
    // An upright 1,000 mm box column, 50 mm walls; and a leaning pipe of 1,000 mm, 50 mm walls.
    const bim = f31BoxBuilding();
    bim.types.push(
      {
        id: 't-box',
        kind: 'column',
        name: 'Box 1000',
        profile: { shape: 'box', widthMm: 1000, depthMm: 1000, wallMm: 50 },
        materialId: 'm-concrete',
      },
      {
        id: 't-pipe',
        kind: 'column',
        name: 'Pipe 1000',
        profile: { shape: 'pipe', diameterMm: 1000, wallMm: 50 },
        materialId: 'm-concrete',
      },
    );
    bim.elements.push(
      {
        id: 'c-box',
        kind: 'column',
        typeId: 't-box',
        at: { xy: [3000, 4000] },
        rotationRad: 0,
        base: { level: 'l-1f', offsetMm: 0 },
        top: { level: 'l-2f', offsetMm: 0 },
      },
      {
        id: 'c-pipe',
        kind: 'column',
        typeId: 't-pipe',
        at: { xy: [7000, 4000] },
        topAt: { xy: [7100, 4000] },
        rotationRad: 0,
        base: { level: 'l-1f', offsetMm: 0 },
        top: { level: 'l-2f', offsetMm: 0 },
      } as never,
    );
    const obstacles = factoryObstacles(bim);
    expect(obstacles.find((o) => o.elementId === 'c-box')!.holes).toHaveLength(1);
    expect(obstacles.find((o) => o.elementId === 'c-pipe')!.holes![0]!.outlineTop).toBeDefined();
    const at = (objects: FactoryObject[]) =>
      checkFactoryBuilding(inBox(objects), bim, obstacles).map((d) => d.message);
    const small = { size: { widthMm: 200, depthMm: 200, heightMm: 1000 } };
    // In the voids: clear (the pipe leans 100 mm over its height: 1,000 mm up it is 30 mm over).
    expect(at([station('a', 3000, 4000, small), station('b', 7000, 4000, small)])).toEqual([]);
    // Across a wall of the box, or around the whole column: a clash.
    expect(at([station('a', 3400, 4000, small)])).toEqual(['a runs into column c-box']);
    const big = { size: { widthMm: 1400, depthMm: 1400, heightMm: 1000 } };
    expect(at([station('a', 3000, 4000, big)])).toEqual(['a runs into column c-box']);
    // A void wider than the pipe's lean, but a box that fills it to its walls meets them.
    const fill = { size: { widthMm: 880, depthMm: 200, heightMm: 2000 } };
    expect(at([station('b', 7000, 4000, fill)])).toEqual(['b runs into column c-pipe']);
    // A thin lane that the leaning box wall crosses at the floor, inside the void higher up:
    // compared at the same heights, it meets the wall.
    const lean = f31BoxBuilding();
    lean.types.push(bim.types.find((t) => t.id === 't-box')!);
    lean.elements.push({
      id: 'c-lean',
      kind: 'column',
      typeId: 't-box',
      at: { xy: [3000, 4000] },
      topAt: { xy: [3800, 4000] },
      rotationRad: 0,
      base: { level: 'l-1f', offsetMm: 0 },
      top: { level: 'l-2f', offsetMm: 0 },
    } as never);
    const thin = inBox([], {
      paths: {
        nodes: [
          { id: 'p-a', x: 3510, y: 3950 },
          { id: 'p-b', x: 3510, y: 4050 },
        ],
        segments: [{ id: 's', from: 'p-a', to: 'p-b' }],
      },
      fleets: [
        {
          id: 'agv',
          name: 'AGV',
          count: 1,
          speedMmS: 1000,
          loadMs: 0,
          unloadMs: 0,
          homeNodeId: 'p-a',
          widthMm: 20,
        },
      ],
    });
    expect(checkFactoryBuilding(thin, lean).map((d) => d.code)).toEqual(['path-clash']);
    // The same lane in the middle of an upright box's void is clear.
    const mid = structuredClone(thin);
    mid.paths!.nodes = [
      { id: 'p-a', x: 3000, y: 3950 },
      { id: 'p-b', x: 3000, y: 4050 },
    ];
    expect(checkFactoryBuilding(mid, bim).map((d) => d.code)).toEqual([]);
  });

  it('lets a lane through the door, not through the wall', () => {
    const lanes = (x: number, widthMm?: number) =>
      inBox([], {
        paths: {
          nodes: [
            { id: 'p-in', x, y: 3000 },
            { id: 'p-out', x, y: -3000 },
          ],
          segments: [{ id: 's', from: 'p-in', to: 'p-out' }],
        },
        fleets: [
          {
            id: 'agv',
            name: 'AGV',
            count: 1,
            speedMmS: 1000,
            loadMs: 0,
            unloadMs: 0,
            homeNodeId: 'p-in',
            ...(widthMm ? { widthMm } : {}),
          },
        ],
      });
    expect(codes(lanes(5000))).toEqual(['path-clash@$.paths.segments.0']);
    // The 900 mm door takes a 700 mm lane down its middle, not a 1,000 mm one or one off centre.
    expect(codes(lanes(2450, 700))).toEqual([]);
    expect(codes(lanes(2450))).toEqual(['path-clash@$.paths.segments.0']);
    expect(codes(lanes(2200, 700))).toEqual(['path-clash@$.paths.segments.0']);
  });

  it('reads a sunken wall, a leaning wall and an arc wall as built', () => {
    const lane = (x: number, y0: number, y1: number, widthMm = 700) =>
      inBox([], {
        paths: {
          nodes: [
            { id: 'p-a', x, y: y0 },
            { id: 'p-b', x, y: y1 },
          ],
          segments: [{ id: 's', from: 'p-a', to: 'p-b' }],
        },
        fleets: [
          {
            id: 'agv',
            name: 'AGV',
            count: 1,
            speedMmS: 1000,
            loadMs: 0,
            unloadMs: 0,
            homeNodeId: 'p-a',
            widthMm,
          },
        ],
      });
    const south = (edit: (w: BimWall) => void, door?: Partial<BimDoorish>) => {
      const bim = f31BoxBuilding();
      const w = bim.elements.find((e) => e.id === 'w-south') as BimWall;
      edit(w);
      bim.elements = [
        w,
        ...(door
          ? [{ ...bim.elements.find((e) => e.id === 'd-entrance')!, ...door } as never]
          : []),
      ];
      return bim;
    };
    // A wall based 1 m below the floor: an opening 1 m up its base starts at the floor.
    const sunken = south((w) => (w.base = { level: 'l-1f', offsetMm: -1000 }), {
      kind: 'window',
      typeId: 't-door-tall',
      sillMm: 1000,
    } as never);
    sunken.types.push({
      id: 't-door-tall',
      kind: 'window',
      name: 'Tall',
      widthMm: 900,
      heightMm: 2200,
    });
    expect(checkFactoryBuilding(lane(2450, 3000, -3000), sunken)).toEqual([]);
    // A wall leaning 0.3 rad outward (to -y): its upper part is over a station 500 mm outside.
    const tall = { size: { widthMm: 200, depthMm: 200, heightMm: 2000 } };
    const upright = south(() => {});
    const leaning = south((w) => (w.lean = 0.3));
    expect(checkFactoryBuilding(inBox([station('a', 5000, -500, tall)]), upright)).toEqual([]);
    expect(
      checkFactoryBuilding(inBox([station('a', 5000, -500, tall)]), leaning).map((d) => d.code),
    ).toEqual(['object-clash']);
    // An arc wall with a 900 mm door in the middle of its arc: a 700 mm lane through it passes.
    const bulge = 0.2;
    const theta = 4 * Math.atan(bulge);
    const length = (theta * 10_000) / (2 * Math.sin(theta / 2));
    const arc = south((w) => (w.bulge = bulge), { alongMm: length / 2 - 450 });
    const door = factoryObstacles(arc)[0]!.passages[0]!.outline;
    const cx = door.reduce((t, p) => t + p[0], 0) / door.length;
    const cy = door.reduce((t, p) => t + p[1], 0) / door.length;
    expect(checkFactoryBuilding(lane(cx, cy + 3000, cy - 3000), arc)).toEqual([]);
    expect(
      checkFactoryBuilding(lane(cx + 2000, cy + 3000, cy - 3000), arc).map((d) => d.code),
    ).toEqual(['path-clash']);
  });

  it('checks leaning walls and columns only up to the height taken', () => {
    const small = (h: number) => ({ size: { widthMm: 200, depthMm: 200, heightMm: h } });
    const only = (edit: (bim: ReturnType<typeof f31BoxBuilding>) => void) => {
      const bim = f31BoxBuilding();
      edit(bim);
      return bim;
    };
    // A column leaning from (5,000, 4,000) at the floor to (8,000, 4,000) at 6,000 mm: under a
    // 1,000 mm station it reaches only x 5,800.
    const leaning = only((bim) => {
      bim.elements = [
        {
          id: 'c-1',
          kind: 'column',
          typeId: 't-column-600',
          at: { xy: [5000, 4000] },
          topAt: { xy: [8000, 4000] },
          rotationRad: 0,
          base: { level: 'l-1f', offsetMm: 0 },
          top: { heightMm: 6000 },
        } as never,
      ];
    });
    const at = (x: number, h: number) =>
      checkFactoryBuilding(inBox([station('a', x, 4000, small(h))]), leaning).map((d) => d.code);
    expect(at(7800, 1000)).toEqual([]);
    expect(at(5700, 1000)).toEqual(['object-clash']);
    expect(at(7800, 6000)).toEqual(['object-clash']);
    // A leaning arc wall keeps its hollow: nothing in the bay inside its arc clashes.
    const arc = (lean?: number) =>
      only((bim) => {
        const w = bim.elements.find((e) => e.id === 'w-south') as BimWall;
        w.bulge = 0.2;
        if (lean) w.lean = lean;
        bim.elements = [w];
      });
    const bay = inBox([station('a', 5000, -500, small(2000))]);
    expect(checkFactoryBuilding(bay, arc())).toEqual([]);
    expect(checkFactoryBuilding(bay, arc(0.001))).toEqual([]);
    // A lane through the door of a wall leaning 0.1 rad: the door leans with it.
    const door = only((bim) => {
      const w = bim.elements.find((e) => e.id === 'w-south') as BimWall;
      w.lean = 0.1;
      bim.elements = bim.elements.filter((e) => e.id === 'w-south' || e.id === 'd-entrance');
    });
    const lane = inBox([], {
      paths: {
        nodes: [
          { id: 'p-a', x: 2450, y: 3000 },
          { id: 'p-b', x: 2450, y: -3000 },
        ],
        segments: [{ id: 's', from: 'p-a', to: 'p-b' }],
      },
      fleets: [
        {
          id: 'agv',
          name: 'AGV',
          count: 1,
          speedMmS: 1000,
          loadMs: 0,
          unloadMs: 0,
          homeNodeId: 'p-a',
          widthMm: 700,
        },
      ],
    });
    expect(checkFactoryBuilding(lane, door)).toEqual([]);
  });

  it('checks a lane over the whole height, by the rise of leaning doors and past wall ends', () => {
    // A 700 mm lane from (x, -1,000) to (x, 1,000).
    const laneAt = (x: number) =>
      inBox([], {
        paths: {
          nodes: [
            { id: 'p-a', x, y: -1000 },
            { id: 'p-b', x, y: 1000 },
          ],
          segments: [{ id: 's', from: 'p-a', to: 'p-b' }],
        },
        fleets: [
          {
            id: 'agv',
            name: 'AGV',
            count: 1,
            speedMmS: 1000,
            loadMs: 0,
            unloadMs: 0,
            homeNodeId: 'p-a',
            widthMm: 700,
          },
        ],
      });
    const build = (edit: (bim: ReturnType<typeof f31BoxBuilding>) => void) => {
      const bim = f31BoxBuilding();
      edit(bim);
      return bim;
    };
    const check = (x: number, bim: ReturnType<typeof f31BoxBuilding>) =>
      checkFactoryBuilding(laneAt(x), bim).map((d) => d.code);
    // A 2,050 mm door in the south wall: upright it clears 2,000 mm; leaning 0.3 rad its head
    // is only 2,050 cos 0.3 = 1,958 mm up.
    const door = (lean: number, heightMm: number) =>
      build((bim) => {
        const w = bim.elements.find((e) => e.id === 'w-south') as BimWall;
        if (lean) w.lean = lean;
        bim.elements = bim.elements.filter((e) => e.id === 'w-south' || e.id === 'd-entrance');
        bim.types = bim.types.map((t) => (t.id === 't-door-900' ? { ...t, heightMm } : t));
      });
    expect(check(2450, door(0, 2050))).toEqual([]);
    expect(check(2450, door(0.3, 2400))).toEqual([]);
    expect(check(2450, door(0.3, 2050))).toEqual(['path-clash']);
    // A door from x 200 beside the wall's end at x 0: a lane at x 150 runs into the pier too.
    const end = build((bim) => {
      bim.elements = bim.elements.filter((e) => e.id === 'w-south' || e.id === 'd-entrance');
      (bim.elements.find((e) => e.id === 'd-entrance') as unknown as BimDoorish).alongMm = 200;
      bim.joins = [];
    });
    expect(check(650, end)).toEqual([]);
    expect(check(150, end)).toEqual(['path-clash']);
    // A column slanting 5,000 mm sideways for every 250 mm up crosses a lane at x 2,500
    // between the heights sampled.
    const slant = build((bim) => {
      bim.elements = [
        {
          id: 'c-1',
          kind: 'column',
          typeId: 't-column-600',
          at: { xy: [0, 0] },
          topAt: { xy: [40000, 0] },
          rotationRad: 0,
          base: { level: 'l-1f', offsetMm: 0 },
          top: { heightMm: 2000 },
        } as never,
      ];
    });
    expect(check(2500, slant)).toEqual(['path-clash']);
    expect(check(-8000, slant)).toEqual([]);
  });

  it('cuts columns as built (lean along their axis, taper) and arcs within 2 mm', () => {
    const build = (edit: (bim: ReturnType<typeof f31BoxBuilding>) => void) => {
      const bim = f31BoxBuilding();
      edit(bim);
      return bim;
    };
    const tiny = (h: number) => ({ size: { widthMm: 20, depthMm: 20, heightMm: h } });
    const at = (bim: ReturnType<typeof f31BoxBuilding>, x: number, y: number, extra = tiny(1000)) =>
      checkFactoryBuilding(inBox([station('a', x, y, extra)]), bim).map((d) => d.code);
    const column = (extra: Record<string, unknown>) =>
      build((bim) => {
        bim.elements = [
          {
            id: 'c-1',
            kind: 'column',
            typeId: 't-column-600',
            at: { xy: [5000, 4000] },
            rotationRad: 0,
            base: { level: 'l-1f', offsetMm: 0 },
            top: { heightMm: 6000 },
            ...extra,
          } as never,
        ];
      });
    // A 600 mm column leaning to (8,000, 4,000) at 6,000 mm: its profile is square to its axis,
    // so its cut is about 671 mm long; at 1,000 mm it reaches x 5,835.
    const leaning = column({ topAt: { xy: [8000, 4000] } });
    expect(at(leaning, 5820, 4000)).toEqual(['object-clash']);
    expect(at(leaning, 5860, 4000)).toEqual([]);
    // An upright column from 6,000 mm under the floor, tapering to 0.1: at the floor it reaches
    // only x 5,165.
    const tapered = column({
      base: { level: 'l-1f', offsetMm: -6000 },
      top: { heightMm: 12000 },
      topScale: 0.1,
    });
    expect(at(tapered, 5250, 4000)).toEqual([]);
    expect(at(tapered, 5150, 4000)).toEqual(['object-clash']);
    // A half-circle south wall (bulge 1, radius about 5,000 mm): a station just inside its
    // outer face clashes (16 pieces an arc would miss it by about 25 mm).
    const arc = build((bim) => {
      const w = bim.elements.find((e) => e.id === 'w-south') as BimWall;
      w.bulge = 1;
      bim.elements = [w];
      bim.joins = [];
    });
    // Leaning 0.3 rad, base and top are sampled alike: the wall's upper part over a station
    // outside its base still clashes.
    const leaningArc = build((bim) => {
      const w = bim.elements.find((e) => e.id === 'w-south') as BimWall;
      w.bulge = 1;
      w.lean = 0.3;
      bim.elements = [w];
      bim.joins = [];
    });
    const obstacle = factoryObstacles(leaningArc)[0]!;
    expect(obstacle.outlineTop).toHaveLength(obstacle.outline.length);
    expect(
      at(leaningArc, 5000, -5500, { size: { widthMm: 200, depthMm: 200, heightMm: 2000 } }),
    ).toEqual(['object-clash']);
    expect(at(arc, 5500, -5170, { size: { widthMm: 200, depthMm: 200, heightMm: 1000 } })).toEqual([
      'object-clash',
    ]);
  });

  it('validates sizes, lane widths and the building reference', () => {
    const doc = inBox([station('a', 0, 0, { size: { widthMm: 0, depthMm: 1, heightMm: 1 } })]);
    expect(validateFactory(doc).map((d) => d.path)).toEqual(['$.objects.0.size.widthMm']);
    const bad = { ...inBox([]), building: { artifactId: 'b', versionId: '' } };
    expect(
      validateFactory(bad)
        .map((d) => d.path)
        .sort(),
    ).toEqual(['$.building.contentHash', '$.building.versionId']);
    const set = applyFactoryOperation(newFactory('x'), {
      type: 'setBuilding',
      building: { artifactId: 'b', versionId: 'v', contentHash: 'h' },
    });
    expect(set.building).toEqual({ artifactId: 'b', versionId: 'v', contentHash: 'h' });
    expect(applyFactoryOperation(set, { type: 'setBuilding', building: null }).building).toBe(
      undefined,
    );
  });
});
