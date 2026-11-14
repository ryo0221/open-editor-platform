import { CircuitError, circuitLimits, type Circuit } from './circuit';
import {
  CircuitDc,
  circuitFloatingNodes,
  type CircuitCompanion,
  type CircuitDcOptions,
  type CircuitDcResult,
} from './dc';

/**
 * Transient analysis (docs/cad/circuit-simulation.md, SL5). Capacitors and inductors become
 * their integration companions (trapezoidal, or backward Euler), each step solved by the same
 * Newton–Raphson as the DC point. The step follows a local error estimate (the corrector against
 * a linear predictor), lands exactly on every event time (a switch or a GPIO output changing),
 * and restarts with one backward-Euler step after each. The start is the DC operating point.
 */

/** At `time`, switches and GPIO outputs (drive ID → volts) change to these values. */
export interface CircuitTranEvent {
  time: number;
  switches?: Readonly<Record<string, boolean>>;
  outputs?: Readonly<Record<string, number>>;
}

export interface CircuitTranOptions extends Pick<CircuitDcOptions, 'switches' | 'drives'> {
  /** End time (s). */
  stop: number;
  /** Largest step (s); default stop / 50. */
  maxStep?: number;
  method?: 'trapezoid' | 'euler';
  events?: readonly CircuitTranEvent[];
  /** Relative tolerance of the step's error estimate (default 1e-3). */
  reltol?: number;
  /** Absolute voltage tolerance (default 1e-6 V). */
  vntol?: number;
}

export interface CircuitTranResult {
  times: number[];
  /** Node name → volts at each time. */
  voltages: Record<string, number[]>;
  /** Element ID → terminal → amps into the element at each time. */
  currents: Record<string, Record<string, number[]>>;
  /** Input drive ID → high at each time. */
  inputs: Record<string, boolean[]>;
  /** Steps rejected (error too large or Newton not converging) and shortened. */
  rejected: number;
}

/** The transient response of `circuit` from its DC operating point. Throws `CircuitError`. */
export function circuitTransient(circuit: Circuit, options: CircuitTranOptions): CircuitTranResult {
  const stepper = circuitTransientStepper(circuit, options);
  stepper.advanceTo(options.stop);
  return stepper.result;
}

/**
 * A transient run advanced piece by piece (SL8: a PLC scan at a time), so switches and GPIO
 * outputs can change at times nobody knew in advance. `options.stop` bounds the whole run;
 * `options.events` still apply at their times.
 */
export interface CircuitTranStepper {
  /** Every point so far (the DC start at 0 included). */
  readonly result: CircuitTranResult;
  /** The time reached (s). */
  readonly time: number;
  /** Changes switches and GPIO outputs from now on (an unknown ID throws `tran-event`). */
  change(change: Omit<CircuitTranEvent, 'time'>): void;
  /** Steps on to `until` (at most `stop`). */
  advanceTo(until: number): void;
  /** Input drive ID → high, now. */
  inputs(): Record<string, boolean>;
}

