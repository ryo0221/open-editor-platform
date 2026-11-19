import { describe, expect, it } from 'vitest';
import {
  checkFemMesh,
  ElasticError,
  radiosityFlux,
  shieldPlates,
  solveTransientThermal,
  stefanBoltzmann,
  viewFactors,
  type TransientInput,
} from './index';

const refusal = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(ElasticError);
    return (e as ElasticError).problem;
  }
  throw new Error('not refused');
};

/** Hottel: two directly opposed rectangles a × b at distance c. */
function opposedRectangles(a: number, b: number, c: number): number {
  const X = a / c,
    Y = b / c;
  return (
    (2 / (Math.PI * X * Y)) *
    (Math.log(Math.sqrt(((1 + X * X) * (1 + Y * Y)) / (1 + X * X + Y * Y))) +
      X * Math.sqrt(1 + Y * Y) * Math.atan(X / Math.sqrt(1 + Y * Y)) +
      Y * Math.sqrt(1 + X * X) * Math.atan(Y / Math.sqrt(1 + X * X)) -
      X * Math.atan(X) -
      Y * Math.atan(Y))
  );
}

/** The fraction of patch set `from`'s emission (area-weighted) that lands on the faces `to`. */
function setFactor(vf: ReturnType<typeof viewFactors>, from: number, to: number) {
  let num = 0,
    area = 0;
  vf.patches.forEach((p, i) => {
    if (p.face !== from) return;
    area += p.area;
    for (let q = vf.rowPtr[i]!; q < vf.rowPtr[i + 1]!; q++)
      if (vf.patches[vf.cols[q]!]!.face === to) num += p.area * vf.values[q]!;
  });
  return num / area;
}

const steel = { conductivity: 50, density: 7.85e-9, specificHeat: 4.6e8 };
const solver = { tolerance: 1e-10, maxIterations: 5000 };

