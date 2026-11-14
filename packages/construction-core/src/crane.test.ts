import { describe, expect, it } from 'vitest';
import {
  bimElementMass,
  deriveBim,
  f37Office,
  validateBim,
  type BimDocument,
} from '@editor-platform/bim-core';
import {
  applyConstructionOperation,
  type Point3,
  bodyMeetsBox,
  capacityAt,
  checkCranes,
  craneReach,
  f87Building,
  f87OfficeCranes,
  liftMotion,
  liftTimes,
  scheduleConstruction,
  siteTaskRefs,
  siteTerrain,
  triangleMeetsBox,
  validateConstruction,
  type Box,
  type ConstructionDocument,
  type Crane,
  type Lift,
  type CraneWorld,
  type LiftBody,
} from './index';

/** Bodies of the F37 columns, beams and slabs from their derived shapes (boxes, no kernel). */
function bodies(bim: BimDocument): Map<string, LiftBody> {
  const derived = deriveBim(bim);
  const out = new Map<string, LiftBody>();
  for (const [id, s] of derived.shapes) {
    let box: Box | undefined;
    if (s.kind === 'column' && s.profile.shape === 'rect') {
      const [w, d] = [s.profile.widthMm / 2, s.profile.depthMm / 2];
      box = [
        [s.at[0] - w, s.at[1] - d, s.zBase],
        [s.at[0] + w, s.at[1] + d, s.zTop],
      ];
    } else if (s.kind === 'beam' && s.profile.shape === 'rect') {
      const half = s.profile.widthMm / 2;
      const x = s.start[0] === s.end[0];
      box = [
        [
          Math.min(s.start[0], s.end[0]) - (x ? half : 0),
          Math.min(s.start[1], s.end[1]) - (x ? 0 : half),
          s.zTop - s.profile.depthMm,
        ],
        [
          Math.max(s.start[0], s.end[0]) + (x ? half : 0),
          Math.max(s.start[1], s.end[1]) + (x ? 0 : half),
          s.zTop,
        ],
      ];
    } else if (s.kind === 'slab') {
      const xs = s.boundary.map((p) => p[0]);
      const ys = s.boundary.map((p) => p[1]);
      box = [
        [Math.min(...xs), Math.min(...ys), s.zBottom],
        [Math.max(...xs), Math.max(...ys), s.zTop],
      ];
    }
    if (box) out.set(id, { bounds: box });
  }
  return out;
}

function world(bim: BimDocument, doc: ConstructionDocument): CraneWorld {
  const derived = deriveBim(bim);
  const terrain = siteTerrain(doc.site);
  return {
    bodies: bodies(bim),
    mass: (id) => {
      const m = bimElementMass(bim, derived, id);
      return m.status === 'ok' ? { kg: m.kg } : { reason: m.status };
    },
    ground: (p) => terrain.heightAt(p),
  };
}

const check = (bim: BimDocument, doc: ConstructionDocument) =>
  checkCranes(doc, scheduleConstruction(doc), world(bim, doc));

