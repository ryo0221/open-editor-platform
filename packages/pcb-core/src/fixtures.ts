import { pcbGenerators, generateFootprint } from './generators';
import { roundedRectLoop } from './geometry';
import type { PcbBoard, PcbComponent, PcbDocument, PcbHole, PcbNetClass } from './model';

/**
 * The class every new board starts with: 0.15 mm tracks and spacing and a 0.6/0.3 mm via, a
 * common fabrication guideline, not one maker's numbers.
 */
export function pcbDefaultNetClass(): PcbNetClass {
  return {
    id: 'nc-default',
    name: 'Default',
    trackWidthMm: 0.15,
    clearanceMm: 0.15,
    viaDiameterMm: 0.6,
    viaDrillMm: 0.3,
  };
}

const board = (outline: PcbBoard['outline'], extra: Partial<PcbBoard> = {}): PcbBoard => ({
  outline,
  cutouts: [],
  thicknessMm: 1.6,
  copperLayers: 2,
  maskColor: 'green',
  silkColor: 'white',
  finish: 'hasl',
  edgeClearanceMm: 0.3,
  holeClearanceMm: 0.25,
  // Common fabrication defaults, not any one maker's values.
  minTrackWidthMm: 0.15,
  minDrillMm: 0.3,
  minAnnularRingMm: 0.13,
  ...extra,
});

/** A new board: 100 × 80 mm with 1 mm corners, two copper layers, no holes. */
export function pcbStarter(): PcbDocument {
  return {
    schemaVersion: 1,
    units: 'mm',
    board: board(roundedRectLoop([0, 0], 100, 80, 1)),
    holes: [],
    footprints: [],
    components: [],
    netClasses: [pcbDefaultNetClass()],
    nets: [],
    tracks: [],
    vias: [],
    zones: [],
    stack: [],
  };
}

/**
 * Raspberry Pi 5 mounting holes (public mechanical drawing RP-008347-DS-1, reference only):
 * 58 × 49 mm apart, 3.5 mm from the left and bottom edges, Ø2.7 mm with a Ø6.2 mm keep-out.
 */
export const pi5MountingHoles = (): PcbHole[] =>
  (
    [
      ['mh-1', 'MH1', 3.5, 3.5],
      ['mh-2', 'MH2', 61.5, 3.5],
      ['mh-3', 'MH3', 61.5, 52.5],
      ['mh-4', 'MH4', 3.5, 52.5],
    ] as const
  ).map(([id, name, x, y]) => ({
    id,
    name,
    at: [x, y],
    drillMm: 2.7,
    plated: false,
    keepoutMm: 6.2,
  }));

/**
 * F75 (PB1 part): a board in the Raspberry Pi 5 form factor — 85 × 56 mm, R3 corners, the four
 * mounting holes — with origin at the lower-left corner and the 40-pin header edge at the top.
 * Later stages add its parts and nets. Values from the public mechanical drawing only.
 */
export function f75Pi5Board(): PcbDocument {
  return {
    schemaVersion: 1,
    units: 'mm',
    board: board(roundedRectLoop([0, 0], 85, 56, 3), { copperLayers: 4 }),
    holes: pi5MountingHoles(),
    footprints: [],
    components: [],
    netClasses: [pcbDefaultNetClass()],
    nets: [],
    tracks: [],
    vias: [],
    zones: [],
    stack: [],
  };
}

/**
 * F75 with one part of every generator (PB7): apart from each other and the mounting holes,
 * inside the board, a few turned and two on the bottom. For the 3D model and view.
 */
export function pcbPartsSample(): PcbDocument {
  const kinds = [...pcbGenerators.keys()];
  const footprints = kinds.map((k) =>
    generateFootprint(
      k,
      k,
      k === 'pin-header' ? { rows: 2, pinsPerRow: 4 } : k === 'body' ? { x: 4, y: 3 } : {},
    ),
  );
  const at: Record<string, [x: number, y: number, deg: number, side?: 'bottom']> = {
    'pin-header': [10, 44, 0],
    chip: [30, 50, 90, 'bottom'],
    soic: [40, 30, 180, 'bottom'],
    qfn: [50, 45, 30],
    bga: [20, 25, 0],
    fpc: [35, 12, 90],
    'jst-sh': [8, 30, 180],
    'usb-c': [12, 6, 0],
    'micro-hdmi': [25, 4, 0],
    'usb-a-stack': [82.5, 34, 90],
    rj45: [82.5, 16, 90],
    body: [45, 20, 30],
  };
  const components: PcbComponent[] = kinds.map((k, i) => {
    const [x, y, deg, side = 'top'] = at[k]!;
    return {
      id: `p-${k}`,
      ref: `${pcbGenerators.get(k)!.refPrefix}${i + 1}`,
      value: 'x',
      footprint: k,
      at: [x, y],
      rotationDeg: deg,
      side,
      locked: false,
    };
  });
  return { ...f75Pi5Board(), footprints, components };
}
