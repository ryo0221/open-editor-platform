import { expect, it } from 'vitest';
import { Flow, forceCoefficient, icosphere, voxelize } from './index';

/**
 * TS-2201 (ST-600 #4): the drag of a sphere at Re 100 against Schiller–Naumann. A long run
 * (about 1.5 million cells, 4,000 steps); it runs only with CFD_SPHERE=1. The conditions and the
 * measured values at other sizes are in docs/verification/vehicle-sim/README.md.
 */
it.skipIf(!process.env.CFD_SPHERE)(
  'gives the drag of a sphere at Re 100 within 10% of Schiller–Naumann',
  () => {
    const D = 16;
    const Re = 100;
    const U = 0.1;
    const dims: [number, number, number] = [10 * D, 6 * D, 6 * D];
    const vox = voxelize(icosphere([3 * D, 3 * D, 3 * D], D / 2, 5), {
      origin: [0, 0, 0],
      spacing: 1,
      dims,
    });
    const flow = new Flow({
      vox,
      speed: U,
      viscosity: (U * D) / Re,
      smagorinsky: 0,
      ground: 'slip',
    });
    // Two passes of the tunnel to settle, then the mean over the last half pass.
    flow.run(Math.round((2 * dims[0]) / U));
    flow.resetAverage();
    flow.run(Math.round((0.5 * dims[0]) / U));
    // The interpolated bounce-back puts the wall on the true sphere, so its true area is used.
    const cd = forceCoefficient(flow.averageForce[0], U, (Math.PI * D * D) / 4);
    const expected = (24 / Re) * (1 + 0.15 * Re ** 0.687);
    expect(Math.abs(cd - expected) / expected).toBeLessThan(0.1);
  },
  3_600_000,
);
