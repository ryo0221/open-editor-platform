import { describe, expect, it } from 'vitest';
import { writeIfc } from '@editor-platform/bim-ifc';
import {
  f88Building,
  f89OfficeTraffic,
  readConstructionIfc,
  scheduleConstruction,
  siteTerrain,
  writeConstructionIfc,
} from './index';

const bim = f88Building();
const building = writeIfc(bim, { artifactId: 'bim-1', timeStamp: '2027-03-01T09:00:00' });

describe('CS6a the schedule in IFC4 (ST-551, TS-2088)', () => {
  it('writes the work schedule, tasks, links and assignments into the building file (ST-551#1)', () => {
    const doc = f89OfficeTraffic(bim);
    const plan = scheduleConstruction(doc);
    const out = writeConstructionIfc(doc, plan, building, { artifactId: 'cs-1' });
    const count = (type: string) =>
      out.text.split('\n').filter((l) => l.includes(`=${type}(`)).length;
    expect(count('IFCWORKSCHEDULE')).toBe(1);
    expect(count('IFCRELDECLARES')).toBe(1);
    expect(count('IFCTASK')).toBe(doc.tasks.length);
    expect(count('IFCTASKTIME')).toBe(doc.tasks.length);
    expect(count('IFCRELASSIGNSTOCONTROL')).toBe(1);
    const links = doc.tasks.reduce((n, t) => n + t.predecessors.length, 0);
    expect(count('IFCRELSEQUENCE')).toBe(links);
    expect(count('IFCLAGTIME')).toBe(links);
    const elements = new Set(doc.tasks.flatMap((t) => t.elementIds));
    // One for each element, and one for each temporary work (CS6b).
    expect(count('IFCRELASSIGNSTOPRODUCT')).toBe(elements.size + doc.site!.temporaries.length);
    expect(out.notes).toEqual([]);
    // The building's own entities are kept as they were, before the schedule's.
    expect(out.text.startsWith(building.text.slice(0, building.text.lastIndexOf('ENDSEC;')))).toBe(
      true,
    );
    expect(out.text.endsWith('ENDSEC;\nEND-ISO-10303-21;\n')).toBe(true);
    // The planned times of a task at the site's working hours, and its float.
    const col = plan.byId.get('col-1')!;
    const taskLine = out.text
      .split('\n')
      .find((l) => l.includes('=IFCTASK(') && l.includes("'col-1'"))!;
    const timeId = /,#(\d+),\.CONSTRUCTION\.\);$/.exec(taskLine)![1];
    const time = out.text.split('\n').find((l) => l.startsWith(`#${timeId}=IFCTASKTIME(`))!;
    expect(time).toContain(`'P6D','${col.start}T07:30:00','${col.finish}T17:30:00'`);
    expect(time).toContain(`'P${col.totalFloat}D',${col.critical ? '.T.' : '.F.'}`);
    // Stable: the same document gives the same file.
    expect(writeConstructionIfc(doc, plan, building, { artifactId: 'cs-1' }).text).toBe(out.text);
    expect(out.taskGlobalIds.get('col-1')).toMatch(/^[0-3][0-9A-Za-z_$]{21}$/);
  });

  it('reads its own file back: tasks, dates, links, actions and elements (ST-551#2)', () => {
    const doc = structuredClone(f89OfficeTraffic(bim));
    doc.tasks[1]!.predecessors[0]!.lagDays = 2;
    // A lead (negative lag) too: written "-P2D" and read back as −2.
    doc.tasks[2]!.predecessors[0]!.lagDays = -2;
    // An empty name stays empty (the ID is not written in its place).
    doc.tasks[3]!.name = '';
    doc.tasks[0]!.actual = { start: doc.startDate, percent: 40 };
    const plan = scheduleConstruction(doc);
    const back = readConstructionIfc(
      writeConstructionIfc(doc, plan, building, { artifactId: 'cs-1' }).text,
    );
    expect(back.name).toBe(doc.name);
    expect(back.tasks.map((t) => t.id)).toEqual(doc.tasks.map((t) => t.id));
    for (const t of doc.tasks) {
      const r = back.tasks.find((x) => x.id === t.id)!;
      expect(r.name).toBe(t.name);
      expect(r.durationDays).toBe(t.durationDays);
      expect(r.action).toBe(t.action);
      expect([r.start, r.finish]).toEqual([
        plan.byId.get(t.id)!.start,
        plan.byId.get(t.id)!.finish,
      ]);
      expect(r.predecessors).toEqual(t.predecessors);
      const elements = new Set(building.globalIds.values());
      expect(r.products.filter((g) => elements.has(g))).toEqual(
        t.elementIds.map((id) => building.globalIds.get(id)),
      );
    }
  });

  it('leaves out elements the building file does not carry, and says so (ST-551#1)', () => {
    const doc = structuredClone(f89OfficeTraffic(bim));
    doc.tasks[2]!.elementIds.push('no-such-element');
    const out = writeConstructionIfc(doc, scheduleConstruction(doc), building, {
      artifactId: 'cs-1',
    });
    expect(out.notes).toEqual([
      "1 element named by tasks is not in the building's file and is left out of the schedule: no-such-element",
    ]);
    expect(() =>
      writeConstructionIfc(
        doc,
        scheduleConstruction(doc),
        { text: 'x', globalIds: new Map() },
        {
          artifactId: 'cs-1',
        },
      ),
    ).toThrow('not an IFC file');
    // A plan past the kept years has no dates: nothing is written.
    const late = structuredClone(f89OfficeTraffic(bim));
    late.startDate = '2200-12-31';
    const latePlan = scheduleConstruction(late);
    expect(latePlan.diagnostics.map((d) => d.code)).toEqual(['schedule-too-long']);
    expect(() => writeConstructionIfc(late, latePlan, building, { artifactId: 'cs-1' })).toThrow(
      latePlan.diagnostics[0]!.message,
    );
  });

  it('keeps a recorded 0 % as 0, and none as unset (ST-551#1)', () => {
    const doc = structuredClone(f89OfficeTraffic(bim));
    doc.tasks[0]!.actual = { start: doc.startDate, percent: 0 };
    const out = writeConstructionIfc(doc, scheduleConstruction(doc), building, {
      artifactId: 'cs-1',
    });
    const times = out.text.split('\n').filter((l) => l.includes('=IFCTASKTIME('));
    expect(times[0]).toMatch(/,0\.\)?;$|,0\.0*\);$/);
    expect(times[1]).toMatch(/,\$\);$/);
  });

  it('writes temporary works as proxies on the site, assigned to their tasks (ST-552#1)', () => {
    const doc = f89OfficeTraffic(bim);
    const out = writeConstructionIfc(doc, scheduleConstruction(doc), building, {
      artifactId: 'cs-1',
    });
    const lines = out.text.split('\n');
    const temporaries = doc.site!.temporaries;
    const proxies = lines.filter((l) => l.includes('=IFCBUILDINGELEMENTPROXY('));
    expect(proxies).toHaveLength(temporaries.length);
    const gate = temporaries.find((t) => t.kind === 'gate')!;
    const line = proxies.find((l) => l.includes(`'${out.temporaryGlobalIds.get(gate.id)}'`))!;
    expect(line).toContain(`'${gate.name}',$,'gate',`);
    expect(line).toContain(`,'${gate.id}',.USERDEFINED.);`);
    // Contained in the site, and an output of the task that puts it up.
    const id = /^#(\d+)=/.exec(line)![1];
    expect(
      lines.some((l) => l.includes('=IFCRELCONTAINEDINSPATIALSTRUCTURE(') && l.includes(`#${id}`)),
    ).toBe(true);
    const assign = lines.find(
      (l) => l.includes('=IFCRELASSIGNSTOPRODUCT(') && l.endsWith(`,$,#${id});`),
    )!;
    expect(assign).toBeDefined();
    // Put up and taken down in the same task: that task once in the assignment's SET.
    const brief = structuredClone(doc);
    const hut = brief.site!.temporaries.find((t) => t.id === gate.id)!;
    hut.untilTaskId = hut.fromTaskId;
    const again = writeConstructionIfc(brief, scheduleConstruction(brief), building, {
      artifactId: 'cs-1',
    }).text.split('\n');
    const one = again.find(
      (l) => l.includes('=IFCRELASSIGNSTOPRODUCT(') && l.endsWith(`,$,#${id});`),
    )!;
    expect(one).toMatch(/,\(#\d+\),/);
    // Its footprint extruded by its height.
    expect(
      lines.some((l) => l.includes('=IFCEXTRUDEDAREASOLID(') && l.endsWith(`,${gate.height}.);`)),
    ).toBe(true);

    // Without a base, it stands on the lowest ground under its outline (as the site view draws
    // it), whichever point the outline starts at.
    const terrain = siteTerrain(doc.site);
    const office = temporaries.find((t) => t.kind === 'office')!;
    const lowest = Math.min(...office.outline.map((p) => terrain.heightAt(p)));
    const bases = (text: string) =>
      text
        .split('\n')
        .map((l) => /=IFCCARTESIANPOINT\(\(0\.,0\.,([^)]+)\)\);$/.exec(l)?.[1])
        .filter((z): z is string => !!z)
        .map(Number);
    expect(bases(out.text).some((z) => Math.abs(z - lowest) < 1e-6)).toBe(true);
    const turned = structuredClone(doc);
    const o = turned.site!.temporaries.find((t) => t.id === office.id)!;
    o.outline = [...o.outline.slice(2), ...o.outline.slice(0, 2)];
    const again2 = writeConstructionIfc(turned, scheduleConstruction(turned), building, {
      artifactId: 'cs-1',
    }).text;
    expect(bases(again2)).toEqual(bases(out.text));
  });
});
