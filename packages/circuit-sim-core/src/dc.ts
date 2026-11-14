import { CircuitError, type Circuit } from './circuit';

/**
 * DC operating point by modified nodal analysis (docs/cad/circuit-simulation.md, SL4). Unknowns
 * are the node voltages (ground is node 0) and the currents of voltage sources and inductors
 * (an inductor is a short in DC; a capacitor is open). Diodes, LEDs, BJTs and MOSFETs are
 * linearised each Newton–Raphson iteration, junction voltages limited as SPICE does; when the
 * iteration does not converge, the sources are brought up in steps. A dense matrix, solved by
 * Gaussian elimination with partial pivoting: the circuit limits keep it small.
 */

/** Thermal voltage kT/q at 300 K. */
export const circuitThermalVolts = 0.025852;
/** Conductance put across every junction so the matrix stays solvable when it is off. */
const gmin = 1e-12;

/**
 * LED colours as diodes (emission coefficient 2): saturation currents chosen for a typical
 * forward voltage at 10 mA (red 1.8 V, yellow 2.0 V, green 2.1 V, blue and white 3.0 V).
 */
export const circuitLedModels: Readonly<
  Record<string, { saturationAmps: number; emission: number }>
> = Object.freeze(
  Object.fromEntries(
    (
      [
        ['red', 1.8],
        ['yellow', 2.0],
        ['green', 2.1],
        ['blue', 3.0],
        ['white', 3.0],
      ] as const
    ).map(([color, vf]) => [
      color,
      { saturationAmps: 0.01 / Math.exp(vf / (2 * circuitThermalVolts)), emission: 2 },
    ]),
  ),
);

/**
 * A pin driven or read by something outside the drawing (a GPIO, SL8): an output is a voltage
 * behind an output resistance; an input is a pull resistor to a supply (or none) and reads high
 * above its threshold. Both are relative to ground.
 */
export type CircuitDrive =
  | { id: string; node: number; kind: 'output'; volts: number; ohms: number }
  | {
      id: string;
      node: number;
      kind: 'input';
      pull: 'up' | 'down' | 'none';
      pullOhms: number;
      supplyVolts: number;
      thresholdVolts: number;
    };

export interface CircuitDcOptions {
  /** Switch element ID → closed. Switches not listed are open. */
  switches?: Readonly<Record<string, boolean>>;
  drives?: readonly CircuitDrive[];
  /** A previous solution's unknowns, to start from (a sweep, the next scan). */
  start?: readonly number[];
  /** Newton iterations per attempt (default 150). */
  maxIterations?: number;
}

export interface CircuitDcResult {
  /** Node name → volts (ground is 0). */
  voltages: Record<string, number>;
  /**
   * Element ID → terminal → amps flowing into the element at that terminal (a resistor from
   * `a` to `b` has a positive `a` current; a battery delivering power has a negative `plus`).
   */
  currents: Record<string, Record<string, number>>;
  /** Input drive ID → high (above its threshold). */
  inputs: Record<string, boolean>;
  /** Every unknown, to start a later calculation from. */
  unknowns: number[];
  iterations: number;
}

/** Nodes with no DC path to ground (through anything but capacitors and current sources). */
export function circuitFloatingNodes(
  circuit: Circuit,
  drives: readonly CircuitDrive[] = [],
  dc = true,
): string[] {
  const parent = circuit.nodes.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const join = (a: number, b: number) => void (parent[find(a)] = find(b));
  for (const e of circuit.elements) {
    if (e.kind === 'isource' || (dc && e.kind === 'capacitor')) continue;
    // A MOSFET's gate carries no DC current: only drain and source join.
    const ns = e.kind === 'mosfet' ? [e.nodes.drain, e.nodes.source] : Object.values(e.nodes);
    for (const n of ns.slice(1)) join(ns[0], n);
  }
  for (const d of drives) if (d.kind === 'output' || d.pull !== 'none') join(d.node, 0);
  return circuit.nodes.filter((_, i) => i > 0 && find(i) !== find(0));
}

