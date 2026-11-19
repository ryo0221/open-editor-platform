import { describe, expect, it } from 'vitest';
import { bimElementMass, deriveBim, type BimDocument } from '@editor-platform/bim-core';
import { addDays } from '@editor-platform/time-axis';
import {
  checkCranes,
  craneClimbOnDay,
  craneOnDay,
  f87Building,
  f160ClimbingCrane,
  scheduleConstruction,
  siteTaskRefs,
  siteTerrain,
  validateConstruction,
  type ConstructionDocument,
  type CraneWorld,
  type LiftBody,
} from './index';

/** Box bodies of the F87 columns, beams and slabs (as crane.test.ts, no kernel). */
function world(bim: BimDocument, doc: ConstructionDocument): CraneWorld {
  const derived = deriveBim(bim);
  const terrain = siteTerrain(doc.site);
  const bodies = new Map<string, LiftBody>();
  for (const [id, s] of derived.shapes) {
    if (s.kind === 'column' && s.profile.shape === 'rect') {
      const [w, d] = [s.profile.widthMm / 2, s.profile.depthMm / 2];
      bodies.set(id, {
        bounds: [
          [s.at[0] - w, s.at[1] - d, s.zBase],
          [s.at[0] + w, s.at[1] + d, s.zTop],
        ],
      });
    } else if (s.kind === 'beam' && s.profile.shape === 'rect') {
      const half = s.profile.widthMm / 2;
      const x = s.start[0] === s.end[0];
      bodies.set(id, {
        bounds: [
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
        ],
      });
    } else if (s.kind === 'slab') {
      const xs = s.boundary.map((p) => p[0]);
      const ys = s.boundary.map((p) => p[1]);
      bodies.set(id, {
        bounds: [
          [Math.min(...xs), Math.min(...ys), s.zBottom],
          [Math.max(...xs), Math.max(...ys), s.zTop],
        ],
      });
    }
  }
  return {
    bodies,
    mass: (id) => {
      const m = bimElementMass(bim, derived, id);
      return m.status === 'ok' ? { kg: m.kg } : { reason: m.status };
    },
    ground: (p) => terrain.heightAt(p),
  };
}
const check = (bim: BimDocument, doc: ConstructionDocument) =>
  checkCranes(doc, scheduleConstruction(doc), world(bim, doc));

