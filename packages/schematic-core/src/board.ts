import { canonicalJson } from '@editor-platform/artifact-core';
import {
  generateFootprint,
  loopBounds,
  pcbCollections,
  type PcbComponent,
  type PcbDocument,
  type PcbFootprint,
  type PcbNet,
  type PcbOperation,
  type PcbPinRef,
} from '@editor-platform/pcb-core';
import type { SchematicDocument, SchematicFootprintRef } from './model';
import { schematicNets, type SchematicNet } from './nets';

/**
 * Sending a schematic to a board (docs/cad/circuit-simulation.md, SL3, SL-U5): the schematic is
 * the source and the board only receives. `schematicBoardDiff` compares the schematic with one
 * exact board version and lists what would change; `schematicBoardOperations` turns the changes
 * the user keeps into ordinary `pcb-core` operations, which `pcbBatchCommand` applies as one
 * transaction (one Undo). Tracks, vias and zones are never touched: copper on a net that changed
 * shows up in the board's DRC (unconnected, short).
 *
 * Parts are matched by reference. A part goes to the board only with a footprint and a full pin
 * map; nets carry the pins of those parts, as `REF.PAD`. A net of one pin that no label or power
 * port names (a pin left alone) is not sent.
 */
export type SchematicBoardChangeKind =
  | 'add-part'
  | 'value'
  | 'footprint'
  | 'board-only-part'
  | 'add-net'
  | 'net-pins'
  | 'rename-net'
  | 'board-only-net';

export interface SchematicBoardChange {
  /** Stable within one diff: `<kind>:<ref or net name>`. */
  id: string;
  kind: SchematicBoardChangeKind;
  /** The part's reference (part changes) or the net's name on the schematic (net changes). */
  name: string;
  /** What the board has now, as text (value, footprint name, net name); absent when nothing. */
  from?: string;
  /** What the schematic asks for, as text. */
  to?: string;
  /** Net changes: pins (`REF.PAD`) the net gains and loses on the board. */
  add?: string[];
  remove?: string[];
  /**
   * Whether the change starts selected. Changes that only the board has (a part or net the
   * schematic does not know) start unselected: applying them deletes board content.
   */
  selected: boolean;
  /** False when it cannot be applied (a board-only net that copper still carries). */
  applicable: boolean;
}

/** Why a schematic part is not sent: no footprint, or pins without a pad. */
export interface SchematicBoardSkip {
  ref: string;
  reason: 'no-footprint' | 'no-pin-map';
}

export interface SchematicBoardDiff {
  changes: SchematicBoardChange[];
  skipped: SchematicBoardSkip[];
  /**
   * Pads that pins of two or more schematic nets map to (`REF.PAD` and the nets' names). While
   * any is listed, `schematicBoardOperations` refuses (`pad-conflict`).
   */
  conflicts: { pad: string; nets: string[] }[];
  /**
   * Names two or more separate schematic nets share (a label named like another net's
   * automatic name): the board names nets uniquely, so `schematicBoardOperations` refuses
   * (`net-name-duplicate`) while any is listed.
   */
  duplicateNames: string[];
}

/** A send the board cannot take; `code` names why. */
export class SchematicBoardError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/**
 * A board pin as a key: reference and pad joined by U+0000, which neither may hold, so `R1.1`
 * pad `1` and `R1` pad `1.1` stay apart. Shown as `REF.PAD` only in the diff's text.
 */
const pinText = ([ref, pad]: [string, string]) => `${ref}\u0000${pad}`;
const shown = (key: string) => key.replace('\u0000', '.');
const collator = new Intl.Collator('en', { numeric: true });
const natural = (a: string, b: string) => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);

interface SentPart {
  ref: string;
  value: string;
  footprint: SchematicFootprintRef;
  generated: PcbFootprint;
  /** The pads its pin map names. */
  mapped: string[];
}
interface SentNet {
  name: string;
  /** `REF.PAD`, sorted. */
  pins: string[];
}

