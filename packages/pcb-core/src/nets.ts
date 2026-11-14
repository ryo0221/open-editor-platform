import { pcbCollections } from './operations';
import { pcbConnectedGroups, type PcbZoneFill } from './zones';
import { componentPads } from './placement';
import type { PcbDocument, PcbNet, PcbPinRef, Vec2 } from './model';

/** Where a net's pin sits on the board. */
export interface PcbPinAt {
  component: string;
  ref: string;
  pad: string;
  at: Vec2;
}
/** One unrouted connection of a net: two of its pins to join (PB3). */
export interface PcbRatsLine {
  net: string;
  a: PcbPinAt;
  b: PcbPinAt;
}

const pinKey = (component: string, pad: string) => `${component}\u0000${pad}`;

/** The net ID of each pad of a placed part, keyed by part ID and pad number. */
export function pcbPadNets(doc: PcbDocument): Map<string, string> {
  const out = new Map<string, string>();
  for (const n of doc.nets) for (const [c, p] of n.pins) out.set(pinKey(c, p), n.id);
  return out;
}
export const pcbPadNet = (map: Map<string, string>, component: string, pad: string) =>
  map.get(pinKey(component, pad));

/** The board positions of a net's pins, in the net's order; missing pads are left out. */
export function pcbNetPins(doc: PcbDocument, net: PcbNet): PcbPinAt[] {
  const parts = new Map(doc.components.map((c) => [c.id, c]));
  const placed = new Map<string, ReturnType<typeof componentPads>>();
  const out: PcbPinAt[] = [];
  for (const [cid, pad] of net.pins) {
    const c = parts.get(cid);
    if (!c) continue;
    if (!placed.has(cid)) placed.set(cid, componentPads(doc, c));
    const p = placed.get(cid)!.find((x) => x.pad.number === pad);
    if (p) out.push({ component: cid, ref: c.ref, pad, at: p.at });
  }
  return out;
}

/**
 * The ratsnest: for each net, the shortest set of straight lines that joins all its pins (a
 * minimum spanning tree, Prim's method; ties keep the earlier pin). Pins already joined by
 * copper (PB4: tracks, vias, touching pads, zone fills) count as one, so only the missing
 * connections are drawn.
 */
export function pcbRatsnest(doc: PcbDocument, fills?: PcbZoneFill[]): PcbRatsLine[] {
  const out: PcbRatsLine[] = [];
  const groups = pcbConnectedGroups(doc, fills);
  for (const net of doc.nets) {
    const pins = pcbNetPins(doc, net);
    const n = pins.length;
    if (n < 2) continue;
    const group = pins.map((p, i) => groups.get(pinKey(p.component, p.pad)) ?? -1 - i);
    const inTree = new Array<boolean>(n).fill(false);
    const best = new Array<number>(n).fill(Infinity);
    const from = new Array<number>(n).fill(-1);
    best[0] = 0;
    for (let k = 0; k < n; k++) {
      let u = -1;
      for (let i = 0; i < n; i++) if (!inTree[i] && (u < 0 || best[i] < best[u])) u = i;
      inTree[u] = true;
      if (from[u] >= 0 && group[from[u]] !== group[u])
        out.push({ net: net.id, a: pins[from[u]], b: pins[u] });
      for (let i = 0; i < n; i++) {
        if (inTree[i]) continue;
        const d =
          group[i] === group[u]
            ? 0
            : Math.hypot(pins[i].at[0] - pins[u].at[0], pins[i].at[1] - pins[u].at[1]);
        if (d < best[i]) {
          best[i] = d;
          from[i] = u;
        }
      }
    }
  }
  return out;
}

/** A refused net list: the code and where in the JSON. */
export class PcbNetListError extends Error {
  constructor(
    readonly code: string,
    readonly path: string,
  ) {
    super(`netlist:${code}@${path}`);
  }
}

/**
 * Pins written as `REF.PAD` ("J8.40", "U1.EP"). Refs and pad numbers may both hold dots, so
 * every split is tried: the text names a pin only when exactly one split matches a placed
 * part's copper pad (an unplated hole is never a pin). Ambiguous or unknown text is undefined.
 */
