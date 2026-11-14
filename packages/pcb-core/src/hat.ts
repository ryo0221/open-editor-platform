import { pcbDefaultNetClass } from './fixtures';
import { generateFootprint } from './generators';
import { distance } from './geometry';
import type {
  PcbComponent,
  PcbDocument,
  PcbFootprint,
  PcbLoop,
  PcbNet,
  PcbNetClass,
  PcbPinRef,
  PcbTrack,
  PcbVia,
  Vec2,
} from './model';
import { componentPads } from './placement';

/**
 * F76 (PB8, docs/cad/pcb-design.md): an original HAT+ for the Raspberry Pi 40-pin header, made
 * from its net list to fabrication data in the editor's own model. The board follows the
 * public HAT+ mechanical rules (RP-008281-DS-1, read with the older public HAT drawing for the
 * cut-outs): 65 × 56 mm with a through-hole header, R3 corners, four Ø2.75 mm unplated mounting
 * holes on the Pi's 58 × 49 mm pattern, the display flex cut-out on the left edge and the
 * camera flex slot. The ID EEPROM circuit is the public design guide's: a 24C32 at 0x50 on
 * ID_SD/ID_SC with 3.9 kΩ pull-ups, its WP pin pulled up by 1 kΩ to a test point, powered from
 * 3V3. The rest is this example's own: an I²C temperature/humidity sensor (a generic part in a
 * SOT-23-6 footprint), an LED and a button. Nothing is copied from a Raspberry Pi layout.
 *
 * Frame: origin at the board's lower-left corner, the header along the top edge (as on F75).
 */

/** The 40-pin header's pin `n` (1–40), board mm: odd pins on the inner row, pin 1 at the left. */
export function pcbGpioPin(n: number): Vec2 {
  const col = Math.floor((n - 1) / 2);
  return [round(8.37 + col * 2.54), n % 2 ? 51.23 : 53.77];
}

/** HAT+ mounting holes: Ø2.75 mm, unplated, ±0.05 mm, on the Pi's pattern. */
export const hatHoleDrillMm = 2.75;
export const hatHoleToleranceMm = 0.05;
export const hatHoleCentres: readonly Vec2[] = [
  [3.5, 3.5],
  [61.5, 3.5],
  [61.5, 52.5],
  [3.5, 52.5],
];

/** The header pins and what they are (Raspberry Pi's public pinout). */
export const pcbGpioPins = {
  power3v3: [1, 17],
  power5v: [2, 4],
  ground: [6, 9, 14, 20, 25, 30, 34, 39],
  idSd: 27,
  idSc: 28,
} as const;

const round = (v: number) => Math.round(v * 1e6) / 1e6;
/** A quarter turn's bulge (counter-clockwise when positive). */
const q = Math.tan(Math.PI / 8);

/** F76's outline: 65 × 56 mm, R3 corners, the display flex cut-out on the left edge (R1 inside). */
export function hatOutline(): PcbLoop {
  return [
    [3, 0],
    [62, 0, q],
    [65, 3],
    [65, 53, q],
    [62, 56],
    [3, 56, q],
    [0, 53],
    // The display flex cut-out: 5 mm deep, 17 mm tall, 19.5 mm above the lower holes' line.
    [0, 40],
    [4, 40, -q],
    [5, 39],
    [5, 24, -q],
    [4, 23],
    [0, 23],
    [0, 3, q],
  ];
}

/** The camera flex slot: 2 × 17 mm with round ends, 45 mm right of the left holes. */
export function hatCameraSlot(): PcbLoop {
  return [
    [47.5, 16],
    [49.5, 16],
    [49.5, 31, 1],
    [47.5, 31],
    [47.5, 16, 1],
  ].slice(1) as PcbLoop;
}

/**
 * The 2 × 20 socket under the HAT: the pin header's pads seen from its own side, so that on the
 * board's bottom (mirrored) pin 1 lands over the Pi's pin 1 and the even row over the edge row.
 * No generator: its 3D shape is its courtyard, a plastic block under the board.
 */