/** The parts and nets the schematic sends: parts with a footprint and a full pin map. */
function sent(doc: SchematicDocument, nets: readonly SchematicNet[]) {
  const parts = new Map<string, SentPart>();
  const skipped: SchematicBoardSkip[] = [];
  const pads = new Map<string, Record<string, string>>();
  const symbols = new Map(doc.symbols.map((s) => [s.id, s]));
  for (const p of doc.parts) {
    if (!p.footprint) {
      skipped.push({ ref: p.ref, reason: 'no-footprint' });
      continue;
    }
    const symbol = symbols.get(p.symbol);
    const map = p.pinMap ?? {};
    if (!symbol || symbol.pins.some((pin) => map[pin.number] === undefined)) {
      skipped.push({ ref: p.ref, reason: 'no-pin-map' });
      continue;
    }
    parts.set(p.id, {
      ref: p.ref,
      value: p.value,
      footprint: p.footprint,
      generated: generateFootprint('fp', p.footprint.generator, p.footprint.params),
      mapped: [...new Set(Object.values(map))],
    });
    pads.set(p.id, map);
  }
  const out: SentNet[] = [];
  for (const n of nets) {
    const pins = n.pins.flatMap(([part, pin]) => {
      const sp = parts.get(part);
      const pad = pads.get(part)?.[pin];
      return sp && pad !== undefined ? [pinText([sp.ref, pad])] : [];
    });
    // The same pad twice (two pins on one pad) is one board pin.
    const unique = [...new Set(pins)].sort(natural);
    if (unique.length === 0 || (unique.length === 1 && !n.named)) continue;
    out.push({ name: n.name, pins: unique });
  }
  // Two schematic nets on one pad (pins of different nets mapped to it): a short the board
  // cannot hold. Reported, and nothing is sent until the schematic is fixed.
  const netsOf = new Map<string, string[]>();
  for (const n of out) for (const p of n.pins) netsOf.set(p, [...(netsOf.get(p) ?? []), n.name]);
  const conflicts = [...netsOf]
    .filter(([, names]) => names.length > 1)
    .map(([pad, nets]) => ({ pad: shown(pad), nets }))
    .sort((a, b) => natural(a.pad, b.pad));
  const seen = new Set<string>();
  const duplicateNames = new Set<string>();
  for (const n of out) (seen.has(n.name) ? duplicateNames : seen).add(n.name);
  skipped.sort((a, b) => natural(a.ref, b.ref));
  return {
    parts: [...parts.values()],
    nets: out,
    skipped,
    conflicts,
    duplicateNames: [...duplicateNames].sort(natural),
  };
}

const sameGenerator = (fp: PcbFootprint | undefined, generated: PcbFootprint) =>
  fp?.generator !== undefined &&
  canonicalJson(fp.generator) === canonicalJson(generated.generator ?? null);

/**
 * Whether a board footprint already serves a part: the same generator and parameters, or (a
 * footprint drawn by hand, without a generator) every pad the part's pin map names.
 */
function footprintServes(fp: PcbFootprint | undefined, part: SentPart): boolean {
  if (!fp) return false;
  if (fp.generator) return sameGenerator(fp, part.generated);
  // An unplated hole is never a pin.
  const pads = new Set(fp.pads.filter((p) => p.type !== 'npth').map((p) => p.number));
  return part.mapped.every((p) => pads.has(p));
}

function boardNetPins(board: PcbDocument, net: PcbNet): string[] {
  const refs = new Map(board.components.map((c) => [c.id, c.ref]));
  return net.pins.map(([c, pad]) => pinText([refs.get(c) ?? c, pad])).sort(natural);
}