describe('face-to-face radiation (VS11b, TS-2276, ST-635)', () => {
  it('finds the view factor of two opposed squares (Hottel) and keeps reciprocity', () => {
    const f = shieldPlates({ side: 100, gap: 100, thickness: 5, divisions: 10, shield: false });
    checkFemMesh(f.mesh);
    const vf = viewFactors(f.mesh, [f.hotFace, f.coldFace], 256);
    expect(vf.patches.length).toBe(400);
    expect(vf.rays).toBe(400 * 256);
    const exact = opposedRectangles(100, 100, 100); // 0.1998
    expect(exact).toBeCloseTo(0.1998, 3);
    expect(Math.abs(setFactor(vf, f.hotFace, f.coldFace) / exact - 1)).toBeLessThan(0.03);
    expect(Math.abs(setFactor(vf, f.coldFace, f.hotFace) / exact - 1)).toBeLessThan(0.03);
    // A_i F_ij = A_j F_ji for every pair; no row over 1; open to the rest.
    for (let i = 0; i < vf.patches.length; i++) {
      let sum = 0;
      for (let q = vf.rowPtr[i]!; q < vf.rowPtr[i + 1]!; q++) {
        const j = vf.cols[q]!;
        sum += vf.values[q]!;
        let back = 0;
        for (let r = vf.rowPtr[j]!; r < vf.rowPtr[j + 1]!; r++)
          if (vf.cols[r] === i) back = vf.values[r]!;
        expect(vf.patches[i]!.area * vf.values[q]!).toBeCloseTo(vf.patches[j]!.area * back, 9);
      }
      expect(sum + vf.ambient[i]!).toBeCloseTo(1, 12);
    }
    // The same rays give the same factors (deterministic).
    const again = viewFactors(f.mesh, [f.hotFace, f.coldFace], 256);
    expect([...again.values]).toEqual([...vf.values]);
  });

  it('keeps reciprocity where sampling noise puts a row over 1 (close plates, few rays)', () => {
    const f = shieldPlates({ side: 400, gap: 4, thickness: 1, divisions: 4, shield: false });
    const vf = viewFactors(f.mesh, [f.hotFace, f.coldFace], 64);
    const at = (i: number, j: number) => {
      for (let q = vf.rowPtr[i]!; q < vf.rowPtr[i + 1]!; q++)
        if (vf.cols[q] === j) return vf.values[q]!;
      return 0;
    };
    let over = 0;
    for (let i = 0; i < vf.patches.length; i++) {
      let sum = 0;
      for (let q = vf.rowPtr[i]!; q < vf.rowPtr[i + 1]!; q++) {
        const j = vf.cols[q]!;
        sum += vf.values[q]!;
        expect(vf.patches[i]!.area * vf.values[q]!).toBeCloseTo(vf.patches[j]!.area * at(j, i), 9);
      }
      over = Math.max(over, sum);
      expect(sum).toBeLessThanOrEqual(1 + 1e-12);
      expect(sum + vf.ambient[i]!).toBeCloseTo(1, 12);
    }
    expect(over).toBeGreaterThan(0.95);
    // Black plates at 600 / 300 K, 0 K surroundings: the net heat of all patches is only the loss
    // to the surroundings; the exchange between them cancels.
    const T = vf.patches.map((p) => (p.face === f.hotFace ? 600 : 300));
    const black = radiosityFlux(vf, T, new Float64Array(T.length).fill(1), 0, stefanBoltzmann);
    let net = 0,
      loss = 0;
    vf.patches.forEach((p, i) => {
      net += p.area * black.flux[i]!;
      loss -= p.area * vf.ambient[i]! * stefanBoltzmann * T[i]! ** 4;
    });
    expect(Math.abs(net - loss) / Math.abs(loss)).toBeLessThan(1e-9);
  });

  it('lets a shield plate block the view (F100): nothing from the hot plate reaches the cold one', () => {
    const f = shieldPlates({ side: 100, gap: 40, thickness: 2, divisions: 8, shield: true });
    const vf = viewFactors(f.mesh, [f.hotFace, f.coldFace, ...f.shieldFaces], 128);
    expect(setFactor(vf, f.hotFace, f.coldFace)).toBe(0);
    expect(setFactor(vf, f.hotFace, f.shieldFaces[0]!)).toBeGreaterThan(0.5);
    // Without the shield in the enclosure it still blocks, as an unseen surface.
    const open = viewFactors(f.mesh, [f.hotFace, f.coldFace], 128);
    expect(setFactor(open, f.hotFace, f.coldFace)).toBe(0);
    const unseen = open.patches.reduce(
      (s, p, i) => s + (p.face === f.hotFace ? p.area * open.unseen[i]! : 0),
      0,
    );
    expect(unseen / 10_000).toBeGreaterThan(0.5);
  });

  it('solves the radiosities of a black and a gray pair', () => {
    const f = shieldPlates({ side: 100, gap: 100, thickness: 5, divisions: 4, shield: false });
    const vf = viewFactors(f.mesh, [f.hotFace, f.coldFace], 64);
    const T = vf.patches.map((p) => (p.face === f.hotFace ? 600 : 300));
    // Black: q_i = Σ F_ij σ T_j⁴ + F_i∞ σ T∞⁴ − σ T_i⁴, in one pass.
    const black = radiosityFlux(vf, T, new Float64Array(T.length).fill(1), 0, stefanBoltzmann);
    expect(black.converged).toBe(true);
    vf.patches.forEach((_, i) => {
      let G = 0;
      for (let q = vf.rowPtr[i]!; q < vf.rowPtr[i + 1]!; q++)
        G += vf.values[q]! * stefanBoltzmann * T[vf.cols[q]!]! ** 4;
      expect(black.flux[i]).toBeCloseTo(G - stefanBoltzmann * T[i]! ** 4, 9);
    });
    const gray = radiosityFlux(vf, T, new Float64Array(T.length).fill(0.3), 0, stefanBoltzmann);
    expect(gray.converged).toBe(true);
    // Gray loses less than black.
    const hot = (q: Float64Array) =>
      vf.patches.reduce((s, p, i) => s + (p.face === f.hotFace ? q[i]! * p.area : 0), 0);
    expect(hot(gray.flux) / hot(black.flux)).toBeGreaterThan(0.25);
    expect(hot(gray.flux) / hot(black.flux)).toBeLessThan(0.35);
  });

  it('exchanges σ(T₁⁴ − T₂⁴)/(2/ε − 1) between close plates, and half of it with a shield (F100)', () => {
    const run = (shield: boolean) => {
      const f = shieldPlates({ side: 400, gap: 4, thickness: 1, divisions: 20, shield });
      const eps = 0.8;
      return {
        f,
        r: solveTransientThermal({
          mesh: f.mesh,
          // A light shield: it settles in a fraction of a second.
          material: { ...steel, specificHeat: 4.6e5 },
          conditions: [
            { kind: 'temperature', faces: f.hotFaces, edges: [], temperature: 600 },
            { kind: 'temperature', faces: f.coldFaces, edges: [], temperature: 300 },
            {
              kind: 'enclosure',
              faces: [f.hotFace, f.coldFace, ...f.shieldFaces],
              emissivity: eps,
            },
          ],
          initialTemperature: 450,
          time: { end: 2, step: 0.2, theta: 1 },
          output: { every: 10 },
          solver,
          nonlinear: { tolerance: 1e-4, maxIterations: 50 },
          enclosure: { ambient: 300, raysPerPatch: 64 },
        }),
      };
    };
    const plain = run(false);
    const shielded = run(true);
    expect(plain.r.converged).toBe(true);
    expect(shielded.r.converged).toBe(true);
    const sigma = stefanBoltzmann;
    const infinite = (sigma * (600 ** 4 - 300 ** 4)) / (2 / 0.8 - 1); // mW/mm²
    // The cold plate's hold takes the heat out: its power is negative.
    const into = (r: typeof plain.r) => -r.conditionPower[1]! / 160_000;
    // Finite plates (Hottel F = 0.980 at gap / side = 1 %) lose a little at the edges: the two-gray-
    // plate network gives σ(T₁⁴ − T₂⁴) / (2 (1 − ε) / ε + 1 / F). Rows that sampling noise puts over
    // 1 are limited (reciprocally), which biases the exchange a little low.
    const F = opposedRectangles(400, 400, 4);
    const finite = (sigma * (600 ** 4 - 300 ** 4)) / ((2 * 0.2) / 0.8 + 1 / F);
    expect(finite / infinite).toBeCloseTo(0.987, 3);
    expect(Math.abs(into(plain.r) / finite - 1)).toBeLessThan(0.04);
    const ratio = into(shielded.r) / into(plain.r);
    expect(ratio).toBeGreaterThan(0.46);
    expect(ratio).toBeLessThan(0.54);
    // The shield settles near ((T₁⁴ + T₂⁴) / 2)^¼ = 512 K.
    const T = shielded.r.temperatures.at(-1)!;
    const shieldNodes = new Set<number>();
    const npe = 10;
    for (let b = 0; b < shielded.f.mesh.boundary.tags.length; b++)
      if (shielded.f.shieldAll.includes(shielded.f.mesh.boundary.tags[b]!))
        for (let a = 0; a < npe; a++)
          shieldNodes.add(
            shielded.f.mesh.elements[shielded.f.mesh.boundary.elements[b]! * npe + a]!,
          );
    let mean = 0;
    for (const p of shieldNodes) mean += T[p]!;
    mean /= shieldNodes.size;
    expect(Math.abs(mean - ((600 ** 4 + 300 ** 4) / 2) ** 0.25)).toBeLessThan(8);
    expect(shielded.r.balance / shielded.r.energyScale).toBeLessThan(1e-6);
  }, 120_000);

  it('refuses an enclosure without its setup, a face radiating twice and beyond the limits', () => {
    const f = shieldPlates({ side: 100, gap: 50, thickness: 5, divisions: 4, shield: false });
    const base: TransientInput = {
      mesh: f.mesh,
      material: steel,
      conditions: [{ kind: 'enclosure', faces: [f.hotFace, f.coldFace], emissivity: 0.5 }],
      initialTemperature: 300,
      time: { end: 1, step: 1, theta: 1 },
      output: { every: 1 },
      solver,
      enclosure: { ambient: 300, raysPerPatch: 16 },
    };
    expect(refusal(() => solveTransientThermal({ ...base, enclosure: undefined }))).toBe(
      'material',
    );
    expect(
      refusal(() =>
        solveTransientThermal({ ...base, enclosure: { ambient: -1, raysPerPatch: 16 } }),
      ),
    ).toBe('material');
    expect(
      refusal(() =>
        solveTransientThermal({
          ...base,
          conditions: [
            ...base.conditions,
            { kind: 'radiation', faces: [f.hotFace], emissivity: 0.5, ambient: 300 },
          ],
        }),
      ),
    ).toBe('constraint-conflict');
    expect(
      refusal(() =>
        solveTransientThermal({
          ...base,
          conditions: [{ kind: 'enclosure', faces: [f.hotFace], emissivity: 1.5 }],
        }),
      ),
    ).toBe('material');
    expect(refusal(() => viewFactors(f.mesh, [f.hotFace], 0))).toBe('limit');
    expect(refusal(() => viewFactors(f.mesh, [f.hotFace], 2000))).toBe('limit');
    expect(refusal(() => viewFactors(f.mesh, [f.hotFace], 8, { patches: 10 }))).toBe('limit');
    expect(refusal(() => viewFactors(f.mesh, [f.hotFace], 64, { rays: 100 }))).toBe('limit');
    expect(refusal(() => viewFactors(f.mesh, [], 8))).toBe('empty-target');
    expect(refusal(() => viewFactors(f.mesh, [99], 8))).toBe('target-index');
    // Two plates radiating to each other only cool towards the surroundings, and keep the balance.
    const r = solveTransientThermal({ ...base, initialTemperature: 500 });
    expect(r.converged).toBe(true);
    expect(r.conditionHeat[0]!).toBeLessThan(0);
    expect(r.balance / r.energyScale).toBeLessThan(1e-8);
  });
});
