import { gridKey, onWire, placedPins, toGrid, type GridPoint } from './geometry';
import type { SchematicDocument } from './model';

/** A part's pin in a net: the part's ID and the pin number. */
export type SchematicPinRef = [part: string, pin: string];

export interface SchematicNet {
  /** The net's name: a power port's, else a label's, else `Net-(REF-PIN)` of its first pin. */
  name: string;
  /** True when a power port or label names it. */
  named: boolean;
  /** True when a power port names it: the supply drives it (the ERC counts it as driven). */
  power: boolean;
  /** Every pin on the net, sorted by reference then pin number. */
  pins: SchematicPinRef[];
  /** Every name given to it (more than one is reported by `schematicNetProblems`). */
  names: string[];
  /** The IDs of the wires, labels, powers and junctions that make it. */
  items: string[];
}

class Joins {
  private parent = new Map<string, string>();
  find(k: string): string {
    let r = this.parent.get(k) ?? k;
    if (r !== k) {
      r = this.find(r);
      this.parent.set(k, r);
    }
    return r;
  }
  add(k: string) {
    if (!this.parent.has(k)) this.parent.set(k, k);
  }
  join(a: string, b: string) {
    this.add(a);
    this.add(b);
    const [x, y] = [this.find(a), this.find(b)];
    if (x !== y) this.parent.set(y < x ? x : y, y < x ? y : x);
  }
}

const collator = new Intl.Collator('en', { numeric: true });
/** Natural order ("R2" before "R10") made total: equal-looking strings ("R1", "R01") by code unit. */
const natural = (a: string, b: string) => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);

/**
 * The nets the drawing makes (SL1). The rules, the same for every item:
 * - a wire joins all its own vertices;
 * - items meet where a point of one is a vertex or end of another (a pin's end, a label's or
 *   power port's point, a wire's vertex);
 * - a point inside a wire's segment joins that wire only where a junction is (wires that only
 *   cross do not meet; an end that only touches a wire is reported as `wire-touch`);
 * - labels and power ports of the same name are one net across the sheet.
 * Nets with no pin are left out. The result does not depend on the order of the document's lists.
 */
export function schematicNets(doc: SchematicDocument): SchematicNet[] {
  const j = new Joins();
  const pointKey = (g: GridPoint) => `p:${gridKey(g)}`;
  const wires = doc.wires.map((w) => ({ id: w.id, points: w.points.map(toGrid) }));
  for (const w of wires) {
    j.add(`w:${w.id}`);
    for (const p of w.points) j.join(`w:${w.id}`, pointKey(p));
  }
  for (const jn of doc.junctions) {
    const at = toGrid(jn.at);
    j.join(`i:${jn.id}`, pointKey(at));
    for (const w of wires) if (onWire(at, w.points)) j.join(pointKey(at), `w:${w.id}`);
  }
  const names = new Map<string, { power: boolean; name: string }[]>();
  const named = (key: string, name: string, power: boolean) => {
    j.join(key, `n:${name}`);
    const list = names.get(key) ?? [];
    list.push({ power, name });
    names.set(key, list);
  };
  for (const l of doc.labels) {
    j.join(`i:${l.id}`, pointKey(toGrid(l.at)));
    named(`i:${l.id}`, l.name, false);
  }
  for (const p of doc.powers) {
    j.join(`i:${p.id}`, pointKey(toGrid(p.at)));
    named(`i:${p.id}`, p.name, true);
  }
  const pins = placedPins(doc);
  for (const p of pins) j.join(`pin:${p.part}\u0000${p.pin.number}`, pointKey(p.end));

  const refOf = new Map(doc.parts.map((p) => [p.id, p.ref]));
  const groups = new Map<
    string,
    { pins: SchematicPinRef[]; powers: Set<string>; labels: Set<string>; items: Set<string> }
  >();
  const group = (root: string) => {
    let g = groups.get(root);
    if (!g) {
      g = { pins: [], powers: new Set(), labels: new Set(), items: new Set() };
      groups.set(root, g);
    }
    return g;
  };
  for (const p of pins)
    group(j.find(`pin:${p.part}\u0000${p.pin.number}`)).pins.push([p.part, p.pin.number]);
  for (const [key, list] of names) {
    const g = group(j.find(key));
    for (const n of list) (n.power ? g.powers : g.labels).add(n.name);
  }
  for (const w of doc.wires) group(j.find(`w:${w.id}`)).items.add(w.id);
  for (const x of [...doc.junctions, ...doc.labels, ...doc.powers])
    group(j.find(`i:${x.id}`)).items.add(x.id);

  const pinOrder = (a: SchematicPinRef, b: SchematicPinRef) =>
    natural(refOf.get(a[0]) ?? a[0], refOf.get(b[0]) ?? b[0]) || natural(a[1], b[1]);
  const nets: SchematicNet[] = [];
  for (const g of groups.values()) {
    if (!g.pins.length) continue;
    g.pins.sort(pinOrder);
    const powers = [...g.powers].sort(natural);
    const labels = [...g.labels].sort(natural);
    const all = [...powers, ...labels.filter((l) => !g.powers.has(l))];
    const first = g.pins[0];
    nets.push({
      name: all[0] ?? `Net-(${refOf.get(first[0]) ?? first[0]}-${first[1]})`,
      named: all.length > 0,
      power: powers.length > 0,
      pins: g.pins,
      names: all,
      items: [...g.items].sort(natural),
    });
  }
  return nets.sort((a, b) => natural(a.name, b.name));
}

/** The net a pin is on, if it is on one. */
export function schematicNetOf(
  nets: readonly SchematicNet[],
  part: string,
  pin: string,
): SchematicNet | undefined {
  return nets.find((n) => n.pins.some(([p, q]) => p === part && q === pin));
}

export interface SchematicNetProblem {
  code: 'net-names' | 'net-name-collision';
  net: string;
  names: string[];
}
/**
 * Naming problems of the nets (warnings): one net with two names (`net-names`, such as two power
 * ports shorted together), and two nets with the same automatic-looking name as a label.
 */
export function schematicNetProblems(nets: readonly SchematicNet[]): SchematicNetProblem[] {
  const out: SchematicNetProblem[] = [];
  for (const n of nets)
    if (n.names.length > 1) out.push({ code: 'net-names', net: n.name, names: n.names });
  const seen = new Map<string, number>();
  for (const n of nets) seen.set(n.name, (seen.get(n.name) ?? 0) + 1);
  for (const [name, count] of seen)
    if (count > 1) out.push({ code: 'net-name-collision', net: name, names: [name] });
  return out;
}
