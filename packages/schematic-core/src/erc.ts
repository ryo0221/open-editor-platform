import type { SchematicDocument, SchematicPinType } from './model';
import { schematicNets, type SchematicNet, type SchematicPinRef } from './nets';

/**
 * The electrical rules check (docs/cad/circuit-simulation.md, SL2), on the nets the drawing
 * makes and each pin's electrical type:
 * - `erc-output-conflict` (error): two or more `output` pins, or an `output` and a `power-out`,
 *   drive one net;
 * - `erc-power-conflict` (error): two or more `power-out` pins drive one net;
 * - `erc-no-driver` (warning): a net of two or more pins, all `input`, not on a power port;
 * - `erc-power-undriven` (warning): a net of two or more pins with `power-in` pins but no
 *   `power-out` pin and no power port;
 * - `erc-unconnected` (warning): a pin alone on its net (not on a power port), unless its type is
 *   `no-connect` or its part lists it in `noConnect`;
 * - `erc-no-connect-connected` (warning): a pin listed in `noConnect` that is connected after all.
 * A duplicate reference is not an ERC finding: validation refuses the document (`ref-duplicate`).
 * `tristate`, `open-collector`, `bidirectional` and `passive` pins never conflict.
 */
export type SchematicErcCode =
  | 'erc-output-conflict'
  | 'erc-power-conflict'
  | 'erc-no-driver'
  | 'erc-power-undriven'
  | 'erc-unconnected'
  | 'erc-no-connect-connected';

export interface SchematicErcIssue {
  code: SchematicErcCode;
  severity: 'error' | 'warning';
  /** The net's name. */
  net: string;
  /** The pins the finding is about. */
  pins: SchematicPinRef[];
}

export function schematicErc(
  doc: SchematicDocument,
  nets: readonly SchematicNet[] = schematicNets(doc),
): SchematicErcIssue[] {
  const parts = new Map(doc.parts.map((p) => [p.id, p]));
  const symbols = new Map(doc.symbols.map((s) => [s.id, s]));
  const typeOf = ([part, number]: SchematicPinRef): SchematicPinType => {
    const p = parts.get(part);
    const pin = p && symbols.get(p.symbol)?.pins.find((q) => q.number === number);
    return pin?.type ?? 'passive';
  };
  const marked = ([part, number]: SchematicPinRef) =>
    parts.get(part)?.noConnect?.includes(number) ?? false;
  const out: SchematicErcIssue[] = [];
  const issue = (
    code: SchematicErcCode,
    severity: 'error' | 'warning',
    net: SchematicNet,
    pins: SchematicPinRef[],
  ) => out.push({ code, severity, net: net.name, pins });

  for (const net of nets) {
    const of = (t: SchematicPinType) => net.pins.filter((p) => typeOf(p) === t);
    const outputs = of('output');
    const powerOuts = of('power-out');
    if (outputs.length >= 2 || (outputs.length >= 1 && powerOuts.length >= 1))
      issue('erc-output-conflict', 'error', net, [...outputs, ...powerOuts]);
    else if (powerOuts.length >= 2) issue('erc-power-conflict', 'error', net, powerOuts);
    const alone = net.pins.length === 1 && !net.power;
    // A pin alone is reported once, as unconnected.
    if (!alone && !net.power && net.pins.every((p) => typeOf(p) === 'input'))
      issue('erc-no-driver', 'warning', net, net.pins);
    const powerIns = of('power-in');
    if (!alone && powerIns.length && !powerOuts.length && !net.power)
      issue('erc-power-undriven', 'warning', net, powerIns);
    for (const p of net.pins) {
      if (marked(p)) {
        if (!alone) issue('erc-no-connect-connected', 'warning', net, [p]);
      } else if (alone && typeOf(p) !== 'no-connect') issue('erc-unconnected', 'warning', net, [p]);
    }
  }
  return out;
}
