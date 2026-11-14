/**
 * The D3Q27 lattice (VS2, docs/cad/vehicle-simulation.md): the 27 velocities c_i ∈ {−1, 0, 1}³,
 * their weights (8/27 rest, 2/27 face, 1/54 edge, 1/216 corner) and each one's opposite. The speed
 * of sound squared is 1/3 in lattice units.
 */
export const Q = 27;
export const cs2 = 1 / 3;
/** The rest velocity (0, 0, 0). */
export const REST = 13;

export const cx = new Int8Array(Q);
export const cy = new Int8Array(Q);
export const cz = new Int8Array(Q);
export const weights = new Float64Array(Q);
export const opposite = new Uint8Array(Q);

{
  let i = 0;
  for (let z = -1; z <= 1; z++)
    for (let y = -1; y <= 1; y++)
      for (let x = -1; x <= 1; x++) {
        cx[i] = x;
        cy[i] = y;
        cz[i] = z;
        const n = Math.abs(x) + Math.abs(y) + Math.abs(z);
        weights[i] = n === 0 ? 8 / 27 : n === 1 ? 2 / 27 : n === 2 ? 1 / 54 : 1 / 216;
        i++;
      }
  for (let a = 0; a < Q; a++)
    for (let b = 0; b < Q; b++)
      if (cx[a] === -cx[b]! && cy[a] === -cy[b]! && cz[a] === -cz[b]!) opposite[a] = b;
}

/** The index of the velocity (x, y, z), each in {−1, 0, 1}. */
export function direction(x: number, y: number, z: number): number {
  return (z + 1) * 9 + (y + 1) * 3 + (x + 1);
}

/** The second-order equilibrium w ρ (1 + 3 c·u + 4.5 (c·u)² − 1.5 u²) of direction i. */
export function equilibrium(i: number, rho: number, ux: number, uy: number, uz: number): number {
  const cu = cx[i]! * ux + cy[i]! * uy + cz[i]! * uz;
  return weights[i]! * rho * (1 + 3 * cu + 4.5 * cu * cu - 1.5 * (ux * ux + uy * uy + uz * uz));
}
