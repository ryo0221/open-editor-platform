import {
  applyPcbOperations,
  pcbBatchCommand,
  pcbContentHash,
  pcbLimits,
  pcbStarter,
  validatePcb,
  type PcbDocument,
} from '@editor-platform/pcb-core';
import { describe, expect, it } from 'vitest';
import {
  SchematicBoardError,
  schematicBoardDiff,
  schematicBoardOperations,
  schematicLedExample,
  schematicPartSuggestion,
  type SchematicDocument,
} from './index';

// SL3a (ST-563, TS-2105): the schematic sent to a board as a diff and one batch of operations.

/** The LED example with each part's suggested footprint and pin map (as placing it gives). */
function led(): SchematicDocument {
  const doc = schematicLedExample();
  const symbols = new Map(doc.symbols.map((s) => [s.id, s]));
  doc.parts = doc.parts.map((p) => {
    const { footprint, pinMap } = schematicPartSuggestion(symbols.get(p.symbol)!);
    return { ...p, footprint, pinMap };
  });
  return doc;
}
let n = 0;
const newId = (taken: Set<string>) => {
  let id: string;
  do id = `x${++n}`;
  while (taken.has(id));
  return id;
};
const all = (s: SchematicDocument, b: PcbDocument) =>
  new Set(schematicBoardDiff(s, b).changes.map((c) => c.id));
const send = (s: SchematicDocument, b: PcbDocument, ids = all(s, b)) => {
  const ops = schematicBoardOperations(s, b, ids, newId);
  return ops.length ? applyPcbOperations(b, ops) : b;
};
const summary = (s: SchematicDocument, b: PcbDocument) =>
  schematicBoardDiff(s, b).changes.map(
    (c) =>
      `${c.id}${c.from !== undefined ? ` ${c.from}` : ''}${c.to !== undefined ? ` → ${c.to}` : ''}` +
      `${c.add?.length ? ` +${c.add.join(',')}` : ''}${c.remove?.length ? ` −${c.remove.join(',')}` : ''}` +
      `${c.selected ? '' : ' (off)'}${c.applicable ? '' : ' (n/a)'}`,
  );

