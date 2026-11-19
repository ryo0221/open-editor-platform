/**
 * VS13 (docs/cad/vehicle-simulation.md, VS13, VS-U7): stress-life fatigue as post-processing of
 * linear static results. A load history (each unit load case's factor over time, e.g. a road's
 * input) scales the cases' nodal stresses; each node's signed von Mises stress over the history
 * is rainflow counted (ASTM E1049-85 §5.4.4), each cycle's amplitude corrected for its mean
 * (Goodman) and given a life on a Basquin S-N line, and the damages summed (Palmgren–Miner).
 * Linear elastic: the stresses are the static solution's, no plasticity, no notch factors.
 * Units MPa.
 */

/** One counted cycle: its stress range (max − min), its mean and 1 (full) or 0.5 (half). */
export interface RainflowCycle {
  range: number;
  mean: number;
  count: 0.5 | 1;
}

/** The turning points of `series`: equal neighbours and points between are dropped. */
export function reversals(series: ArrayLike<number>): number[] {
  const out: number[] = [];
  for (let i = 0; i < series.length; i++) {
    const v = series[i]!;
    if (!Number.isFinite(v)) throw new RangeError(`fatigue: point ${i} is not finite`);
    if (out.length && v === out.at(-1)) continue;
    if (out.length >= 2) {
      const a = out.at(-2)!;
      const b = out.at(-1)!;
      // b lies between a and v: not a turning point.
      if ((b - a) * (v - b) > 0) {
        out[out.length - 1] = v;
        continue;
      }
    }
    out.push(v);
  }
  return out;
}

/** Rainflow counting after ASTM E1049-85 §5.4.4 (the three-point rule with the start point). */
export function rainflow(series: ArrayLike<number>): RainflowCycle[] {
  const points = reversals(series);
  const cycles: RainflowCycle[] = [];
  const stack: number[] = [];
  for (const p of points) {
    stack.push(p);
    while (stack.length >= 3) {
      const x = Math.abs(stack.at(-1)! - stack.at(-2)!);
      const y = Math.abs(stack.at(-2)! - stack.at(-3)!);
      if (x < y) break;
      const a = stack.at(-3)!;
      const b = stack.at(-2)!;
      if (stack.length === 3) {
        // Y holds the start point: half a cycle, and the start point goes.
        cycles.push({ range: y, mean: (a + b) / 2, count: 0.5 });
        stack.shift();
      } else {
        cycles.push({ range: y, mean: (a + b) / 2, count: 1 });
        const last = stack.pop()!;
        stack.pop();
        stack.pop();
        stack.push(last);
      }
    }
  }
  for (let i = 1; i < stack.length; i++)
    cycles.push({
      range: Math.abs(stack[i]! - stack[i - 1]!),
      mean: (stack[i]! + stack[i - 1]!) / 2,
      count: 0.5,
    });
  return cycles;
}

/**
 * A Basquin S-N line in stress amplitude: N = `reference.cycles` × (S / `reference.amplitude`)^−m
 * above the endurance limit, no damage below it. `ultimate` (MPa) is the Goodman mean correction's
 * tensile strength: an amplitude S at a tensile mean σm counts as S / (1 − σm / Su).
 */
export interface SnCurve {
  reference: { amplitude: number; cycles: number };
  /** The line's inverse slope m (log N against log S), e.g. 5 for welded or 8–12 for smooth. */
  slope: number;
  /** Amplitude with no damage (MPa); 0 for none. */
  endurance: number;
  ultimate: number;
}

/**
 * Structural steel (S355, smooth, R = −1): 250 MPa at 10⁶ cycles, slope 10, the endurance limit
 * there (250 MPa), Su 510 MPa. A starting value after the usual fatigue-strength ratio (about half
 * Su at 10⁶) for the analysis; a design takes the part's own measured line.
 */
export const steelSn: Readonly<SnCurve> = Object.freeze({
  reference: Object.freeze({ amplitude: 250, cycles: 1e6 }),
  slope: 10,
  endurance: 250,
  ultimate: 510,
});

export function checkSnCurve(sn: SnCurve): void {
  const ok =
    sn.reference.amplitude > 0 &&
    Number.isFinite(sn.reference.amplitude) &&
    sn.reference.cycles >= 1 &&
    Number.isFinite(sn.reference.cycles) &&
    sn.slope > 0 &&
    Number.isFinite(sn.slope) &&
    sn.endurance >= 0 &&
    Number.isFinite(sn.endurance) &&
    sn.ultimate > 0 &&
    Number.isFinite(sn.ultimate);
  if (!ok) throw new RangeError('fatigue: the S-N curve needs positive finite values');
}

/** Cycles to failure at amplitude `amplitude` and mean `mean` (Infinity below the endurance limit). */
export function cyclesToFailure(sn: SnCurve, amplitude: number, mean: number): number {
  if (!(amplitude > 0)) return Infinity;
  if (mean >= sn.ultimate) return 0;
  const equivalent = mean > 0 ? amplitude / (1 - mean / sn.ultimate) : amplitude;
  if (equivalent <= sn.endurance) return Infinity;
  return sn.reference.cycles * (equivalent / sn.reference.amplitude) ** -sn.slope;
}

/** Miner's damage of `cycles` (one pass of the history). */
export function minerDamage(sn: SnCurve, cycles: readonly RainflowCycle[]): number {
  let d = 0;
  for (const c of cycles) {
    const n = cyclesToFailure(sn, c.range / 2, c.mean);
    if (n === 0) return Infinity;
    d += c.count / n;
  }
  return d;
}

