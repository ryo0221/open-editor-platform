import {
  schematicModelSpecs,
  schematicNets,
  type SchematicDocument,
  type SchematicNet,
} from '@editor-platform/schematic-core';

/**
 * The circuit a schematic makes (docs/cad/circuit-simulation.md, SL4): one node per net, ground
 * as node 0, and one element per part with a model. Parts without a model are left out (and
 * listed); a rail power port whose name reads as a voltage ("3V3", "5V", "1V8", "+12V") is an
 * ideal source from ground.
 */
export type CircuitElementKind =
  | 'resistor'
  | 'capacitor'
  | 'inductor'
  | 'diode'
  | 'led'
  | 'bjt'
  | 'mosfet'
  | 'switch'
  | 'vsource'
  | 'isource';

export interface CircuitElement {
  /** The part's ID, or `rail:<name>` for a rail power port (`rail:<name>#2` if a part has that ID). */
  id: string;
  /** The part's reference, or the rail's name. */
  ref: string;
  kind: CircuitElementKind;
  /** Terminal name (the model's) → node index. */
  nodes: Record<string, number>;
  params: Record<string, number | string>;
}

export interface CircuitLeftOut {
  ref: string;
  reason: 'no-model' | 'model-terminal';
}

export interface Circuit {
  /** Node names by index; node 0 is ground. */
  nodes: string[];
  elements: CircuitElement[];
  /** Parts not in the circuit, and why. */
  left: CircuitLeftOut[];
}

/** A circuit the calculation refuses; `code` names why, `node` / `element` where. */
export class CircuitError extends Error {
  constructor(
    readonly code: string,
    readonly detail: { node?: string; element?: string } = {},
  ) {
    super(code);
  }
}

/** Initial safety limits (refused as `limit-*`); not performance promises. */
export const circuitLimits = Object.freeze({ nodes: 500, elements: 2000, steps: 200_000 });

/** "3V3" → 3.3, "5V" → 5, "1V8" → 1.8, "+12V" → 12, "-5V" → −5; anything else undefined. */
export function circuitRailVolts(name: string): number | undefined {
  const m = /^([+-]?)(\d+)V(\d*)$/.exec(name);
  if (!m) return undefined;
  const v = Number(`${m[2]}.${m[3] || '0'}`);
  return m[1] === '-' ? -v : v;
}

/**
 * Which nets are ground (node 0): a net any of whose names is a ground port's (`GND` when the
 * drawing has no ground port). Its display name may be another name.
 */
export function circuitGroundTest(doc: SchematicDocument): (net: SchematicNet) => boolean {
  const groundNames = new Set(doc.powers.filter((p) => p.style === 'ground').map((p) => p.name));
  if (groundNames.size === 0) groundNames.add('GND');
  return (n) => groundNames.has(n.name) || n.names.some((x) => groundNames.has(x));
}

/**
 * The circuit of a schematic. Throws `CircuitError` (`no-ground`, `net-name-duplicate`,
 * `rail-conflict`, `limit-*`).
 */
export function schematicCircuit(
  doc: SchematicDocument,
  nets: readonly SchematicNet[] = schematicNets(doc),
): Circuit {
  const isGround = circuitGroundTest(doc);
  const grounds = nets.filter(isGround);
  if (grounds.length === 0) throw new CircuitError('no-ground');
  const ground = [...new Set(grounds.map((n) => n.name))].sort().join('/');
  // Pin → net (its index; '' for ground). Nodes are made only for nets a modelled part uses, so a pin
  // of a part left out (an IC without a model) does not make a floating node.
  const netOf = new Map<string, string>();
  nets.forEach((n, i) => {
    for (const [part, pin] of n.pins)
      netOf.set(`${part}\u0000${pin}`, isGround(n) ? '' : String(i));
  });
  const nodes = [ground];
  const index = new Map<string, number>([['', 0]]);
  const nodeOf = (net: string) => {
    let i = index.get(net);
    if (i === undefined) {
      i = nodes.length;
      nodes.push(nets[Number(net)].name);
      index.set(net, i);
    }
    return i;
  };
  const elements: CircuitElement[] = [];
  const left: CircuitLeftOut[] = [];
  const kept: { p: (typeof doc.parts)[number]; kind: string; terminals: Record<string, string> }[] =
    [];
  for (const p of doc.parts) {
    const model = p.model;
    if (!model) {
      left.push({ ref: p.ref, reason: 'no-model' });
      continue;
    }
    const spec = schematicModelSpecs.get(model.kind);
    const terminals: Record<string, string> = {};
    let ok = !!spec;
    for (const t of spec?.terminals ?? []) {
      const net = netOf.get(`${p.id}\u0000${model.terminals[t]}`);
      if (net === undefined) ok = false;
      else terminals[t] = net;
    }
    if (!ok) left.push({ ref: p.ref, reason: 'model-terminal' });
    else kept.push({ p, kind: model.kind, terminals });
  }
  // Nodes in net order (as `schematicNets` lists them), so results read in a stable order.
  const used = new Set(kept.flatMap((k) => Object.values(k.terminals)));
  nets.forEach((_, i) => used.has(String(i)) && nodeOf(String(i)));
  if (nodes.length > circuitLimits.nodes) throw new CircuitError('limit-nodes');
  // Results are keyed by net name: two nets the calculation uses must not share one (a label
  // named like another net's automatic name).
  const seen = new Set<string>();
  for (const n of nodes) {
    if (seen.has(n)) throw new CircuitError('net-name-duplicate', { node: n });
    seen.add(n);
  }
  for (const { p, kind, terminals } of kept)
    elements.push({
      id: p.id,
      ref: p.ref,
      kind: kind as CircuitElementKind,
      nodes: Object.fromEntries(Object.entries(terminals).map(([t, net]) => [t, nodeOf(net)])),
      params: { ...p.model!.params },
    });
  // Rail power ports: one ideal source per net in use that a voltage-named rail names, found by the
  // net's names (not only its display name). Two rails of different voltages on one net (or a
  // voltage rail on ground) are refused as `rail-conflict`.
  const rails = new Set(doc.powers.filter((p) => p.style === 'rail').map((p) => p.name));
  const partIds = new Set(doc.parts.map((p) => p.id));
  const railIds = new Set<string>();
  const railNodes = new Map<number, { name: string; volts: number }>();
  for (const name of [...rails].sort()) {
    const volts = circuitRailVolts(name);
    if (volts === undefined) continue;
    nets.forEach((n, i) => {
      if (!n.names.includes(name) && n.name !== name) return;
      const net = isGround(n) ? '' : String(i);
      const node = index.get(net);
      if (node === undefined) return;
      if (node === 0) {
        if (volts !== 0) throw new CircuitError('rail-conflict', { node: nodes[0] });
        return;
      }
      const had = railNodes.get(node);
      if (had && had.volts !== volts)
        throw new CircuitError('rail-conflict', { node: nodes[node] });
      if (had) return;
      railNodes.set(node, { name, volts });
      // A part may be called `rail:<name>` too: keep the IDs apart.
      let id = `rail:${name}`;
      for (let k = 2; partIds.has(id) || railIds.has(id); k++) id = `rail:${name}#${k}`;
      railIds.add(id);
      elements.push({
        id,
        ref: name,
        kind: 'vsource',
        nodes: { plus: node, minus: 0 },
        params: { volts },
      });
    });
  }
  if (elements.length > circuitLimits.elements) throw new CircuitError('limit-elements');
  left.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  return { nodes, elements, left };
}
