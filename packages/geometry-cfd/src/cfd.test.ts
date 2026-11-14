import { describe, expect, it } from 'vitest';
import {
  CfdError,
  Flow,
  Q,
  boxSurface,
  cellIndex,
  cx,
  cy,
  cz,
  forceCoefficient,
  frontalArea,
  icosphere,
  opposite,
  streamline,
  surfacePressure,
  voxelize,
  weights,
  type TriangleSurface,
  type Voxelization,
} from './index';

describe('D3Q27 lattice', () => {
  it('has weights summing to 1, isotropic second moments and opposites', () => {
    let w = 0,
      xx = 0,
      xy = 0;
    for (let d = 0; d < Q; d++) {
      w += weights[d]!;
      xx += weights[d]! * cx[d]! * cx[d]!;
      xy += weights[d]! * cx[d]! * cy[d]!;
      expect(cx[opposite[d]!]! + cx[d]!).toBe(0);
      expect(cz[opposite[d]!]! + cz[d]!).toBe(0);
    }
    expect(w).toBeCloseTo(1, 14);
    expect(xx).toBeCloseTo(1 / 3, 14);
    expect(xy).toBeCloseTo(0, 14);
  });
});

describe('voxelize', () => {
  const grid = {
    origin: [0, 0, 0] as [number, number, number],
    spacing: 1,
    dims: [40, 40, 40] as [number, number, number],
  };

  it('fills a sphere to its volume and finds link crossings', () => {
    const r = 10;
    const vox = voxelize(icosphere([20, 20, 20], r, 4), grid);
    expect(vox.solidCells / ((4 / 3) * Math.PI * r ** 3)).toBeGreaterThan(0.97);
    expect(vox.solidCells / ((4 / 3) * Math.PI * r ** 3)).toBeLessThan(1.01);
    expect(vox.links.size).toBeGreaterThan(1000);
    expect(vox.fallbackLinks).toBe(0);
    for (const q of vox.links.values()) {
      expect(q).toBeGreaterThan(0);
      expect(q).toBeLessThanOrEqual(1);
    }
    // A link along +x from the cell just left of the sphere: the surface sits at x = 10.
    const i = 9; // centre 9.5
    const link = vox.links.get(cellIndex(grid, i, 19, 19) * Q + 14);
    expect(cx[14]).toBe(1);
    expect(cy[14]).toBe(0);
    expect(link).toBeDefined();
    expect(frontalArea(vox) / (Math.PI * r * r)).toBeGreaterThan(0.95);
  });

  it('fills a box exactly', () => {
    const vox = voxelize(boxSurface([10, 10, 10], [20, 15, 30]), grid);
    expect(vox.solidCells).toBe(10 * 5 * 20);
    // Faces half-way between centres: every axis link has q = ½.
    expect(vox.links.get(cellIndex(grid, 9, 12, 12) * Q + 14)).toBeCloseTo(0.5, 9);
  });

  it('refuses open surfaces, bodies outside the grid and grids past the limit', () => {
    const s = boxSurface([10, 10, 10], [20, 20, 20]);
    const open = { positions: s.positions, triangles: s.triangles.slice(3) };
    expect(() => voxelize(open, grid)).toThrow(/surface-open/);
    expect(() => voxelize(boxSurface([0.5, 10, 10], [20, 20, 20]), grid)).toThrow(/body-outside/);
    expect(() => voxelize(s, { ...grid, dims: [200, 200, 200] })).toThrow(CfdError);
    expect(() => voxelize(s, { ...grid, dims: [200, 200, 200] })).toThrow(/grid-too-large/);
  });
});

/** Two solid plates at k = 0 and k = nz − 1 (walls half-way to the next centres). */
function channel(nx: number, ny: number, nz: number): Voxelization {
  const grid = {
    origin: [0, 0, 0] as [number, number, number],
    spacing: 1,
    dims: [nx, ny, nz] as [number, number, number],
  };
  const solid = new Uint8Array(nx * ny * nz);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      solid[cellIndex(grid, i, j, 0)] = 1;
      solid[cellIndex(grid, i, j, nz - 1)] = 1;
    }
  return { grid, solid, links: new Map(), solidCells: 2 * nx * ny, fallbackLinks: 0 };
}

