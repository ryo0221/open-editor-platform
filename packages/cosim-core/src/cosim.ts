import {
  circuitGroundTest,
  circuitTransientStepper,
  schematicCircuit,
  type Circuit,
  type CircuitDrive,
  type CircuitTranStepper,
} from '@editor-platform/circuit-sim-core';
import {
  ladderInitialState,
  ladderScan,
  ladderVariableMap,
  validateLadder,
  type LadderDocument,
  type LadderState,
  type LadderValue,
} from '@editor-platform/ladder-core';
import { schematicNets, type SchematicDocument } from '@editor-platform/schematic-core';

/**
 * Co-simulation of a ladder program and a schematic (docs/cad/circuit-simulation.md, SL8,
 * SL-U6). Ladder variables are bound to GPIO nets of the schematic: an input reads its net's
 * voltage against the GPIO threshold, an output drives its net through the GPIO's output
 * resistance. Time alternates by the program's scan period, as a PLC updates its I/O: read the
 * inputs from the circuit → one scan → set the outputs → advance the circuit's transient by one
 * period. Outputs (and switches pressed by hand) change only at the period boundaries.
 */

/** A 3.3 V GPIO as the schematic screen models it (SL5b `schematicSimGpio`). */
export const cosimGpio = Object.freeze({
  volts: 3.3,
  outputOhms: 40,
  pullOhms: 50_000,
  thresholdVolts: 1.65,
});

export interface CosimBinding {
  /** A BOOL ladder variable: an input for `kind` input, an output for `kind` output. */
  variable: string;
  /** A named net of the schematic that the calculation uses. */
  net: string;
  kind: 'input' | 'output';
  /** Input pin's pull resistor (default up, as a button to ground needs). */
  pull?: 'up' | 'down' | 'none';
  /** The variable is TRUE while the net is low (a button to ground), or drives it low. */
  activeLow?: boolean;
}

/** Initial safety limits (refused as `limit-*`); not performance promises. */
export const cosimLimits = Object.freeze({ bindings: 64, seconds: 120 });

export class CosimError extends Error {
  constructor(
    readonly code: string,
    readonly detail: { variable?: string; net?: string } = {},
  ) {
    super(code);
  }
}

/** One scan's result: the ladder's state after it, the circuit at the end of its period. */
export interface CosimFrame {
  scan: number;
  /** Seconds at the end of the period. */
  time: number;
  ladder: LadderState;
  /** Node and coil ID → power leaving it, in this scan. */
  power: Record<string, boolean>;
  /** Net name → volts at the end of the period (ground nets 0). */
  voltages: Record<string, number>;
  /** Part ID → amps into its first terminal (a resistor's `a`, an LED's anode, …). */
  currents: Record<string, number>;
}

/** What changes before a scan: switches pressed by hand, and inputs or forcing of unbound variables. */
export interface CosimChange {
  switches?: Readonly<Record<string, boolean>>;
  inputs?: Readonly<Record<string, LadderValue>>;
  forced?: Readonly<Record<string, LadderValue>>;
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
const dict = <T>() => Object.create(null) as Record<string, T>;

/**
 * Checks bindings against both documents. Throws `CosimError`: `ladder-invalid`,
 * `cosim-variable` (not a BOOL input/output of the program, or bound twice), `cosim-net` (not
 * a net the calculation uses, ground, or bound twice), `limit-bindings`.
 */
export function cosimCheck(
  circuit: Circuit,
  ladder: LadderDocument,
  bindings: readonly CosimBinding[],
) {
  if (validateLadder(ladder).some((d) => d.severity === 'error'))
    throw new CosimError('ladder-invalid');
  if (bindings.length > cosimLimits.bindings) throw new CosimError('limit-bindings');
  const vars = ladderVariableMap(ladder);
  const variables = new Set<string>();
  const nets = new Set<string>();
  for (const b of bindings) {
    const v = vars.get(b.variable);
    if (!v || v.type !== 'BOOL' || v.role !== b.kind || variables.has(v.name.toUpperCase()))
      throw new CosimError('cosim-variable', { variable: b.variable });
    variables.add(v.name.toUpperCase());
    if (circuit.nodes.indexOf(b.net) <= 0 || nets.has(b.net))
      throw new CosimError('cosim-net', { net: b.net, variable: b.variable });
    nets.add(b.net);
  }
}

/**
 * A co-simulation advanced a scan at a time. Throws `CosimError` or `CircuitError` (the circuit
 * cannot be calculated) when made, and `CircuitError` from `scan` when the transient fails.
 */
export class Cosim {
  readonly circuit: Circuit;
  private readonly stepper: CircuitTranStepper;
  private state: LadderState;
  private readonly ground: Set<string>;
  private readonly declared: Map<string, string>;
  private inputs: Record<string, LadderValue> = dict();
  private forced: Record<string, LadderValue> = dict();

