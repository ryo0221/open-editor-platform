import { describe, expect, it } from 'vitest';
import {
  componentPads,
  f75Pi5Board,
  f75Pi5Example,
  f76HatBoard,
  pcbDrc,
  pcbGpioPin,
  pcbGpioPinout,
  pcbModel3d,
  pcbRatsnest,
  pcbStackedModel3d,
  pcbStackPlacement,
  validatePcb,
  type PcbStackedBoard,
} from './index';

// PB8b (docs/cad/pcb-design.md, ST-471): F75 with its parts, and boards stacked over a board in
// 3D. TS-1956 F75 example, TS-1957 stacked model.

describe('F75 Raspberry Pi 5 form factor with parts (PB8b)', () => {
  it('TS-1956: is a valid board on F75 with the header pinout, every net joined', () => {
    const doc = f75Pi5Example();
    expect(validatePcb(doc)).toEqual([]);
    // The same outline and holes as F75 itself.
    expect(doc.board).toEqual(f75Pi5Board().board);
    expect(doc.holes).toEqual(f75Pi5Board().holes);
    expect(pcbRatsnest(doc)).toEqual([]);
    // The header's 40 pins on the Pi's grid, each in its pinout net.
    expect(pcbGpioPinout).toHaveLength(40);
    const j8 = doc.components.find((c) => c.id === 'j8')!;
    const pads = componentPads(doc, j8);
    expect(pads).toHaveLength(40);
    for (const p of pads) {
      const n = Number(p.pad.number);
      expect(p.at[0]).toBeCloseTo(pcbGpioPin(n)[0], 9);
      expect(p.at[1]).toBeCloseTo(pcbGpioPin(n)[1], 9);
      const net = doc.nets.find((x) => x.pins.some(([c, q]) => c === 'j8' && q === p.pad.number));
      expect(net?.name).toBe(pcbGpioPinout[n - 1]);
    }
    expect(doc.nets.find((n) => n.name === 'GND')!.pins).toHaveLength(8);
    // The editor's generic connector shapes are larger than the real parts at the drawing's
    // places: DRC says where (documented in docs/verification/pcb/README.md, PB8b).
    expect(pcbDrc(doc).violations.map((v) => [v.rule, v.severity, v.items.join('+')])).toEqual([
      ['hole-clearance', 'error', 'mh-1+j-usbc'],
      ['silk-over-pad', 'warning', 'j-rj45'],
      ['silk-over-pad', 'warning', 'j-usb3'],
      ['silk-over-pad', 'warning', 'j-usb2'],
      ['silk-over-pad', 'warning', 'j-fan'],
      ['silk-over-pad', 'warning', 'u-pmic'],
      ['part-over-hole', 'warning', 'j-usbc+mh-1'],
      ['part-outside-board', 'warning', 'j-rj45'],
      ['part-over-hole', 'warning', 'j-rj45+mh-2'],
      ['part-outside-board', 'warning', 'j-usb2'],
    ]);
  });
});

describe('stacked boards in 3D (PB8b)', () => {
  const entry: PcbStackedBoard = {
    id: 'st-hat',
    name: 'Sensor HAT+',
    source: { artifactId: 'a', versionId: 'v', contentHash: 'a'.repeat(64) },
    at: [0, 0],
    rotationDeg: 0,
    gapMm: 11,
  };
  it('TS-1957: builds the stacked board with its own parts, placed over the header', () => {
    const pi = f75Pi5Example();
    const hat = f76HatBoard();
    const own = pcbModel3d(pi);
    const hatOwn = pcbModel3d(hat);
    const doc = { ...pi, stack: [entry] };
    const model = pcbStackedModel3d(doc, [{ entry, doc: hat }]);
    expect(model.parts).toHaveLength(own.parts.length + hatOwn.parts.length);
    // The base board's parts unchanged; the stacked board's named after the entry.
    expect(model.parts.slice(0, own.parts.length)).toEqual(own.parts);
    const stacked = model.parts.slice(own.parts.length);
    expect(stacked.every((p) => p.stacked === 'st-hat')).toBe(true);
    expect(stacked[0]!.name).toBe('Sensor HAT+ · Board');
    // Each one a transform of the stacked board's own node, lifted 1.6 + 11 mm.
    for (const p of stacked) {
      const op = model.graph.nodes[p.node]!;
      expect(op.op).toBe('transform');
      if (op.op !== 'transform') continue;
      expect(op.translation).toEqual([0, 0, 12.6]);
      expect(model.graph.nodes[op.input]).toBeDefined();
    }
    // No node names collide, and every reference resolves.
    const refs = Object.values(model.graph.nodes).flatMap((op) =>
      'input' in op
        ? [op.input]
        : 'inputs' in op
          ? op.inputs
          : 'target' in op
            ? [op.target, ...op.tools]
            : [],
    );
    for (const r of refs) expect(model.graph.nodes[r], r).toBeDefined();
    // Not turned: x and y kept, so the HAT's holes stay over the Pi's (TS-1952).
    const place = pcbStackPlacement(doc, entry);
    expect(place.rotation).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    // Turned 180° about the origin: x and y flip, z kept.
    expect(pcbStackPlacement(doc, { ...entry, rotationDeg: 180, at: [85, 56] })).toEqual({
      rotation: [-1, 0, 0, 0, -1, 0, 0, 0, 1],
      translation: [85, 56, 12.6],
    });
    // A board that could not be read is left out (the view says why).
    expect(pcbStackedModel3d(doc, [{ entry, error: 'board-source-missing' }])).toEqual(
      pcbModel3d(doc),
    );
  });
});
