import {
  CircuitError,
  circuitDcOperatingPoint,
  circuitGroundTest,
  circuitTransient,
  schematicCircuit,
  type CircuitDrive,
  type CircuitTranEvent,
} from '@editor-platform/circuit-sim-core';
import { schematicNets, type SchematicDocument } from '@editor-platform/schematic-core';

/**
 * SL5b: the circuit calculation as the schematic screen runs it (docs/cad/circuit-simulation.md,
 * SL5). Settings are the screen's, not the document's: which named nets are GPIO pins (an output
 * at a level, an input with a pull resistor) and when switches are pressed. The result is plain
 * data, so a Worker can send it back.
 */

/** A Raspberry Pi style 3.3 V GPIO (output resistance, pull resistors, input threshold). */
export const schematicSimGpio = Object.freeze({
  volts: 3.3,
  outputOhms: 40,
  pullOhms: 50_000,
  thresholdVolts: 1.65,
});

export type SchematicSimPin =
  | {
      kind: 'output';
      high: boolean;
      /** Transient: the level flips at this time (s). */ toggleAt?: number;
    }
  | { kind: 'input'; pull: 'up' | 'down' | 'none' };

export interface SchematicSimSettings {
  mode: 'dc' | 'tran';
  /** Transient end time (s). */
  stop: number;
  /** Named net → GPIO pin. */
  pins: Record<string, SchematicSimPin>;
  /** Switch part ID → pressed: in DC, and while [from, to) in a transient. */
  presses: Record<string, { pressed: boolean; from?: number; to?: number }>;
}

export const schematicSimDefaults: SchematicSimSettings = Object.freeze({
  mode: 'dc',
  stop: 0.01,
  pins: {},
  presses: {},
}) as SchematicSimSettings;

export interface SchematicSimResult {
  mode: 'dc' | 'tran';
  /** [0] for DC. */
  times: number[];
  /** Net name → volts at each time (ground nets are 0). */
  voltages: Record<string, number[]>;
  /**
   * Part ID (or `rail:<name>`) → amps at each time into its first terminal: a resistor's `a`, a
   * diode's or LED's anode, a BJT's collector, a MOSFET's drain, a source's `plus`.
   */
  currents: Record<string, number[]>;
  /** Input pin net → high at each time. */
  inputs: Record<string, boolean[]>;
  /** Parts not in the calculation, and why. */
  left: { ref: string; reason: string }[];
}

const mainTerminal: Record<string, string> = {
  resistor: 'a',
  capacitor: 'a',
  inductor: 'a',
  switch: 'a',
  diode: 'anode',
  led: 'anode',
  bjt: 'collector',
  mosfet: 'drain',
  vsource: 'plus',
  isource: 'plus',
};

/** Runs the calculation. Throws `CircuitError` (its `code` says why). */
export function schematicSimulate(
  doc: SchematicDocument,
  settings: SchematicSimSettings,
): SchematicSimResult {
  const nets = schematicNets(doc);
  const circuit = schematicCircuit(doc, nets);
  const g = schematicSimGpio;
  const drives: CircuitDrive[] = [];
  const events: CircuitTranEvent[] = [];
  for (const [net, pin] of Object.entries(settings.pins).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const node = circuit.nodes.indexOf(net);
    // A pin on a net the calculation does not use (nothing modelled on it) drives nothing.
    if (node <= 0) continue;
    const id = `pin:${net}`;
    if (pin.kind === 'output') {
      drives.push({ id, node, kind: 'output', volts: pin.high ? g.volts : 0, ohms: g.outputOhms });
      if (settings.mode === 'tran' && pin.toggleAt !== undefined)
        events.push({ time: pin.toggleAt, outputs: { [id]: pin.high ? 0 : g.volts } });
    } else
      drives.push({
        id,
        node,
        kind: 'input',
        pull: pin.pull,
        pullOhms: g.pullOhms,
        supplyVolts: g.volts,
        thresholdVolts: g.thresholdVolts,
      });
  }
  const switches: Record<string, boolean> = {};
  const ids = new Set(circuit.elements.filter((e) => e.kind === 'switch').map((e) => e.id));
  for (const [part, p] of Object.entries(settings.presses)) {
    if (!ids.has(part)) continue;
    if (settings.mode === 'dc') {
      switches[part] = p.pressed;
      continue;
    }
    // No time at all (cleared fields, or only the DC tick): not pressed in this run.
    if (p.from === undefined && p.to === undefined) {
      switches[part] = false;
      continue;
    }
    const from = p.from ?? 0;
    // A release at or before the press is an empty interval: refused, not read as held.
    if (p.to !== undefined && p.to <= Math.max(from, 0))
      throw new CircuitError('press-interval', {
        element: circuit.elements.find((e) => e.id === part)?.ref ?? part,
      });
    switches[part] = from <= 0;
    if (from > 0) events.push({ time: from, switches: { [part]: true } });
    if (p.to !== undefined) events.push({ time: p.to, switches: { [part]: false } });
  }
  const main = (id: string, terms: Record<string, number[]>) => {
    const kind = circuit.elements.find((e) => e.id === id)?.kind;
    return terms[mainTerminal[kind ?? ''] ?? Object.keys(terms)[0]];
  };
  // Ground by the same rule as the circuit (never by splitting the joined node name).
  const isGround = circuitGroundTest(doc);
  const out = (
    times: number[],
    voltages: Record<string, number[]>,
    currents: Record<string, Record<string, number[]>>,
    inputs: Record<string, boolean[]>,
  ): SchematicSimResult => {
    // Own properties only: a net may be called `__proto__`.
    const v: Record<string, number[]> = Object.fromEntries(
      nets.map((n) => [
        n.name,
        isGround(n)
          ? times.map(() => 0)
          : Object.hasOwn(voltages, n.name)
            ? voltages[n.name]
            : times.map(() => Number.NaN),
      ]),
    );
    return {
      mode: settings.mode,
      times,
      voltages: v,
      currents: Object.fromEntries(Object.entries(currents).map(([id, t]) => [id, main(id, t)])),
      inputs: Object.fromEntries(Object.entries(inputs).map(([id, x]) => [id.slice(4), x])),
      left: circuit.left,
    };
  };
  if (settings.mode === 'dc') {
    const r = circuitDcOperatingPoint(circuit, { switches, drives });
    const wrap = <T>(o: Record<string, T>) =>
      Object.fromEntries(Object.entries(o).map(([k, x]) => [k, [x]]));
    return out(
      [0],
      wrap(r.voltages),
      Object.fromEntries(Object.entries(r.currents).map(([id, t]) => [id, wrap(t)])),
      wrap(r.inputs),
    );
  }
  const r = circuitTransient(circuit, { stop: settings.stop, switches, drives, events });
  return out(r.times, r.voltages, r.currents, r.inputs);
}

