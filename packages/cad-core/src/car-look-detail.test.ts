import { describe, expect, it } from 'vitest';
import { f83Air } from './car-look-air';
import { f143DuctOutline, f143Grown, f143Openings, f143Package } from './car-look-detail';
import { f141Arch, f141BodyLines, f141CanopyLines, f141FlareLine } from './car-look-skin';
import { f82Rules } from './car-look-package';
import { validateCad } from './validation';

type V2 = readonly [number, number];
const points = (id: string) => {
  const o = f143Openings.find((x) => x.id === id)!;
  return o.outlines.flatMap((segments) => segments.flat()) as V2[];
};

describe('F143: 「翔」 with the openings of its air story (CL8a, TS-2031)', () => {
  it('draws every opening of the story that F142 does not already have', () => {
    const open = new Set(['side-intake', 'diffuser-exit']);
    expect(new Set(f143Openings.map((o) => o.story))).toEqual(
      new Set(f83Air.openings.map((o) => o.id).filter((id) => !open.has(id))),
    );
  });
  it('keeps the fender vents outside the front flare and on the side, under the shoulder', () => {
    const arch = f141Arch(f82Rules.tyre.front.diameter);
    const lines = f141BodyLines();
    for (const [x, z] of points('fender-vent')) {
      expect(Math.hypot(x, z - arch.z)).toBeGreaterThan(arch.r + f141FlareLine.front + 50);
      expect(z).toBeGreaterThan(lines(x).lower[1]);
      expect(z).toBeLessThan(lines(x).shoulder[1] - 100);
    }
  });
  it('cuts the plan openings where a vertical line meets only the deck, outside the canopy', () => {
    const lines = f141BodyLines();
    const canopy = f141CanopyLines();
    for (const id of ['engine-intake', 'deck-outlet']) {
      for (const [x, y] of points(id)) {
        // Inside the lower edge (and so the widest line), the cut misses the side below.
        expect(y, `${id} at ${x}`).toBeLessThan(lines(x).lower[0] - 10);
        expect(y).toBeGreaterThan(lines(x).deckEdge[0]);
        if (x < 1950) expect(y).toBeGreaterThan(canopy(x).foot[0]);
      }
      // Their ducts too, so each duct's panel is one piece of the deck.
      for (const [x, y] of f143DuctOutline(f143Openings.find((o) => o.id === id)!).flat())
        expect(y, `${id} duct at ${x}`).toBeLessThan(lines(x).lower[0] - 10);
    }
  });
  it('keeps the nose inlets and arch exits inside their faces, on the face', () => {
    const lines = f141BodyLines();
    for (const [id, x] of [
      ['nose-inlet', -950],
      ['arch-exit', 3400],
    ] as const) {
      const at = lines(x);
      for (const [y, z] of points(id)) {
        expect(z).toBeGreaterThan(at.lower[1]);
        expect(y).toBeLessThan(
          at.lower[0] +
            ((at.widest[0] - at.lower[0]) * (z - at.lower[1])) / (at.widest[1] - at.lower[1]),
        );
      }
    }
  });
  it('validates, with each surface’s openings cut at once and a dark duct behind each', () => {
    const doc = f143Package();
    expect(validateCad(doc)).toEqual([]);
    expect(doc.bodies.filter((b) => b.id.startsWith('detail-')).map((b) => b.name)).toEqual(
      f143Openings.flatMap((o) => [`${o.name} duct right`, `${o.name} duct left`]),
    );
    const trims = doc.features.filter(
      (f) => f.type === 'trim' && f.id.startsWith('detail-openings-'),
    );
    expect(trims.map((f) => f.name)).toEqual([
      'Nose openings',
      'Side openings right',
      'Side openings left',
      'Deck openings right',
      'Deck openings left',
      'Tail openings',
    ]);
    // The ducts read the uncut skin: their panels' sources are no opening's trim.
    for (const f of doc.features)
      if (f.type === 'panel' && f.id.startsWith('detail-'))
        expect(f.args.source.featureId.startsWith('detail-')).toBe(false);
  });
  it('grows a duct’s outline outwards by its margin', () => {
    expect(f143DuctOutline(f143Openings.find((o) => o.id === 'deck-outlet')!).flat()[0]).toEqual([
      2270 - 80,
      665 - 80,
    ]);
    const [grown] = f143Grown(
      [
        [
          [0, 0],
          [10, 0],
        ],
        [
          [10, 0],
          [0, 0],
        ],
      ],
      5,
    );
    expect(grown).toEqual([
      [-5, 0],
      [15, 0],
    ]);
  });
});
