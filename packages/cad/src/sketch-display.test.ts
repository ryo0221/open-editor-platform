import { f81TwoView, type CadDocument, type CadSketch } from '@editor-platform/cad-core';
import { describe, expect, it } from 'vitest';
import { sketchDisplay, sketchInk } from './sketch-display';

describe('CLF11: the shown sketches in model space (TS-2020)', () => {
  const doc = f81TwoView();
  const side = doc.sketches.find((s) => 'origin' in s.plane)!;

  it('draws only the shown sketches, each curve in its colour on its plane', () => {
    expect(sketchDisplay(doc, new Set())).toEqual({ lines: [], notes: [] });
    const first = side.entities.find((e) => e.type !== 'point')!;
    const coloured: CadDocument = {
      ...doc,
      sketches: doc.sketches.map((s) =>
        s.id === side.id
          ? ({
              ...s,
              entities: s.entities.map((e) => (e.id === first.id ? { ...e, color: '#d1495b' } : e)),
              notes: [{ id: 'n1', at: [10, 20], text: 'ルーフ', size: 8, color: '#3e7cb1' }],
            } as CadSketch)
          : s,
      ),
    };
    const d = sketchDisplay(coloured, new Set([side.id]));
    expect(new Set(d.lines.map((l) => l.sketchId))).toEqual(new Set([side.id]));
    expect(d.lines.find((l) => l.element === first.id)!.color).toBe('#d1495b');
    expect(d.lines.filter((l) => l.element !== first.id).every((l) => l.color === sketchInk)).toBe(
      true,
    );
    // Every point lies on the sketch's plane: along its normal, as far as its origin.
    const plane = side.plane as Extract<CadSketch['plane'], { origin: unknown }>;
    const q = plane.orientation;
    const normal = [
      2 * (q[0] * q[2] + q[3] * q[1]),
      2 * (q[1] * q[2] - q[3] * q[0]),
      1 - 2 * (q[0] ** 2 + q[1] ** 2),
    ];
    const origin = plane.origin.map((l) => ('literalMm' in l ? l.literalMm : 0));
    const off = (p: number[]) => p.reduce((a, x, i) => a + (x - origin[i]!) * normal[i]!, 0);
    for (const l of d.lines) for (const p of l.points) expect(off(p)).toBeCloseTo(0, 6);
    const [note] = d.notes;
    expect(note).toMatchObject({ id: 'n1', text: 'ルーフ', size: 8, color: '#3e7cb1' });
    expect(off(note!.at)).toBeCloseTo(0, 6);
    // u, v and the normal make a right-handed frame.
    const [u, v] = [note!.u, note!.v];
    const cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    cross.forEach((x, i) => expect(x).toBeCloseTo(normal[i]!, 6));
    for (const l of d.lines) l.normal.forEach((x, i) => expect(x).toBeCloseTo(normal[i]!, 6));
  });
});