/** The changes that would bring `board` in line with `schematic`, in a stable order. */
export function schematicBoardDiff(
  schematic: SchematicDocument,
  board: PcbDocument,
  nets: readonly SchematicNet[] = schematicNets(schematic),
): SchematicBoardDiff {
  const s = sent(schematic, nets);
  const changes: SchematicBoardChange[] = [];
  const byRef = new Map(board.components.map((c) => [c.ref, c]));
  const footprints = new Map(board.footprints.map((f) => [f.id, f]));
  const change = (c: Omit<SchematicBoardChange, 'id' | 'selected' | 'applicable'>) =>
    changes.push({
      id: `${c.kind}:${c.name}`,
      selected: c.kind !== 'board-only-part' && c.kind !== 'board-only-net',
      applicable: true,
      ...c,
    });
  const refs = new Set(s.parts.map((p) => p.ref));
  for (const p of [...s.parts].sort((a, b) => natural(a.ref, b.ref))) {
    const c = byRef.get(p.ref);
    if (!c) {
      change({ kind: 'add-part', name: p.ref, to: `${p.value} · ${p.generated.name}` });
      continue;
    }
    if (c.value !== p.value) change({ kind: 'value', name: p.ref, from: c.value, to: p.value });
    const fp = footprints.get(c.footprint);
    if (!footprintServes(fp, p))
      change({
        kind: 'footprint',
        name: p.ref,
        from: fp?.name ?? c.footprint,
        to: p.generated.name,
      });
  }
  // Parts the schematic skips (no footprint yet) are not board-only: the board may have them.
  const known = new Set([...refs, ...s.skipped.map((k) => k.ref)]);
  for (const c of [...board.components].sort((a, b) => natural(a.ref, b.ref)))
    if (!known.has(c.ref)) change({ kind: 'board-only-part', name: c.ref, from: c.value });

  const boardNets = new Map(board.nets.map((n) => [n.name, n]));
  const sentNames = new Set(s.nets.map((n) => n.name));
  // A board net that only its name tells apart from a schematic net: renamed on one side.
  const unmatchedBoard = board.nets.filter((n) => !sentNames.has(n.name));
  const renamed = new Set<string>();
  const copper = new Set([...board.tracks, ...board.vias, ...board.zones].map((t) => t.net));
  for (const n of [...s.nets].sort((a, b) => natural(a.name, b.name))) {
    const b = boardNets.get(n.name);
    if (b) {
      const have = boardNetPins(board, b);
      const add = n.pins.filter((p) => !have.includes(p));
      const remove = have.filter((p) => !n.pins.includes(p));
      if (add.length || remove.length)
        change({
          kind: 'net-pins',
          name: n.name,
          add: add.map(shown),
          remove: remove.map(shown),
        });
      continue;
    }
    const same = unmatchedBoard.find(
      (x) =>
        !renamed.has(x.name) && canonicalJson(boardNetPins(board, x)) === canonicalJson(n.pins),
    );
    if (same) {
      renamed.add(same.name);
      change({ kind: 'rename-net', name: n.name, from: same.name, to: n.name });
    } else change({ kind: 'add-net', name: n.name, add: n.pins.map(shown) });
  }
  for (const b of [...unmatchedBoard].sort((x, y) => natural(x.name, y.name)))
    if (!renamed.has(b.name)) {
      changes.push({
        id: `board-only-net:${b.name}`,
        kind: 'board-only-net',
        name: b.name,
        from: b.name,
        remove: boardNetPins(board, b).map(shown),
        selected: false,
        // Copper on the net keeps it: deleting it would leave tracks on no net.
        applicable: !copper.has(b.id),
      });
    }
  return {
    changes,
    skipped: s.skipped,
    conflicts: s.conflicts,
    duplicateNames: s.duplicateNames,
  };
}

/**
 * The board operations for the selected changes, in order (insert, updateMany, setNets,
 * delete), for `pcbBatchCommand` / `applyPcbOperations`, which validate the result as a whole
 * (a part changing footprints may pass the footprint limit by one in between); empty when nothing changes. `newId` gives an ID not in `taken` (and adds nothing to it).
 * Refuses while the diff lists pad conflicts (`pad-conflict`) or shared net names
 * (`net-name-duplicate`). New parts are put in a column right
 * of the board, to be placed by hand. A net pin whose part
 * or pad is not on the board after the changes (a part left unsent) is left out.
 */
