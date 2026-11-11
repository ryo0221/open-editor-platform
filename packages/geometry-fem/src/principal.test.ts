import { describe, expect, it } from 'vitest';
import { principalOf, principalStresses } from './elastic';

/** TS-1355 (ST-190#1): principal stresses of a Voigt stress, largest first. */
describe('principal stresses (R3e-5d)', () => {
  const close = (a: number[], b: number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, 9));

  it('orders a diagonal stress and solves shear and a rotated tensor', () => {
    close(principalOf([1, -3, 2, 0, 0, 0]), [2, 1, -3]);
    close(principalOf([0, 0, 0, 5, 0, 0]), [5, 0, -5]);
    close(principalOf([4, 4, 4, 0, 0, 0]), [4, 4, 4]);
    // diag(30, 10, -20) turned 30° about z.
    const [c, s] = [Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)];
    const t = [30 * c * c + 10 * s * s, 30 * s * s + 10 * c * c, -20, (30 - 10) * c * s, 0, 0];
    close(principalOf(t), [30, 10, -20]);
    // A general tensor keeps its trace and its largest is at least each normal stress.
    const g = [12, -7, 3, 4, -2, 6];
    const p = principalOf(g);
    expect(p[0] + p[1] + p[2]).toBeCloseTo(8, 9);
    expect(p[0]).toBeGreaterThanOrEqual(12);
    expect(p[2]).toBeLessThanOrEqual(-7);
  });

  it('gives the largest and smallest per node', () => {
    const { max, min } = principalStresses(new Float64Array([1, 2, 3, 0, 0, 0, 0, 0, 0, 5, 0, 0]));
    close([...max], [3, 5]);
    close([...min], [1, -5]);
  });
});
