import { describe, expect, it } from 'vitest';
import {
  checkBuildingInSite,
  earthworkVolumes,
  f86OfficeSite,
  scheduleConstruction,
  siteTerrain,
  siteWorksOnDay,
  triangulatePolygon,
  type Plan,
  type TemporaryWork,
} from '@editor-platform/construction-core';
import {
  formatPlanList,
  formatVolume,
  parsePlanList,
  siteGroundMeshes,
  siteViewSolids,
  temporaryMesh,
} from './index';

const area = (poly: Plan[], tris: number[]) => {
  let a = 0;
  for (let k = 0; k < tris.length; k += 3) {
    const [p, q, r] = [poly[tris[k]!]!, poly[tris[k + 1]!]!, poly[tris[k + 2]!]!];
    const turn = (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    expect(turn).toBeGreaterThan(0);
    a += turn / 2;
  }
  return a;
};

describe('CS2b site view and forms (ST-544, TS-2075)', () => {
  it('triangulates outlines either way round, concave ones too (ST-544#2)', () => {
    const l: Plan[] = [
      [0, 0],
      [4000, 0],
      [4000, 1000],
      [1000, 1000],
      [1000, 3000],
      [0, 3000],
    ];
    expect(area(l, triangulatePolygon(l))).toBeCloseTo(6e6, 6);
    const back = [...l].reverse();
    expect(area(back, triangulatePolygon(back))).toBeCloseTo(6e6, 6);
    // A corner on a straight edge is kept in a triangle or dropped, never folded.
    const straight: Plan[] = [
      [0, 0],
      [1000, 0],
      [2000, 0],
      [2000, 1000],
      [0, 1000],
    ];
    expect(area(straight, triangulatePolygon(straight))).toBeCloseTo(2e6, 6);
  });

  it('draws temporary works as closed prisms on the ground or their own base (ST-544#2)', () => {
    const t: TemporaryWork = {
      id: 't',
      name: 'Office',
      kind: 'office',
      outline: [
        [0, 0],
        [0, 3000],
        [6000, 3000],
        [6000, 0],
      ],
      height: 2500,
      fromTaskId: 'a',
    };
    const mesh = temporaryMesh(t, ([x]) => x / 10);
    const zs = [...mesh.positions].filter((_, i) => i % 3 === 2);
    // Standing on its lowest corner.
    expect(Math.min(...zs)).toBe(0);
    expect(Math.max(...zs)).toBe(2500);
    // Every face points outwards: the sum of the face normals × area is zero and the volume
    // (divergence theorem) is the prism's.
    let volume = 0;
    const p = mesh.positions;
    for (let k = 0; k < mesh.indices.length; k += 3) {
      const [a, b, c] = [0, 1, 2].map((i) => mesh.indices[k + i]! * 3);
      const ax = p[a]!;
      const ay = p[a! + 1]!;
      const az = p[a! + 2]!;
      const bx = p[b!]!;
      const by = p[b! + 1]!;
      const bz = p[b! + 2]!;
      const cx = p[c!]!;
      const cy = p[c! + 1]!;
      const cz = p[c! + 2]!;
      volume +=
        (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    }
    expect(volume).toBeCloseTo(6000 * 3000 * 2500, -3);
    expect(
      Math.max(
        ...[...temporaryMesh({ ...t, baseZ: 900 }, () => 0).positions].filter(
          (_, i) => i % 3 === 2,
        ),
      ),
    ).toBe(3400);
  });

  it('lowers the ground as the earthworks go and shows what stands that day (ST-544#1)', () => {
    const doc = f86OfficeSite();
    const site = doc.site!;
    const schedule = scheduleConstruction(doc);
    const terrain = siteTerrain(site);
    const volumes = earthworkVolumes(site, terrain);
    const pitTask = schedule.byId.get('site')!;
    const before = siteWorksOnDay(doc, schedule, volumes, '2027-03-31');
    const after = siteWorksOnDay(doc, schedule, volumes, pitTask.finish);
    const lowest = (progress: ReadonlyMap<string, number>) => {
      const g = siteGroundMeshes(site, progress, terrain)!;
      return {
        moved: g.moved.indices.length / 3,
        kept: g.kept.indices.length / 3,
        z: Math.min(...[...g.kept.positions].filter((_, i) => i % 3 === 2)),
      };
    };
    const untouched = lowest(before.progress);
    expect(untouched.moved).toBe(0);
    const dug = lowest(after.progress);
    expect(dug.moved).toBeGreaterThan(1000);
    // The pit's floor is at its level.
    expect(dug.z).toBeCloseTo(-1500, 0);
    // Before the site work nothing stands; the day the pit is done the hoarding, gate and office do.
    const ids = (works: typeof before) =>
      siteViewSolids(site, {
        progress: works.progress,
        standing: works.standing,
        terrain,
      }).solids.map((s) => s.instances[0]!.path[0]);
    expect(ids(before)).toEqual([' site:ground', ' site:boundary']);
    expect(ids(after)).toEqual([
      ' site:ground',
      ' site:boundary',
      ' site:temporary:hoarding',
      ' site:temporary:gate',
      ' site:temporary:office',
    ]);
    const shown = siteViewSolids(site, {
      progress: after.progress,
      standing: after.standing,
      selected: 'office',
      terrain,
    });
    expect(
      shown.solids.find((s) => s.instances[0]!.path[0] === ' site:temporary:office')!.instances[0]!
        .selected,
    ).toBe(true);
    // The view frames the whole plot.
    expect(shown.bounds![0][0]).toBeLessThan(-15000);
    expect(shown.bounds![1][0]).toBeGreaterThan(60000);
  });

  it('lists building elements over the boundary (ST-544#3)', () => {
    const site = f86OfficeSite().site!;
    const inside = { id: 'wall-1', name: 'Wall', points: [[0, 0] as Plan, [10000, 0] as Plan] };
    expect(checkBuildingInSite(site, [inside])).toEqual([]);
    // On the boundary is inside; past it is not.
    const edge = { id: 'edge', points: [[-15000, 0] as Plan] };
    expect(checkBuildingInSite(site, [edge])).toEqual([]);
    const over = { id: 'col', name: 'Column', points: [[-15100, 0] as Plan, [-15200, 0] as Plan] };
    expect(checkBuildingInSite(site, [inside, over])).toEqual([
      {
        code: 'outside-boundary',
        path: 'building:col',
        message: 'Column (building) stands over the site boundary',
      },
    ]);
    // On a U-shaped site a wall across both arms has its ends inside; its edge is not.
    const u = {
      ...site,
      boundary: [
        [0, 0],
        [30000, 0],
        [30000, 20000],
        [20000, 20000],
        [20000, 5000],
        [10000, 5000],
        [10000, 20000],
        [0, 20000],
      ] as Plan[],
    };
    const ends: Plan[] = [
      [5000, 15000],
      [25000, 15000],
    ];
    expect(checkBuildingInSite(u, [{ id: 'w', points: ends }])).toEqual([]);
    expect(
      checkBuildingInSite(u, [{ id: 'w', points: ends, edges: [[ends[0]!, ends[1]!]] }]),
    ).toHaveLength(1);
    // Along the notch's edges is inside.
    const notch: Plan[] = [
      [10000, 20000],
      [10000, 5000],
      [20000, 5000],
      [20000, 20000],
    ];
    expect(
      checkBuildingInSite(u, [
        { id: 'n', points: notch, edges: notch.slice(1).map((q, k) => [notch[k]!, q] as const) },
      ]),
    ).toEqual([]);
    // Without a boundary nothing is checked.
    expect(checkBuildingInSite(undefined, [over])).toEqual([]);
  });

  it('reads and writes the outline fields, and shows volumes (ST-544#2)', () => {
    expect(parsePlanList('0, 0\n60000,0\n 60000 45000 ; -5.5, 3')).toEqual([
      [0, 0],
      [60000, 0],
      [60000, 45000],
      [-5.5, 3],
    ]);
    expect(parsePlanList('0, 0\nten, 3')).toBe('"ten, 3" is not "x, y" in mm');
    expect(
      formatPlanList([
        [0, 0],
        [1, -2],
      ]),
    ).toBe('0, 0\n1, -2');
    expect(formatVolume(2151.4)).toBe('2,151');
    expect(formatVolume(8.04)).toBe('8.0');
  });
});