function socketFootprint(): PcbFootprint {
  const header = generateFootprint('fp-socket', 'pin-header', { rows: 2, pinsPerRow: 20 });
  const flip = (p: Vec2): Vec2 => [round(-p[0]), p[1]];
  const x1 = 19 * 2.54 + 1.27;
  return {
    id: 'fp-socket',
    name: 'Socket 2×20 2.54 mm (under the board)',
    pads: header.pads.map((p) => ({ ...p, at: flip(p.at) })),
    silk: [
      { kind: 'line', from: [1.27, -1.27], to: [-x1, -1.27], widthMm: 0.15 },
      { kind: 'line', from: [-x1, -1.27], to: [-x1, 3.81], widthMm: 0.15 },
      { kind: 'line', from: [-x1, 3.81], to: [1.27, 3.81], widthMm: 0.15 },
      { kind: 'line', from: [1.27, 3.81], to: [1.27, -1.27], widthMm: 0.15 },
    ],
    courtyard: [
      [-x1 - 0.25, -1.52],
      [1.52, -1.52],
      [1.52, 4.06],
      [-x1 - 0.25, 4.06],
    ],
    heightMm: 8.5,
  };
}

/** A two-pad tactile switch, 5.2 mm body, pads at its sides (a generic form). */
function switchFootprint(): PcbFootprint {
  const pad = (n: string, x: number) => ({
    number: n,
    type: 'smd' as const,
    shape: 'rect' as const,
    at: [x, 0] as Vec2,
    size: [1.0, 1.6] as Vec2,
    rotationDeg: 0,
  });
  return {
    id: 'fp-switch',
    name: 'Tactile switch 5.2 mm, 2 pads',
    pads: [pad('1', -3.1), pad('2', 3.1)],
    silk: [
      { kind: 'line', from: [-2.2, 2.6], to: [2.2, 2.6], widthMm: 0.15 },
      { kind: 'line', from: [-2.2, -2.6], to: [2.2, -2.6], widthMm: 0.15 },
      { kind: 'circle', center: [0, 0], radiusMm: 1.5, widthMm: 0.15, filled: false },
    ],
    courtyard: [
      [-3.85, -2.85],
      [3.85, -2.85],
      [3.85, 2.85],
      [-3.85, 2.85],
    ],
    heightMm: 3.5,
  };
}

/** A round test pad, Ø1.0 mm. */
function testPointFootprint(): PcbFootprint {
  return {
    id: 'fp-tp',
    name: 'Test point Ø1.0 mm',
    pads: [{ number: '1', type: 'smd', shape: 'circle', at: [0, 0], size: [1, 1], rotationDeg: 0 }],
    silk: [],
    courtyard: [
      [-0.75, -0.75],
      [0.75, -0.75],
      [0.75, 0.75],
      [-0.75, 0.75],
    ],
    heightMm: 0.05,
  };
}

const signal: PcbNetClass = {
  id: 'nc-signal',
  name: 'Signal',
  trackWidthMm: 0.2,
  clearanceMm: 0.2,
  viaDiameterMm: 0.6,
  viaDrillMm: 0.3,
};
const power: PcbNetClass = {
  id: 'nc-power',
  name: 'Power',
  trackWidthMm: 0.4,
  clearanceMm: 0.2,
  viaDiameterMm: 0.6,
  viaDrillMm: 0.3,
};