describe('Flow', () => {
  // VS4 (Codex on #1185): a yawed tunnel's road runs along the car, not the wind: the ground drags
  // the air next to it across the grid (y) as asked, and not at all without a sideways road.
  it('moves the ground with the road velocity it is given', () => {
    const grid = {
      origin: [0, 0, 0] as [number, number, number],
      spacing: 1,
      dims: [30, 12, 10] as [number, number, number],
    };
    const empty = {
      grid,
      solid: new Uint8Array(30 * 12 * 10),
      links: new Map(),
      solidCells: 0,
      fallbackLinks: 0,
    };
    const sideways = (road?: [number, number]) => {
      const flow = new Flow({
        vox: empty,
        speed: 0.05,
        viscosity: 0.05,
        smagorinsky: 0,
        ground: 'moving',
        ...(road ? { road } : {}),
      });
      flow.run(200);
      const { velocity } = flow.fields();
      let vy = 0;
      for (let j = 0; j < 12; j++)
        for (let i = 5; i < 25; i++) vy += velocity[3 * cellIndex(grid, i, j, 0) + 1]!;
      return vy / (12 * 20);
    };
    expect(Math.abs(sideways())).toBeLessThan(1e-6);
    expect(sideways([0.05, 0.02])).toBeGreaterThan(0.005);
    expect(
      () =>
        new Flow({
          vox: empty,
          speed: 0.05,
          viscosity: 0.05,
          smagorinsky: 0,
          ground: 'moving',
          road: [0.2, 0],
        }),
    ).toThrow(/road speed/);
  });

  it('develops plane Poiseuille flow between plates (u_max = 1.5 U)', () => {
    const nx = 80,
      ny = 3,
      nz = 22;
    const flow = new Flow({
      vox: channel(nx, ny, nz),
      speed: 0.04,
      viscosity: 0.1,
      smagorinsky: 0,
      ground: 'slip',
    });
    flow.run(4000);
    const { velocity } = flow.fields();
    const H = nz - 2;
    const i = 60;
    let worst = 0;
    for (let k = 1; k < nz - 1; k++) {
      const z = k - 0.5;
      const mean = (() => {
        let s = 0;
        for (let kk = 1; kk < nz - 1; kk++) s += velocity[3 * (i + nx * (1 + ny * kk))]!;
        return s / H;
      })();
      const exact = 6 * mean * (z / H) * (1 - z / H);
      worst = Math.max(
        worst,
        Math.abs(velocity[3 * (i + nx * (1 + ny * k))]! - exact) / (1.5 * mean),
      );
    }
    expect(worst).toBeLessThan(0.03);
  }, 120_000);

  it('pushes a sphere downstream with no side force', () => {
    const grid = {
      origin: [0, 0, 0] as [number, number, number],
      spacing: 1,
      dims: [60, 30, 30] as [number, number, number],
    };
    const vox = voxelize(icosphere([20, 15, 15], 5, 3), grid);
    const flow = new Flow({ vox, speed: 0.05, viscosity: 0.05, smagorinsky: 0, ground: 'slip' });
    flow.run(400);
    flow.resetAverage();
    flow.run(100);
    const [fx, fy, fz] = flow.averageForce;
    expect(fx).toBeGreaterThan(0);
    expect(Math.abs(fy) / fx).toBeLessThan(0.15);
    expect(Math.abs(fz) / fx).toBeLessThan(0.15);
    const cd = forceCoefficient(fx, 0.05, frontalArea(vox));
    expect(cd).toBeGreaterThan(0.5);
    expect(cd).toBeLessThan(10);
  }, 120_000);

  it('refuses settings out of range and stops when it blows up', () => {
    const vox = channel(10, 3, 6);
    expect(
      () => new Flow({ vox, speed: 0.3, viscosity: 0.1, smagorinsky: 0, ground: 'slip' }),
    ).toThrow(/config/);
    expect(
      () => new Flow({ vox, speed: 0.1, viscosity: 0, smagorinsky: 0, ground: 'slip' }),
    ).toThrow(/config/);
    expect(
      () => new Flow({ vox, speed: 0.1, viscosity: 0.1, smagorinsky: 0.5, ground: 'slip' }),
    ).toThrow(/config/);
  });
});