/** The value at `t` (linear between points). */
export function schematicSimAt(times: readonly number[], values: readonly number[], t: number) {
  if (!times.length) return Number.NaN;
  if (t <= times[0]) return values[0];
  for (let i = 1; i < times.length; i++)
    if (t <= times[i]) {
      const f = (t - times[i - 1]) / (times[i] - times[i - 1] || 1);
      return values[i - 1] + f * (values[i] - values[i - 1]);
    }
  return values[values.length - 1];
}

/** CSV of the chosen nets' voltages and parts' currents over time. */
export function schematicSimCsv(
  result: SchematicSimResult,
  nets: readonly string[],
  parts: readonly { id: string; ref: string }[] = [],
): string {
  const quote = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const cols = [
    ...nets
      .filter((n) => result.voltages[n])
      .map((n) => ({ label: `V(${n})`, v: result.voltages[n] })),
    ...parts
      .filter((p) => result.currents[p.id])
      .map((p) => ({ label: `I(${p.ref})`, v: result.currents[p.id] })),
  ];
  const lines = [['time', ...cols.map((c) => c.label)].map(quote).join(',')];
  result.times.forEach((t, i) => lines.push([t, ...cols.map((c) => c.v[i])].join(',')));
  return `${lines.join('\n')}\n`;
}

export interface SchematicSimRequest {
  id: number;
  doc: SchematicDocument;
  settings: SchematicSimSettings;
}
export type SchematicSimResponse =
  | { id: number; status: 'done'; result: SchematicSimResult }
  | { id: number; status: 'refused'; code: string; node?: string; element?: string }
  | { id: number; status: 'failed'; message: string };

/** The answer to one request (in the Worker, or here when no Worker can start). */
export function schematicSimAnswer(request: SchematicSimRequest): SchematicSimResponse {
  try {
    return {
      id: request.id,
      status: 'done',
      result: schematicSimulate(request.doc, request.settings),
    };
  } catch (e) {
    if (e instanceof CircuitError)
      return { id: request.id, status: 'refused', code: e.code, ...e.detail };
    return {
      id: request.id,
      status: 'failed',
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * One calculation at a time in a Worker, so the screen keeps working. `cancel` terminates the
 * Worker (the next run starts a new one). Where no Worker can start, it runs on this thread.
 */
export class SchematicSimJobs {
  private worker: Worker | undefined;
  private broken = false;
  private sequence = 0;
  private pending: { id: number; resolve(r: SchematicSimResponse): void } | undefined;

  constructor(private readonly start: () => Worker = defaultWorker) {}

  run(doc: SchematicDocument, settings: SchematicSimSettings): Promise<SchematicSimResponse> {
    this.cancel();
    const id = ++this.sequence;
    const request: SchematicSimRequest = { id, doc, settings };
    const worker = this.ensure();
    if (!worker) return Promise.resolve(schematicSimAnswer(request));
    return new Promise((resolve) => {
      this.pending = { id, resolve };
      try {
        worker.postMessage(request);
      } catch (e) {
        this.pending = undefined;
        resolve({ id, status: 'failed', message: e instanceof Error ? e.message : String(e) });
      }
    });
  }

  /** Stops a running calculation; its promise answers `failed` with `cancelled`. */
  cancel() {
    const p = this.pending;
    if (!p) return;
    this.pending = undefined;
    this.worker?.terminate();
    this.worker = undefined;
    p.resolve({ id: p.id, status: 'failed', message: 'cancelled' });
  }

  dispose() {
    this.cancel();
    this.worker?.terminate();
    this.worker = undefined;
    this.broken = true;
  }

  private ensure(): Worker | undefined {
    if (this.worker || this.broken) return this.worker;
    try {
      const worker = this.start();
      worker.onmessage = ({ data }: MessageEvent<SchematicSimResponse>) => {
        const p = this.pending;
        if (!p || p.id !== data.id) return;
        this.pending = undefined;
        p.resolve(data);
      };
      worker.onerror = (event) => {
        event.preventDefault();
        worker.terminate();
        if (this.worker === worker) this.worker = undefined;
        this.broken = true;
        const p = this.pending;
        this.pending = undefined;
        p?.resolve({ id: p.id, status: 'failed', message: 'worker-failed' });
      };
      this.worker = worker;
    } catch {
      this.broken = true;
    }
    return this.worker;
  }
}

const defaultWorker = () =>
  new Worker(new URL('./simulate-worker.ts', import.meta.url), { type: 'module' });
