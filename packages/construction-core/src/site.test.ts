import { describe, expect, it } from 'vitest';
import {
  applyConstructionOperation,
  checkSite,
  earthworkProgress,
  earthworkVolumes,
  emptySite,
  f86OfficeSite,
  groundOnDay,
  readTerrainCsv,
  scheduleConstruction,
  siteTerrain,
  siteWorksOnDay,
  validateConstruction,
  type ConstructionDocument,
  type Earthwork,
} from './index';

const rect = (x0: number, y0: number, x1: number, y1: number): [number, number][] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];
const pit = (over: Partial<Earthwork> = {}): Earthwork => ({
  id: 'pit',
  name: 'Pit',
  kind: 'cut',
  outline: rect(0, 0, 10000, 10000),
  levelZ: -2000,
  slope: 0,
  taskId: 'site',
  ...over,
});
const codes = (doc: unknown) => validateConstruction(doc).map((d) => d.code);

describe('CS2a site, ground and earthworks (ST-543, TS-2074)', () => {
  it('keeps a valid site and refuses bad shapes (ST-543#1)', () => {
    const doc = f86OfficeSite();
    expect(validateConstruction(doc)).toEqual([]);
    const withSite = (site: unknown) => ({ ...f86OfficeSite(), site });
    expect(
      codes(
        withSite({
          ...doc.site,
          boundary: [
            [0, 0],
            [1, 1],
          ],
        }),
      ),
    ).toEqual(['polygon']);
    // Edges that touch or fold back are not simple; an L shape is.
    for (const boundary of [
      [
        [0, 0],
        [4000, 0],
        [4000, 4000],
        [2000, 0],
        [0, 4000],
      ],
      [
        [0, 0],
        [4000, 0],
        [2000, 0],
        [2000, 3000],
      ],
    ])
      expect(codes(withSite({ ...doc.site, boundary }))).toEqual(['polygon']);
    expect(
      codes(
        withSite({
          ...doc.site,
          boundary: [
            [-20000, -20000],
            [70000, -20000],
            [70000, 10000],
            [40000, 10000],
            [40000, 50000],
            [-20000, 50000],
          ],
        }),
      ),
    ).toEqual([]);
    // A bow tie is not a simple polygon.
    expect(
      codes(
        withSite({
          ...doc.site,
          boundary: [
            [0, 0],
            [10, 10],
            [10, 0],
            [0, 10],
          ],
        }),
      ),
    ).toEqual(['polygon']);
    expect(
      codes(
        withSite({
          ...doc.site,
          terrain: [
            [0, 0, 1],
            [0, 0, 2],
          ],
        }),
      ),
    ).toEqual(['terrain']);
    expect(
      codes(
        withSite({
          ...doc.site,
          terrain: [
            [0, 0, 1],
            [1, 1, 2],
            [2, 2, 3],
          ],
        }),
      ),
    ).toEqual(['terrain']);
    const bad = structuredClone(doc.site!);
    bad.earthworks[0]!.slope = -1;
    bad.earthworks[1]!.taskId = 'nope';
    bad.temporaries[0]!.height = 0;
    bad.temporaries[1]!.id = 'pit';
    (bad.temporaries[2] as { kind: string }).kind = 'crane';
    expect(codes(withSite(bad))).toEqual([
      'slope',
      'task-missing',
      'height',
      'duplicate-id',
      'kind',
    ]);
    expect(codes(withSite({ ...doc.site, extra: 1 }))).toEqual(['unknown-key']);
  });

  it('reads the ground from survey points (ST-543#2)', () => {
    const t = siteTerrain({
      terrain: [
        [0, 0, 0],
        [10000, 0, 1000],
        [0, 10000, 2000],
        [10000, 10000, 3000],
      ],
    });
    expect(t.heightAt([5000, 5000])).toBeCloseTo(1500);
    expect(t.heightAt([2500, 0])).toBeCloseTo(250);
    // Outside the survey: the nearest point.
    expect(t.heightAt([20000, 20000])).toBe(3000);
    expect(siteTerrain(undefined).heightAt([1, 2])).toBe(0);
    const big = f86OfficeSite().site!.terrain;
    const tin = siteTerrain({ terrain: big });
    for (const [x, y, z] of big.slice(0, 50)) expect(tin.heightAt([x, y])).toBeCloseTo(z, 6);
    expect(readTerrainCsv('X,y,Z\n0,0,0\n1000,0,10\n0,1000,20.5\n')).toEqual({
      points: [
        [0, 0, 0],
        [1000, 0, 10],
        [0, 1000, 20.5],
      ],
      diagnostics: [],
    });
    expect(readTerrainCsv('x,y\n').diagnostics.map((d) => d.message)).toEqual(['no "z" column']);
    expect(
      readTerrainCsv('x,y,z\n0,0,a\n0,0,1\n').diagnostics.map((d) => `${d.path} ${d.message}`),
    ).toEqual(['line 2 z "a" is not a number of mm', 'line 3 two heights at 0,0']);
  });

  it('measures cut and fill (ST-543#3)', () => {
    const site = { ...emptySite(), earthworks: [pit()] };
    // Flat ground, vertical sides: 10 m × 10 m × 2 m.
    expect(earthworkVolumes(site)[0]!.cut).toBeCloseTo(200, 6);
    // Sides 1 : 1: prism + side wedges + corner cones (A·h + P·s·h²/2 + π·s²·h³/3).
    const sloped = earthworkVolumes({ ...site, earthworks: [pit({ slope: 1 })] })[0]!;
    const exact = 100 * 2 + (40 * 1 * 4) / 2 + (Math.PI * 8) / 3;
    expect(Math.abs(sloped.cut - exact) / exact).toBeLessThan(0.01);
    expect(sloped.fill).toBe(0);
    // A deep hollow far away does not widen a cut (it is below the level), nor dilute it.
    const hollow = earthworkVolumes({
      ...emptySite(),
      terrain: [
        [-10000, -10000, 0],
        [10000, -10000, 0],
        [-10000, 10000, 0],
        [10000, 10000, 0],
        [1e6, 1e6, -5e5],
      ],
      earthworks: [pit({ outline: rect(-1000, -1000, 1000, 1000), levelZ: -1000, slope: 1 })],
    })[0]!;
    const small = 4 + (8 * 1) / 2 + Math.PI / 3;
    expect(Math.abs(hollow.cut - small) / small).toBeLessThan(0.02);
    // A long narrow trench lying diagonally: 0.5 m × ~141 m × 1 m = 100 m³.
    const trench = earthworkVolumes({
      ...emptySite(),
      earthworks: [
        pit({
          outline: [
            [0, 0],
            [100000, 100000],
            [99500, 100500],
            [-500, 500],
          ],
          levelZ: -1000,
        }),
      ],
    })[0]!;
    expect(Math.abs(trench.cut - 100) / 100).toBeLessThan(0.02);
    // Ground rising almost as steeply as the side: the reach falls back to the whole survey.
    const steep = earthworkVolumes({
      ...emptySite(),
      terrain: [
        [-300000, -300000, -297000],
        [300000, -300000, 297000],
        [-300000, 300000, -297000],
        [300000, 300000, 297000],
      ],
      earthworks: [pit({ outline: rect(-2000, 0, 0, 2000), levelZ: -2000, slope: 1 })],
    })[0]!;
    expect(steep.cut).toBeGreaterThan(3000);
    // Flat around the pit, a high bench farther off: the side slope still reaches the bench.
    const bench = earthworkVolumes({
      ...emptySite(),
      terrain: [-20000, 2000, 5000, 20000].flatMap((x, i) =>
        [-20000, 20000].map((y) => [x, y, i < 2 ? 0 : 10000] as [number, number, number]),
      ),
      earthworks: [pit({ outline: rect(0, 0, 1000, 1000), levelZ: -1000, slope: 1 })],
    })[0]!;
    expect(bench.cut).toBeGreaterThan(380);
    expect(bench.cut).toBeLessThan(410);
    // A far-off survey point widens the reach, but the pit keeps its own resolution:
    // 2 m × 2 m × 1 m plus sides of slope 1 = 4 + 8/2 + π/3 m³.
    const remote = earthworkVolumes({
      ...emptySite(),
      terrain: [
        [-10000, -10000, 0],
        [10000, -10000, 0],
        [-10000, 10000, 0],
        [10000, 10000, 0],
        [10000000, 10000000, 5000000],
      ],
      earthworks: [pit({ outline: rect(-1000, -1000, 1000, 1000), levelZ: -1000, slope: 1 })],
    })[0]!;
    const pitVolume = 4 + 8 / 2 + Math.PI / 3;
    expect(Math.abs(remote.cut - pitVolume) / pitVolume).toBeLessThan(0.02);
    // A fill to 1 m on flat ground, vertical sides.
    const fill = earthworkVolumes({ ...site, earthworks: [pit({ kind: 'fill', levelZ: 1000 })] });
    expect(fill[0]).toMatchObject({ cut: 0 });
    expect(fill[0]!.fill).toBeCloseTo(100, 6);
    // On sloping ground a cut only takes what stands above the level.
    const slopeGround = {
      ...site,
      terrain: [
        [-5000, 0, -3000],
        [15000, 0, 1000],
        [-5000, 10000, -3000],
        [15000, 10000, 1000],
      ] as [number, number, number][],
      earthworks: [pit()],
    };
    // Ground z = 0.2·x − 2000 over x 0..10 m: above −2 m everywhere, mean depth 1 m.
    expect(earthworkVolumes(slopeGround)[0]!.cut).toBeCloseTo(100, 0);
  });

  it('moves the ground over the task days and stands temporary works by their tasks (ST-543#4)', () => {
    const doc = f86OfficeSite();
    const plan = scheduleConstruction(doc);
    const site = plan.byId.get('site')!;
    const pitWork = doc.site!.earthworks[0]!;
    expect(earthworkProgress(doc, plan, pitWork, '2027-03-31')).toBe(0);
    expect(earthworkProgress(doc, plan, pitWork, site.finish)).toBe(1);
    const mid = earthworkProgress(doc, plan, pitWork, site.start);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    // Site preparation runs Thu 04-01 to Tue 04-06 (Mon–Sat): no digging on Sunday.
    expect(earthworkProgress(doc, plan, pitWork, '2027-04-03')).toBeCloseTo(3 / 5);
    expect(earthworkProgress(doc, plan, pitWork, '2027-04-04')).toBeCloseTo(3 / 5);
    expect(earthworkProgress(doc, plan, pitWork, '2027-04-05')).toBeCloseTo(4 / 5);
    const volumes = earthworkVolumes(doc.site!);
    const pitVolume = volumes[0]!.cut;
    // 45.2 m × 30.8 m dug to 1.5 m below the ground floor on ground about ±0.8 m: some 2,000 m³.
    expect(pitVolume).toBeGreaterThan(1500);
    expect(pitVolume).toBeLessThan(3000);
    expect(volumes[1]!.fill).toBeGreaterThan(0);
    const before = siteWorksOnDay(doc, plan, volumes, '2027-03-31');
    expect(before).toMatchObject({ cut: 0, fill: 0, standing: [] });
    const done = siteWorksOnDay(doc, plan, volumes, site.finish);
    expect(done.cut).toBeCloseTo(pitVolume);
    expect(done.standing).toEqual(['hoarding', 'gate', 'office']);
    const walls = siteWorksOnDay(doc, plan, volumes, plan.byId.get('walls-1')!.start);
    expect(walls.standing).toEqual(['hoarding', 'gate', 'office', 'yard', 'scaffold']);
    const end = siteWorksOnDay(doc, plan, volumes, plan.byId.get('complete')!.start);
    expect(end.standing).toEqual(['hoarding', 'gate', 'office']);
    // The ground in the pit is at its level once dug, and partly down while digging.
    const terrain = siteTerrain(doc.site);
    const at: [number, number] = [20000, 15000];
    expect(groundOnDay(doc.site!, terrain, done.progress, at)).toBeCloseTo(-1500);
    const half = new Map([['pit', 0.5]]);
    expect(groundOnDay(doc.site!, terrain, half, at)).toBeCloseTo(
      (terrain.heightAt(at) - 1500) / 2,
    );
  });

  it('flags works over the boundary and scaffolds taken down before they go up (ST-543#5)', () => {
    const doc = f86OfficeSite();
    expect(checkSite(doc, scheduleConstruction(doc))).toEqual([]);
    doc.site!.temporaries[2]!.outline = rect(58000, 30000, 62000, 36000);
    doc.site!.earthworks[0]!.outline = rect(-14800, -1000, 44200, 29800);
    doc.site!.temporaries[4]!.untilTaskId = 'site';
    expect(checkSite(doc, scheduleConstruction(doc)).map((d) => [d.code, d.path])).toEqual([
      ['outside-boundary', '$.site.temporaries[2].outline'],
      ['removed-before-put-up', '$.site.temporaries[4].untilTaskId'],
      ['outside-boundary', '$.site.earthworks[0].outline'],
    ]);
    // A cut above the ground moves nothing, so it is not over; a side climbing rising ground is.
    const small = {
      ...f86OfficeSite(),
      site: {
        ...emptySite(),
        boundary: rect(-3000, -3000, 3000, 3000),
        earthworks: [pit({ outline: rect(100, 100, 900, 900), levelZ: 1000, slope: 1 })],
      },
    };
    expect(checkSite(small)).toEqual([]);
    // A vertical-sided pit filling the site to its boundary moves nothing outside it.
    small.site.earthworks = [pit({ outline: rect(-3000, -3000, 3000, 3000), levelZ: -1000 })];
    expect(checkSite(small)).toEqual([]);
    small.site.terrain = [
      [-10000, -10000, -9000],
      [10000, -10000, 9000],
      [-10000, 10000, -9000],
      [10000, 10000, 9000],
    ];
    small.site.earthworks = [pit({ outline: rect(0, 0, 1000, 1000), levelZ: -1000, slope: 1 })];
    expect(checkSite(small).map((d) => d.code)).toEqual(['outside-boundary']);
    // Flat around the boundary, a high bench beyond it that the side slope still cuts into.
    small.site.boundary = rect(-3000, -3000, 2500, 3000);
    small.site.terrain = [-20000, 3000, 5000, 20000].flatMap((x, i) =>
      [-20000, 20000].map((y) => [x, y, i < 2 ? 0 : 10000] as [number, number, number]),
    );
    expect(checkSite(small).map((d) => d.code)).toEqual(['outside-boundary']);
    // A vertical pit tucked into a concave corner of the boundary stays inside it.
    small.site.terrain = [];
    small.site.boundary = [
      [0, 0],
      [10000, 0],
      [10000, 10000],
      [7000, 10000],
      [7000, 7000],
      [0, 7000],
    ];
    small.site.earthworks = [
      pit({
        outline: [
          [7000, 6500],
          [8000, 6500],
          [8000, 8000],
          [7000, 8000],
        ],
        levelZ: -1000,
      }),
    ];
    expect(checkSite(small)).toEqual([]);
    // A temporary work along the boundary is inside it.
    const edge = f86OfficeSite();
    edge.site!.temporaries[0]!.outline = rect(-15000, -15000, 60000, -14800);
    expect(checkSite(edge, scheduleConstruction(edge))).toEqual([]);
    // A yard across both arms of a U-shaped site: every corner is inside, its middle is not.
    const u = f86OfficeSite();
    u.site!.boundary = [
      [-15000, -15000],
      [60000, -15000],
      [60000, 30000],
      [40000, 30000],
      [40000, 0],
      [5000, 0],
      [5000, 30000],
      [-15000, 30000],
    ];
    u.site!.earthworks = [];
    u.site!.temporaries = [u.site!.temporaries[0]!];
    u.site!.temporaries[0]!.outline = rect(0, 20000, 50000, 25000);
    expect(checkSite(u, scheduleConstruction(u)).map((d) => d.path)).toEqual([
      '$.site.temporaries[0].outline',
    ]);
    // Following the notch's edges exactly is inside.
    u.site!.temporaries[0]!.outline = [
      [0, -5000],
      [45000, -5000],
      [45000, 10000],
      [40000, 10000],
      [40000, 0],
      [5000, 0],
      [5000, 10000],
      [0, 10000],
    ];
    expect(checkSite(u, scheduleConstruction(u))).toEqual([]);
    // Actual dates decide: taken down after the roof as built, though planned before it.
    const late = f86OfficeSite();
    late.site!.temporaries[4]!.fromTaskId = 'roof';
    late.site!.temporaries[4]!.untilTaskId = 'ground';
    expect(checkSite(late, scheduleConstruction(late)).map((d) => d.code)).toEqual([
      'removed-before-put-up',
    ]);
    late.tasks.find((t) => t.id === 'ground')!.actual = {
      start: '2027-04-07',
      finish: '2027-08-20',
    };
    expect(checkSite(late, scheduleConstruction(late))).toEqual([]);
  });

  it('edits the site as operations and keeps named tasks (ST-543#6)', () => {
    let doc: ConstructionDocument = f86OfficeSite();
    expect(() => applyConstructionOperation(doc, { type: 'removeTask', id: 'complete' })).toThrow(
      /names this task/,
    );
    doc = applyConstructionOperation(doc, {
      type: 'putEarthwork',
      earthwork: { ...doc.site!.earthworks[0]!, levelZ: -2500 },
    });
    expect(doc.site!.earthworks[0]!.levelZ).toBe(-2500);
    expect(() =>
      applyConstructionOperation(doc, {
        type: 'putTemporary',
        temporary: { ...doc.site!.temporaries[0]!, id: 'pit' },
      }),
    ).toThrow(/pit is used twice/);
    doc = applyConstructionOperation(doc, { type: 'removeTemporary', id: 'gate' });
    expect(doc.site!.temporaries.map((t) => t.id)).not.toContain('gate');
    doc = applyConstructionOperation(doc, { type: 'removeEarthwork', id: 'yard-fill' });
    expect(() =>
      applyConstructionOperation(doc, {
        type: 'setSiteGround',
        boundary: rect(0, 0, 1, 1).slice(0, 2),
        terrain: [],
      }),
    ).toThrow();
    doc = applyConstructionOperation(doc, {
      type: 'setSiteGround',
      boundary: rect(0, 0, 100000, 100000),
      terrain: [],
    });
    expect(doc.site!.terrain).toEqual([]);
    expect(doc.site!.earthworks).toHaveLength(1);
    // A schedule without a site gets one on its first site edit.
    const bare = f86OfficeSite();
    delete bare.site;
    const one = applyConstructionOperation(bare, { type: 'putEarthwork', earthwork: pit() });
    expect(one.site).toEqual({ ...emptySite(), earthworks: [pit()] });
  });
});
