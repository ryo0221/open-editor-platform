import type { SchematicDocument } from './model';
import { schematicSymbolLibrary } from './symbols';

/** An empty A4 sheet with the symbol library (one symbol of each generator, `sym-<kind>`). */
export function schematicStarter(): SchematicDocument {
  return {
    schemaVersion: 1,
    units: 'mm',
    sheet: { size: 'A4', orientation: 'landscape', title: 'Schematic' },
    symbols: schematicSymbolLibrary(),
    parts: [],
    wires: [],
    junctions: [],
    labels: [],
    powers: [],
  };
}

/**
 * A small drawn circuit (SL1 tests and the Surface's test host): GPIO17 → R1 330 Ω → D1 (LED) →
 * GND, and a push button SW1 from GPIO27 to GND. The GND wire from D1 joins the button's GND by a
 * junction. Every point is on the 1.27 mm grid.
 */
export function schematicLedExample(): SchematicDocument {
  const doc = schematicStarter();
  doc.sheet.title = 'LED and button';
  doc.parts = [
    {
      id: 'r1',
      ref: 'R1',
      value: '330',
      symbol: 'sym-resistor',
      at: [76.2, 50.8],
      rotationDeg: 0,
      mirror: false,
    },
    {
      id: 'd1',
      ref: 'D1',
      value: 'LED green',
      symbol: 'sym-led',
      at: [101.6, 50.8],
      rotationDeg: 0,
      mirror: false,
    },
    {
      id: 'sw1',
      ref: 'SW1',
      value: 'Button',
      symbol: 'sym-switch',
      at: [76.2, 76.2],
      rotationDeg: 0,
      mirror: false,
    },
  ];
  doc.wires = [
    // GPIO17 label → R1.1
    {
      id: 'w1',
      points: [
        [60.96, 50.8],
        [71.12, 50.8],
      ],
    },
    // R1.2 → D1.A
    {
      id: 'w2',
      points: [
        [81.28, 50.8],
        [96.52, 50.8],
      ],
    },
    // D1.K → down to the GND rail
    {
      id: 'w3',
      points: [
        [106.68, 50.8],
        [114.3, 50.8],
        [114.3, 88.9],
      ],
    },
    // GPIO27 label → SW1.1
    {
      id: 'w4',
      points: [
        [60.96, 76.2],
        [71.12, 76.2],
      ],
    },
    // SW1.2 → right to the GND wire, met by a junction
    {
      id: 'w5',
      points: [
        [81.28, 76.2],
        [114.3, 76.2],
      ],
    },
  ];
  doc.junctions = [{ id: 'j1', at: [114.3, 76.2] }];
  doc.labels = [
    { id: 'l1', name: 'GPIO17', at: [60.96, 50.8], rotationDeg: 0 },
    { id: 'l2', name: 'GPIO27', at: [60.96, 76.2], rotationDeg: 0 },
  ];
  doc.powers = [{ id: 'p1', name: 'GND', at: [114.3, 88.9], rotationDeg: 0, style: 'ground' }];
  return doc;
}