describe('fields', () => {
  it('traces a streamline around a box and reads the stagnation pressure on its front', () => {
    const grid = {
      origin: [0, 0, 0] as [number, number, number],
      spacing: 1,
      dims: [50, 24, 24] as [number, number, number],
    };
    const box = boxSurface([15, 8, 8], [21, 16, 16]);
    const vox = voxelize(box, grid);
    const speed = 0.05;
    const flow = new Flow({ vox, speed, viscosity: 0.05, smagorinsky: 0, ground: 'slip' });
    flow.run(600);
    const { rho, velocity } = flow.fields();
    // A line seeded just beside the box passes it and goes downstream.
    const line = streamline(vox, velocity, [3, 17.2, 12.2], { stepMm: 0.5, maxSteps: 400 });
    const last = line.length / 3 - 1;
    expect(line[3 * last]!).toBeGreaterThan(21);
    for (let p = 0; p <= last; p++) {
      const x = line[3 * p]!,
        y = line[3 * p + 1]!,
        z = line[3 * p + 2]!;
      expect(x > 15 && x < 21 && y > 8 && y < 16 && z > 8 && z < 16).toBe(false);
    }
    // Cp near 1 at the middle of the front face (triangles 8–9 are x = min, 4–5 y = min), negative on the sides.
    const { triangles } = surfacePressure(box, vox, rho, speed);
    expect(Math.max(triangles[8]!, triangles[9]!)).toBeGreaterThan(0.5);
    expect(Math.max(triangles[4]!, triangles[5]!)).toBeLessThan(0);
  }, 120_000);
});

describe('pressure outlet (VS2b)', () => {
  it('holds the outlet at density 1 so the mass stops growing, and reads p∞ upstream', () => {
    const grid = {
      origin: [0, 0, 0] as [number, number, number],
      spacing: 1,
      dims: [60, 20, 20] as [number, number, number],
    };
    // A blunt plate across a third of the tunnel pushes mass back toward the inlet.
    const vox = voxelize(boxSurface([20, 6, 6], [23, 14, 14]), grid);
    const flow = new Flow({ vox, speed: 0.05, viscosity: 0.05, smagorinsky: 0, ground: 'slip' });
    flow.run(1500);
    const m1 = flow.mass();
    flow.run(500);
    const m2 = flow.mass();
    const fluid = vox.solid.reduce((a, s) => a + (s ? 0 : 1), 0);
    // Settled: the mean density moves by less than 1e-4 over 500 steps.
    expect(Math.abs(m2 - m1) / fluid).toBeLessThan(1e-4);
    const { rho } = flow.fields();
    for (let k = 2; k < 18; k += 5)
      for (let j = 2; j < 18; j += 5)
        expect(Math.abs(rho[cellIndex(grid, 59, j, k)]! - 1)).toBeLessThan(1e-3);
    // Upstream sits above the outlet by the plate's pressure drop, which Cp is measured against.
    expect(flow.referenceDensity()).toBeGreaterThan(1);
  }, 120_000);
});

describe('voxelize several bodies', () => {
  it('joins overlapping closed surfaces (a wheel in its arch) into one solid', () => {
    const grid = {
      origin: [0, 0, 0] as [number, number, number],
      spacing: 1,
      dims: [40, 30, 30] as [number, number, number],
    };
    const body = boxSurface([5, 5, 10], [35, 25, 20]);
    const wheel = icosphere([10, 15, 10], 4, 3);
    const vox = voxelize([body, wheel], grid);
    const alone = voxelize(body, grid);
    // The sphere's lower half adds cells below the box; nothing inside the overlap is lost.
    expect(vox.solidCells).toBeGreaterThan(alone.solidCells);
    expect(vox.solid[cellIndex(grid, 10, 15, 10)]).toBe(1);
    expect(vox.solid[cellIndex(grid, 10, 15, 7)]).toBe(1);
  });
});

/** A closed box from `lo` to `hi` whose faces are split at the given cuts along each axis. */
function cutBox(lo: number[], hi: number[], cuts: number[][]): TriangleSurface {
  const axes = [0, 1, 2].map((a) => [lo[a]!, ...cuts[a]!, hi[a]!]);
  const index = new Map<string, number>();
  const positions: number[] = [];
  const triangles: number[] = [];
  const at = (p: number[]) => {
    const key = p.join(',');
    if (!index.has(key)) {
      index.set(key, positions.length / 3);
      positions.push(...p);
    }
    return index.get(key)!;
  };
  for (let a = 0; a < 3; a++)
    for (const side of [0, 1]) {
      const [u, v] = [(a + 1) % 3, (a + 2) % 3];
      const us = axes[u]!;
      const vs = axes[v]!;
      for (let i = 0; i + 1 < us.length; i++)
        for (let j = 0; j + 1 < vs.length; j++) {
          const q = [
            [us[i]!, vs[j]!],
            [us[i + 1]!, vs[j]!],
            [us[i + 1]!, vs[j + 1]!],
            [us[i]!, vs[j + 1]!],
          ].map(([pu, pv]) => {
            const p = [0, 0, 0];
            p[a] = side ? hi[a]! : lo[a]!;
            p[u] = pu!;
            p[v] = pv!;
            return at(p);
          });
          const [p0, p1, p2, p3] = q as [number, number, number, number];
          // Outward: counter-clockwise seen from outside.
          if (side) triangles.push(p0, p1, p2, p0, p2, p3);
          else triangles.push(p0, p2, p1, p0, p3, p2);
        }
    }
  return {
    positions: Float64Array.from(positions),
    triangles: Uint32Array.from(triangles),
    faces: new Int32Array(triangles.length / 3),
  };
}

