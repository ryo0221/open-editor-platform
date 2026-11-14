/**
 * The schematic's canonical content (docs/cad/circuit-simulation.md, SL1). Millimetres on the
 * sheet, x to the right and y DOWN from the sheet's top-left corner (as drawn on paper). Every
 * point lies on the 1.27 mm grid. Schema 1 is the only schema: there is no migration path.
 */

import type { SchematicModel } from './models';

export type Vec2 = [number, number];

export const schematicSchemaVersion = 1;
/** The connection grid (0.05 in). Every point of a part, pin, wire, label or junction is on it. */
export const schematicGridMm = 1.27;

export const schematicSheetSizes = ['A4', 'A3', 'A2'] as const;
export type SchematicSheetSize = (typeof schematicSheetSizes)[number];
export const schematicOrientations = ['landscape', 'portrait'] as const;
export type SchematicOrientation = (typeof schematicOrientations)[number];
/** ISO 216 sheet sides in mm, landscape (width, height). */
export const schematicSheetMm: Record<SchematicSheetSize, Vec2> = {
  A4: [297, 210],
  A3: [420, 297],
  A2: [594, 420],
};

export interface SchematicSheet {
  size: SchematicSheetSize;
  orientation: SchematicOrientation;
  title: string;
}

/**
 * A pin's electrical type (SL2 checks them in the ERC; SL1 keeps them). `power-in` takes a
 * supply, `power-out` gives one; `passive` is either end of a resistor and the like.
 */
export const schematicPinTypes = [
  'input',
  'output',
  'bidirectional',
  'tristate',
  'passive',
  'power-in',
  'power-out',
  'open-collector',
  'no-connect',
] as const;
export type SchematicPinType = (typeof schematicPinTypes)[number];
/** Which way the pin's line runs from its connection end into the symbol's body. */
export const schematicPinSides = ['left', 'right', 'up', 'down'] as const;
export type SchematicPinSide = (typeof schematicPinSides)[number];

/** A pin in its symbol's frame. `at` is the connection end, on the grid. */
export interface SchematicPin {
  /** Unique in the symbol ("1", "A", "K", "GND"). */
  number: string;
  name: string;
  at: Vec2;
  /** The pin's line goes from `at` this way, `lengthMm` long, to the body. */
  side: SchematicPinSide;
  lengthMm: number;
  type: SchematicPinType;
}

/** The symbol's drawing in its own frame (not connected to anything). */
export type SchematicGraphic =
  | { kind: 'line'; points: Vec2[] }
  | { kind: 'rect'; from: Vec2; to: Vec2; filled: boolean }
  | { kind: 'circle'; center: Vec2; radiusMm: number; filled: boolean }
  | { kind: 'polygon'; points: Vec2[]; filled: boolean }
  | { kind: 'text'; at: Vec2; text: string; sizeMm: number };

/** The parametric shape a symbol was generated from (SL2), kept so it can be regenerated. */
export interface SchematicGenerator {
  kind: string;
  params: Record<string, number | string | boolean>;
}

/** A symbol definition, held in the document (no outside library is read). */
export interface SchematicSymbol {
  id: string;
  name: string;
  /** Reference prefix for new parts ("R", "D", "U"). */
  prefix: string;
  pins: SchematicPin[];
  graphics: SchematicGraphic[];
  generator?: SchematicGenerator;
}

export const schematicRotations = [0, 90, 180, 270] as const;
export type SchematicRotation = (typeof schematicRotations)[number];

/** A footprint by its `pcb-core` generator and parameters: the board makes it from these (SL3). */
export interface SchematicFootprintRef {
  generator: string;
  params: Record<string, number | string>;
}

/** A placed symbol: the symbol's frame is mirrored (x → −x) first, then turned, then moved. */
export interface SchematicPart {
  id: string;
  /** Reference designator, unique in the sheet ("R1"). */
  ref: string;
  value: string;
  symbol: string;
  at: Vec2;
  /** Clockwise as seen on the sheet (y down), in degrees. */
  rotationDeg: SchematicRotation;
  mirror: boolean;
  /** The footprint the board places for this part (SL2). */
  footprint?: SchematicFootprintRef;
  /** With `footprint` only: every pin number of the symbol → a pad number of the footprint. */
  pinMap?: Record<string, string>;
  /** The part to the circuit calculation; without one, the calculation leaves it out (SL4). */
  model?: SchematicModel;
  /** Pins meant to stay unconnected: the ERC does not report them (SL2). */
  noConnect?: string[];
}

/** A wire: an orthogonal polyline of 2+ grid points. */
export interface SchematicWire {
  id: string;
  points: Vec2[];
}
/** Joins every wire, pin and label that passes through its point. */
export interface SchematicJunction {
  id: string;
  at: Vec2;
}
/** A net label: everything at its point, and every label of the same name, is one net. */
export interface SchematicLabel {
  id: string;
  name: string;
  at: Vec2;
  rotationDeg: SchematicRotation;
}
export const schematicPowerStyles = ['ground', 'rail'] as const;
export type SchematicPowerStyle = (typeof schematicPowerStyles)[number];
/** A power port: like a label, named after its supply ("GND", "3V3"); its name names the net. */
export interface SchematicPower {
  id: string;
  name: string;
  at: Vec2;
  rotationDeg: SchematicRotation;
  style: SchematicPowerStyle;
}

export interface SchematicDocument {
  schemaVersion: 1;
  units: 'mm';
  sheet: SchematicSheet;
  symbols: SchematicSymbol[];
  parts: SchematicPart[];
  wires: SchematicWire[];
  junctions: SchematicJunction[];
  labels: SchematicLabel[];
  powers: SchematicPower[];
}

export interface SchematicDiagnostic {
  code: string;
  path: string;
  severity: 'error' | 'warning';
  id?: string;
  firstPath?: string;
}

/** Initial safety limits (refused as `limit-*`); not performance promises. */
export const schematicLimits = Object.freeze({
  idCodePoints: 128,
  nameCodePoints: 256,
  jsonDepth: 16,
  symbols: 500,
  pinsPerSymbol: 512,
  graphicsPerSymbol: 512,
  pointsPerGraphic: 256,
  parts: 2000,
  wires: 10000,
  pointsPerWire: 256,
  junctions: 10000,
  labels: 5000,
  powers: 5000,
  /** |x|, |y| of a symbol's own drawing. */
  symbolExtentMm: 200,
  maxPinLengthMm: 25.4,
  maxTextMm: 20,
  contentBytes: 8 * 1024 * 1024,
});

/** The sheet's drawable size in mm (width, height) for its orientation. */
export function schematicSheetSize(sheet: SchematicSheet): Vec2 {
  const [w, h] = schematicSheetMm[sheet.size];
  return sheet.orientation === 'landscape' ? [w, h] : [h, w];
}
