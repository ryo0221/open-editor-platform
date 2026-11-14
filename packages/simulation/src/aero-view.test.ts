import { boxSurface, type Grid } from '@editor-platform/geometry-cfd';
import { describe, expect, it } from 'vitest';
import {
  aeroSection,
  aeroStreamlines,
  nearestSamples,
  triangleToPoint,
  tunnelToVehicle,
  vehicleToTunnel,
  type AeroFlowField,
} from './aero-view';
import { runResult, resultVtu } from './results';

/**
 * TS-2212 (ST-609): what a wind-tunnel run shows (VS4c): the frames, the values carried to the
 * bodies' points, the flow section and the streamlines on a made-up flow.
 */

/** A flow of the inflow speed along +x (the tunnel's), around a block of solid cells. */
function uniformFlow(yawDeg = 0): AeroFlowField {
  const grid: Grid = { origin: [-1000, -400, -20], spacing: 20, dims: [100, 40, 30] };
  const [nx, ny, nz] = grid.dims;
  const velocity = new Float32Array(3 * nx * ny * nz);
  const solid = new Uint8Array(nx * ny * nz);
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const c = i + nx * (j + ny * k);
        // The block: x −400…0, y −100…100, z 20…200 in the tunnel.
        const x = grid.origin[0] + (i + 0.5) * 20;
        const y = grid.origin[1] + (j + 0.5) * 20;
        const z = grid.origin[2] + (k + 0.5) * 20;
        if (x > -400 && x < 0 && Math.abs(y) < 100 && z > 20 && z < 200) solid[c] = 1;
        else velocity[3 * c] = 1;
      }
  return { grid, velocity, solid, yawDeg };
}

describe('wind-tunnel views (VS4c)', () => {
  it('turns points to the tunnel and back', () => {
    for (const yaw of [0, 12, -20]) {
      const p = [1234, -56, 78];
      const back = tunnelToVehicle(yaw, vehicleToTunnel(yaw, p));
      back.forEach((v, k) => expect(v).toBeCloseTo(p[k]!, 9));
    }
    // No yaw: the nose (+x) is upstream (−x in the tunnel).
    expect(vehicleToTunnel(0, [400, 10, 5])).toEqual([-400, 10, 5]);
  });

  it('carries triangle values and samples to the points', () => {
    const box = boxSurface([0, 0, 0], [10, 10, 10]);
    const per = Float64Array.from({ length: 12 }, () => 2);
    expect(Array.from(triangleToPoint(box.positions, box.triangles, per))).toEqual(
      new Array(8).fill(2),
    );
    const [near] = nearestSamples(box.positions, [0, 0, 0, 10, 10, 10], [[1, 5]]);
    // Corner 0 is at the first sample, corner 7 at the second; corner 1 (10, 0, 0) nearer the first.
    expect([near![0], near![7], near![1]]).toEqual([1, 5, 1]);
  });

  it('shows the flow speed on a section, without the body or outside the tunnel', () => {
    const flow = uniformFlow();
    // Vehicle frame: the block is x 0…400; the plane y = 0 through it.
    const s = aeroSection(flow, 1, 0, [0, -100, 20], [400, 100, 200]);
    expect(s.values.length).toBeGreaterThan(100);
    // The free stream away from the block, slower next to it (the solid cells hold no flow).
    expect(s.values.every((v) => v >= 0 && v <= 1 + 1e-6)).toBe(true);
    expect(s.values.filter((v) => Math.abs(v - 1) < 1e-6).length).toBeGreaterThan(100);
    // Two sides: the back repeats every vertex.
    expect(s.mesh.positions.length / 3).toBe(2 * s.values.length);
    // No vertex inside the block.
    const p = s.mesh.positions;
    const o = s.mesh.origin;
    for (let v = 0; v < p.length / 3; v++) {
      const [x, z] = [p[3 * v]! + o[0], p[3 * v + 2]! + o[2]];
      expect(x > 20 && x < 380 && z > 40 && z < 180).toBe(false);
    }
  });

  it('draws streamlines from a rake ahead of the bodies, in the vehicle frame', () => {
    const flow = uniformFlow();
    // 8 across (two of them, y = ±105, beside the block) and 3 up (the top row over it).
    const s = aeroStreamlines(flow, 8, 3);
    expect(s.lines).toBe(24);
    const p = s.mesh.positions;
    const o = s.mesh.origin;
    let maxX = -Infinity;
    let minX = Infinity;
    for (let v = 0; v < p.length / 3; v++) {
      maxX = Math.max(maxX, p[3 * v]! + o[0]);
      minX = Math.min(minX, p[3 * v]! + o[0]);
    }
    // Seeds a fifth of the length ahead of the nose (x = 400 + 80), carried downstream (−x) past
    // the block by the lines that miss it.
    expect(maxX).toBeGreaterThan(470);
    expect(minX).toBeLessThan(-200);
    expect(s.colors.length).toBe(p.length);
  });

  it('makes a result and a VTU of the bodies with their values', () => {
    const box = boxSurface([0, 0, 0], [10, 10, 10]);
    const fields = {
      kind: 'aero' as const,
      points: box.positions,
      triangles: box.triangles,
      cp: new Float64Array(8).fill(0.5),
      cf: new Float64Array(8),
      htc: new Float64Array(8).fill(30),
    };
    const r = runResult(fields);
    expect(r.scalars.map((s) => s.id)).toEqual(['cp', 'cf', 'htc']);
    expect(r.aero).toEqual({});
    expect(r.twoSided?.every((x) => x === 0)).toBe(true);
    const vtu = resultVtu(fields);
    expect(vtu).toContain('Name="Cp"');
    expect(vtu).toContain('NumberOfCells="12"');
  });
});