/** Whether switch `id` is closed: only an own `true` (never an inherited `toString`). */
export function circuitSwitchClosed(
  switches: Readonly<Record<string, boolean>> | undefined,
  id: string,
): boolean {
  return !!switches && Object.hasOwn(switches, id) && switches[id] === true;
}

/** SPICE's junction voltage limiting: a new junction voltage not far past the last one. */
function pnjlim(vnew: number, vold: number, vt: number, vcrit: number): number {
  if (vnew > vcrit && Math.abs(vnew - vold) > 2 * vt) {
    if (vold > 0) {
      const arg = 1 + (vnew - vold) / vt;
      return arg > 0 ? vold + vt * Math.log(arg) : vcrit;
    }
    return vt * Math.log(vnew / vt);
  }
  return vnew;
}
const junction = (is: number, nvt: number, v: number) => {
  const e = Math.exp(Math.min(v / nvt, 80));
  return { i: is * (e - 1), g: (is / nvt) * e };
};

/** Solves A x = b in place by Gaussian elimination with partial pivoting; throws when singular. */
export function circuitSolve(a: number[][], b: number[]): number[] {
  const n = b.length;
  for (let k = 0; k < n; k++) {
    let p = k;
    for (let i = k + 1; i < n; i++) if (Math.abs(a[i][k]) > Math.abs(a[p][k])) p = i;
    if (Math.abs(a[p][k]) < 1e-300) throw new CircuitError('dc-singular');
    [a[k], a[p]] = [a[p], a[k]];
    [b[k], b[p]] = [b[p], b[k]];
    for (let i = k + 1; i < n; i++) {
      const f = a[i][k] / a[k][k];
      if (f === 0) continue;
      for (let j = k; j < n; j++) a[i][j] -= f * a[k][j];
      b[i] -= f * b[k];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i];
    for (let j = i + 1; j < n; j++) s -= a[i][j] * x[j];
    x[i] = s / a[i][i];
  }
  return x;
}

/** What one element adds to the system, given the present unknowns. */
interface Stamp {
  /** Unknown index of a node (−1 for ground). */
  row(node: number): number;
  g(a: number, b: number, value: number): void;
  /** Current `amps` injected into node `a` (and drawn from `b`). */
  inject(a: number, b: number, amps: number): void;
  /** A nonlinear device: currents into it at each terminal node and their derivatives. */
  device(currents: [number, number][], jac: [number, number, number][]): void;
  voltage(node: number): number;
}

/** The previous time point, for the integration companions of a transient step (SL5). */
export interface CircuitCompanion {
  h: number;
  method: 'euler' | 'trapezoid';
  /** The previous unknowns. */
  prev: readonly number[];
  /** Node voltage at the previous point. */
  at(node: number): number;
  /** Capacitor ID → current from `a` to `b` at the previous point. */
  current: ReadonlyMap<string, number>;
  /** Inductor ID → voltage `a` − `b` at the previous point. */
  voltage: ReadonlyMap<string, number>;
}

/** Element kinds with a branch current unknown. */
const branchKinds = new Set(['vsource', 'inductor']);

export class CircuitDc {
  private readonly size: number;
  private readonly branch = new Map<string, number>();
  /** Last junction voltages per element, for limiting. */
  private junctions = new Map<string, number[]>();
  /** Whether limiting moved a junction voltage in the last assembly (not yet converged). */
  private limited = false;
  /**
   * In a transient step: capacitors and inductors as their integration companions (SL5), from
   * the previous time point's unknowns and element currents and voltages.
   */
  companion?: CircuitCompanion;
  /** Nodes given a tiny conductance to ground (a transient's start, nodes only capacitors hold). */
  shunts: readonly number[] = [];

