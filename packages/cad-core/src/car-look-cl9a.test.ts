import { describe, expect, it } from 'vitest';
import {
  f143Openings,
  f146Package,
  f147NoseInlet,
  f147Openings,
  f147Package,
  f147Rim,
} from './car-look-detail';
import { f141BodyLines } from './car-look-skin';
import { cadLimits } from './model';
import { validateCad } from './validation';

type V2 = readonly [number, number];
const corners = (o: typeof f147NoseInlet) => o.outlines[0]!.map((s) => s[0]!) as V2[];
const luminance = (hex: string) =>
  [1, 3, 5].reduce(
    (sum, i, k) => sum + [0.2126, 0.7152, 0.0722][k]! * parseInt(hex.slice(i, i + 2), 16),
    0,
  );

describe('F147: 「翔」 after the close-ups (CL9a, TS-2035)', () => {
  it('slants the nose inlets: the top edge rises outwards, inside the nose face', () => {
    const at = f141BodyLines()(-950);
    for (const [y, z] of corners(f147NoseInlet)) {
      expect(z).toBeGreaterThan(at.lower[1]);
      expect(y).toBeLessThan(
        at.lower[0] +
          ((at.widest[0] - at.lower[0]) * (z - at.lower[1])) / (at.widest[1] - at.lower[1]),
      );
    }
    const [, , outerTop, innerTop] = corners(f147NoseInlet);
    expect(outerTop![1] - innerTop![1]).toBeGreaterThan(20);
    expect(outerTop![0] - innerTop![0]).toBeGreaterThan(300);
    // Deeper than CL8a's duct, and only the nose inlet changes.
    expect(f147NoseInlet.depth).toBeGreaterThan(40);
    expect(f147Openings.map((o) => o.id)).toEqual(f143Openings.map((o) => o.id));
    expect(f147Openings.filter((o, i) => o !== f143Openings[i]).map((o) => o.id)).toEqual([
      'nose-inlet',
    ]);
  });
  // Builds both complete car packages before comparing their wheel appearances.
  it('makes the wheels’ faces brighter than F146’s', () => {
    const rim = (doc: ReturnType<typeof f146Package>) =>
      doc.bodies.find((b) => b.name === 'Front right rim')!.appearance!;
    expect(rim(f147Package()).color).toBe(f147Rim.color);
    expect(luminance(f147Rim.color)).toBeGreaterThan(luminance(rim(f146Package()).color) + 40);
  }, 10_000);
  // Builds two complete packages to compare real body IDs; this is a semantic
  // integration check, not a performance deadline (CL9a / TS-2035).
  it('validates with the same bodies as F146, at the body limit', () => {
    const doc = f147Package();
    expect(validateCad(doc)).toEqual([]);
    expect(doc.bodies.map((b) => b.id)).toEqual(f146Package().bodies.map((b) => b.id));
    expect(doc.bodies.length).toBeLessThanOrEqual(cadLimits.bodies);
  }, 15_000);
});
