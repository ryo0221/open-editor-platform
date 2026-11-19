import { describe, expect, it } from 'vitest';
import { f83Air } from './car-look-air';
import { f142DiffuserDegrees, f142FloorEdge, f142Package, f142Underbody } from './car-look-aero';
import { f82Rules } from './car-look-package';
import { f141BodyLines } from './car-look-skin';
import { validateCad } from './validation';

describe('F142: 「翔」 with the floor and the diffuser of its air story (CL7c, TS-2030)', () => {
  it('runs the floor inside the lower edge and clear of the front tyres', () => {
    const lines = f141BodyLines();
    const inner = f82Rules.track.front / 2 - f82Rules.tyre.front.width / 2;
    for (let x = f142Underbody.floor.from; x <= f142Underbody.floor.to; x += 50) {
      expect(f142FloorEdge(x), `at ${x}`).toBeLessThanOrEqual(lines(x).lower[0] - 20 + 1e-9);
      expect(f142FloorEdge(x)).toBeLessThanOrEqual(inner - 40);
      // The floor stays under the skin's lower edge.
      expect(lines(x).lower[1]).toBeGreaterThan(f142Underbody.floor.z);
    }
  });
  it('rises the tunnels at the story’s diffuser angle, about 10°', () => {
    expect(f142DiffuserDegrees()).toBeCloseTo(
      (Math.atan2(
        f83Air.tunnel.roofExit - f83Air.tunnel.roofStart,
        f83Air.tunnel.exit - f83Air.tunnel.start,
      ) *
        180) /
        Math.PI,
      9,
    );
    expect(f142DiffuserDegrees()).toBeGreaterThan(9.5);
    expect(f142DiffuserDegrees()).toBeLessThan(10.5);
  });
  it('validates, with the floor and the two tunnels as bodies', () => {
    const doc = f142Package();
    expect(validateCad(doc)).toEqual([]);
    expect(doc.bodies.map((b) => b.name).slice(-3)).toEqual([
      'Floor',
      'Tunnel right',
      'Tunnel left',
    ]);
  });
});