  constructor(
    readonly circuit: Circuit,
    public options: CircuitDcOptions = {},
  ) {
    let next = circuit.nodes.length - 1;
    for (const e of circuit.elements) if (branchKinds.has(e.kind)) this.branch.set(e.id, next++);
    this.size = next;
  }

  /** Builds the linear system at `x` (sources scaled by `factor`). */
  private assemble(x: number[], factor: number, limit: boolean) {
    this.limited = false;
    const lim = (vnew: number, value: number) => {
      if (Math.abs(value - vnew) > 1e-12) this.limited = true;
      return value;
    };
    const n = this.size;
    const a = Array.from({ length: n }, () => new Array<number>(n).fill(0));
    const b = new Array<number>(n).fill(0);
    const row = (node: number) => node - 1;
    const v = (node: number) => (node === 0 ? 0 : x[node - 1]);
    const add = (i: number, j: number, value: number) => {
      if (i >= 0 && j >= 0) a[i][j] += value;
    };
    const stamp: Stamp = {
      row,
      voltage: v,
      g(p, q, value) {
        add(row(p), row(p), value);
        add(row(q), row(q), value);
        add(row(p), row(q), -value);
        add(row(q), row(p), -value);
      },
      inject(p, q, amps) {
        if (p > 0) b[row(p)] += amps;
        if (q > 0) b[row(q)] -= amps;
      },
      device(currents, jac) {
        // I_t(V) ≈ I_t(V0) + Σ dI_t/dV_m (V_m − V0_m): the constant part moves to the right side.
        const lin = new Map<number, number>();
        for (const [t, m, d] of jac) {
          add(row(t), row(m), d);
          lin.set(t, (lin.get(t) ?? 0) + d * v(m));
        }
        // Terminals may share a node (a diode-connected transistor): sum per node first.
        const into = new Map<number, number>();
        for (const [t, i] of currents) into.set(t, (into.get(t) ?? 0) + i);
        for (const [t, i] of into) if (t > 0) b[row(t)] -= i - (lin.get(t) ?? 0);
      },
    };
    const switches = this.options.switches ?? {};
    const vt = circuitThermalVolts;
    for (const e of this.circuit.elements) {
      const p = e.params;
      const nd = e.nodes;
      switch (e.kind) {
        case 'resistor':
          stamp.g(nd.a, nd.b, 1 / (p.ohms as number));
          break;
        case 'switch':
          stamp.g(
            nd.a,
            nd.b,
            1 / ((circuitSwitchClosed(switches, e.id) ? p.closedOhms : p.openOhms) as number),
          );
          break;
        case 'capacitor': {
          const c = this.companion;
          if (!c) break;
          const trap = c.method === 'trapezoid';
          const geq = ((trap ? 2 : 1) * (p.farads as number)) / c.h;
          const vprev = c.at(nd.a) - c.at(nd.b);
          // i = geq·v − (geq·vprev [+ iprev]): the constant part is a source into `a`.
          stamp.g(nd.a, nd.b, geq);
          stamp.inject(nd.a, nd.b, geq * vprev + (trap ? (c.current.get(e.id) ?? 0) : 0));
          break;
        }
        case 'isource':
          stamp.inject(nd.plus, nd.minus, factor * (p.amps as number));
          break;
        case 'vsource':
        case 'inductor': {
          const k = this.branch.get(e.id)!;
          const [pl, mi] = e.kind === 'vsource' ? [nd.plus, nd.minus] : [nd.a, nd.b];
          // Branch current flows into `plus` through the source.
          add(row(pl), k, 1);
          add(row(mi), k, -1);
          add(k, row(pl), 1);
          add(k, row(mi), -1);
          b[k] += e.kind === 'vsource' ? factor * (p.volts as number) : 0;
          const c = this.companion;
          if (e.kind === 'inductor' && c) {
            // v = req·(i − iprev) [− vprev]: Va − Vb − req·i = −req·iprev [− vprev].
            const trap = c.method === 'trapezoid';
            const req = ((trap ? 2 : 1) * (p.henries as number)) / c.h;
            a[k][k] -= req;
            b[k] -= req * c.prev[k] + (trap ? (c.voltage.get(e.id) ?? 0) : 0);
          }
          break;
        }
        case 'diode':
        case 'led': {
          const m =
            e.kind === 'led'
              ? circuitLedModels[p.color as string]
              : { saturationAmps: p.saturationAmps as number, emission: p.emission as number };
          const nvt = m.emission * vt;
          let vd = v(nd.anode) - v(nd.cathode);
          const old = this.junctions.get(e.id)?.[0] ?? 0;
          if (limit)
            vd = lim(
              vd,
              pnjlim(vd, old, nvt, nvt * Math.log(nvt / (Math.SQRT2 * m.saturationAmps))),
            );
          this.junctions.set(e.id, [vd]);
          const j = junction(m.saturationAmps, nvt, vd);
          const g = j.g + gmin;
          const i = j.i + gmin * vd;
          // Linearised about vd (which limiting may have moved off the node voltages).
          stamp.g(nd.anode, nd.cathode, g);
          stamp.inject(nd.anode, nd.cathode, -(i - g * vd));
          break;
        }
        case 'bjt': {
          const pol = p.polarity === 'pnp' ? -1 : 1;
          const bf = p.beta as number;
          const br = 1;
          const is = 1e-14;
          const vcrit = vt * Math.log(vt / (Math.SQRT2 * is));
          let vbe = pol * (v(nd.base) - v(nd.emitter));
          let vbc = pol * (v(nd.base) - v(nd.collector));
          const [obe, obc] = this.junctions.get(e.id) ?? [0, 0];
          if (limit) {
            vbe = lim(vbe, pnjlim(vbe, obe, vt, vcrit));
            vbc = lim(vbc, pnjlim(vbc, obc, vt, vcrit));
          }
          this.junctions.set(e.id, [vbe, vbc]);
          const f = junction(is, vt, vbe);
          const r = junction(is, vt, vbc);
          // Transport model: currents into the device, in the npn frame.
          const ic = f.i - r.i - r.i / br - gmin * vbc;
          const ib = f.i / bf + r.i / br + gmin * vbe + gmin * vbc;
          // Derivatives with respect to vbe and vbc.
          const dic = [f.g, -r.g - r.g / br - gmin];
          const dib = [f.g / bf + gmin, r.g / br + gmin];
          // In node voltages: vbe = pol(Vb − Ve), vbc = pol(Vb − Vc); currents scale by pol, so
          // dI/dV keeps its sign.
          const at = (vb: number, vc: number) => ({
            b: vb + vc,
            c: -vc,
            e: -vb,
          });
          const dc = at(dic[0], dic[1]);
          const db = at(dib[0], dib[1]);
          const icn = pol * ic;
          const ibn = pol * ib;
          const jac: [number, number, number][] = [
            [nd.collector, nd.base, dc.b],
            [nd.collector, nd.collector, dc.c],
            [nd.collector, nd.emitter, dc.e],
            [nd.base, nd.base, db.b],
            [nd.base, nd.collector, db.c],
            [nd.base, nd.emitter, db.e],
            [nd.emitter, nd.base, -dc.b - db.b],
            [nd.emitter, nd.collector, -dc.c - db.c],
            [nd.emitter, nd.emitter, -dc.e - db.e],
          ];
          // The linear part is taken about the limited voltages: shift by the difference.
          const dVbe = pol * vbe - (v(nd.base) - v(nd.emitter));
          const dVbc = pol * vbc - (v(nd.base) - v(nd.collector));
          const shiftC = dic[0] * dVbe + dic[1] * dVbc;
          const shiftB = dib[0] * dVbe + dib[1] * dVbc;
          stamp.device(
            [
              [nd.collector, icn - shiftC],
              [nd.base, ibn - shiftB],
              [nd.emitter, -(icn - shiftC) - (ibn - shiftB)],
            ],
            jac,
          );
          break;
        }
        case 'mosfet': {
          const pol = p.channel === 'p' ? -1 : 1;
          const vth = pol * (p.thresholdVolts as number);
          const k = p.k as number;
          // Drain and source swap when the drain is below the source (in the n frame).
          let d = nd.drain;
          let s = nd.source;
          if (pol * (v(d) - v(s)) < 0) [d, s] = [s, d];
          let vgs = pol * (v(nd.gate) - v(s));
          const vds = pol * (v(d) - v(s));
          const [ogs] = this.junctions.get(e.id) ?? [vgs];
          if (limit) vgs = lim(vgs, Math.max(ogs - 1, Math.min(ogs + 1, vgs)));
          this.junctions.set(e.id, [vgs]);
          const vov = vgs - vth;
          let id = 0;
          let gm = 0;
          let gds = 0;
          if (vov > 0) {
            if (vds < vov) {
              id = k * (vov * vds - (vds * vds) / 2);
              gm = k * vds;
              gds = k * (vov - vds);
            } else {
              id = (k / 2) * vov * vov;
              gm = k * vov;
            }
          }
          gds += gmin;
          id += gmin * vds;
          // Into the drain: id(Vg − Vs, Vd − Vs), scaled by pol (dI/dV keeps its sign).
          const shift = gm * (pol * vgs - (v(nd.gate) - v(s)));
          const idn = pol * id - shift;
          stamp.device(
            [
              [d, idn],
              [s, -idn],
            ],
            [
              [d, nd.gate, gm],
              [d, d, gds],
              [d, s, -gm - gds],
              [s, nd.gate, -gm],
              [s, d, -gds],
              [s, s, gm + gds],
            ],
          );
          break;
        }
      }
    }
    for (const node of this.shunts) stamp.g(node, 0, gmin);
    for (const dr of this.options.drives ?? []) {
      if (dr.kind === 'output') {
        const g = 1 / dr.ohms;
        stamp.g(dr.node, 0, g);
        stamp.inject(dr.node, 0, factor * g * dr.volts);
      } else if (dr.pull !== 'none') {
        const g = 1 / dr.pullOhms;
        stamp.g(dr.node, 0, g);
        if (dr.pull === 'up') stamp.inject(dr.node, 0, factor * g * dr.supplyVolts);
      }
    }
    return { a, b };
  }