describe('review fixes (VS2a)', () => {
  it('fills a box whose edges sit just past a row of cell centres', () => {
    // An edge 5e-7 above the row y = 5.5: the nudged rays still find the triangles below it.
    const grid = {
      origin: [0, 0, 0] as [number, number, number],
      spacing: 1,
      dims: [12, 12, 12] as [number, number, number],
    };
    const vox = voxelize(cutBox([3, 3, 3], [9, 9, 9], [[], [5.5000005], []]), grid);
    expect(vox.solidCells).toBe(216);
    expect(vox.fallbackLinks).toBe(0);
  });

  it('counts a ray through an edge two triangles share once', () => {
    // The origin moves the nudged rays exactly onto the box's diagonals.
    const grid = {
      origin: [0, -1.234567e-6, -2.718281e-6] as [number, number, number],
      spacing: 1,
      dims: [12, 12, 12] as [number, number, number],
    };
    const vox = voxelize(boxSurface([3, 3, 3], [9, 9, 9]), grid);
    expect(vox.solidCells).toBe(216);
    expect(vox.fallbackLinks).toBe(0);
  });

  it('stops when one cell gives a value that is not a number', () => {
    const vox = channel(10, 3, 6);
    const flow = new Flow({ vox, speed: 0.05, viscosity: 0.1, smagorinsky: 0, ground: 'slip' });
    flow.run(2);
    // The first fluid cell after the inlet plane.
    const f = (flow as unknown as { f: Float32Array }).f;
    f[cellIndex(vox.grid, 1, 1, 1) * Q + 5] = NaN;
    expect(() => flow.step()).toThrow(/unstable/);
  });

  it('ends a streamline at a body thinner than its step', () => {
    const grid = {
      origin: [0, 0, 0] as [number, number, number],
      spacing: 1,
      dims: [20, 12, 12] as [number, number, number],
    };
    const vox = voxelize(boxSurface([6, 4, 4], [7, 8, 8]), grid);
    const flow = new Flow({ vox, speed: 0.05, viscosity: 0.05, smagorinsky: 0, ground: 'slip' });
    flow.run(500);
    const line = streamline(vox, flow.fields().velocity, [4.5, 6, 6], { stepMm: 3, maxSteps: 50 });
    for (let p = 0; p < line.length; p += 3) expect(line[p]!).toBeLessThan(6);
  }, 60_000);
  it('reads Cp in the fluid cell of a narrow gap between two bodies', () => {
    const grid = {
      origin: [0, 0, 0] as [number, number, number],
      spacing: 1,
      dims: [14, 14, 14] as [number, number, number],
    };
    const near = boxSurface([3, 4, 4], [6.1, 10, 10]);
    const vox = voxelize([near, boxSurface([7, 4, 4], [10, 10, 10])], grid);
    expect(vox.solid[cellIndex(grid, 6, 7, 7)]).toBe(0);
    const rho = new Float32Array(14 * 14 * 14).fill(1.01);
    // Triangles 10–11 are the first box's face at x = 6.1, one fluid cell from the second box.
    const { triangles } = surfacePressure(near, vox, rho, 0.05);
    expect(triangles[10]).toBeCloseTo(0.01 / 3 / (0.5 * 0.05 ** 2), 3);
    expect(triangles[11]).toBeCloseTo(0.01 / 3 / (0.5 * 0.05 ** 2), 3);
  });

  it('keeps every streamline point inside the grid', () => {
    const grid = {
      origin: [0, 0, 0] as [number, number, number],
      spacing: 1,
      dims: [20, 12, 12] as [number, number, number],
    };
    const vox = channel(20, 12, 12);
    vox.solid.fill(0);
    const velocity = new Float32Array(3 * 20 * 12 * 12);
    for (let c = 0; c < 20 * 12 * 12; c++) velocity[3 * c] = 0.05;
    const line = streamline({ ...vox, grid }, velocity, [18, 2, 2], { stepMm: 3, maxSteps: 10 });
    for (let p = 0; p < line.length; p += 3) expect(line[p]!).toBeLessThanOrEqual(20);
  });
});