describe('CS3a cranes and lifts (ST-545, TS-2077)', () => {
  it('gives masses from the materials, or says why not (ST-545#1)', () => {
    const plain = f37Office();
    expect(bimElementMass(plain, deriveBim(plain), 'c-1-1-1')).toEqual({
      status: 'no-density',
      materialIds: ['m-concrete'],
    });
    const bim = f87Building();
    const derived = deriveBim(bim);
    // 600 × 600 × 4,000 mm of concrete at 2,400 kg/m³.
    const column = bimElementMass(bim, derived, 'c-1-1-1');
    expect(column.status).toBe('ok');
    expect(column.status === 'ok' && column.kg).toBeCloseTo(3456, 6);
    expect(bimElementMass(bim, derived, 'nope')).toEqual({ status: 'missing' });
    // A wall of two layers: concrete 180 and plaster 20 by their share of the thickness.
    const wall = bim.elements.find((e) => e.kind === 'wall')!;
    const q = derived.quantities.get(wall.id)!.values;
    const v = (q.netVolume ?? q.grossVolume)! * 1e-9;
    const m = bimElementMass(bim, derived, wall.id);
    expect(m.status === 'ok' && m.kg).toBeCloseTo(v * (0.9 * 2400 + 0.1 * 1500), 6);
    // A density is above 0 and at most 30,000 kg/m³.
    bim.materials[0]!.densityKgM3 = 0;
    expect(validateBim(bim).map((d) => d.code)).toContain('material-density');
    bim.materials[0]!.densityKgM3 = 2400;
    expect(validateBim(bim).map((d) => d.code)).not.toContain('material-density');
  });

  it('reads the load chart on the safe side (ST-545#2)', () => {
    const crane = f87OfficeCranes().site!.cranes![0]!;
    expect(craneReach(crane)).toBe(50000);
    expect(capacityAt(crane, 2000)).toBe(0);
    expect(capacityAt(crane, 25000)).toBe(10000);
    expect(capacityAt(crane, 25001)).toBe(8300);
    expect(capacityAt(crane, 50000)).toBe(5000);
    expect(capacityAt(crane, 50001)).toBe(0);
  });

  it('refuses cranes and lifts that do not fit together (ST-545#3)', () => {
    const doc = f87OfficeCranes();
    expect(validateConstruction(doc)).toEqual([]);
    const codes = (d: ConstructionDocument) => validateConstruction(d).map((x) => [x.code, x.path]);
    const rising = structuredClone(doc);
    rising.site!.cranes![0]!.loadChart[1]!.capacityKg = 12000;
    expect(codes(rising)).toEqual([['load-chart', '$.site.cranes[0].loadChart[1].capacityKg']]);
    const long = structuredClone(doc);
    long.site!.cranes![0]!.jibLength = 40000;
    expect(codes(long)).toEqual([['load-chart', '$.site.cranes[0].loadChart[5].radius']]);
    const wrong = structuredClone(doc);
    wrong.site!.lifts![0]!.elementId = 's-2';
    wrong.site!.lifts![1]!.craneId = 'tc-9';
    expect(codes(wrong)).toEqual([
      ['lift-element', '$.site.lifts[0].elementId'],
      ['crane-missing', '$.site.lifts[1].craneId'],
    ]);
    // A crane a lift uses, and a task a crane or lift names, are kept.
    expect(() => applyConstructionOperation(doc, { type: 'removeCrane', id: 'tc-1' })).toThrow(
      'a lift uses this crane',
    );
    expect([...siteTaskRefs(doc.site)]).toEqual(
      expect.arrayContaining(['ground', 'roof', 'col-1', 'beam-5']),
    );
    // Cranes and lifts come and go with their operations; the last one leaves no empty list.
    let d = applyConstructionOperation(f87OfficeCranes(), {
      type: 'putLift',
      lift: { ...doc.site!.lifts![0]!, pick: [50000, 10000, 1000] },
    });
    expect(d.site!.lifts![0]!.pick).toEqual([50000, 10000, 1000]);
    for (const l of doc.site!.lifts!)
      d = applyConstructionOperation(d, { type: 'removeLift', id: l.id });
    d = applyConstructionOperation(d, { type: 'removeCrane', id: 'tc-1' });
    expect(d.site).not.toHaveProperty('cranes');
    expect(d.site).not.toHaveProperty('lifts');
  });

  it('spreads lifts over their task days in order (ST-545#2)', () => {
    const doc = f87OfficeCranes();
    const plan = scheduleConstruction(doc);
    const times = liftTimes(doc, plan);
    const col = plan.byId.get('col-1')!;
    const of = (id: string) => times.get(`lift-${id}`)!;
    expect(of('c-1-1-1').day).toBe(col.start);
    expect(of('c-1-7-5').day <= col.finish).toBe(true);
    expect(of('c-1-1-1').order).toBe(0);
    expect(of('c-1-1-2').order).toBe(1);
    // Every beam of 2F is lifted after every column of 1F.
    expect(of('b-2-x1-1').order).toBeGreaterThan(of('c-1-7-5').order);
  });

  it('lifts the office cleanly, and finds a crane too far, too weak or too low (ST-545#1, #4)', () => {
    const bim = f87Building();
    const doc = f87OfficeCranes(bim);
    expect(check(bim, doc)).toEqual([]);
    // The motion: up from the yard, round, down onto the column's place.
    const crane = doc.site!.cranes![0]!;
    const lift = doc.site!.lifts![0]!;
    const body = bodies(bim).get(lift.elementId)!;
    const m = liftMotion(crane, 0, lift, body, 4000);
    expect(m.at(0).hook).toEqual([52000, 11000, 5000]);
    expect(m.at(1).hook[2]).toBe(4000);
    expect(m.at(1).hook[0]).toBeCloseTo(0, 6);
    expect(m.travelZ).toBe(4000 + 1000 + 4000);
    expect(m.at(m.phases[0]).hook[2]).toBeCloseTo(9000, 6);
    // Too far: the crane moved east, the far corner out of reach.
    const far = structuredClone(doc);
    far.site!.cranes![0]!.base = [40000, -6000];
    expect(check(bim, far).filter((d) => d.code === 'out-of-reach').length).toBeGreaterThan(0);
    // Too weak: the chart halved.
    const weak = structuredClone(doc);
    for (const row of weak.site!.cranes![0]!.loadChart) row.capacityKg /= 2;
    const over = check(bim, weak).filter((d) => d.code === 'overload');
    expect(over.length).toBeGreaterThan(0);
    expect(over[0]!.message).toMatch(/kg at .* m; Tower crane 1 lifts .* kg there/);
    // Too low: the jib under the roof; the load cannot clear the frame and the jib hits it.
    const low = structuredClone(doc);
    low.site!.cranes![0]!.height = 14000;
    const lowCodes = new Set(check(bim, low).map((d) => d.code));
    expect(lowCodes).toContain('load-clash');
    expect(lowCodes).toContain('jib-clash');
    expect(lowCodes).toContain('hook-height');
    // No densities: every lift stops at the mass.
    const plain = f37Office();
    expect(check(plain, f87OfficeCranes(plain)).every((d) => d.code === 'mass-unknown')).toBe(true);
  }, 60_000);

  it('flags a second crane that slews over the first while both stand (ST-545#4)', () => {
    const bim = f87Building();
    const doc = f87OfficeCranes(bim);
    const second = {
      ...doc.site!.cranes![0]!,
      id: 'tc-2',
      name: 'Tower crane 2',
      base: [21600, 40000] as [number, number],
      height: 36000,
    };
    doc.site!.cranes!.push(second);
    expect(check(bim, doc)).toEqual([
      {
        code: 'slew-overlap',
        path: '$.site.cranes[1]',
        message:
          'Tower crane 1 and Tower crane 2 slew over the same ground (jibs 5.5 m apart in height)',
      },
    ]);
    // Not at the same time: the second comes after the first is taken down.
    second.fromTaskId = 'walls-5';
    second.untilTaskId = undefined;
    delete second.untilTaskId;
    expect(check(bim, doc)).toEqual([]);
  });

  it('tests triangles against boxes exactly (ST-545#4)', () => {
    const box: Box = [
      [0, 0, 0],
      [10, 10, 10],
    ];
    // Through the box, outside every face's slab, and past a corner on the diagonal.
    expect(triangleMeetsBox([-5, 5, 5, 15, 5, 5, 5, 5, 20], 0, box)).toBe(true);
    expect(triangleMeetsBox([20, 0, 0, 30, 0, 0, 20, 10, 0], 0, box)).toBe(false);
    expect(triangleMeetsBox([11, 20, 5, 20, 11, 5, 20, 20, 5], 0, box)).toBe(false);
    expect(triangleMeetsBox([9, 20, 5, 20, 9, 5, 20, 20, 5], 0, box)).toBe(false);
    expect(triangleMeetsBox([5, 14, 5, 14, 5, 5, 20, 20, 5], 0, box)).toBe(true);
  });

  describe('review fixes on small sites', () => {
    const tower = (over: Partial<Crane> = {}): Crane => ({
      id: 'tc',
      name: 'TC',
      kind: 'tower',
      base: [0, 0],
      height: 30000,
      jibLength: 50000,
      minRadius: 500,
      loadChart: [{ radius: 50000, capacityKg: 10000 }],
      fromTaskId: 'up',
      ...over,
    });
    const task = (
      id: string,
      action: 'construct' | 'remove',
      elementIds: string[],
      after = '',
    ) => ({
      id,
      name: id,
      durationDays: 2,
      predecessors: after ? [{ taskId: after, lagDays: 0 }] : [],
      action,
      elementIds,
    });
    const small = (
      tasks: ConstructionDocument['tasks'],
      cranes: Crane[],
      lifts: Lift[],
    ): ConstructionDocument => ({
      schemaVersion: 1,
      name: 'small',
      source: { artifactId: 'a', versionId: 'v', contentHash: 'h' },
      startDate: '2026-11-02',
      calendar: { workWeekdays: [1, 2, 3, 4, 5], holidays: [] },
      tasks: [task('up', 'construct', []), ...tasks],
      site: { boundary: [], terrain: [], earthworks: [], temporaries: [], cranes, lifts },
    });
    const lift = (id: string, taskId: string, elementId: string, pick: Point3): Lift => ({
      id,
      craneId: 'tc',
      taskId,
      elementId,
      pick,
    });
    const box = (lo: Point3, hi: Point3): LiftBody => ({ bounds: [lo, hi] });
    const run = (doc: ConstructionDocument, bodies: Record<string, LiftBody>) =>
      checkCranes(doc, scheduleConstruction(doc), {
        bodies: new Map(Object.entries(bodies)),
        mass: () => ({ kg: 1000 }),
        ground: () => 0,
      });

    it('leaves out an element lifted earlier and removed since', () => {
      const doc = small(
        [
          task('a', 'construct', ['e1'], 'up'),
          task('rm', 'remove', ['e1'], 'a'),
          task('b', 'construct', ['e2'], 'rm'),
        ],
        [tower()],
        [lift('l1', 'a', 'e1', [20000, 0, 0]), lift('l2', 'b', 'e2', [20000, 0, 0])],
      );
      // e2 goes where e1 stood, lower than it: e1 standing would be in its way.
      const bodies = {
        e1: box([10000, -500, 0], [11000, 500, 1000]),
        e2: box([10000, -500, 0], [11000, 500, 500]),
      };
      expect(run(doc, bodies)).toEqual([]);
    });

    it('checks what rises above the load at its place all the way down', () => {
      const doc = small(
        [task('a', 'construct', ['e'], 'up')],
        [tower()],
        [lift('l', 'a', 'e', [20000, 0, 0])],
      );
      const load = box([10000, -500, 0], [11000, 500, 1000]);
      // A wall standing (no task) in the load's place, taller than the load.
      const wall = { e: load, w: box([10400, -500, 0], [10600, 500, 1500]) };
      expect(run(doc, wall).map((d) => [d.code, d.message])).toEqual([
        ['load-clash', 'l (e): the load hits w'],
      ]);
      // A slab under it, and a column into which it is set, are supports.
      const under = {
        e: load,
        s: box([9000, -1500, -200], [12000, 1500, 0]),
        c: box([10000, -500, -3000], [10500, 500, 1000]),
      };
      expect(run(doc, under)).toEqual([]);
    });

    it('samples the slew by the jib tip, not the hook', () => {
      const doc = small(
        [task('a', 'construct', ['e'], 'up')],
        [tower({ height: 10000 })],
        [lift('l', 'a', 'e', [1000, 0, 7700])],
      );
      const misses: string[] = [];
      for (let deg = 3; deg < 90; deg += 3) {
        const a = (deg * Math.PI) / 180;
        const [px, py] = [45000 * Math.cos(a), 45000 * Math.sin(a)];
        const codes = run(doc, {
          e: box([-200, 800, 7700], [200, 1200, 7800]),
          pole: box([px - 500, py - 500, 0], [px + 500, py + 500, 12000]),
        }).map((d) => d.code);
        if (!codes.includes('jib-clash')) misses.push(`${deg} ${codes.join(',')}`);
      }
      expect(misses).toEqual([]);
    });

    it('keeps the slew its own samples when the hoist is long', () => {
      // 30 m tower, 50 m jib, hook 1 m out: picked at the ground, a 90° slew.
      const doc = small(
        [task('a', 'construct', ['e'], 'up')],
        [tower()],
        [lift('l', 'a', 'e', [1000, 0, 0])],
      );
      const misses: string[] = [];
      for (let deg = 3; deg < 90; deg += 3) {
        const a = (deg * Math.PI) / 180;
        const [px, py] = [45000 * Math.cos(a), 45000 * Math.sin(a)];
        const codes = run(doc, {
          e: box([-200, 800, 0], [200, 1200, 100]),
          pole: box([px - 500, py - 500, 0], [px + 500, py + 500, 32000]),
        }).map((d) => d.code);
        if (!codes.includes('jib-clash')) misses.push(`${deg} ${codes.join(',')}`);
      }
      expect(misses).toEqual([]);
    });

    it('spreads lifts over actual days before the planned start', () => {
      const doc = small(
        [
          {
            ...task('a', 'construct', ['e1', 'e2'], 'up'),
            actual: { start: '2026-10-19', finish: '2026-10-24' },
          },
        ],
        [tower()],
        [lift('l1', 'a', 'e1', [20000, 0, 0]), lift('l2', 'a', 'e2', [20000, 0, 0])],
      );
      const times = liftTimes(doc, scheduleConstruction(doc));
      // Mon 19 … Fri 23 are worked: two lifts on the 1st and 3rd of them.
      expect([times.get('l1')!.day, times.get('l2')!.day]).toEqual(['2026-10-19', '2026-10-21']);
    });

    it('reports a bad task action instead of throwing', () => {
      const doc = structuredClone(f87OfficeCranes()) as unknown as { tasks: { action: unknown }[] };
      doc.tasks[0]!.action = { toString: 0 };
      (doc as unknown as { site: { lifts: { craneId: unknown }[] } }).site.lifts[0]!.craneId = {
        toString: 0,
      };
      const codes = validateConstruction(doc as unknown as ConstructionDocument).map((d) => d.code);
      expect(codes).toContain('action');
      expect(codes).toContain('crane-missing');
    });

    it('follows a mobile boom tip rising fast near its length', () => {
      // 100 m boom from 3 m: from 99 m to 99.999 m out its tip rises about 13.7 m.
      const doc = small(
        [task('a', 'construct', ['e'], 'up')],
        [
          tower({
            kind: 'mobile',
            height: 3000,
            jibLength: 100000,
            loadChart: [{ radius: 100000, capacityKg: 10000 }],
          }),
        ],
        [lift('l', 'a', 'e', [99000, 0, 0])],
      );
      const codes = run(doc, {
        e: box([99899, -100, 0], [100099, 100, 100]),
        pole: box([99930, -500, 4500], [100030, 500, 5500]),
      }).map((d) => d.code);
      expect(codes).toContain('jib-clash');
    });

    it('checks the way a small load swept between samples', () => {
      // A 100 mm load moved out from 10 m to 20 m at 28 m; a thin plate 10.2–10.3 m out.
      const doc = small(
        [task('a', 'construct', ['e'], 'up')],
        [tower()],
        [lift('l', 'a', 'e', [10000, 0, 27900])],
      );
      const codes = run(doc, {
        e: box([19950, -50, 27900], [20050, 50, 28000]),
        plate: box([10200, -500, 27000], [10300, 500, 28500]),
      }).map((d) => d.code);
      expect(codes).toContain('load-clash');
    });

    it('finds a box wholly inside a closed body', () => {
      // A closed cube 0–10 of 12 triangles.
      const c = (i: number) => [i & 1 ? 10 : 0, i & 2 ? 10 : 0, i & 4 ? 10 : 0];
      const faces = [
        [0, 1, 3, 2],
        [4, 6, 7, 5],
        [0, 4, 5, 1],
        [2, 3, 7, 6],
        [0, 2, 6, 4],
        [1, 5, 7, 3],
      ];
      const triangles = new Float64Array(
        faces.flatMap((f) => [f[0]!, f[1]!, f[2]!, f[0]!, f[2]!, f[3]!].flatMap(c)),
      );
      const cube = {
        bounds: [
          [0, 0, 0],
          [10, 10, 10],
        ] as Box,
        triangles,
      };
      expect(
        bodyMeetsBox(cube, [
          [2, 2, 2],
          [3, 3, 3],
        ]),
      ).toBe(true);
      expect(
        bodyMeetsBox(cube, [
          [12, 2, 2],
          [13, 3, 3],
        ]),
      ).toBe(false);
      expect(
        bodyMeetsBox(cube, [
          [-1, 2, 2],
          [1, 3, 3],
        ]),
      ).toBe(true);
    });

    it('measures a mobile crane slewing circle level', () => {
      const mobile = (id: string, x: number): Crane => ({
        ...tower(),
        id,
        name: id,
        kind: 'mobile',
        base: [x, 0],
        height: 3000,
        jibLength: 100000,
        loadChart: [{ radius: 10000, capacityKg: 10000 }],
      });
      const doc = small([], [mobile('m1', 0), mobile('m2', 50000)], []);
      expect(run(doc, {})).toEqual([]);
    });
  });
});