describe('schematic → board (SL3a, TS-2105)', () => {
  it('sends every part and net to an empty board, and then has nothing left to send', () => {
    const s = led();
    expect(summary(s, pcbStarter())).toEqual([
      'add-part:D1 → LED green · Chip 0603',
      'add-part:R1 → 330 · Chip 0603',
      'add-part:SW1 → Button · Pin header 1×2 2.54 mm',
      'add-net:GND +D1.1,SW1.2',
      'add-net:GPIO17 +R1.1',
      'add-net:GPIO27 +SW1.1',
      'add-net:Net-(D1-2) +D1.2,R1.2',
    ]);
    const b = send(s, pcbStarter());
    expect(validatePcb(b)).toEqual([]);
    expect(b.components.map((c) => `${c.ref} ${c.value}`)).toEqual([
      'D1 LED green',
      'R1 330',
      'SW1 Button',
    ]);
    // R1 and D1 share one generated 0603 footprint.
    expect(b.footprints).toHaveLength(2);
    // New parts wait in a column right of the board (100 mm wide).
    expect(b.components.every((c) => c.at[0] === 110)).toBe(true);
    expect(schematicBoardDiff(s, b).changes).toEqual([]);
  });

  it('lists value, footprint and net changes, and applies them in one transaction', () => {
    const s = led();
    const b = send(s, pcbStarter());
    const r1 = s.parts.find((p) => p.ref === 'R1')!;
    r1.value = '1k';
    r1.footprint = { generator: 'chip', params: { size: '1206' } };
    s.parts.find((p) => p.ref === 'D1')!.footprint = {
      generator: 'chip',
      params: { size: '1206' },
    };
    // SW1 off the GND net: its pin 2 left alone (one pin, no name) is not sent.
    s.wires = s.wires.filter((w) => w.id !== 'w5');
    s.junctions = [];
    expect(summary(s, b)).toEqual([
      'footprint:D1 Chip 0603 → Chip 1206',
      'value:R1 330 → 1k',
      'footprint:R1 Chip 0603 → Chip 1206',
      'net-pins:GND −SW1.2',
    ]);
    const ops = schematicBoardOperations(s, b, all(s, b), newId);
    expect(ops.map((o) => o.type)).toEqual(['insert', 'updateMany', 'setNets', 'delete']);
    const cmd = pcbBatchCommand(ops, 'Send schematic', {
      expectedHash: pcbContentHash(b),
      canEdit: () => true,
    });
    expect(cmd.type).toBe('pcb.batch');
    const after = cmd.apply(b);
    expect(validatePcb(after)).toEqual([]);
    expect(schematicBoardDiff(s, after).changes).toEqual([]);
    // One 1206 footprint for both; the 0603 nothing uses any more is gone; pins stay on their nets.
    expect(after.footprints.map((f) => f.name).sort()).toEqual([
      'Chip 1206',
      'Pin header 1×2 2.54 mm',
    ]);
    expect(after.nets.find((x) => x.name === 'GPIO17')!.pins).toHaveLength(1);
    // The exact board version: any other base is refused.
    const stale = pcbBatchCommand(ops, 'Send schematic', {
      expectedHash: pcbContentHash(after),
      canEdit: () => true,
    });
    expect(() => stale.apply(b)).toThrow('pcb-base-mismatch');
    expect(() => pcbBatchCommand([], 'x', { expectedHash: '', canEdit: () => true })).toThrow(
      'operation-empty',
    );
  });

  it('keeps board-only parts and nets unless chosen, and never deletes a net copper carries', () => {
    const s = led();
    const b = send(s, pcbStarter());
    // On the board only: a part, a net, and a net with a track.
    b.components.push({ ...b.components[0], id: 'tp', ref: 'TP1', value: 'Test' });
    b.nets.push({ id: 'n-x', name: 'SPARE', class: b.netClasses[0].id, pins: [['tp', '1']] });
    b.nets.push({ id: 'n-y', name: 'ROUTED', class: b.netClasses[0].id, pins: [['tp', '2']] });
    b.tracks.push({
      id: 't1',
      net: 'n-y',
      layer: 'F.Cu',
      widthMm: 0.25,
      from: [0, 0],
      to: [1, 0],
    });
    expect(validatePcb(b)).toEqual([]);
    expect(summary(s, b)).toEqual([
      'board-only-part:TP1 Test (off)',
      'board-only-net:ROUTED ROUTED −TP1.2 (off) (n/a)',
      'board-only-net:SPARE SPARE −TP1.1 (off)',
    ]);
    // Sending what starts selected changes nothing.
    const selected = new Set(
      schematicBoardDiff(s, b)
        .changes.filter((c) => c.selected)
        .map((c) => c.id),
    );
    expect(schematicBoardOperations(s, b, selected, newId)).toEqual([]);
    // Choosing all of them deletes TP1 and SPARE; ROUTED stays (its pin went with TP1).
    const after = send(s, b);
    expect(validatePcb(after)).toEqual([]);
    expect(after.components.map((c) => c.ref)).not.toContain('TP1');
    expect(after.nets.map((x) => x.name)).toContain('ROUTED');
    expect(after.nets.map((x) => x.name)).not.toContain('SPARE');
  });

  it('finds a net renamed on the board, and skips parts without a footprint', () => {
    const s = led();
    const b = send(s, pcbStarter());
    b.nets.find((x) => x.name === 'Net-(D1-2)')!.name = 'LED_A';
    expect(summary(s, b)).toEqual(['rename-net:Net-(D1-2) LED_A → Net-(D1-2)']);
    const back = send(s, b);
    expect(back.nets.map((x) => x.name)).toContain('Net-(D1-2)');
    // SW1 without a footprint is skipped, not a board-only part; its pins leave the nets.
    const sw1 = s.parts.find((p) => p.ref === 'SW1')!;
    delete sw1.footprint;
    delete sw1.pinMap;
    const d = schematicBoardDiff(s, back);
    expect(d.skipped).toEqual([{ ref: 'SW1', reason: 'no-footprint' }]);
    expect(d.changes.map((c) => c.id)).toEqual(['net-pins:GND', 'board-only-net:GPIO27']);
  });

  it('keeps a hand-drawn footprint that has the mapped pads, and refuses two nets on one pad', () => {
    const s = led();
    // SW1 on two pads of a 1×4 header.
    s.parts.find((p) => p.ref === 'SW1')!.footprint = {
      generator: 'pin-header',
      params: { rows: 1, pinsPerRow: 4 },
    };
    const b = send(s, pcbStarter());
    // The board draws SW1's footprint by hand (no generator), with pads 1 and 2 only.
    const sw1 = b.components.find((c) => c.ref === 'SW1')!;
    const fp = b.footprints.find((f) => f.id === sw1.footprint)!;
    const { generator: _g, ...hand } = fp;
    b.footprints = b.footprints.map((f) =>
      f.id === fp.id ? { ...hand, pads: fp.pads.filter((p) => ['1', '2'].includes(p.number)) } : f,
    );
    expect(validatePcb(b)).toEqual([]);
    expect(schematicBoardDiff(s, b).changes).toEqual([]);
    // R1's two pins on pad 1: GPIO17 and Net-(D1-2) would short there.
    s.parts.find((p) => p.ref === 'R1')!.pinMap = { '1': '1', '2': '1' };
    expect(schematicBoardDiff(s, b).conflicts).toEqual([
      { pad: 'R1.1', nets: ['GPIO17', 'Net-(D1-2)'] },
    ]);
    expect(() => schematicBoardOperations(s, b, all(s, b), newId)).toThrow(SchematicBoardError);
    expect(() => schematicBoardOperations(s, b, all(s, b), newId)).toThrow('pad-conflict');
  });

  it('refuses two nets of one name, and never takes an unplated hole for a pad', () => {
    const s = led();
    const b = send(s, pcbStarter());
    // A label named like R1's other net: two separate nets called Net-(D1-2).
    s.labels.push({ id: 'l9', name: 'Net-(D1-2)', at: [60.96, 76.2], rotationDeg: 0 });
    s.labels = s.labels.filter((l) => l.id !== 'l2');
    expect(schematicBoardDiff(s, b).duplicateNames).toEqual(['Net-(D1-2)']);
    expect(() => schematicBoardOperations(s, b, all(s, b), newId)).toThrow('net-name-duplicate');
    // SW1's hand-drawn footprint has pad 1 as an unplated hole: it does not serve SW1.
    const t = led();
    const sw1 = b.components.find((c) => c.ref === 'SW1')!;
    const fp = b.footprints.find((f) => f.id === sw1.footprint)!;
    const { generator: _g, ...hand } = fp;
    const holed = {
      ...hand,
      id: 'fp-hand',
      pads: fp.pads.map((p) =>
        p.number === '1' ? { ...p, type: 'npth' as const, shape: 'circle' as const } : p,
      ),
    };
    const nets = b.nets.map((n) => ({ ...n, pins: n.pins.filter(([c]) => c !== sw1.id) }));
    const c = {
      ...b,
      footprints: [...b.footprints, holed],
      components: b.components.map((x) => (x.id === sw1.id ? { ...x, footprint: 'fp-hand' } : x)),
      nets,
    };
    expect(validatePcb(c)).toEqual([]);
    const changes = schematicBoardDiff(t, c).changes.map((x) => x.id);
    expect(changes).toContain('footprint:SW1');
    const after = send(t, c);
    expect(validatePcb(after)).toEqual([]);
    expect(schematicBoardDiff(t, after).changes).toEqual([]);
  });

  it('replaces a footprint on a board at the footprint limit', () => {
    const s = led();
    const b = send(s, pcbStarter());
    // Fill the board up to the limit with unused copies.
    const spare = b.footprints[0];
    while (b.footprints.length < pcbLimits.footprints)
      b.footprints.push({ ...spare, id: `spare-${b.footprints.length}` });
    expect(validatePcb(b)).toEqual([]);
    s.parts.find((p) => p.ref === 'SW1')!.footprint = {
      generator: 'pin-header',
      params: { rows: 1, pinsPerRow: 3 },
    };
    const after = send(s, b);
    expect(after.footprints).toHaveLength(pcbLimits.footprints);
    expect(schematicBoardDiff(s, after).changes).toEqual([]);
  });

  it('keeps a reference and a pad apart even when both hold dots', () => {
    const s = led();
    const r1 = s.parts.find((p) => p.ref === 'R1')!;
    // A second resistor called R1.1, its pin 1 on the label X.
    s.parts.push({ ...r1, id: 'r11', ref: 'R1.1', at: [152.4, 127] });
    s.labels.push({ id: 'lx', name: 'X', at: [147.32, 127], rotationDeg: 0 });
    const b = send(s, pcbStarter());
    // R1's footprint drawn by hand with an extra copper pad "1.1".
    const c1 = b.components.find((c) => c.ref === 'R1')!;
    const fp = b.footprints.find((f) => f.id === c1.footprint)!;
    const { generator: _g, ...hand } = fp;
    const extra = {
      ...hand,
      id: 'fp-r1',
      pads: [...fp.pads, { ...fp.pads[0], number: '1.1', at: [0, 2] as [number, number] }],
    };
    b.footprints.push(extra);
    b.components = b.components.map((c) => (c.id === c1.id ? { ...c, footprint: 'fp-r1' } : c));
    expect(validatePcb(b)).toEqual([]);
    const x = b.nets.find((n) => n.name === 'X')!;
    const r11 = b.components.find((c) => c.ref === 'R1.1')!;
    expect(x.pins).toEqual([[r11.id, '1']]);
    expect(schematicBoardDiff(s, b).changes).toEqual([]);
    // Wired to R1's pad 1.1 on the board instead: the diff shows it, as R1.1.1 both times.
    b.nets = b.nets.map((n) => (n.name === 'X' ? { ...n, pins: [[c1.id, '1.1']] } : n));
    expect(summary(s, b)).toEqual(['net-pins:X +R1.1.1 −R1.1.1']);
    const after = send(s, b);
    expect(after.nets.find((n) => n.name === 'X')!.pins).toEqual([[r11.id, '1']]);
  });
});