export function schematicBoardOperations(
  schematic: SchematicDocument,
  board: PcbDocument,
  selected: ReadonlySet<string>,
  newId: (taken: Set<string>) => string,
  schematicNetList: readonly SchematicNet[] = schematicNets(schematic),
): PcbOperation[] {
  const diff = schematicBoardDiff(schematic, board, schematicNetList);
  if (diff.conflicts.length) throw new SchematicBoardError('pad-conflict');
  if (diff.duplicateNames.length) throw new SchematicBoardError('net-name-duplicate');
  const chosen = diff.changes.filter((c) => c.applicable && selected.has(c.id));
  const want = (kind: SchematicBoardChangeKind, name: string) =>
    chosen.some((c) => c.kind === kind && c.name === name);
  const s = sent(schematic, schematicNetList);
  const taken = new Set(pcbCollections.flatMap((k) => board[k].map((e) => e.id)));
  const id = () => {
    const v = newId(taken);
    taken.add(v);
    return v;
  };

  const footprints = [...board.footprints];
  const newFootprints: PcbFootprint[] = [];
  const footprintFor = (p: SentPart) => {
    const old = footprints.find((f) => sameGenerator(f, p.generated));
    if (old) return old.id;
    const fp = { ...p.generated, id: id() };
    footprints.push(fp);
    newFootprints.push(fp);
    return fp.id;
  };
  const components = new Map(board.components.map((c) => [c.ref, { ...c }]));
  const added: PcbComponent[] = [];
  const updated = new Set<string>();
  const [, , x1, y1] = loopBounds(board.board.outline);
  for (const p of [...s.parts].sort((a, b) => natural(a.ref, b.ref))) {
    const c = components.get(p.ref);
    if (!c) {
      if (!want('add-part', p.ref)) continue;
      const comp: PcbComponent = {
        id: id(),
        ref: p.ref,
        value: p.value,
        footprint: footprintFor(p),
        at: [Math.min(x1 + 10, 1990), Math.max(y1 - 10 * added.length, -1990)],
        rotationDeg: 0,
        side: 'top',
        locked: false,
      };
      added.push(comp);
      components.set(p.ref, comp);
      continue;
    }
    if (want('value', p.ref)) {
      c.value = p.value;
      updated.add(c.id);
    }
    if (want('footprint', p.ref)) {
      c.footprint = footprintFor(p);
      updated.add(c.id);
    }
  }
  const deleted = new Set(
    board.components.filter((c) => want('board-only-part', c.ref)).map((c) => c.id),
  );
  for (const c of board.components) if (deleted.has(c.id)) components.delete(c.ref);

  // The board's pads after the part changes, to keep every net pin on a real pad.
  const padsOf = new Map(
    footprints.map((f) => [
      f.id,
      new Set(f.pads.filter((p) => p.type !== 'npth').map((p) => p.number)),
    ]),
  );
  const pinRef = (key: string): PcbPinRef | undefined => {
    const cut = key.indexOf('\u0000');
    const c = components.get(key.slice(0, cut));
    const pad = key.slice(cut + 1);
    return c && padsOf.get(c.footprint)?.has(pad) ? [c.id, pad] : undefined;
  };
  const sentNets = new Map(s.nets.map((n) => [n.name, n]));
  let nets: PcbNet[] = board.nets.map((n) => ({ ...n, pins: [...n.pins] }));
  const claimed: PcbNet[] = [];
  const cls = board.netClasses[0].id;
  for (const c of chosen) {
    const sn = sentNets.get(c.name);
    const pins = () =>
      (sn?.pins ?? []).flatMap((t) => {
        const r = pinRef(t);
        return r ? [r] : [];
      });
    if (c.kind === 'add-net') {
      const net = { id: id(), name: c.name, class: cls, pins: pins() };
      nets.push(net);
      claimed.push(net);
    } else if (c.kind === 'net-pins') {
      const net = nets.find((n) => n.name === c.name)!;
      net.pins = pins();
      claimed.push(net);
    } else if (c.kind === 'rename-net') {
      const net = nets.find((n) => n.name === c.from)!;
      net.name = c.name;
      net.pins = pins();
      claimed.push(net);
    } else if (c.kind === 'board-only-net') nets = nets.filter((n) => n.name !== c.name);
  }
  // A pad belongs to one net: a net the schematic set takes it from any other.
  const key = ([c, p]: PcbPinRef) => `${c}\u0000${p}`;
  const owner = new Map<string, PcbNet>();
  for (const n of claimed) for (const p of n.pins) owner.set(key(p), n);
  const live = new Map([...components.values()].map((c) => [c.id, c]));
  for (const n of nets)
    n.pins = n.pins.filter(([c, pad]) => {
      const comp = live.get(c);
      return (
        comp !== undefined &&
        padsOf.get(comp.footprint)?.has(pad) &&
        (owner.get(key([c, pad])) ?? n) === n
      );
    });

  // Footprints no part uses any more, among those a changed part left.
  const used = new Set([...components.values()].map((c) => c.footprint));
  const leftBehind = board.components
    .filter((c) => deleted.has(c.id) || updated.has(c.id))
    .map((c) => c.footprint)
    .filter((f) => !used.has(f));

  const ops: PcbOperation[] = [];
  if (added.length || newFootprints.length)
    ops.push({
      type: 'insert',
      entities: {
        ...(newFootprints.length ? { footprints: newFootprints } : {}),
        ...(added.length ? { components: added } : {}),
      },
    });
  const changed = board.components
    .filter((c) => updated.has(c.id))
    .map((c) => components.get(c.ref)!);
  if (changed.length) ops.push({ type: 'updateMany', collection: 'components', entities: changed });
  if (canonicalJson(nets) !== canonicalJson(board.nets)) ops.push({ type: 'setNets', nets });
  const gone = [...deleted, ...new Set(leftBehind)];
  if (gone.length) ops.push({ type: 'delete', ids: gone });
  return ops;
}
