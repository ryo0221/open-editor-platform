import { describe, expect, it } from 'vitest';
import { f144LampDepth, f144Lamps, f144Package } from './car-look-detail';
import { f141BodyLines } from './car-look-skin';
import { validateCad } from './validation';

type V2 = readonly [number, number];
const pts = (o: (readonly V2[])[]) => o.flat();

describe('F144: 「翔」 with its lamps (CL8b, TS-2032)', () => {
  it('lays the headlamp on the hood’s slope, inside the lower edge and along the shoulder', () => {
    const lines = f141BodyLines();
    const h = f144Lamps.find((l) => l.id === 'headlamp')!;
    for (const [x, y] of [...pts(h.outline), ...pts(h.graphic)]) {
      // A vertical cut meets the slope alone.
      expect(y, `at ${x}`).toBeLessThan(lines(x).lower[0] - 10);
      expect(y).toBeGreaterThan(lines(x).deckEdge[0]);
    }
  });
  it('keeps each lit graphic inside its lens', () => {
    for (const l of f144Lamps) {
      const o = pts(l.outline);
      const box = [0, 1].map((k) => [
        Math.min(...o.map((p) => p[k]!)),
        Math.max(...o.map((p) => p[k]!)),
      ]);
      for (const p of pts(l.graphic))
        for (const k of [0, 1]) {
          expect(p[k]).toBeGreaterThan(box[k]![0]!);
          expect(p[k]).toBeLessThan(box[k]![1]!);
        }
    }
    expect(f144LampDepth.graphic).toBeLessThan(f144LampDepth.housing);
  });
  it('runs the tail lamp across the tail’s face, under the deck’s edge', () => {
    const at = f141BodyLines()(3400);
    const t = f144Lamps.find((l) => l.id === 'tail-lamp')!;
    for (const [y, z] of pts(t.outline)) {
      expect(z).toBeGreaterThan(at.widest[1]);
      expect(z).toBeLessThan(at.shoulder[1]);
      expect(Math.abs(y)).toBeLessThan(at.shoulder[0]);
    }
  });
  it('validates, with a lens, light and housing per lamp and side', () => {
    const doc = f144Package();
    expect(validateCad(doc)).toEqual([]);
    expect(doc.bodies.filter((b) => b.id.startsWith('lamp-')).map((b) => b.name)).toEqual([
      'Headlamp lens right',
      'Headlamp light right',
      'Headlamp housing right',
      'Headlamp lens left',
      'Headlamp light left',
      'Headlamp housing left',
      'Tail lamp lens',
      'Tail lamp light',
      'Tail lamp housing',
    ]);
    expect(doc.bodies.find((b) => b.name === 'Tail lamp light')!.appearance?.emission).toBeTruthy();
    expect(
      doc.features.filter((f) => f.type === 'trim' && f.id.startsWith('lamp-')).map((f) => f.id),
    ).toEqual(['lamp-headlamp-cut-right', 'lamp-headlamp-cut-left', 'lamp-tail-lamp-cut']);
  });
});
