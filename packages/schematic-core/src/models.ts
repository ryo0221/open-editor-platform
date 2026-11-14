/**
 * What a part is to the circuit calculation (docs/cad/circuit-simulation.md, SL2; SL4 solves it).
 * A model names its kind, which of the symbol's pins are its terminals, and its values. A part
 * without a model is left out of the calculation, and the calculation says so.
 *
 * Values are SI units (ohms, farads, henries, volts, amps). The ranges below only refuse values
 * no real part has; they are not tolerances.
 */

export interface SchematicModelParam {
  name: string;
  label: string;
  /** A number in [min, max], or one of `options`. */
  min?: number;
  max?: number;
  options?: readonly string[];
  default: number | string;
}
export interface SchematicModelSpec {
  kind: string;
  label: string;
  /** The terminal names, in the order the calculation reads them. */
  terminals: readonly string[];
  params: readonly SchematicModelParam[];
}

/** A part's circuit model: `terminals` maps each terminal name to a pin number of its symbol. */
export interface SchematicModel {
  kind: string;
  terminals: Record<string, string>;
  params: Record<string, number | string>;
}

const num = (name: string, label: string, min: number, max: number, d: number) =>
  ({ name, label, min, max, default: d }) as const;

export const schematicLedColors = ['red', 'green', 'blue', 'yellow', 'white'] as const;

const specs: SchematicModelSpec[] = [
  {
    kind: 'resistor',
    label: 'Resistor',
    terminals: ['a', 'b'],
    params: [num('ohms', 'Resistance (Ω)', 1e-3, 1e12, 1000)],
  },
  {
    kind: 'capacitor',
    label: 'Capacitor',
    terminals: ['a', 'b'],
    params: [num('farads', 'Capacitance (F)', 1e-15, 10, 1e-7)],
  },
  {
    kind: 'inductor',
    label: 'Inductor',
    terminals: ['a', 'b'],
    params: [num('henries', 'Inductance (H)', 1e-12, 1e3, 1e-5)],
  },
  {
    kind: 'diode',
    label: 'Diode',
    terminals: ['anode', 'cathode'],
    params: [
      num('saturationAmps', 'Saturation current (A)', 1e-20, 1e-3, 1e-14),
      num('emission', 'Emission coefficient', 0.5, 4, 1),
    ],
  },
  {
    kind: 'led',
    label: 'LED',
    terminals: ['anode', 'cathode'],
    params: [{ name: 'color', label: 'Colour', options: schematicLedColors, default: 'red' }],
  },
  {
    kind: 'bjt',
    label: 'Bipolar transistor',
    terminals: ['base', 'collector', 'emitter'],
    params: [
      { name: 'polarity', label: 'Polarity', options: ['npn', 'pnp'], default: 'npn' },
      num('beta', 'Current gain β', 1, 1e4, 100),
    ],
  },
  {
    kind: 'mosfet',
    label: 'MOSFET',
    terminals: ['gate', 'drain', 'source'],
    params: [
      { name: 'channel', label: 'Channel', options: ['n', 'p'], default: 'n' },
      num('thresholdVolts', 'Threshold (V)', -20, 20, 1.5),
      num('k', 'Transconductance k (A/V²)', 1e-6, 1e3, 0.1),
    ],
  },
  {
    kind: 'switch',
    label: 'Switch',
    terminals: ['a', 'b'],
    params: [
      num('closedOhms', 'Closed resistance (Ω)', 1e-6, 1e3, 0.05),
      num('openOhms', 'Open resistance (Ω)', 1e3, 1e15, 1e9),
    ],
  },
  {
    kind: 'vsource',
    label: 'Voltage source',
    terminals: ['plus', 'minus'],
    params: [num('volts', 'Voltage (V)', -1e4, 1e4, 5)],
  },
  {
    // `amps` flows out of `plus` into the circuit and back in at `minus`.
    kind: 'isource',
    label: 'Current source',
    terminals: ['plus', 'minus'],
    params: [num('amps', 'Current (A)', -1e3, 1e3, 1e-3)],
  },
];

/** The model kinds by name. */
export const schematicModelSpecs: ReadonlyMap<string, SchematicModelSpec> = new Map(
  specs.map((s) => [s.kind, s]),
);

/**
 * Why `model` is not a valid model for a symbol with pins `pins`, or undefined when it is:
 * `model-kind`, `model-terminals` (not exactly the kind's terminals, a pin the symbol lacks, or
 * one pin for two terminals) or `model-param` (a missing, unknown or out-of-range value).
 */
export function schematicModelProblem(
  model: SchematicModel,
  pins: ReadonlySet<string>,
): 'model-kind' | 'model-terminals' | 'model-param' | undefined {
  const spec = schematicModelSpecs.get(model.kind);
  if (!spec) return 'model-kind';
  const names = Object.keys(model.terminals);
  const used = Object.values(model.terminals);
  if (
    names.length !== spec.terminals.length ||
    !spec.terminals.every((t) => Object.hasOwn(model.terminals, t)) ||
    !used.every((p) => typeof p === 'string' && pins.has(p)) ||
    new Set(used).size !== used.length
  )
    return 'model-terminals';
  const keys = Object.keys(model.params);
  if (keys.length !== spec.params.length) return 'model-param';
  for (const p of spec.params) {
    if (!Object.hasOwn(model.params, p.name)) return 'model-param';
    const v = model.params[p.name];
    if (p.options) {
      if (typeof v !== 'string' || !p.options.includes(v)) return 'model-param';
    } else if (typeof v !== 'number' || !Number.isFinite(v) || v < p.min! || v > p.max!)
      return 'model-param';
  }
  return undefined;
}

/** A model of `kind` with its default values, on the given terminal pins. */
export function schematicDefaultModel(
  kind: string,
  terminals: Record<string, string>,
): SchematicModel {
  const spec = schematicModelSpecs.get(kind);
  if (!spec) throw new Error(`model-kind:${kind}`);
  return {
    kind,
    terminals: { ...terminals },
    params: Object.fromEntries(spec.params.map((p) => [p.name, p.default])),
  };
}