/**
 * The von Mises stress of a Voigt tensor [xx, yy, zz, xy, yz, zx], signed by its trace. A tensor
 * with no trace (pure shear) takes the sign of its product with `ref` (a tensor at `refAt`), so a
 * reversed shear stays reversed (Codex on #1283); without `ref` it is positive.
 */
export function signedVonMises(
  s: ArrayLike<number>,
  at = 0,
  ref?: ArrayLike<number>,
  refAt = 0,
): number {
  const [xx, yy, zz, xy, yz, zx] = [
    s[at]!,
    s[at + 1]!,
    s[at + 2]!,
    s[at + 3]!,
    s[at + 4]!,
    s[at + 5]!,
  ];
  const vm = Math.sqrt(
    0.5 * ((xx - yy) ** 2 + (yy - zz) ** 2 + (zz - xx) ** 2) + 3 * (xy * xy + yz * yz + zx * zx),
  );
  const trace = xx + yy + zz;
  if (Math.abs(trace) > traceShare * vm) return trace < 0 ? -vm : vm;
  if (ref) {
    let dot = 0;
    for (let d = 0; d < 6; d++) dot += s[at + d]! * ref[refAt + d]! * (d < 3 ? 1 : 2);
    if (dot < 0) return -vm;
  }
  return vm;
}
/** A trace below this share of the von Mises stress counts as none (roundoff of a shear). */
const traceShare = 1e-9;

/**
 * One pass of a history that repeats, as a finite record: turned to start at its largest |value|
 * and closed back on it, so that no cycle across the end of one pass and the start of the next is
 * left as two half cycles (Codex on #1283). `rainflow` itself counts a finite record.
 */
export function repeated(x: ArrayLike<number>): number[] {
  let top = 0;
  for (let i = 1; i < x.length; i++) if (Math.abs(x[i]!) > Math.abs(x[top]!)) top = i;
  const out: number[] = [];
  for (let i = 0; i <= x.length; i++) out.push(x[(top + i) % x.length]!);
  return out;
}

/** Limits: load cases, history points and nodes × points (the work of one field). */
export const fatigueLimits = Object.freeze({ cases: 16, points: 100_000, work: 2e9 });

export interface FatigueInput {
  /** Each unit case's nodal Voigt stresses (6 per node), all on the same nodes. */
  cases: readonly Float64Array[];
  /** Each case's factor at each point of the history (all the same length). */
  history: readonly (readonly number[])[];
  sn: SnCurve;
}

export interface FatigueField {
  /** Miner's damage of one pass of the history at each node. */
  damage: Float64Array;
  /** Passes to failure at each node (Infinity with no damage). */
  life: Float64Array;
  /** The node with the most damage, its damage and life. */
  worst: { node: number; damage: number; life: number };
}

/**
 * Damage and life at every node. One case's stresses scale with its factor, so its signed von
 * Mises stress is that factor times the unit one: the history is counted once and scaled. The
 * history is one pass of a load that repeats (`repeated`). Several
 * cases are summed as tensors at each point and counted node by node.
 */
export function fatigueField(input: FatigueInput): FatigueField {
  const { cases, history, sn } = input;
  checkSnCurve(sn);
  if (!cases.length || cases.length > fatigueLimits.cases || cases.length !== history.length)
    throw new RangeError(`fatigue: 1–${fatigueLimits.cases} cases, each with a history`);
  const nodes = cases[0]!.length / 6;
  if (!Number.isInteger(nodes) || cases.some((c) => c.length !== cases[0]!.length))
    throw new RangeError('fatigue: every case needs 6 stresses on the same nodes');
  const points = history[0]!.length;
  if (points < 2 || points > fatigueLimits.points || history.some((h) => h.length !== points))
    throw new RangeError(`fatigue: every history needs 2–${fatigueLimits.points} points, the same`);
  for (const h of history)
    for (const v of h)
      if (!Number.isFinite(v)) throw new RangeError('fatigue: a factor is not finite');
  if (nodes * points > fatigueLimits.work)
    throw new RangeError(
      `fatigue: ${nodes} nodes × ${points} points is over ${fatigueLimits.work}`,
    );
  const damage = new Float64Array(nodes);
  if (cases.length === 1) {
    const unit = rainflow(repeated(history[0]!));
    for (let n = 0; n < nodes; n++) {
      const s = signedVonMises(cases[0]!, 6 * n);
      // Miner's sum without a cycle list per node (Codex on #1283: nodes × cycles is the work).
      let d = 0;
      for (const c of unit) {
        const life = cyclesToFailure(sn, (Math.abs(s) * c.range) / 2, s * c.mean);
        if (life === 0) {
          d = Infinity;
          break;
        }
        d += c.count / life;
      }
      damage[n] = d;
    }
  } else {
    const series = new Float64Array(points);
    const t = new Float64Array(6);
    for (let n = 0; n < nodes; n++) {
      // A shear's sign against the first case with stress here, as one case is signed.
      const ref = cases.find((c) => {
        for (let d = 0; d < 6; d++) if (c[6 * n + d] !== 0) return true;
        return false;
      });
      for (let p = 0; p < points; p++) {
        t.fill(0);
        for (let k = 0; k < cases.length; k++) {
          const f = history[k]![p]!;
          for (let d = 0; d < 6; d++) t[d]! += f * cases[k]![6 * n + d]!;
        }
        series[p] = signedVonMises(t, 0, ref, 6 * n);
      }
      damage[n] = minerDamage(sn, rainflow(repeated(series)));
    }
  }
  const life = damage.map((d) => (d > 0 ? 1 / d : Infinity));
  let worst = 0;
  for (let n = 1; n < nodes; n++) if (damage[n]! > damage[worst]!) worst = n;
  return { damage, life, worst: { node: worst, damage: damage[worst]!, life: life[worst]! } };
}
