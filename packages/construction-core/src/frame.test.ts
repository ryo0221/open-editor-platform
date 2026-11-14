import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  bimElementMass,
  bimStarter,
  deriveBim,
  f39Roofs,
  f47Taper,
  type BimDocument,
  type BimElement,
} from '@editor-platform/bim-core';
import {
  checkFrameModel,
  readCalculixFrame,
  writeCalculixFrame,
} from '@editor-platform/geometry-fem';
import {
  applyConstructionOperation,
  buildFrame,
  compareFrames,
  craneReactions,
  f88Building,
  f88OfficeFrame,
  frameCompleted,
  frameMemberResults,
  frameOnDay,
  frameSection,
  scheduleConstruction,
  siteTaskRefs,
  siteTerrain,
  validateConstruction,
  type ConstructionDocument,
  type ConstructionFrame,
  type CraneWorld,
  type FrameWorld,
} from './index';

const ccx = spawnSync('ccx', ['-v'], { encoding: 'utf8' });
const hasCcx = /Version \d/.test(`${ccx.stdout ?? ''}${ccx.stderr ?? ''}`);
function solve(frame: ConstructionFrame) {
  const dir = mkdtempSync(join(tmpdir(), 'ccx-'));
  try {
    writeFileSync(join(dir, 'job.inp'), writeCalculixFrame(frame.model!));
    const r = spawnSync('ccx', ['-i', 'job'], { cwd: dir, encoding: 'utf8', timeout: 120_000 });
    if (r.status !== 0) throw new Error(`ccx failed: ${r.stdout}${r.stderr}`);
    return frameMemberResults(
      frame,
      readCalculixFrame(frame.model!, readFileSync(join(dir, 'job.frd'), 'utf8')),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const world = (bim: BimDocument): FrameWorld => ({ bim, derived: deriveBim(bim) });
const sumForce = (f: ConstructionFrame) => f.model!.force.reduce((t, x) => t - x[3], 0);

describe('CS4 the frame of a construction stage (ST-547, TS-2082)', () => {
  it('gives each BIM profile its section properties (ST-547#1)', () => {
    // H-400×200×8×13: A, strong and weak axes, as the steel tables give them.
    const h = frameSection({ shape: 'h', depthMm: 400, widthMm: 200, webMm: 8, flangeMm: 13 });
    expect(h.approximate).toBe(false);
    expect(h.section.area).toBeCloseTo(2 * 200 * 13 + 374 * 8, 6);
    expect(h.section.i11).toBeCloseTo((200 * 400 ** 3 - 192 * 374 ** 3) / 12, 3);
    expect(h.section.i22).toBeCloseTo((2 * 13 * 200 ** 3 + 374 * 8 ** 3) / 12, 3);
    expect(h.section.c1).toBe(200);
    const box = frameSection({ shape: 'box', depthMm: 300, widthMm: 300, wallMm: 12 });
    expect(box.section.i11).toBeCloseTo((300 ** 4 - 276 ** 4) / 12, 3);
    // An angle's centroid sits off its corner; it is marked approximate.
    const l = frameSection({ shape: 'l', depthMm: 100, widthMm: 100, thicknessMm: 10 });
    expect(l.approximate).toBe(true);
    expect(l.section.area).toBe(1900);
    expect(l.section.c1).toBeCloseTo(100 - (1000 * 5 + 900 * 55) / 1900, 6);
    const rect = frameSection({ shape: 'rect', depthMm: 800, widthMm: 400 });
    expect(rect.section.i11).toBeCloseTo((400 * 800 ** 3) / 12, 3);
  });

  it('builds the frame standing on a day with its loads (ST-547#2, #3)', () => {
    const bim = f88Building();
    const doc = f88OfficeFrame(bim);
    expect(validateConstruction(doc)).toEqual([]);
    const plan = scheduleConstruction(doc);
    const w = world(bim);
    const slab4 = plan.byId.get('slab-4')!;
    const day = frameOnDay(doc, plan, w, slab4.start);
    const done = frameCompleted(doc, plan, w);
    expect(day.notes).toEqual([]);
    expect(done.notes).toEqual([]);
    expect(checkFrameModel(JSON.parse(JSON.stringify(day.model)))).toEqual(day.model);
    // On that day the columns and beams up to 4F stand; 5F's are not set yet.
    const ids = new Set(day.members.map((m) => m.elementId));
    expect(ids.has('c-1-4-1-4')).toBe(false);
    expect([...ids].some((id) => id.startsWith('b-4-'))).toBe(true);
    expect([...ids].some((id) => id.startsWith('b-5-'))).toBe(false);
    expect(done.members.length).toBe(465);
    // Supports: the 35 ground columns' feet.
    expect(day.model!.fixed.length).toBe(35);
    // The site load: 6 kN/m² over the 3F slab, on the day only.
    const loadOn3 = day.slabLoads.find((s) => s.elementId === doc.site!.loads![0]!.elementIds[0])!;
    const shape = w.derived.shapes.get(loadOn3.elementId)!;
    expect(shape.kind).toBe('slab');
    expect(loadOn3.siteN).toBeGreaterThan(0);
    expect(done.slabLoads.every((s) => s.siteN === 0)).toBe(true);
    // The slab's own weight is its mass, all of it put on the frame.
    const m = bimElementMass(bim, w.derived, loadOn3.elementId);
    expect(m.status === 'ok' && loadOn3.selfN).toBeCloseTo(m.status === 'ok' ? m.kg * 9.81 : 0, 3);
    // Every load lands on a node: the nodal forces add up to the total.
    expect(sumForce(day)).toBeCloseTo(day.totalLoadN, 3);
    expect(sumForce(done)).toBeCloseTo(done.totalLoadN, 3);
  });

  it('leaves out what reaches no support or has no stiffness, and says so (ST-547#3)', () => {
    const bim = f88Building();
    const doc = f88OfficeFrame(bim);
    const plan = scheduleConstruction(doc);
    // A 2F beam set while its columns are left out of the building's stiffness.
    const plain = structuredClone(bim);
    for (const m of plain.materials) delete m.youngsModulusMPa;
    const none = frameCompleted(doc, plan, world(plain));
    expect(none.model).toBeUndefined();
    expect(none.notes.map((n) => n.code)).toEqual(
      expect.arrayContaining(['frame-material', 'frame-empty']),
    );
    // Beams set before their columns: the 1F columns' task moved after the 2F beams'.
    const early = structuredClone(doc);
    early.tasks.find((t) => t.id === 'beam-1')!.predecessors = [{ taskId: 'ground', lagDays: 0 }];
    early.tasks.find((t) => t.id === 'col-1')!.predecessors = [{ taskId: 'beam-1', lagDays: 0 }];
    const p2 = scheduleConstruction(early);
    const f = frameOnDay(early, p2, world(bim), p2.byId.get('beam-1')!.finish);
    expect(f.model).toBeUndefined();
    expect(f.notes.find((n) => n.code === 'frame-unsupported')?.message).toMatch(
      /^58 members reach no support and are left out: b-2-/,
    );
  });

  it('keeps site loads valid and in their place (ST-547#3)', () => {
    const doc = f88OfficeFrame();
    const codes = (d: ConstructionDocument) => validateConstruction(d).map((x) => [x.code, x.path]);
    const bad = structuredClone(doc);
    bad.site!.loads![0]!.kNm2 = 0;
    bad.site!.loads!.push({ ...doc.site!.loads![0]!, id: 'tc-1', taskId: 'nope', elementIds: [] });
    expect(codes(bad)).toEqual([
      ['site-load', '$.site.loads[0].kNm2'],
      ['duplicate-id', '$.site.loads[1].id'],
      ['task-missing', '$.site.loads[1].taskId'],
      ['site-load', '$.site.loads[1].elementIds'],
    ]);
    expect(siteTaskRefs(doc.site).has('slab-4')).toBe(true);
    let d = applyConstructionOperation(doc, {
      type: 'putSiteLoad',
      load: { ...doc.site!.loads![0]!, kNm2: 3 },
    });
    expect(d.site!.loads![0]!.kNm2).toBe(3);
    d = applyConstructionOperation(d, { type: 'removeSiteLoad', id: 'load-shoring-4' });
    expect(d.site).not.toHaveProperty('loads');
    expect(() =>
      applyConstructionOperation(d, { type: 'removeSiteLoad', id: 'load-shoring-4' }),
    ).toThrow('no site load load-shoring-4');
    // A crane's own mass is above 0.
    const heavy = structuredClone(doc);
    heavy.site!.cranes![0]!.massKg = -1;
    expect(codes(heavy)).toEqual([['mass', '$.site.cranes[0].massKg']]);
  });

  it('gives the crane foundation its reaction from the lifts (ST-547#4)', () => {
    const bim = f88Building();
    const doc = f88OfficeFrame(bim);
    const plan = scheduleConstruction(doc);
    const derived = deriveBim(bim);
    const bodies = new Map(
      [...derived.shapes].flatMap(([id, s]) => {
        if (s.kind !== 'column') return [];
        const box: [[number, number, number], [number, number, number]] = [
          [s.at[0] - 300, s.at[1] - 300, s.zBase],
          [s.at[0] + 300, s.at[1] + 300, s.zTop],
        ];
        return [[id, { bounds: box }]];
      }),
    );
    const terrain = siteTerrain(doc.site);
    const cw: CraneWorld = {
      bodies,
      mass: (id) => {
        const m = bimElementMass(bim, derived, id);
        return m.status === 'ok' ? { kg: m.kg } : { reason: m.status };
      },
      ground: (p) => terrain.heightAt(p),
    };
    const [r] = craneReactions(doc, plan, cw);
    // The heaviest load on the crane's own 60 t; a 3,456 kg column at 30.6 m (the yard) or more.
    expect(r!.ownMassKnown).toBe(true);
    const heaviest = Math.max(
      ...doc.site!.lifts!.map((l) =>
        'kg' in cw.mass(l.elementId) ? (cw.mass(l.elementId) as { kg: number }).kg : 0,
      ),
    );
    expect(r!.verticalKN).toBeCloseTo(((60000 + heaviest) * 9.81) / 1000, 6);
    expect(r!.momentKNm).toBeGreaterThan((3456 * 9.81 * 30.6) / 1000);
    expect(r!.liftId).toMatch(/^lift-/);
    // Beams have no body here (their radius is the pick's); every mass is known.
    expect(r!.unknown).toBe(0);
    // On a day with no lift the reaction is the crane's own weight; before it is put up, none.
    expect(craneReactions(doc, plan, cw, plan.byId.get('site')!.start)).toEqual([]);
    const up = plan.byId.get(doc.site!.cranes![0]!.fromTaskId)!.start;
    const quiet = craneReactions(doc, plan, cw, up)[0]!;
    expect(quiet.verticalKN).toBeCloseTo((60000 * 9.81) / 1000, 6);
    expect(quiet.momentKNm).toBe(0);
  });

  it.skipIf(!hasCcx)(
    'finds the 3F beams worked harder under the 4F casting than when complete (ST-547#2)',
    () => {
      const bim = f88Building();
      const doc = f88OfficeFrame(bim);
      const plan = scheduleConstruction(doc);
      const w = world(bim);
      const day = solve(frameOnDay(doc, plan, w, plan.byId.get('slab-4')!.start));
      const done = solve(frameCompleted(doc, plan, w));
      const worst = compareFrames(day, done)[0]!;
      expect(worst.elementId).toMatch(/^b-3-/);
      expect(worst.ratio).toBeGreaterThan(1.5);
      // The completed frame: the ground columns carry the most.
      const top = [...done].sort((a, b) => b.stressMPa - a.stressMPa)[0]!;
      expect(top.elementId).toMatch(/^c-1-/);
      expect(Math.max(...done.map((r) => r.displacementMm))).toBeLessThan(10);
    },
    60_000,
  );
});

describe('CS4 review fixes on small frames (ST-547)', () => {
  /** Concrete and steel with their stiffness and density. */
  const stiff = (doc: BimDocument) => {
    for (const m of doc.materials)
      Object.assign(
        m,
        m.category === 'metal'
          ? { youngsModulusMPa: 205000, densityKgM3: 7850 }
          : { youngsModulusMPa: 24000, densityKgM3: 2400 },
      );
    return doc;
  };
  const starter = (elements: BimElement[]) => {
    const doc = stiff(bimStarter());
    doc.types.push({
      id: 't-member-box',
      kind: 'member',
      name: 'Steel box 300',
      profile: { shape: 'box', depthMm: 300, widthMm: 300, wallMm: 12 },
      materialId: 'm-steel',
    });
    doc.elements = elements;
    return doc;
  };
  const level = (l: string) => ({ level: l, offsetMm: 0 });
  const column = (id: string, xy: [number, number], base = 'l-1f', top = 'l-2f'): BimElement => ({
    id,
    kind: 'column',
    typeId: 't-column-600',
    at: { xy },
    rotationRad: 0,
    base: level(base),
    top: level(top),
  });
  /** The group of model element `e`. */
  const groupOf = (f: ConstructionFrame, e: number) => {
    let off = 0;
    for (const g of f.model!.groups) {
      if (e < off + g.elements.length / 2) return g;
      off += g.elements.length / 2;
    }
    throw new Error(`no element ${e}`);
  };

  it('keeps the BIM orientation of a leaning column and steps a tapered one', () => {
    const bim = stiff(f47Taper());
    const f = buildFrame(world(bim), () => true, []);
    expect(f.notes).toEqual([]);
    const member = (id: string) => f.members.find((m) => m.elementId === id)!;
    // Leaning in x–z, turned 0: its depth runs along y, as the BIM solid's.
    const lean = groupOf(f, member('c-lean').elements[0]!);
    expect(lean.depthDirection.map((x) => Math.abs(x))).toEqual([0, 1, 0]);
    // Each element carries its middle's section; the own weight is the tapered volume's.
    const round = member('c-round');
    expect(round.approximate).toBe(true);
    const areas = round.elements.map((e) => groupOf(f, e).section.area);
    expect(areas[0]! / areas[3]!).toBeCloseTo(((1 - 0.75 / 8) / (1 - (0.75 * 7) / 8)) ** 2, 9);
    const weight = round.elements.reduce((t, e) => {
      const g = groupOf(f, e);
      return t + g.section.area * 1500 * 2400e-12 * 9810;
    }, 0);
    const d = deriveBim(bim);
    const m = bimElementMass(bim, d, 'c-round');
    expect(m.status).toBe('ok');
    // The midpoint steps miss (1 − k)²/192 of the cone's (1 + k + k²)/3: 0.7 % at k = 0.25.
    const ratio = weight / (m.status === 'ok' ? m.kg * 9.81 : 1);
    expect(ratio).toBeGreaterThan(0.99);
    expect(ratio).toBeLessThan(1);
  });

  it('never lets a short member fall together into zero-length elements', () => {
    const bim = starter([
      column('c', [0, 0]),
      {
        id: 'm-short',
        kind: 'member',
        typeId: 't-member-box',
        start: { at: { xy: [0, 0] }, height: level('l-2f') },
        end: { at: { xy: [30, 0] }, height: level('l-2f') },
        rotationRad: 0,
      },
    ]);
    const f = buildFrame(world(bim), () => true, []);
    expect(f.notes).toEqual([]);
    expect(checkFrameModel(f.model)).toEqual(f.model);
    expect(f.members.find((m) => m.elementId === 'm-short')!.elements.length).toBe(1);
  });

  it('spreads a narrow slab over its beam, and says when a weight is not known', () => {
    const bim = starter([
      column('c-a', [0, 0]),
      column('c-b', [10000, 0]),
      {
        id: 'b',
        kind: 'beam',
        typeId: 't-beam-400x700',
        start: { xy: [0, 0] },
        end: { xy: [10000, 0] },
        top: level('l-2f'),
      },
      {
        id: 's',
        kind: 'slab',
        typeId: 't-slab-200',
        top: level('l-2f'),
        boundary: [
          [0, -50],
          [10000, -50],
          [10000, 50],
          [0, 50],
        ],
        holes: [],
      },
    ]);
    const f = buildFrame(world(bim), (id) => id !== 's', [
      { elementId: 's', self: 0.005, site: 0 },
    ]);
    expect(f.notes).toEqual([]);
    const total = 0.005 * 10000 * 100;
    // On the beam's quarter points: the column tops get an eighth each.
    const tops = f.members
      .filter((m) => m.kind === 'column')
      .map((m) => m.nodes.find((q) => f.model!.nodes[3 * q + 2] === 3000)!);
    const atTop = (q: number) =>
      f.model!.force.filter((x) => x[0] === q).reduce((t, x) => t - x[3], 0);
    const own = (q: number) => {
      // The own weight lumped there, from the groups.
      let w = 0;
      for (const g of f.model!.groups)
        for (let e = 0; e < g.elements.length; e += 2) {
          const [a, b] = [g.elements[e]!, g.elements[e + 1]!];
          if (a !== q && b !== q) continue;
          const len = Math.hypot(
            ...[0, 1, 2].map((k) => f.model!.nodes[3 * b + k]! - f.model!.nodes[3 * a + k]!),
          );
          w += (g.section.area * len * 2400 * 9810e-12) / 2;
        }
      return w;
    };
    for (const q of tops) expect((atTop(q) - own(q)) / total).toBeCloseTo(1 / 8, 2);
    // Without densities the members' own weight is left out, and said.
    const light = structuredClone(bim);
    for (const m of light.materials) delete m.densityKgM3;
    const g = buildFrame(world(light), (id) => id !== 's', []);
    expect(g.totalLoadN).toBe(0);
    expect(g.notes.map((n) => [n.code, n.message])).toEqual([
      ['mass-unknown', '3 members have no density; their own weight is left out: c-a, c-b, b'],
    ]);
  });

  it('loads a slab at its level, its arcs kept', () => {
    // A 2 m column under a half-round slab (6 m across) whose rim passes over it.
    const bim = starter([
      {
        ...(column('c', [20000, 0]) as Extract<BimElement, { kind: 'column' }>),
        top: { level: 'l-1f', offsetMm: 2000 },
      },
      {
        id: 's-half',
        kind: 'slab',
        typeId: 't-slab-200',
        top: { level: 'l-1f', offsetMm: 2000 },
        boundary: [
          [26000, 0, 1],
          [20000, 0],
          [23000, 0],
        ],
        holes: [],
      },
    ]);
    const f = buildFrame(world(bim), (id) => id === 'c', [
      { elementId: 's-half', self: 0, site: 0.001 },
    ]);
    expect(f.notes).toEqual([]);
    // π·3,000²/2 mm² at 1 kN/m²: 14.14 kN, all on the column's top (not a node below it).
    expect(f.slabLoads[0]!.siteN).toBeCloseTo((Math.PI * 3000 ** 2) / 2 / 1000, 6);
    const top = f.model!.force.filter((x) => f.model!.nodes[3 * x[0] + 2] === 2000);
    const slab = f.slabLoads[0]!.siteN;
    const own = (f.totalLoadN - slab) / 8;
    expect(-top.reduce((t, x) => t + x[3], 0)).toBeCloseTo(slab + own, 6);
  });

  it('loads a sloped slab where its top runs, at each end', () => {
    // A 10 m ramp from 3 m to 5 m over a sloped beam between a 3 m and a 5 m column.
    const at = (mm: number) => ({ level: 'l-1f', offsetMm: mm });
    const col = (id: string, x: number, h: number) => ({
      ...(column(id, [x, 0]) as Extract<BimElement, { kind: 'column' }>),
      top: at(h),
    });
    const bim = starter([
      col('c-low', 0, 3000),
      col('c-high', 10000, 5000),
      {
        id: 'b',
        kind: 'beam',
        typeId: 't-beam-400x700',
        start: { xy: [0, 0] },
        end: { xy: [10000, 0] },
        top: at(3000),
        endTop: at(5000),
      },
      {
        id: 's',
        kind: 'slab',
        typeId: 't-slab-200',
        top: at(3000),
        boundary: [
          [0, 500],
          [0, -500],
          [10000, -500],
          [10000, 500],
        ],
        holes: [],
        slope: { edge: 0, endTop: at(5000) },
      },
    ]);
    const f = buildFrame(world(bim), (id) => id !== 's', [{ elementId: 's', self: 0, site: 0.01 }]);
    expect(f.notes).toEqual([]);
    // Every slab share lands on the beam's line at the slab's own height there.
    const slab = 0.01 * 10000 * 1000;
    const own = new Map<number, number>();
    for (const g of f.model!.groups)
      for (let e = 0; e < g.elements.length; e += 2) {
        const [a, b] = [g.elements[e]!, g.elements[e + 1]!];
        const len = Math.hypot(
          ...[0, 1, 2].map((k) => f.model!.nodes[3 * b + k]! - f.model!.nodes[3 * a + k]!),
        );
        for (const q of [a, b])
          own.set(q, (own.get(q) ?? 0) + (g.section.area * len * 2400 * 9810e-12) / 2);
      }
    let onLine = 0;
    for (const [q, , , fz] of f.model!.force) {
      const extra = -fz - (own.get(q) ?? 0);
      if (extra < 1e-6) continue;
      const [x, , z] = [0, 1, 2].map((k) => f.model!.nodes[3 * q + k]!);
      expect(z).toBeCloseTo(3000 + (2000 * x!) / 10000, 6);
      onLine += extra;
    }
    expect(onLine).toBeCloseTo(slab, 3);
  });

  it('stands a temporary beam while its task runs, not when complete', () => {
    const bim = starter([
      column('c-a', [0, 0]),
      column('c-b', [6000, 0]),
      {
        id: 'b-shore',
        kind: 'beam',
        typeId: 't-beam-400x700',
        start: { xy: [0, 0] },
        end: { xy: [6000, 0] },
        top: level('l-2f'),
      },
    ]);
    const doc: ConstructionDocument = {
      schemaVersion: 1,
      name: 'shoring',
      source: { artifactId: 'a', versionId: 'v', contentHash: 'a'.repeat(64) },
      startDate: '2026-11-02',
      calendar: { workWeekdays: [1, 2, 3, 4, 5], holidays: [] },
      tasks: [
        {
          id: 'shore',
          name: 'Shore',
          durationDays: 3,
          predecessors: [],
          action: 'temporary',
          elementIds: ['b-shore'],
        },
      ],
    };
    expect(validateConstruction(doc)).toEqual([]);
    const plan = scheduleConstruction(doc);
    const on = frameOnDay(doc, plan, world(bim), plan.byId.get('shore')!.start);
    expect(on.members.map((m) => m.elementId).sort()).toEqual(['b-shore', 'c-a', 'c-b']);
    const done = frameCompleted(doc, plan, world(bim));
    expect(done.members.map((m) => m.elementId).sort()).toEqual(['c-a', 'c-b']);
  });

  it('leaves out a column cut by a roof, and says so', () => {
    const bim = stiff(f39Roofs('gable'));
    const f = buildFrame(world(bim), () => true, []);
    expect(f.notes.find((n) => n.path === 'c-ridge')?.code).toBe('frame-clipped');
    expect(f.members.some((m) => m.elementId === 'c-ridge')).toBe(false);
  });

  it('finds the foundation from every column, stiff or not', () => {
    const bim = starter([column('c-low', [0, 0]), column('c-up', [0, 0], 'l-2f', 'l-rf')]);
    bim.materials.push({ id: 'm-soft', name: 'Unknown', category: 'concrete' });
    bim.types.push({
      id: 't-column-soft',
      kind: 'column',
      name: 'Column of unknown stiffness',
      profile: { shape: 'rect', widthMm: 600, depthMm: 600 },
      materialId: 'm-soft',
    });
    (bim.elements[0] as Extract<BimElement, { kind: 'column' }>).typeId = 't-column-soft';
    const f = buildFrame(world(bim), () => true, []);
    expect(f.model).toBeUndefined();
    expect(f.notes.map((n) => n.code)).toEqual([
      'frame-material',
      'frame-unsupported',
      'frame-empty',
    ]);
    expect(f.notes[1]!.message).toBe('1 member reaches no support and is left out: c-up');
  });
});
