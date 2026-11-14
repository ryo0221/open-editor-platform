import { describe, expect, it } from 'vitest';
import { EditorSession } from '@editor-platform/editor-core';
import {
  applySchematicOperation,
  partPoint,
  schematicContentHash,
  schematicEditorCommand,
  schematicLedExample,
  schematicMove,
  schematicNetProblems,
  schematicNets,
  schematicStarter,
  validateSchematic,
  type SchematicDocument,
} from './index';

// SL1 schematic model (ST-560, TS-2100): validation, nets and operations.

const codes = (doc: unknown) => validateSchematic(doc).map((d) => d.code);
const errors = (doc: unknown) =>
  validateSchematic(doc)
    .filter((d) => d.severity === 'error')
    .map((d) => d.code);
const netsByName = (doc: SchematicDocument) =>
  Object.fromEntries(
    schematicNets(doc).map((n) => [
      n.name,
      n.pins.map(([p, q]) => `${doc.parts.find((x) => x.id === p)!.ref}.${q}`),
    ]),
  );

describe('schematic model (SL1, TS-2100)', () => {
  it('accepts the starter and the LED example', () => {
    expect(validateSchematic(schematicStarter())).toEqual([]);
    expect(validateSchematic(schematicLedExample())).toEqual([]);
  });

  it('derives the nets from wires, junctions, labels and power ports', () => {
    const doc = schematicLedExample();
    expect(netsByName(doc)).toEqual({
      GND: ['D1.1', 'SW1.2'],
      GPIO17: ['R1.1'],
      GPIO27: ['SW1.1'],
      'Net-(D1-2)': ['D1.2', 'R1.2'],
    });
    const gnd = schematicNets(doc).find((n) => n.name === 'GND')!;
    expect(gnd.named).toBe(true);
    expect(gnd.items).toEqual(['j1', 'p1', 'w3', 'w5']);
    expect(schematicNetProblems(schematicNets(doc))).toEqual([]);
  });

  it('does not depend on the order of the lists', () => {
    const doc = schematicLedExample();
    const shuffled = {
      ...doc,
      parts: [...doc.parts].reverse(),
      wires: [...doc.wires].reverse(),
      labels: [...doc.labels].reverse(),
    };
    expect(schematicNets(shuffled)).toEqual(schematicNets(doc));
  });

  it('joins a wire that ends inside another only at a junction, and warns otherwise', () => {
    const doc = schematicLedExample();
    doc.junctions = [];
    // SW1's GND wire now only touches the D1 GND wire: not joined, reported.
    expect(netsByName(doc).GND).toEqual(['D1.1']);
    expect(codes(doc)).toEqual(['wire-touch']);
    expect(validateSchematic(doc)[0]).toMatchObject({
      severity: 'warning',
      path: '$.wires[4].points[1]',
      id: 'w5',
    });
  });

  it('does not join wires that only cross', () => {
    const doc = schematicLedExample();
    // A wire across the GND wire, from SW1.2's row to nowhere, with no junction.
    doc.wires.push({
      id: 'w6',
      points: [
        [109.22, 63.5],
        [119.38, 63.5],
      ],
    });
    const gnd = schematicNets(doc).find((n) => n.name === 'GND')!;
    expect(gnd.items).not.toContain('w6');
  });

  it('joins labels of the same name across the sheet, and reports one net with two names', () => {
    const doc = schematicLedExample();
    doc.labels.push({ id: 'l3', name: 'GPIO17', at: [114.3, 63.5], rotationDeg: 0 });
    doc.junctions.push({ id: 'j2', at: [114.3, 63.5] });
    // The GND wire now also carries GPIO17: the two nets are one.
    const nets = schematicNets(doc);
    const net = nets.find((n) => n.pins.some(([p]) => p === 'r1'))!;
    expect(net.name).toBe('GND');
    expect(net.names).toEqual(['GND', 'GPIO17']);
    expect(schematicNetProblems(nets)).toEqual([
      { code: 'net-names', net: 'GND', names: ['GND', 'GPIO17'] },
    ]);
  });

  it('places pins turned clockwise on the sheet and mirrored before turning', () => {
    const part = { at: [50.8, 50.8] as [number, number], rotationDeg: 90 as const, mirror: false };
    expect(partPoint(part, [5.08, 0])).toEqual([50.8, 55.88]);
    expect(partPoint({ ...part, rotationDeg: 270 }, [5.08, 0])).toEqual([50.8, 45.72]);
    expect(partPoint({ ...part, rotationDeg: 0, mirror: true }, [5.08, 0])).toEqual([45.72, 50.8]);
    expect(partPoint({ ...part, mirror: true }, [5.08, 0])).toEqual([50.8, 45.72]);
  });

  it('refuses malformed documents with a code and path', () => {
    const bad = (edit: (d: SchematicDocument) => void) => {
      const d = schematicLedExample();
      edit(d);
      return errors(d);
    };
    expect(errors({ ...schematicStarter(), schemaVersion: 2 })).toEqual(['unsupported-schema']);
    expect(errors({ ...schematicStarter(), extra: 1 })).toEqual(['unknown-key']);
    expect(bad((d) => (d.parts[0].at = [76, 50.8]))).toContain('grid-off');
    expect(
      bad(
        (d) =>
          (d.wires[0].points = [
            [60.96, 50.8],
            [71.12, 52.07],
          ]),
      ),
    ).toEqual(['wire-diagonal']);
    expect(
      bad(
        (d) =>
          (d.wires[0].points = [
            [60.96, 50.8],
            [60.96, 50.8],
          ]),
      ),
    ).toEqual(['wire-degenerate']);
    expect(
      bad(
        (d) =>
          (d.wires[0].points = [
            [60.96, 50.8],
            [71.12, 50.8],
            [66.04, 50.8],
          ]),
      ),
    ).toEqual(['wire-overlap']);
    expect(bad((d) => (d.parts[1].ref = 'R1'))).toEqual(['ref-duplicate']);
    expect(bad((d) => (d.parts[1].ref = '1D'))).toEqual(['ref']);
    expect(bad((d) => (d.parts[0].symbol = 'nope'))).toEqual(['symbol-missing']);
    expect(bad((d) => (d.parts[0].id = 'd1'))).toEqual(['duplicate-id']);
    expect(bad((d) => (d.labels[0].name = 'GPIO 17'))).toEqual(['net-name']);
    expect(bad((d) => (d.labels[0].at = [-1.27, 50.8]))).toEqual(['off-sheet']);
    // A part whose pin end leaves the sheet.
    expect(bad((d) => (d.parts[0].at = [2.54, 50.8]))).toEqual(['off-sheet']);
    expect(bad((d) => (d.symbols[0].pins[1].number = '1'))).toEqual(['pin-duplicate']);
    expect(bad((d) => (d.symbols[0].pins[1].at = [5, 0]))).toEqual(['grid-off']);
    expect(bad((d) => ((d.parts[0] as { rotationDeg: number }).rotationDeg = 45))).toEqual([
      'enum',
    ]);
  });

  it('moves a part and its wires follow, squared with a corner', () => {
    const doc = schematicLedExample();
    // D1 down 2 grid steps: w2 (R1.2 → D1.A) and w3 (D1.K → GND) follow.
    const next = applySchematicOperation(doc, { type: 'move', ids: ['d1'], delta: [0, 2.54] });
    expect(next.parts[1].at).toEqual([101.6, 53.34]);
    expect(next.wires[1].points).toEqual([
      [81.28, 50.8],
      [96.52, 50.8],
      [96.52, 53.34],
    ]);
    // w3 started horizontal at D1.K: the new end keeps it square to (114.3, 53.34).
    expect(next.wires[2].points).toEqual([
      [106.68, 53.34],
      [114.3, 53.34],
      [114.3, 88.9],
    ]);
    expect(netsByName(next)).toEqual(netsByName(doc));
    // Moving back gives straight wires again.
    const back = schematicMove(next, ['d1'], [0, -2.54]);
    expect(back.wires[1].points).toEqual(doc.wires[1].points);
  });

  it('moves a whole wire, label or power port by the grid only', () => {
    const doc = schematicLedExample();
    expect(() =>
      applySchematicOperation(doc, { type: 'move', ids: ['l1'], delta: [1, 0] }),
    ).toThrow('grid-off');
    expect(() =>
      applySchematicOperation(doc, { type: 'move', ids: ['zz'], delta: [1.27, 0] }),
    ).toThrow('not-found');
    const next = applySchematicOperation(doc, {
      type: 'move',
      ids: ['p1'],
      delta: [0, 2.54],
    });
    expect(next.powers[0].at).toEqual([114.3, 91.44]);
    expect(next.wires[2].points.at(-1)).toEqual([114.3, 91.44]);
  });

  it('applies operations atomically and as session commands', () => {
    const doc = schematicLedExample();
    expect(() =>
      applySchematicOperation(doc, {
        type: 'insert',
        entities: { parts: [{ ...doc.parts[0], id: 'r2' }] },
      }),
    ).toThrow('ref-duplicate');
    expect(doc.parts).toHaveLength(3);
    const session = new EditorSession<SchematicDocument>(doc);
    const hash = schematicContentHash(doc);
    const next = session.execute(
      schematicEditorCommand(
        { type: 'delete', ids: ['sw1', 'w4', 'w5', 'j1'] },
        { expectedHash: hash, canEdit: () => true },
      ),
    );
    expect(next.parts.map((p) => p.ref)).toEqual(['R1', 'D1']);
    expect(Object.keys(netsByName(next))).toEqual(['GND', 'GPIO17', 'Net-(D1-2)']);
    session.undo();
    expect(session.content).toEqual(doc);
    expect(() =>
      session.execute(
        schematicEditorCommand(
          { type: 'setSheet', sheet: { ...doc.sheet, size: 'A3' } },
          { expectedHash: 'stale', canEdit: () => true },
        ),
      ),
    ).toThrow('schematic-base-mismatch');
    expect(() =>
      session.execute(
        schematicEditorCommand(
          { type: 'setSheet', sheet: { ...doc.sheet, size: 'A3' } },
          { expectedHash: hash, canEdit: () => false },
        ),
      ),
    ).toThrow('permission-denied');
  });

  it('refuses a move that would change which pins are connected', () => {
    const doc = schematicLedExample();
    // D1 down by 27.94 mm pushes w3's corner below junction j1: SW1.2 would leave GND.
    expect(() =>
      applySchematicOperation(doc, { type: 'move', ids: ['d1'], delta: [0, 27.94] }),
    ).toThrow('move-changes-nets');
    // A small move keeps the circuit and is applied.
    const ok = applySchematicOperation(doc, { type: 'move', ids: ['d1'], delta: [0, 5.08] });
    expect(netsByName(ok)).toEqual(netsByName(doc));
  });

  it('names an unnamed net the same whatever the part order, even for R1 and R01', () => {
    const doc = schematicStarter();
    const r = (id: string, ref: string) => ({
      id,
      ref,
      value: '1k',
      symbol: 'sym-resistor',
      at: [50.8, 50.8] as [number, number],
      rotationDeg: 0 as const,
      mirror: false,
    });
    // Both resistors in the same place: their pins meet, pin 1 to pin 1.
    doc.parts = [r('a', 'R1'), r('b', 'R01')];
    const names = schematicNets(doc).map((n) => n.name);
    doc.parts.reverse();
    expect(schematicNets(doc).map((n) => n.name)).toEqual(names);
    expect(names).toContain('Net-(R01-1)');
  });
});
