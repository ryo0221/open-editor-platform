import type { ExplicitModel, ExplicitPlasticity } from './explicit';

/**
 * F97 (VS6c): a square steel tube crushed along its axis, for the Abramowicz–Jones check. The
 * tube's midsurface is a square of side `side` (mm) along z from 0 to `length`, `perSide`
 * shells across each face and square shells along it; the bottom ring is clamped, the top ring
 * moves down at `speed` (mm/s, a prescribed velocity), every shell touches every other
 * (self contact). A small dent of the first folding pattern near the top (faces in, out, in,
 * out, a tenth of the thickness at most) starts the folds there.
 */
export interface F97Options {
  side?: number;
  thickness?: number;
  length?: number;
  perSide?: number;
  speed?: number;
  /** Flow stress (MPa), elastic–perfectly plastic. */
  flowStress?: number;
}

export function f97SquareTube(options: F97Options = {}): {
  model: ExplicitModel;
  bottom: number[];
  top: number[];
  /** Half the fold length of Abramowicz–Jones, H = 0.99 t^(1/3) C^(2/3) (mm). */
  halfFold: number;
} {
  const C = options.side ?? 50;
  const t = options.thickness ?? 1.5;
  const L = options.length ?? 200;
  const m = options.perSide ?? 20;
  const speed = options.speed ?? 10_000;
  const sigma = options.flowStress ?? 300;
  const ring = 4 * m;
  const h = C / m;
  const rows = Math.round(L / h);
  const H = 0.99 * t ** (1 / 3) * C ** (2 / 3);
  const n = ring * (rows + 1);
  const nodes = new Float64Array(3 * n);
  for (let j = 0; j <= rows; j++) {
    const z = (j * L) / rows;
    for (let k = 0; k < ring; k++) {
      const face = Math.floor(k / m);
      const s = (k % m) * h;
      // Walk round the square counter-clockwise about +z, from (−C/2, −C/2).
      const [x, y] =
        face === 0
          ? [-C / 2 + s, -C / 2]
          : face === 1
            ? [C / 2, -C / 2 + s]
            : face === 2
              ? [C / 2 - s, C / 2]
              : [-C / 2, C / 2 - s];
      // The dent: along the inward normal on faces 0 and 2, outward on 1 and 3.
      const depth = Math.max(0, 1 - (L - z) / (2 * H));
      const a = 0.1 * t * Math.sin((Math.PI * s) / C) * depth * (face % 2 === 0 ? 1 : -1);
      const [nx, ny] = face === 0 ? [0, 1] : face === 1 ? [-1, 0] : face === 2 ? [0, -1] : [1, 0];
      const i = j * ring + k;
      nodes.set([x + a * nx, y + a * ny, z], 3 * i);
    }
  }
  const shells = new Uint32Array(4 * ring * rows);
  for (let j = 0; j < rows; j++)
    for (let k = 0; k < ring; k++) {
      const a = j * ring + k;
      const b = j * ring + ((k + 1) % ring);
      // Counter-clockwise seen from outside: the normal points out.
      shells.set([a, b, b + ring, a + ring], 4 * (j * ring + k));
    }
  const ne = ring * rows;
  const plastic: ExplicitPlasticity = { strain: [0], stress: [sigma] };
  const bottom = [...Array(ring).keys()];
  const top = bottom.map((k) => rows * ring + k);
  const fixed = new Uint8Array(n);
  const velocity = new Float64Array(3 * n);
  for (const i of bottom) fixed[i] = 63;
  for (const i of top) {
    fixed[i] = 63;
    velocity[3 * i + 2] = -speed;
  }
  return {
    model: {
      nodes,
      shells,
      thickness: new Float64Array(ne).fill(t),
      shellMaterial: new Uint16Array(ne),
      materials: [{ density: 7.85e-9, youngsModulus: 210_000, poissonRatio: 0.3, plastic }],
      fixed,
      velocity,
      contact: {},
    },
    bottom,
    top,
    halfFold: H,
  };
}

/** Abramowicz–Jones (1984) mean crushing force of a square tube: 13.05 σ0 t^(5/3) C^(1/3) (N). */
export function abramowiczJonesSquare(flowStress: number, thickness: number, side: number) {
  return 13.05 * flowStress * thickness ** (5 / 3) * side ** (1 / 3);
}