  /** Newton–Raphson from `x0` at `factor`: the last iterate and whether it converged. */
  newton(x0: number[], factor: number, max: number) {
    let x = [...x0];
    this.junctions = new Map();
    for (let it = 1; it <= max; it++) {
      const { a, b } = this.assemble(x, factor, it > 1);
      const next = circuitSolve(a, b);
      let done = it > 1 && !this.limited;
      for (let i = 0; i < next.length; i++) {
        const tol = i < this.circuit.nodes.length - 1 ? 1e-6 : 1e-12;
        if (Math.abs(next[i] - x[i]) > tol + 1e-3 * Math.max(Math.abs(next[i]), Math.abs(x[i])))
          done = false;
        if (!Number.isFinite(next[i])) return { x, it, ok: false };
      }
      x = next;
      if (done && this.balanced(x, factor)) return { x, it, ok: true };
    }
    return { x, it: max, ok: false };
  }

  /**
   * Whether every node's currents balance at `x` with the devices evaluated there (not at the
   * last linearisation): small steps alone do not prove a junction's current has settled. Each
   * node's sum is measured against the currents meeting there.
   */
  private balanced(x: number[], factor: number): boolean {
    // Source stepping's intermediate points only seed the next; the full circuit is checked.
    if (factor !== 1) return true;
    const n = this.circuit.nodes.length;
    const sum = new Array<number>(n).fill(0);
    const scale = new Array<number>(n).fill(0);
    const add = (node: number, amps: number) => {
      sum[node] += amps;
      scale[node] += Math.abs(amps);
    };
    const v = (node: number) => (node === 0 ? 0 : x[node - 1]);
    const { currents } = this.result(x, 0);
    for (const e of this.circuit.elements)
      for (const [t, i] of Object.entries(currents[e.id])) add(e.nodes[t], i);
    for (const node of this.shunts) add(node, gmin * v(node));
    for (const d of this.options.drives ?? []) {
      if (d.kind === 'output') add(d.node, (v(d.node) - d.volts) / d.ohms);
      else if (d.pull === 'up') add(d.node, (v(d.node) - d.supplyVolts) / d.pullOhms);
      else if (d.pull === 'down') add(d.node, v(d.node) / d.pullOhms);
    }
    for (let i = 1; i < n; i++) if (Math.abs(sum[i]) > 1e-9 + 1e-3 * scale[i]) return false;
    return true;
  }