export function pcbParsePin(doc: PcbDocument, text: string): PcbPinRef | undefined {
  const found: PcbPinRef[] = [];
  for (let dot = text.indexOf('.'); dot > 0; dot = text.indexOf('.', dot + 1)) {
    const ref = text.slice(0, dot);
    const pad = text.slice(dot + 1);
    if (!pad) continue;
    const c = doc.components.find((x) => x.ref === ref);
    const fp = c && doc.footprints.find((f) => f.id === c.footprint);
    if (c && fp?.pads.some((p) => p.number === pad && p.type !== 'npth')) found.push([c.id, pad]);
  }
  return found.length === 1 ? found[0] : undefined;
}
/** A pin as `REF.PAD`, or the raw IDs when its part is gone. */
export function pcbPinText(doc: PcbDocument, [component, pad]: PcbPinRef): string {
  return `${doc.components.find((c) => c.id === component)?.ref ?? component}.${pad}`;
}

/**
 * Reads a net list `{ "nets": [{ "name": "GND", "class"?: "Power", "pins": ["J8.6", "U1.3"] }] }`
 * against the board (PB3, no schematic: PCB-U3). An imported net replaces the net of the same
 * name; other nets stay, but give up any pin the import names. Classes are named, the default
 * is the first. `newId` makes the ID of each new net. Returns every net of the board after the
 * import, for one `setNets` operation (which validates the result as a whole).
 */
export function pcbImportNetList(
  doc: PcbDocument,
  text: string,
  newId: (taken: Set<string>) => string,
): PcbNet[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new PcbNetListError('json', '$');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new PcbNetListError('not-object', '$');
  const list = (value as { nets?: unknown }).nets;
  if (!Array.isArray(list)) throw new PcbNetListError('array', '$.nets');
  const keep = doc.nets.map((n) => ({ ...n, pins: [...n.pins] }));
  // One ID namespace across every collection (tracks and vias included).
  const taken = new Set(pcbCollections.flatMap((k) => doc[k].map((e) => e.id)));
  const imported: PcbNet[] = [];
  const names = new Set<string>();
  list.forEach((raw, i) => {
    const path = `$.nets[${i}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new PcbNetListError('object', path);
    const r = raw as Record<string, unknown>;
    for (const k of Object.keys(r))
      if (!['name', 'class', 'pins'].includes(k))
        throw new PcbNetListError('unknown-key', `${path}.${k}`);
    if (typeof r.name !== 'string' || !r.name.trim())
      throw new PcbNetListError('name', `${path}.name`);
    const name = r.name.trim();
    if (names.has(name)) throw new PcbNetListError('net-name-duplicate', `${path}.name`);
    names.add(name);
    let cls = doc.netClasses[0].id;
    if (r.class !== undefined) {
      const k = doc.netClasses.find((x) => x.name === r.class);
      if (!k) throw new PcbNetListError('net-class-missing', `${path}.class`);
      cls = k.id;
    }
    if (!Array.isArray(r.pins)) throw new PcbNetListError('array', `${path}.pins`);
    const pins = r.pins.map((p, k) => {
      const pin = typeof p === 'string' ? pcbParsePin(doc, p.trim()) : undefined;
      if (!pin) throw new PcbNetListError('net-pin-missing', `${path}.pins[${k}]`);
      return pin;
    });
    const old = keep.find((n) => n.name === name);
    let id = old?.id;
    if (!id) {
      id = newId(taken);
      taken.add(id);
    }
    imported.push({ id, name, class: cls, pins });
  });
  const claimed = new Set(imported.flatMap((n) => n.pins.map(([c, p]) => pinKey(c, p))));
  const byName = new Map(imported.map((n) => [n.name, n]));
  const out: PcbNet[] = keep.map(
    (n) =>
      byName.get(n.name) ?? { ...n, pins: n.pins.filter(([c, p]) => !claimed.has(pinKey(c, p))) },
  );
  for (const n of imported) if (!keep.some((k) => k.name === n.name)) out.push(n);
  return out;
}
