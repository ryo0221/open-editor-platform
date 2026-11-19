import { describe, expect, it } from 'vitest';
import { deriveBim } from '@editor-platform/bim-core';
import { writeIfc } from '@editor-platform/bim-ifc';
import { addDays } from '@editor-platform/time-axis';
import {
  checkRaises,
  f87Building,
  f88Building,
  f88OfficeFrame,
  f161RaisedRoof,
  frameOnDay,
  liftScene,
  liftTimes,
  readConstructionCsv,
  readConstructionIfc,
  scheduleConstruction,
  shiftBody,
  siteOnDay,
  validateConstruction,
  writeConstructionCsv,
  writeConstructionIfc,
  type CraneWorld,
  type LiftBody,
} from './index';

describe('TT2 raising what was built (ST-801, TS-2602)', () => {
  it('stands lower until raised, rising evenly while each raise runs (ST-801#1)', () => {
    const doc = f161RaisedRoof();
    expect(validateConstruction(doc)).toEqual([]);
    const plan = scheduleConstruction(doc);
    const up1 = plan.byId.get('roof-up-1')!;
    const up2 = plan.byId.get('roof-up-2')!;
    const on = (d: string) => siteOnDay(doc, plan, d);
    const roof = plan.byId.get('roof')!;
    // Built 4 m low; a raise is not a build: the roof stays "built" throughout.
    expect(on(roof.finish).offsets.get('r-roof')).toBe(-4000);
    expect(on(addDays(roof.finish, 1)!).states.get('r-roof')).toBe('built');
    expect(on(addDays(up1.start, -1)!).offsets.get('r-roof')).toBe(-4000);
    // Running: what is left of the first raise, by calendar day, plus all of the second.
    const days = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 864e5 + 1;
    const n = days(up1.start, up1.finish);
    const first = on(up1.start);
    expect(first.offsets.get('r-roof')).toBeCloseTo(-(3000 * (1 - 1 / n) + 1000), 6);
    expect(first.raising.has('r-roof')).toBe(true);
    expect(first.running).toContain('roof-up-1');
    expect(first.states.get('r-roof')).toBe('built');
    expect(on(up1.finish).offsets.get('r-roof')).toBe(-1000);
    // After the last raise it stands where the BIM puts it.
    expect(on(up2.finish).offsets.has('r-roof')).toBe(false);
    expect(on(up2.finish).raising.has('r-roof')).toBe(true);
    expect(on(addDays(up2.finish, 1)!).offsets.size).toBe(0);
    expect(on(addDays(up2.finish, 1)!).raising.size).toBe(0);
  });

  it('rejects raises without a distance or of what nothing builds (ST-801#2)', () => {
    const doc = f161RaisedRoof();
    const i = doc.tasks.findIndex((t) => t.id === 'roof-up-1');
    const codes = (patch: (d: typeof doc) => void) => {
      const d = structuredClone(doc);
      patch(d);
      return validateConstruction(d).map((x) => `${x.code} ${x.path}`);
    };
    expect(codes((d) => delete d.tasks[i]!.raiseMm)).toEqual([`raise $.tasks[${i}].raiseMm`]);
    expect(codes((d) => (d.tasks[i]!.raiseMm = 0))).toEqual([`raise $.tasks[${i}].raiseMm`]);
    expect(codes((d) => (d.tasks[i]!.raiseMm = 2e6))).toEqual([`raise $.tasks[${i}].raiseMm`]);
    expect(codes((d) => (d.tasks[0]!.raiseMm = 10))).toEqual(['raise $.tasks[0].raiseMm']);
    // A raise of an element no task builds.
    expect(codes((d) => d.tasks[i]!.elementIds.push('c-1-1-1-x'))).toEqual([
      `raise-unbuilt $.tasks[${i}].elementIds[1]`,
    ]);
  });

  it('finds a raise that starts before its load is built, or while it is removed (ST-801#3)', () => {
    const doc = f161RaisedRoof();
    expect(checkRaises(doc, scheduleConstruction(doc))).toEqual([]);
    // Started with the roof, not after it.
    const early = structuredClone(doc);
    early.tasks.find((t) => t.id === 'roof-up-1')!.predecessors = [
      { taskId: 'beam-5', lagDays: 0 },
    ];
    const plan = scheduleConstruction(early);
    expect(checkRaises(early, plan).slice(0, 1)).toEqual([
      {
        code: 'raise-before-built',
        path: `$.tasks[${early.tasks.findIndex((t) => t.id === 'roof-up-1')}]`,
        message: `Jack the roof up 3 m starts on ${plan.byId.get('roof-up-1')!.start} before r-roof is built`,
      },
    ]);
    // Taken away while the second raise runs.
    const gone = structuredClone(doc);
    gone.tasks.push({
      id: 'strip',
      name: 'Strip',
      durationDays: 3,
      predecessors: [{ taskId: 'roof-up-1', lagDays: 0 }],
      action: 'remove',
      elementIds: ['r-roof'],
    });
    expect(checkRaises(gone, scheduleConstruction(gone)).map((d) => d.code)).toEqual([
      'raise-removed',
    ]);
    // Built by a milestone on the raise's own first day: built then, as on the site.
    const milestone = structuredClone(doc);
    milestone.tasks.find((t) => t.id === 'roof')!.durationDays = 0;
    const mp = scheduleConstruction(milestone);
    expect(mp.byId.get('roof-up-1')!.start).toBe(mp.byId.get('roof')!.start);
    expect(checkRaises(milestone, mp)).toEqual([]);
  });

  it('keeps the distance through CSV and IFC (ST-801#4)', () => {
    const doc = f161RaisedRoof();
    const csv = writeConstructionCsv(doc.tasks);
    expect(csv.split('\r\n')[0]!.endsWith(',raise_mm')).toBe(true);
    const back = readConstructionCsv(csv);
    expect(back.diagnostics).toEqual([]);
    expect(back.tasks).toEqual(doc.tasks);
    expect(
      readConstructionCsv('id,name,duration,action,raise_mm\na,A,1,raise,high').diagnostics.map(
        (d) => d.code,
      ),
    ).toEqual(['raise']);
    const bim = f88Building();
    const building = writeIfc(bim, { artifactId: 'bim-1', timeStamp: '2027-03-01T09:00:00' });
    const plan = scheduleConstruction(doc);
    const text = writeConstructionIfc(doc, plan, building, { artifactId: 'cs-1' }).text;
    expect(text).toMatch(
      /IFCTASK\('[^']+',\$,'Jack the roof up 3 m','Raised 3000 mm',\$,'roof-up-1',\$,\$,'RAISE',\.F\.,\$,#\d+,\.MOVE\.\)/,
    );
    const read = readConstructionIfc(text).tasks.find((t) => t.id === 'roof-up-2')!;
    expect([read.action, read.raiseMm]).toEqual(['raise', 1000]);
  });

  it('lifts onto the lowered place, and leaves what hangs on jacks out of the frame (ST-801#5)', () => {
    const bim = f87Building();
    const doc = f161RaisedRoof(bim);
    // The roof lifted by the crane while it is built, 4 m below its place.
    doc.site!.lifts!.push({
      id: 'lift-roof',
      craneId: 'tc-1',
      taskId: 'roof',
      elementId: 'r-roof',
      pick: [52000, 11000, 1000],
    });
    const plan = scheduleConstruction(doc);
    const box: LiftBody = {
      bounds: [
        [0, 0, 20000],
        [1000, 1000, 20400],
      ],
    };
    const world: CraneWorld = {
      bodies: new Map([['r-roof', box]]),
      mass: () => ({ kg: 1 }),
      ground: () => 0,
    };
    const time = liftTimes(doc, plan).get('lift-roof')!;
    const scene = liftScene(
      doc,
      plan,
      world,
      doc.site!.lifts!.at(-1)!,
      doc.site!.cranes![0]!,
      box,
      time,
    );
    expect(scene.motion.placeHook[2]).toBe(20400 - 4000);
    expect(scene.body.bounds[0][2]).toBe(16000);
    expect(
      shiftBody({ bounds: box.bounds, triangles: [0, 0, 1, 0, 0, 2, 0, 0, 3] }, -10).triangles,
    ).toEqual(Float64Array.from([0, 0, -9, 0, 0, -8, 0, 0, -7]));
    // The frame: roof beams raised 500 mm after they are set hang on the jacks until then.
    const fb = f88Building();
    const fdoc = f88OfficeFrame(fb);
    const beams = fdoc.tasks.find((t) => t.id === 'beam-5')!.elementIds;
    fdoc.tasks.push({
      id: 'jack',
      name: 'Jack',
      durationDays: 2,
      predecessors: [{ taskId: 'beam-5', lagDays: 0 }],
      action: 'raise',
      elementIds: beams,
      raiseMm: 500,
    });
    const fplan = scheduleConstruction(fdoc);
    const w = { bim: fb, derived: deriveBim(fb) };
    const ids = (d: string) =>
      new Set(frameOnDay(fdoc, fplan, w, d).members.map((m) => m.elementId));
    expect(ids(fplan.byId.get('jack')!.start).has(beams[0]!)).toBe(false);
    expect(ids(addDays(fplan.byId.get('jack')!.finish, 1)!).has(beams[0]!)).toBe(true);
    // A slab on jacks loads the frame neither: its weight comes once it is up.
    const slabs = fdoc.tasks.find((t) => t.id === 'slab-4')!.elementIds;
    fdoc.tasks.push({
      id: 'jack-slab',
      name: 'Jack the slab',
      durationDays: 2,
      predecessors: [{ taskId: 'slab-4', lagDays: 0 }],
      action: 'raise',
      elementIds: slabs,
      raiseMm: 300,
    });
    const splan = scheduleConstruction(fdoc);
    const loads = (d: string) =>
      new Set(frameOnDay(fdoc, splan, w, d).slabLoads.map((l) => l.elementId));
    expect(loads(splan.byId.get('jack-slab')!.start).has(slabs[0]!)).toBe(false);
    expect(loads(addDays(splan.byId.get('jack-slab')!.finish, 1)!).has(slabs[0]!)).toBe(true);
  });
});