  /** The node whose current balance is worst at `x`. */
  private worstNode(x: number[]): string {
    const { a, b } = this.assemble(x, 1, false);
    let worst = 0;
    let at = 1;
    for (let i = 0; i < this.circuit.nodes.length - 1; i++) {
      const r = Math.abs(a[i].reduce((s, aij, j) => s + aij * x[j], 0) - b[i]);
      if (r > worst) {
        worst = r;
        at = i + 1;
      }
    }
    return this.circuit.nodes[at];
  }

  /** The number of unknowns (node voltages, then branch currents). */
  get unknowns(): number {
    return this.size;
  }

  /** The DC operating point. Throws `CircuitError`. */
  solve(): CircuitDcResult {
    if (!this.shunts.length) {
      const floating = circuitFloatingNodes(this.circuit, this.options.drives);
      if (floating.length) throw new CircuitError('floating-node', { node: floating[0] });
    }
    const max = this.options.maxIterations ?? 150;
    const start =
      this.options.start?.length === this.size
        ? [...this.options.start]
        : new Array<number>(this.size).fill(0);
    let r = this.newton(start, 1, max);
    let iterations = r.it;
    // Source stepping: bring the sources up in tenths from zero.
    if (!r.ok) {
      let x = new Array<number>(this.size).fill(0);
      for (let step = 1; step <= 10; step++) {
        r = this.newton(x, step / 10, max);
        iterations += r.it;
        if (!r.ok) break;
        x = r.x;
      }
    }
    if (!r.ok) throw new CircuitError('dc-no-convergence', { node: this.worstNode(r.x) });
    return this.result(r.x, iterations);
  }

