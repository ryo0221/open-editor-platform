import { describe, expect, it } from 'vitest';
import { deriveBim } from '@editor-platform/bim-core';
import {
  approachRows,
  approachesOnDay,
  diagnosticRows,
  liftOverflowRows,
  f88Building,
  f89OfficeTraffic,
  scheduleConstruction,
  siteTerrain,
  writeChecksCsv,
} from './index';

describe('CS6b the checks as one table (ST-552, TS-2089)', () => {
  it('writes diagnostics and approaches as CSV, formulas defused (ST-552#2)', () => {
    const bim = f88Building();
    const derived = deriveBim(bim);
    const doc = f89OfficeTraffic(bim);
    const plan = scheduleConstruction(doc);
    const day = plan.byId.get('col-1')!.start;
    const approaches = approachesOnDay(
      doc,
      plan,
      {
        terrain: siteTerrain(doc.site),
        place: (id) => {
          const s = derived.shapes.get(id);
          return s?.kind === 'column'
            ? { centre: [s.at[0], s.at[1]], half: [300, 300] }
            : undefined;
        },
      },
      day,
    );
    const rows = [
      ...diagnosticRows('site', [
        { code: 'outside', path: 'c-1-1-1', message: '=SUM(A1), "quoted"' },
      ]),
      ...approachRows(approaches),
    ];
    const csv = writeChecksCsv(rows);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('area,code,where,day,message');
    expect(lines[1]).toBe(`site,outside,c-1-1-1,,"'=SUM(A1), ""quoted"""`);
    expect(lines[2]).toBe(
      `traffic,approach-slew,walk-office,${day},07:40:00–07:41:07: the trip from 07:40 comes into the slewing circle (Tower crane 1 slewing)`,
    );
    expect(lines).toHaveLength(2 + approaches.length + 1);
    expect(csv.endsWith('\r\n')).toBe(true);
  });

  it('names each lift past the working day (ST-552#2)', () => {
    expect(liftOverflowRows([{ day: '2027-04-20', liftIds: ['lift-a', 'lift-b'] }])).toEqual([
      {
        area: 'traffic',
        code: 'lift-past-day-end',
        where: 'lift-a',
        day: '2027-04-20',
        message: 'the lift does not fit in the working day: its danger is not drawn',
      },
      {
        area: 'traffic',
        code: 'lift-past-day-end',
        where: 'lift-b',
        day: '2027-04-20',
        message: 'the lift does not fit in the working day: its danger is not drawn',
      },
    ]);
  });
});