export function f76HatBoard(): PcbDocument {
  const footprints: PcbFootprint[] = [
    socketFootprint(),
    generateFootprint('fp-soic8', 'soic', { pins: 8, bodyWidth: 3.6 }),
    generateFootprint('fp-sot23-6', 'soic', {
      pins: 6,
      pitch: 0.95,
      span: 2.6,
      bodyWidth: 1.5,
      padLength: 0.9,
      height: 1.1,
    }),
    generateFootprint('fp-0603', 'chip', { size: '0603' }),
    switchFootprint(),
    testPointFootprint(),
  ];
  const part = (
    id: string,
    ref: string,
    value: string,
    footprint: string,
    at: Vec2,
    rotationDeg = 0,
    side: PcbComponent['side'] = 'top',
  ): PcbComponent => ({ id, ref, value, footprint, at, rotationDeg, side, locked: false });
  const components: PcbComponent[] = [
    part('j1', 'J1', '2×20 socket', 'fp-socket', pcbGpioPin(1), 0, 'bottom'),
    part('u1', 'U1', '24C32 EEPROM (ID, 0x50)', 'fp-soic8', [41.4, 44], 90),
    part('u2', 'U2', 'T/RH sensor, I²C 0x44', 'fp-sot23-6', [11.86, 44], 270),
    part('c1', 'C1', '100 nF', 'fp-0603', [37, 45.6], 90),
    part('c2', 'C2', '100 nF', 'fp-0603', [11.86, 39.6]),
    part('r1', 'R1', '3.9 kΩ', 'fp-0603', [46.5, 47], 90),
    part('r2', 'R2', '3.9 kΩ', 'fp-0603', [36.5, 48.6]),
    part('r3', 'R3', '1 kΩ', 'fp-0603', [48, 44.6]),
    part('r4', 'R4', '330 Ω', 'fp-0603', [21.07, 45.2], 90),
    part('d1', 'D1', 'LED green', 'fp-0603', [21.07, 41.6], 90),
    part('sw1', 'SW1', 'Button', 'fp-switch', [28, 36.5]),
    part('tp1', 'TP1', 'WP', 'fp-tp', [45.45, 44.6]),
  ];
  const j = (n: number): PcbPinRef => ['j1', String(n)];
  const net = (id: string, name: string, cls: string, pins: PcbPinRef[]): PcbNet => ({
    id,
    name,
    class: cls,
    pins,
  });
  // U1 (24C32): 1–3 A0–A2, 4 VSS, 5 SDA, 6 SCL, 7 WP, 8 VCC. U2: 1 SCL, 2 GND, 3 SDA, 5 VDD.
  // D1: 1 cathode, 2 anode. SW1: 1 to the GPIO, 2 to ground.
  const nets: PcbNet[] = [
    net('n-3v3', '3V3', 'nc-power', [
      j(1),
      j(17),
      ['u1', '8'],
      ['c1', '1'],
      ['r1', '1'],
      ['r2', '1'],
      ['r3', '2'],
      ['u2', '5'],
      ['c2', '1'],
    ]),
    net('n-gnd', 'GND', 'nc-power', [
      ...pcbGpioPins.ground.map(j),
      ['u1', '1'],
      ['u1', '2'],
      ['u1', '3'],
      ['u1', '4'],
      ['c1', '2'],
      ['u2', '2'],
      ['c2', '2'],
      ['d1', '1'],
      ['sw1', '2'],
    ]),
    net('n-id-sd', 'ID_SD', 'nc-signal', [j(27), ['u1', '5'], ['r1', '2']]),
    net('n-id-sc', 'ID_SC', 'nc-signal', [j(28), ['u1', '6'], ['r2', '2']]),
    net('n-wp', 'EEPROM_WP', 'nc-signal', [
      ['u1', '7'],
      ['r3', '1'],
      ['tp1', '1'],
    ]),
    net('n-sda', 'SDA1', 'nc-signal', [j(3), ['u2', '3']]),
    net('n-scl', 'SCL1', 'nc-signal', [j(5), ['u2', '1']]),
    net('n-gpio17', 'GPIO17', 'nc-signal', [j(11), ['r4', '2']]),
    net('n-led', 'LED_A', 'nc-signal', [
      ['r4', '1'],
      ['d1', '2'],
    ]),
    net('n-gpio27', 'GPIO27', 'nc-signal', [j(13), ['sw1', '1']]),
  ];

  const tracks: PcbTrack[] = [];
  const route = (netId: string, width: number, points: Vec2[], layer = 'F.Cu') => {
    for (let i = 1; i < points.length; i++)
      tracks.push({
        id: `t-${netId.slice(2)}-${tracks.length + 1}`,
        net: netId,
        layer,
        widthMm: width,
        from: points[i - 1]!,
        to: points[i]!,
      });
  };
  const vias: PcbVia[] = [];
  const via = (at: Vec2) =>
    vias.push({ id: `v-gnd-${vias.length + 1}`, net: 'n-gnd', at, diameterMm: 0.6, drillMm: 0.3 });

  // ID EEPROM: ID_SD from pin 27 to SDA (5) and R1; ID_SC from pin 28, left of pin 27, to SCL
  // (6) and R2.
  route('n-id-sd', 0.2, [pcbGpioPin(27), [41.39, 50], [43.305, 48.085], [43.305, 46.7]]);
  route('n-id-sd', 0.2, [
    [43.305, 48.085],
    [46.5, 48.085],
    [46.5, 47.8],
  ]);
  route('n-id-sc', 0.2, [
    pcbGpioPin(28),
    [40.12, 52.5],
    [40.12, 48.6],
    [42.035, 48.6],
    [42.035, 46.7],
  ]);
  route('n-id-sc', 0.2, [
    [40.12, 48.6],
    [37.3, 48.6],
  ]);
  // WP: under U1 to the test point and R3.
  route('n-wp', 0.2, [
    [40.765, 46.7],
    [40.765, 44.6],
    [47.2, 44.6],
  ]);
  // 3V3 from pin 17: R2, then a run under U1 to VCC, C1, R3 and R1.
  route('n-3v3', 0.4, [pcbGpioPin(17), [28.69, 43.6], [48.8, 43.6], [48.8, 46.2], [46.5, 46.2]]);
  route('n-3v3', 0.4, [
    [28.69, 48.6],
    [35.7, 48.6],
  ]);
  route('n-3v3', 0.4, [
    [37, 43.6],
    [37, 44.8],
  ]);
  route('n-3v3', 0.4, [
    [39.495, 43.6],
    [39.495, 46.7],
  ]);
  // 3V3 from pin 1 to the sensor and C2; pins 1 and 17 joined under the board.
  route('n-3v3', 0.4, [pcbGpioPin(1), [8.37, 41.6], [11.86, 41.6], [11.86, 42.7]]);
  route('n-3v3', 0.4, [
    [11.06, 41.6],
    [11.06, 39.6],
  ]);
  route('n-3v3', 0.4, [pcbGpioPin(1), [8.37, 49.6], [28.69, 49.6], pcbGpioPin(17)], 'B.Cu');
  // Ground: U1's address and VSS pins tied, every ground pad to the bottom plane by a via.
  route('n-gnd', 0.4, [
    [39.495, 41.3],
    [44.6, 41.3],
  ]);
  via([44.6, 41.3]);
  route('n-gnd', 0.4, [
    [37, 46.4],
    [37, 47.4],
  ]);
  via([37, 47.4]);
  route('n-gnd', 0.4, [
    [11.86, 45.3],
    [11.86, 47],
  ]);
  via([11.86, 47]);
  route('n-gnd', 0.4, [
    [12.66, 39.6],
    [13.9, 39.6],
  ]);
  via([13.9, 39.6]);
  route('n-gnd', 0.4, [
    [21.07, 40.8],
    [21.07, 39.4],
  ]);
  via([21.07, 39.4]);
  route('n-gnd', 0.4, [
    [31.1, 36.5],
    [32.6, 36.5],
  ]);
  via([32.6, 36.5]);
  // The sensor on I²C1.
  route('n-sda', 0.2, [pcbGpioPin(3), [10.91, 45.3]]);
  route('n-scl', 0.2, [pcbGpioPin(5), [13.45, 47], [12.81, 46.36], [12.81, 45.3]]);
  // LED on GPIO17 through R4; button on GPIO27 to ground.
  route('n-gpio17', 0.2, [pcbGpioPin(11), [21.07, 46]]);
  route('n-led', 0.2, [
    [21.07, 44.4],
    [21.07, 42.4],
  ]);
  route('n-gpio27', 0.2, [pcbGpioPin(13), [23.61, 38.6], [24.9, 38.6], [24.9, 36.5]]);

  const outline = hatOutline();
  return {
    schemaVersion: 1,
    units: 'mm',
    board: {
      outline,
      cutouts: [hatCameraSlot()],
      thicknessMm: 1.6,
      copperLayers: 2,
      maskColor: 'green',
      silkColor: 'white',
      finish: 'enig',
      edgeClearanceMm: 0.3,
      holeClearanceMm: 0.25,
      minTrackWidthMm: 0.15,
      minDrillMm: 0.3,
      minAnnularRingMm: 0.13,
    },
    holes: hatHoleCentres.map(([x, y], i) => ({
      id: `mh-${i + 1}`,
      name: `MH${i + 1}`,
      at: [x, y],
      drillMm: hatHoleDrillMm,
      plated: false,
      keepoutMm: 6.2,
    })),
    footprints,
    components,
    netClasses: [pcbDefaultNetClass(), signal, power],
    nets,
    tracks,
    vias,
    zones: [
      {
        id: 'z-gnd',
        net: 'n-gnd',
        layer: 'B.Cu',
        outline,
        priority: 0,
        clearanceMm: 0.25,
        padConnection: 'thermal',
        thermalGapMm: 0.3,
        spokeWidthMm: 0.3,
      },
    ],
    stack: [],
  };
}