/** A stepper at the DC operating point (time 0). Throws `CircuitError`. */
export function circuitTransientStepper(
  circuit: Circuit,
  options: CircuitTranOptions,
): CircuitTranStepper {
  const stop = options.stop;
  if (!(stop > 0) || !Number.isFinite(stop)) throw new CircuitError('tran-stop');
  const maxStep = options.maxStep ?? stop / 50;
  if (!(maxStep > 0) || !Number.isFinite(maxStep)) throw new CircuitError('tran-step');
  const method = options.method ?? 'trapezoid';
  const reltol = options.reltol ?? 1e-3;
  const vntol = options.vntol ?? 1e-6;
  const minStep = stop * 1e-12;
  if (!(reltol > 0 && reltol < 1) || !(vntol > 0) || !Number.isFinite(vntol))
    throw new CircuitError('tran-tolerance');
  const events = [...(options.events ?? [])].sort((a, b) => a.time - b.time);
  for (const ev of events)
    if (!(ev.time >= 0) || !Number.isFinite(ev.time)) throw new CircuitError('tran-event');
  const ids = new Set(circuit.elements.filter((e) => e.kind === 'switch').map((e) => e.id));
  const outputs = new Set(
    (options.drives ?? []).filter((d) => d.kind === 'output').map((d) => d.id),
  );
  const check = (ev: Omit<CircuitTranEvent, 'time'>) => {
    for (const id of Object.keys(ev.switches ?? {}))
      if (!ids.has(id)) throw new CircuitError('tran-event', { element: id });
    for (const id of Object.keys(ev.outputs ?? {}))
      if (!outputs.has(id)) throw new CircuitError('tran-event', { element: id });
  };
  for (const ev of events) check(ev);

  // Nodes no path holds even with capacitors are refused; nodes only capacitors hold start from
  // a tiny conductance to ground.
  const floating = circuitFloatingNodes(circuit, options.drives, false);
  if (floating.length) throw new CircuitError('floating-node', { node: floating[0] });
  const held = new Set(circuitFloatingNodes(circuit, options.drives, true));

  let switches: Record<string, boolean> = { ...(options.switches ?? {}) };
  let drives = [...(options.drives ?? [])];
  let next = 0;
  /** Applies every event at or before `t`. */
  const take = (ev: Omit<CircuitTranEvent, 'time'>) => {
    switches = { ...switches, ...ev.switches };
    drives = drives.map((d) =>
      d.kind === 'output' && ev.outputs && Object.hasOwn(ev.outputs, d.id)
        ? { ...d, volts: ev.outputs[d.id] }
        : d,
    );
  };
  const apply = (t: number) => {
    let changed = false;
    while (next < events.length && events[next].time <= t + minStep) {
      take(events[next++]);
      changed = true;
    }
    return changed;
  };
  apply(0);
  const solver = new CircuitDc(circuit, { switches, drives });
  solver.shunts = circuit.nodes.flatMap((n, i) => (held.has(n) ? [i] : []));
  const start = solver.solve();
  solver.shunts = [];

  // Null-prototype dictionaries: an element or pin ID such as "toString" is an ordinary key.
  const dict = <T>() => Object.create(null) as Record<string, T>;
  const out: CircuitTranResult = {
    times: [],
    voltages: dict<number[]>(),
    currents: dict<Record<string, number[]>>(),
    inputs: dict<boolean[]>(),
    rejected: 0,
  };
  for (const n of circuit.nodes) out.voltages[n] = [];
  const record = (t: number, r: CircuitDcResult) => {
    out.times.push(t);
    for (const [n, v] of Object.entries(r.voltages)) out.voltages[n].push(v);
    for (const [id, terms] of Object.entries(r.currents)) {
      const o = (out.currents[id] ??= dict<number[]>());
      for (const [term, i] of Object.entries(terms)) (o[term] ??= []).push(i);
    }
    for (const [id, high] of Object.entries(r.inputs)) (out.inputs[id] ??= []).push(high);
  };
  record(0, start);

  const nodeCount = circuit.nodes.length - 1;
  /** A time point: the unknowns and what the next step's companions need from it. */
  interface Point {
    x: readonly number[];
    result: CircuitDcResult;
    current: Map<string, number>;
    voltage: Map<string, number>;
  }
  const pointOf = (r: CircuitDcResult): Point => {
    const current = new Map<string, number>();
    const voltage = new Map<string, number>();
    for (const e of circuit.elements) {
      if (e.kind === 'capacitor') current.set(e.id, r.currents[e.id].a);
      if (e.kind === 'inductor')
        voltage.set(
          e.id,
          (e.nodes.a ? r.unknowns[e.nodes.a - 1] : 0) - (e.nodes.b ? r.unknowns[e.nodes.b - 1] : 0),
        );
    }
    return { x: r.unknowns, result: r, current, voltage };
  };
  /** One step of `h` from `from`, or undefined when Newton does not converge. */
  const advance = (from: Point, h: number, m: 'euler' | 'trapezoid'): Point | undefined => {
    const x0 = from.x;
    solver.companion = {
      h,
      method: m,
      prev: x0,
      at: (node: number) => (node === 0 ? 0 : x0[node - 1]),
      current: from.current,
      voltage: from.voltage,
    } satisfies CircuitCompanion;
    solver.options = { switches, drives };
    const r = solver.newton([...x0], 1, 50);
    return r.ok ? pointOf(solver.result(r.x, r.it)) : undefined;
  };
  /** The largest node difference between `a` and `b` over its tolerance. */
  const error = (a: readonly number[], b: readonly number[]) => {
    let err = 0;
    for (let i = 0; i < nodeCount; i++) {
      const tol = vntol + reltol * Math.max(Math.abs(a[i]), Math.abs(b[i]));
      err = Math.max(err, Math.abs(a[i] - b[i]) / tol);
    }
    return err;
  };
  const shorter = (h: number) => {
    out.rejected++;
    if (!(h >= minStep)) throw new CircuitError('tran-step-too-small');
    return h;
  };

  let prev = pointOf(start);
  let before: { x: readonly number[]; h: number } | undefined;
  let restart = true;
  let h = maxStep / 10;
  let t = 0;
  let steps = 0;
  let last = start;
  const advanceTo = (until: number) => {
    if (!(until <= stop + minStep) || !Number.isFinite(until)) throw new CircuitError('tran-stop');
    while (t < until - minStep) {
      const breakAt = next < events.length ? Math.min(events[next].time, until) : until;
      let hh = Math.min(h, maxStep, breakAt - t);
      // Do not leave a sliver before the event or the end.
      if (breakAt - (t + hh) < 0.1 * hh) hh = breakAt - t;
      if (!(hh >= minStep)) throw new CircuitError('tran-step-too-small');
      let points: [number, Point][];
      let err: number;
      if (restart) {
        // After the start or an event there is no history to predict from: one Euler step against
        // two of half the length (step doubling), keeping the two halves.
        const full = advance(prev, hh, 'euler');
        const half = full && advance(prev, hh / 2, 'euler');
        const two = half && advance(half, hh / 2, 'euler');
        if (!two) {
          h = shorter(hh / 4);
          continue;
        }
        err = error(two.x, full.x);
        if (err > 1) {
          h = shorter(hh * Math.max(0.1, 0.9 / Math.sqrt(err)));
          continue;
        }
        points = [
          [hh / 2, half],
          [hh, two],
        ];
        before = { x: half.x, h: hh / 2 };
      } else {
        const r = advance(prev, hh, method);
        if (!r) {
          h = shorter(hh / 4);
          continue;
        }
        // The corrector against a straight line through the last two points.
        const b = before!;
        const pred = prev.x.map((x, i) => x + ((x - b.x[i]) * hh) / b.h);
        err = error(r.x, pred);
        if (err > 1) {
          h = shorter(hh * Math.max(0.25, 0.9 / Math.sqrt(err)));
          continue;
        }
        points = [[hh, r]];
        before = { x: prev.x, h: hh };
      }
      const t0 = t;
      for (const [dt, p] of points) {
        if (++steps > circuitLimits.steps) throw new CircuitError('limit-steps');
        t = Math.abs(t0 + dt - breakAt) <= minStep ? breakAt : t0 + dt;
        record(t, p.result);
        last = p.result;
        prev = p;
      }
      restart = false;
      h = hh * Math.min(2, 0.9 / Math.sqrt(Math.max(err, 1e-4)));
      if (apply(t)) {
        // A switch or an output changed: start again with Euler steps, small.
        restart = true;
        before = undefined;
        h = maxStep / 10;
      }
    }
  };
  return {
    result: out,
    get time() {
      return t;
    },
    change(ev) {
      check(ev);
      take(ev);
      // The circuit changed now: start again with small Euler steps.
      restart = true;
      before = undefined;
      h = maxStep / 10;
    },
    advanceTo,
    inputs: () => Object.assign(dict<boolean>(), last.inputs),
  };
}

/**
 * A transient result as CSV: a `time` column, then the chosen node voltages (`V(<node>)`) and
 * element currents (`I(<id>.<terminal>)`); every node voltage when nothing is chosen.
 */
export function circuitTranCsv(
  result: CircuitTranResult,
  columns: { nodes?: readonly string[]; currents?: readonly [string, string][] } = {},
): string {
  const nodes = columns.nodes ?? Object.keys(result.voltages);
  const cur = columns.currents ?? [];
  const quote = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const series = [
    ...nodes.map((n) => {
      const v = result.voltages[n];
      if (!v) throw new CircuitError('csv-column', { node: n });
      return { label: `V(${n})`, values: v };
    }),
    ...cur.map(([id, term]) => {
      const v = result.currents[id]?.[term];
      if (!v) throw new CircuitError('csv-column', { element: id });
      return { label: `I(${id}.${term})`, values: v };
    }),
  ];
  const lines = [['time', ...series.map((s) => s.label)].map(quote).join(',')];
  result.times.forEach((t, i) =>
    lines.push([t, ...series.map((s) => s.values[i])].map((x) => String(x)).join(',')),
  );
  return `${lines.join('\n')}\n`;
}