  constructor(
    readonly schematic: SchematicDocument,
    readonly ladder: LadderDocument,
    readonly bindings: readonly CosimBinding[],
    switches: Readonly<Record<string, boolean>> = {},
  ) {
    const nets = schematicNets(schematic);
    this.circuit = schematicCircuit(schematic, nets);
    cosimCheck(this.circuit, ladder, bindings);
    const isGround = circuitGroundTest(schematic);
    this.ground = new Set(nets.filter(isGround).map((n) => n.name));
    const vars = ladderVariableMap(ladder);
    this.declared = new Map(bindings.map((b) => [b.variable, vars.get(b.variable)!.name]));
    this.state = ladderInitialState(ladder);
    const g = cosimGpio;
    const drives: CircuitDrive[] = bindings.map((b) => {
      const node = this.circuit.nodes.indexOf(b.net);
      return b.kind === 'output'
        ? {
            id: this.driveId(b),
            node,
            kind: 'output',
            volts: this.level(b, this.state.values[this.declared.get(b.variable)!] === true),
            ohms: g.outputOhms,
          }
        : {
            id: this.driveId(b),
            node,
            kind: 'input',
            pull: b.pull ?? 'up',
            pullOhms: g.pullOhms,
            supplyVolts: g.volts,
            thresholdVolts: g.thresholdVolts,
          };
    });
    this.stepper = circuitTransientStepper(this.circuit, {
      stop: cosimLimits.seconds,
      maxStep: ladder.scanMs / 1000,
      switches: { ...switches },
      drives,
    });
  }

  private driveId(b: CosimBinding) {
    return `pin:${b.net}`;
  }
  private level(b: CosimBinding, on: boolean) {
    return on !== !!b.activeLow ? cosimGpio.volts : 0;
  }
  /** Seconds simulated so far. */
  get time() {
    return this.stepper.time;
  }
  /** The transient points so far (for waveforms). */
  get transient() {
    return this.stepper.result;
  }

  /**
   * One scan: switches and unbound inputs change (from now on), the bound inputs are read from
   * the circuit, the ladder scans, its outputs drive the circuit, and the circuit advances one
   * period. Inputs and forcing given here hold until changed (an undefined value releases).
   */
  scan(change: CosimChange = {}): CosimFrame {
    const ladder = this.ladder;
    const vars = ladderVariableMap(ladder);
    if (change.switches) this.stepper.change({ switches: change.switches });
    const merge = (
      into: Record<string, LadderValue>,
      from?: Readonly<Record<string, LadderValue>>,
    ) => {
      const out = Object.assign(dict<LadderValue>(), into);
      for (const [name, v] of Object.entries(from ?? {})) {
        // Names compare without case: one entry per variable, under its declared spelling.
        const k = vars.get(name)?.name ?? name;
        if (v === undefined) delete out[k];
        else out[k] = v;
      }
      return out;
    };
    this.inputs = merge(this.inputs, change.inputs);
    this.forced = merge(this.forced, change.forced);
    // Bound inputs come from the circuit and win over typed ones.
    const read = this.stepper.inputs();
    const inputs = Object.assign(dict<LadderValue>(), this.inputs);
    for (const b of this.bindings)
      if (b.kind === 'input')
        inputs[this.declared.get(b.variable)!] = read[this.driveId(b)] !== !!b.activeLow;
    const { state, power } = ladderScan(ladder, this.state, inputs, this.forced);
    this.state = state;
    const outputs: Record<string, number> = {};
    for (const b of this.bindings)
      if (b.kind === 'output')
        outputs[this.driveId(b)] = this.level(
          b,
          state.values[this.declared.get(b.variable)!] === true,
        );
    if (Object.keys(outputs).length) this.stepper.change({ outputs });
    this.stepper.advanceTo(this.stepper.time + ladder.scanMs / 1000);
    return { scan: state.scans, time: this.stepper.time, ladder: state, power, ...this.now() };
  }

  /** The circuit now: net voltages (ground 0) and parts' main currents. */
  private now() {
    const r = this.stepper.result;
    const voltages = dict<number>();
    for (const n of this.ground) voltages[n] = 0;
    for (const [n, v] of Object.entries(r.voltages)) voltages[n] = v[v.length - 1];
    const currents = dict<number>();
    for (const e of this.circuit.elements) {
      const terms = r.currents[e.id];
      if (!terms) continue;
      const t = terms[mainTerminal[e.kind] ?? Object.keys(terms)[0]];
      if (t) currents[e.id] = t[t.length - 1];
    }
    return { voltages, currents };
  }
}

/** Runs `scans` scans; `changes[k]` applies before scan k + 1 (0-based). */
export function cosimRun(
  schematic: SchematicDocument,
  ladder: LadderDocument,
  bindings: readonly CosimBinding[],
  scans: number,
  changes: Readonly<Record<number, CosimChange>> = {},
): CosimFrame[] {
  const sim = new Cosim(schematic, ladder, bindings);
  const frames: CosimFrame[] = [];
  for (let k = 0; k < scans; k++) frames.push(sim.scan(changes[k]));
  return frames;
}