/** A HAT+ rule the board breaks (PB8): what and which items. */
export interface PcbHatProblem {
  code:
    | 'hat-hole-missing'
    | 'hat-hole-size'
    | 'hat-hole-plated'
    | 'hat-header-missing'
    | 'hat-id-pin-use'
    | 'hat-id-pullup'
    | 'hat-eeprom-power'
    | 'hat-back-power';
  ids: string[];
  detail?: string;
}

/**
 * Checks a board against the HAT+ rules this editor can see (PB8): the four mounting holes
 * (centre within 0.05 mm, Ø2.75 ± 0.05 mm, unplated); the ID pins 27/28 joined only to the
 * ID EEPROM and one pull-up each to 3V3; the EEPROM's VCC on 3V3; and no copper of the board
 * on the 5V pins (2, 4), which would back-power the Pi: this example does not, so a net on them
 * is a problem. `header` is the 40-pin part, `eeprom` the ID EEPROM (pins as a 24C32).
 */
export function pcbHatProblems(doc: PcbDocument, header = 'j1', eeprom = 'u1'): PcbHatProblem[] {
  const out: PcbHatProblem[] = [];
  for (const c of hatHoleCentres) {
    const h = doc.holes.find((x) => distance(x.at, c) <= hatHoleToleranceMm);
    if (!h) {
      out.push({ code: 'hat-hole-missing', ids: [], detail: `${c[0]},${c[1]}` });
      continue;
    }
    if (Math.abs(h.drillMm - hatHoleDrillMm) > hatHoleToleranceMm + 1e-9)
      out.push({ code: 'hat-hole-size', ids: [h.id] });
    if (h.plated) out.push({ code: 'hat-hole-plated', ids: [h.id] });
  }
  const part = doc.components.find((c) => c.id === header);
  if (!part) return [...out, { code: 'hat-header-missing', ids: [header] }];
  // Pin 27/28 and 2/4 must be where the Pi's are (the part placed as the header).
  const pads = new Map(componentPads(doc, part).map((p) => [p.pad.number, p.at]));
  for (const n of [2, 4, 27, 28])
    if (!pads.has(String(n)) || distance(pads.get(String(n))!, pcbGpioPin(n)) > 0.05)
      return [...out, { code: 'hat-header-missing', ids: [header], detail: `pin ${n}` }];
  const netOf = (c: string, p: string) =>
    doc.nets.find((n) => n.pins.some(([a, b]) => a === c && b === p));
  const v3 = doc.nets.find((n) =>
    pcbGpioPins.power3v3.some((p) => n.pins.some(([a, b]) => a === header && b === String(p))),
  );
  const footprintOf = new Map(doc.components.map((c) => [c.id, c.footprint]));
  const padCount = (c: string) =>
    doc.footprints.find((f) => f.id === footprintOf.get(c))?.pads.length ?? 0;
  for (const [pin, eepromPin] of [
    [pcbGpioPins.idSd, '5'],
    [pcbGpioPins.idSc, '6'],
  ] as const) {
    const n = netOf(header, String(pin));
    if (!n) {
      out.push({ code: 'hat-id-pin-use', ids: [header], detail: `pin ${pin} not connected` });
      continue;
    }
    // Only the EEPROM's pin and two-pad parts (the pull-up) besides this header pin: another
    // header pin on the ID bus is a forbidden connection too.
    const others = n.pins.filter(([c, p]) => !(c === header && p === String(pin)));
    const extra = others.filter(
      ([c, p]) => !(c === eeprom && p === eepromPin) && padCount(c) !== 2,
    );
    if (extra.length || !others.some(([c, p]) => c === eeprom && p === eepromPin))
      out.push({ code: 'hat-id-pin-use', ids: [n.id, ...extra.map(([c]) => c)] });
    const pulls = others.filter(([c]) => c !== eeprom && padCount(c) === 2);
    const pulledUp = pulls.filter(([c, p]) => {
      const other = netOf(c, p === '1' ? '2' : '1');
      return other && other === v3;
    });
    if (pulls.length !== 1 || pulledUp.length !== 1)
      out.push({ code: 'hat-id-pullup', ids: [n.id, ...pulls.map(([c]) => c)] });
  }
  if (!v3 || netOf(eeprom, '8') !== v3) out.push({ code: 'hat-eeprom-power', ids: [eeprom] });
  for (const pin of pcbGpioPins.power5v) {
    const n = netOf(header, String(pin));
    const used =
      n &&
      n.pins.some(([c, p]) => !(c === header && pcbGpioPins.power5v.some((x) => String(x) === p)));
    const copper =
      n &&
      (doc.tracks.some((t) => t.net === n.id) ||
        doc.vias.some((v) => v.net === n.id) ||
        doc.zones.some((z) => z.net === n.id));
    if (used || copper) out.push({ code: 'hat-back-power', ids: [n!.id], detail: `pin ${pin}` });
  }
  return out;
}