  result(x: number[], iterations: number): CircuitDcResult {
    const v = (node: number) => (node === 0 ? 0 : x[node - 1]);
    // Null-prototype dictionaries: an ID such as "toString" or "__proto__" is an ordinary key.
    const voltages = Object.create(null) as Record<string, number>;
    this.circuit.nodes.forEach((name, i) => (voltages[name] = v(i)));
    const currents = Object.create(null) as Record<string, Record<string, number>>;
    const switches = this.options.switches ?? {};
    const vt = circuitThermalVolts;
    for (const e of this.circuit.elements) {
      const nd = e.nodes;
      const p = e.params;
      const two = (a: string, b: string, i: number) => (currents[e.id] = { [a]: i, [b]: -i });
      switch (e.kind) {
        case 'resistor':
          two('a', 'b', (v(nd.a) - v(nd.b)) / (p.ohms as number));
          break;
        case 'switch':
          two(
            'a',
            'b',
            (v(nd.a) - v(nd.b)) /
              ((circuitSwitchClosed(switches, e.id) ? p.closedOhms : p.openOhms) as number),
          );
          break;
        case 'capacitor': {
          const c = this.companion;
          if (!c) {
            two('a', 'b', 0);
            break;
          }
          const trap = c.method === 'trapezoid';
          const geq = ((trap ? 2 : 1) * (p.farads as number)) / c.h;
          const dv = v(nd.a) - v(nd.b) - (c.at(nd.a) - c.at(nd.b));
          two('a', 'b', geq * dv - (trap ? (c.current.get(e.id) ?? 0) : 0));
          break;
        }
        case 'isource':
          // Out of `plus` into the circuit: into the element at `minus`.
          two('plus', 'minus', -(p.amps as number));
          break;
        case 'vsource':
          two('plus', 'minus', x[this.branch.get(e.id)!]);
          break;
        case 'inductor':
          two('a', 'b', x[this.branch.get(e.id)!]);
          break;
        case 'diode':
        case 'led': {
          const m =
            e.kind === 'led'
              ? circuitLedModels[p.color as string]
              : { saturationAmps: p.saturationAmps as number, emission: p.emission as number };
          const vd = v(nd.anode) - v(nd.cathode);
          two('anode', 'cathode', junction(m.saturationAmps, m.emission * vt, vd).i + gmin * vd);
          break;
        }
        case 'bjt': {
          const pol = p.polarity === 'pnp' ? -1 : 1;
          const vbe = pol * (v(nd.base) - v(nd.emitter));
          const vbc = pol * (v(nd.base) - v(nd.collector));
          const f = junction(1e-14, vt, vbe).i;
          const r = junction(1e-14, vt, vbc).i;
          const ic = pol * (f - 2 * r - gmin * vbc);
          const ib = pol * (f / (p.beta as number) + r + gmin * (vbe + vbc));
          currents[e.id] = { base: ib, collector: ic, emitter: -ic - ib };
          break;
        }
        case 'mosfet': {
          const pol = p.channel === 'p' ? -1 : 1;
          let d = nd.drain;
          let s = nd.source;
          let sign = 1;
          if (pol * (v(d) - v(s)) < 0) {
            [d, s] = [s, d];
            sign = -1;
          }
          const vov = pol * (v(nd.gate) - v(s)) - pol * (p.thresholdVolts as number);
          const vds = pol * (v(d) - v(s));
          const k = p.k as number;
          let id =
            vov <= 0 ? 0 : vds < vov ? k * (vov * vds - (vds * vds) / 2) : (k / 2) * vov * vov;
          id = pol * (id + gmin * vds) * sign;
          currents[e.id] = { gate: 0, drain: id, source: -id };
          break;
        }
      }
    }
    const inputs = Object.create(null) as Record<string, boolean>;
    for (const dr of this.options.drives ?? [])
      if (dr.kind === 'input') inputs[dr.id] = v(dr.node) > dr.thresholdVolts;
    return { voltages, currents, inputs, unknowns: x, iterations };
  }
}

/** The DC operating point of `circuit`. Throws `CircuitError`. */
export function circuitDcOperatingPoint(
  circuit: Circuit,
  options: CircuitDcOptions = {},
): CircuitDcResult {
  return new CircuitDc(circuit, options).solve();
}

/**
 * A DC sweep: the operating point for each value of one source's `volts` (voltage source) or
 * `amps` (current source), each started from the one before.
 */
export function circuitDcSweep(
  circuit: Circuit,
  source: string,
  values: readonly number[],
  options: CircuitDcOptions = {},
): CircuitDcResult[] {
  const e = circuit.elements.find((x) => x.id === source);
  if (!e || (e.kind !== 'vsource' && e.kind !== 'isource'))
    throw new CircuitError('sweep-source', { element: source });
  const param = e.kind === 'vsource' ? 'volts' : 'amps';
  const out: CircuitDcResult[] = [];
  let start = options.start;
  for (const value of values) {
    const swept: Circuit = {
      ...circuit,
      elements: circuit.elements.map((x) =>
        x === e ? { ...x, params: { ...x.params, [param]: value } } : x,
      ),
    };
    const r = circuitDcOperatingPoint(swept, { ...options, start });
    out.push(r);
    start = r.unknowns;
  }
  return out;
}