describe('TT1 climbing cranes (ST-800, TS-2600)', () => {
  it('stands where its last started climb puts it (ST-800#1)', () => {
    const doc = f160ClimbingCrane();
    const plan = scheduleConstruction(doc);
    const crane = doc.site!.cranes![0]!;
    const day = (id: string) => plan.byId.get(id)!.start;
    const at = (d: string) => {
      const c = craneOnDay(doc, plan, crane, d);
      return [c.baseZ ?? null, c.height, c.supportIds ?? null];
    };
    expect(at(day('col-1'))).toEqual([null, 14000, null]);
    // The 3F climb is listed second but starts first.
    expect(craneClimbOnDay(doc, plan, crane, day('col-3'))).toBe(1);
    expect(at(day('col-3'))).toEqual([8000, 22000, ['s-3']]);
    expect(at(day('col-5'))).toEqual([0, 30000, null]);
    expect(craneOnDay(doc, plan, crane, day('col-5'))).not.toHaveProperty('climbs');
  });

  it('checks each lift with the crane as it stands that day (ST-800#2)', () => {
    const bim = f87Building();
    const doc = f160ClimbingCrane(bim);
    expect(check(bim, doc)).toEqual([]);
    // Without its climbs the 14 m jib cannot clear the upper floors: only lifts from the 3F
    // columns on fail, those before stay clean.
    const fixed = structuredClone(doc);
    delete fixed.site!.cranes![0]!.climbs;
    const found = check(bim, fixed);
    expect(new Set(found.map((d) => d.code))).toContain('hook-height');
    const lifts = fixed.site!.lifts!;
    const early = new Set(['col-1', 'beam-1', 'col-2']);
    for (const d of found) {
      const i = Number(/lifts\[(\d+)\]/.exec(d.path)![1]);
      expect(early.has(lifts[i]!.taskId)).toBe(false);
    }
  }, 60_000);

  it('needs what a climb stands on to be built while it stands (ST-800#3)', () => {
    const bim = f87Building();
    const doc = f160ClimbingCrane(bim);
    const plan = scheduleConstruction(doc);
    // Climbing onto the 3F slab when the 2F beams start: the slab is cast later.
    doc.site!.cranes![0]!.climbs![1]!.taskId = 'beam-2';
    const early = check(bim, doc).filter((d) => d.code === 'crane-unsupported');
    expect(early).toEqual([
      {
        code: 'crane-unsupported',
        path: '$.site.cranes[0].climbs[1].supportIds',
        message: `Tower crane 1 stands on s-3 on ${plan.byId.get('beam-2')!.start}, not built then`,
      },
    ]);
    // A support that is no element of the building.
    doc.site!.cranes![0]!.climbs![1]!.taskId = 'col-3';
    doc.site!.cranes![0]!.climbs![1]!.supportIds = ['s-3', 'no-such'];
    expect(check(bim, doc).map((d) => d.code)).toEqual(['element-missing']);
  }, 60_000);

  it('checks a climb only while it holds the crane (ST-800#3)', () => {
    const bim = f87Building();
    const unsupported = (doc: ConstructionDocument) =>
      check(bim, doc).filter((d) => d.code === 'crane-unsupported');
    // Two climbs on one day: the later entry holds the crane, the earlier one never does.
    const same = f160ClimbingCrane(bim);
    const [ground, slab] = same.site!.cranes![0]!.climbs!;
    ground!.supportIds = ['r-roof'];
    slab!.taskId = 'col-5';
    expect(unsupported(same)).toEqual([]);
    // Taken down before the next climb: its support may go once the crane is gone.
    const down = f160ClimbingCrane(bim);
    down.site!.cranes![0]!.untilTaskId = 'beam-3';
    down.tasks.push({
      id: 'strip-s3',
      name: 'Strip 3F slab',
      durationDays: 1,
      predecessors: [{ taskId: 'beam-3', lagDays: 0 }],
      action: 'remove',
      elementIds: ['s-3'],
    });
    const plan = scheduleConstruction(down);
    expect(plan.byId.get('strip-s3')!.finish < plan.byId.get('col-5')!.start).toBe(true);
    expect(unsupported(down)).toEqual([]);
    // A climb dated before the crane is put up holds it from its erection on, when the slab is cast.
    const before = f160ClimbingCrane(bim);
    before.site!.cranes![0]!.fromTaskId = 'col-3';
    before.site!.cranes![0]!.climbs![1]!.taskId = 'beam-2';
    expect(unsupported(before)).toEqual([]);
    // With no task that takes it down, the crane stands as long as any actual date runs: a climb
    // late past the planned finish is still checked.
    const late = f160ClimbingCrane(bim);
    delete late.site!.cranes![0]!.untilTaskId;
    const finish = scheduleConstruction(late).projectFinish;
    const after = (n: number) => addDays(finish, n)!;
    late.tasks.push(
      {
        id: 'strip-s3',
        name: 'Strip 3F slab',
        durationDays: 1,
        predecessors: [],
        action: 'remove',
        elementIds: ['s-3'],
        actual: { start: after(5), finish: after(5) },
      },
      {
        id: 'late-climb',
        name: 'Late climb',
        durationDays: 1,
        predecessors: [],
        action: 'construct',
        elementIds: [],
        actual: { start: after(10), finish: after(10) },
      },
    );
    late.site!.cranes![0]!.climbs!.push({
      taskId: 'late-climb',
      baseZ: 8000,
      height: 22000,
      supportIds: ['s-3'],
    });
    expect(unsupported(late).map((d) => d.message)).toContain(
      `Tower crane 1 stands on s-3 on ${after(10)}, not built then`,
    );
    // A climb's task is one the site refers to (playback reaches its day).
    expect(siteTaskRefs(late.site).has('late-climb')).toBe(true);
  }, 60_000);

  it('gives the least jib height apart of two cranes that climb (ST-800#4)', () => {
    const bim = f87Building();
    const doc = f160ClimbingCrane(bim);
    const first = doc.site!.cranes![0]!;
    doc.site!.cranes!.push({
      ...structuredClone(first),
      id: 'tc-2',
      name: 'Tower crane 2',
      base: [21600, 40000],
      height: 20000,
      climbs: [{ taskId: 'col-4', baseZ: 0, height: 34000 }],
    });
    const overlap = check(bim, doc).filter((d) => d.code === 'slew-overlap');
    // 14 vs 20 m at first, 30 vs 20 m from the 3F climb, 30 vs 34 m from col-4, 30 vs 34 m on.
    expect(overlap).toEqual([
      {
        code: 'slew-overlap',
        path: '$.site.cranes[1]',
        message:
          'Tower crane 1 and Tower crane 2 slew over the same ground (jibs 4.0 m apart in height)',
      },
    ]);
  }, 60_000);

  it('rejects malformed climbs (ST-800#5)', () => {
    const doc = f160ClimbingCrane();
    const crane = doc.site!.cranes![0]!;
    const codes = (patch: (c: typeof crane) => void) => {
      const d = structuredClone(doc);
      patch(d.site!.cranes![0]!);
      return validateConstruction(d).map((x) => `${x.code} ${x.path}`);
    };
    expect(validateConstruction(doc)).toEqual([]);
    expect(codes((c) => (c.climbs![0]!.taskId = 'nope'))).toEqual([
      'task-missing $.site.cranes[0].climbs[0].taskId',
    ]);
    expect(codes((c) => (c.climbs![0]!.height = 0))).toEqual([
      'length $.site.cranes[0].climbs[0].height',
    ]);
    expect(codes((c) => (c.climbs![0]!.baseZ = 2e8))).toEqual([
      'coordinate $.site.cranes[0].climbs[0].baseZ',
    ]);
    expect(codes((c) => (c.climbs![1]!.supportIds = []))).toEqual([
      'climb $.site.cranes[0].climbs[1].supportIds',
    ]);
    expect(codes((c) => (c.climbs![1]!.supportIds = ['s-3', 's-3']))).toEqual([
      'climb $.site.cranes[0].climbs[1].supportIds',
    ]);
    expect(codes((c) => ((c.climbs![0] as unknown as Record<string, unknown>).extra = 1))).toEqual([
      'unknown-key $.site.cranes[0].climbs[0].extra',
    ]);
    expect(
      codes((c) => (c.climbs = Array.from({ length: 51 }, () => ({ ...c.climbs![0]! })))),
    ).toEqual(['limit-exceeded $.site.cranes[0].climbs']);
  });
});
