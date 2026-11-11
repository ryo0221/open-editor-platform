import { describe, expect, it } from 'vitest';
import {
  bimSchedule,
  bimScheduleCsv,
  deriveBim,
  f37Office,
  f39Roofs,
  f40Lattice,
  type BimDocument,
} from './index';

const close = (a: number | undefined, b: number, eps = 1e-6) =>
  expect(Math.abs(a! - b)).toBeLessThan(eps);
const schedule = (doc: BimDocument, kq?: Map<string, Record<string, number>>) =>
  bimSchedule(doc, deriveBim(doc), kq);

describe('schedule (TW3)', () => {
  it('sums F37 by kind, type and level, and its volumes match the elements', () => {
    const doc = f37Office();
    const s = schedule(doc);
    const columns = s.rows.filter((r) => r.kind === 'column');
    expect(columns.map((r) => r.levelName)).toEqual(['1F', '2F', '3F', '4F', '5F']);
    for (const r of columns) {
      expect(r.count).toBe(35);
      close(r.lengthMm, 35 * 4000);
      close(r.volumeMm3, 35 * 600 * 600 * 4000, 1e-3);
      expect(r.category).toBe('concrete');
      expect(r.missing).toBe(0);
    }
    // Every element but the openings is in one row, once.
    const counted = s.rows.reduce((n, r) => n + r.count, 0);
    expect(counted).toBe(doc.elements.filter((e) => e.kind !== 'opening').length);
    const d = deriveBim(doc);
    let volume = 0;
    for (const e of doc.elements) {
      if (['opening', 'door', 'window', 'part'].includes(e.kind)) continue;
      const v = d.quantities.get(e.id)!.values;
      volume += v.netVolume ?? v.grossVolume ?? 0;
    }
    close(
      s.rows.reduce((n, r) => n + (r.volumeMm3 ?? 0), 0),
      volume,
      1,
    );
    // Rows come by kind, then type, then level from the bottom.
    const order = [...new Set(s.rows.map((r) => r.kind))];
    expect(order).toEqual(['column', 'beam', 'wall', 'slab', 'roof', 'door', 'window', 'space']);
    // Spaces have no material: no subtotal of their own.
    expect(s.subtotals.map((t) => t.category)).toEqual(['concrete']);
    const concrete = s.subtotals[0]!;
    expect(concrete.count).toBe(
      s.rows.filter((r) => r.category === 'concrete').reduce((n, r) => n + r.count, 0),
    );
  });

  it('gives the steel of a lattice by member type and level', () => {
    const s = schedule(f40Lattice());
    const member = (type: string, level: string) =>
      s.rows.find((r) => r.kind === 'member' && r.typeId === type && r.level === level)!;
    const round = member('t-member-round', 'l-gl');
    expect(round.count).toBe(2);
    close(round.lengthMm, 6000 + Math.hypot(2000, 3000, 6000));
    close(round.volumeMm3, Math.PI * 200 * 200 * (6000 + 7000), 1e-3);
    expect(member('t-member-box', 'l-gl').count).toBe(1);
    expect(member('t-member-box', 'l-1').count).toBe(1);
    const steel = s.subtotals.find((t) => t.category === 'metal')!;
    expect(steel.count).toBe(4);
    close(steel.lengthMm, 6000 + 7000 + Math.hypot(4000, 3000, 6000) + 6000);
    const lean = s.rows.find((r) => r.kind === 'column')!;
    close(lean.lengthMm, Math.hypot(2000, 6000));
  });

  it("counts what the kernel has not measured, and takes the kernel's values", () => {
    const doc = f39Roofs('gable');
    const before = schedule(doc);
    const walls = before.rows.find((r) => r.kind === 'wall')!;
    expect(walls.missing).toBe(4);
    expect(walls.volumeMm3).toBeUndefined();
    // Lengths and areas in plan stay analytic.
    close(walls.lengthMm, 2 * 10000 + 2 * 8000);
    const kq = new Map(
      doc.elements
        .filter((e) => e.kind === 'wall' || e.id === 'c-ridge')
        .map((e) => [e.id, { netVolume: 1e9 }]),
    );
    const after = schedule(doc, kq);
    const measured = after.rows.find((r) => r.kind === 'wall')!;
    expect(measured.missing).toBe(0);
    close(measured.volumeMm3, 4e9);
  });

  it('writes CSV in metres with a subtotal per material, quoting what needs it', () => {
    const doc = f40Lattice();
    doc.types.find((t) => t.id === 't-member-box')!.name = 'Box 300, "SHS"';
    const csv = bimScheduleCsv(schedule(doc));
    const lines = csv.split('\r\n');
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(lines[0]).toBe(
      'Kind,Type,Level,Material,Count,Length (m),Area (m²),Volume (m³),Not measured',
    );
    expect(lines).toContain(
      `member,Steel tube 400,GL,metal,2,13.000,,${(Math.PI * 0.2 * 0.2 * 13).toFixed(3)},`,
    );
    expect(csv).toContain('member,"Box 300, ""SHS""",GL,metal,1,');
    expect(lines.filter((l) => l.startsWith('Subtotal,')).map((l) => l.split(',')[3])).toEqual([
      'concrete',
      'metal',
    ]);
  });
});
