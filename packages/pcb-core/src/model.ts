/**
 * The printed circuit board (PCB) domain's canonical content (docs/cad/pcb-design.md, PB1).
 * Millimetres; plan coordinates with x to the right and y up, seen from the top (front) side.
 * Schema 1 is the only schema: there is no migration path.
 */

export type Vec2 = [number, number];
/**
 * A loop vertex: `[x, y]`, or `[x, y, bulge]` when the side to the next vertex is a circular
 * arc. `bulge` is tan(θ / 4) of the arc's sweep θ (positive counter-clockwise),
 * 0 < |bulge| ≤ 1, as in `geometry-core`. A loop is closed: the last vertex joins the first.
 */
export type PcbLoopVertex = [number, number] | [number, number, number];
export type PcbLoop = PcbLoopVertex[];

export const pcbSchemaVersion = 1;

/** Copper layer counts a board may have. */
export const pcbCopperCounts = [2, 4, 6, 8] as const;
export type PcbCopperCount = (typeof pcbCopperCounts)[number];
export const pcbMaskColors = ['green', 'red', 'blue', 'black', 'white', 'purple'] as const;
export type PcbMaskColor = (typeof pcbMaskColors)[number];
export const pcbSilkColors = ['white', 'black'] as const;
export type PcbSilkColor = (typeof pcbSilkColors)[number];
export const pcbFinishes = ['hasl', 'enig'] as const;
export type PcbFinish = (typeof pcbFinishes)[number];

export interface PcbBoard {
  /** The board's edge (Edge.Cuts): one simple loop. */
  outline: PcbLoop;
  /** Slots and cut-outs through the board: simple loops inside the outline, apart. */
  cutouts: PcbLoop[];
  /** Finished board thickness. */
  thicknessMm: number;
  copperLayers: PcbCopperCount;
  maskColor: PcbMaskColor;
  silkColor: PcbSilkColor;
  finish: PcbFinish;
  /** Copper kept this far from the board's edge and cut-outs (zones keep it; DRC checks it). */
  edgeClearanceMm: number;
  /** Copper of another net kept this far from a drilled hole's wall (NPTH, mounting holes). */
  holeClearanceMm: number;
  /** DRC (PB5): the narrowest track, smallest drill and thinnest annular ring allowed. */
  minTrackWidthMm: number;
  minDrillMm: number;
  minAnnularRingMm: number;
}

/** A drilled hole that belongs to the board, not to a part (a mounting hole). */
export interface PcbHole {
  id: string;
  name: string;
  at: Vec2;
  drillMm: number;
  plated: boolean;
  /**
   * Diameter kept free around the hole on every copper layer (a mounting hole's land or
   * keep-out); 0 for none, else larger than the drill.
   */
  keepoutMm: number;
}

export const pcbPadShapes = ['circle', 'rect', 'oval', 'roundrect'] as const;
export type PcbPadShape = (typeof pcbPadShapes)[number];
export const pcbPadTypes = ['smd', 'thru', 'npth'] as const;
/**
 * `smd`: copper on the part's side only (with mask opening and paste); `thru`: a plated hole
 * with copper on every copper layer; `npth`: an unplated hole, no copper.
 */
export type PcbPadType = (typeof pcbPadTypes)[number];

/** A pad in its footprint's frame (mm; the footprint's origin is its placement point). */
export interface PcbPad {
  /** Pin number or name, unique in the footprint ("1", "A1", "EP"). */
  number: string;
  type: PcbPadType;
  shape: PcbPadShape;
  at: Vec2;
  /** Width (x) and height (y) before `rotationDeg`. A circle has equal sides. */
  size: Vec2;
  /** Multiples of 90° only. */
  rotationDeg: number;
  /** `thru` and `npth` only: round drill. */
  drillMm?: number;
  /** `roundrect` only: corner radius as a fraction of the shorter side, (0, 0.5]. */
  roundness?: number;
}

/** A drawn line on the footprint's silkscreen (or fabrication) layer, in the footprint frame. */
export interface PcbSilkLine {
  kind: 'line';
  from: Vec2;
  to: Vec2;
  widthMm: number;
}
export interface PcbSilkCircle {
  kind: 'circle';
  center: Vec2;
  radiusMm: number;
  widthMm: number;
  filled: boolean;
}
export type PcbSilk = PcbSilkLine | PcbSilkCircle;

/**
 * The parametric shape a footprint was generated from (PB2): kept so its 3D body (PB7) and a
 * regenerated footprint follow the same numbers. `params` are the generator's own.
 */
export interface PcbGenerator {
  kind: string;
  params: Record<string, number | string | boolean>;
}

export interface PcbFootprint {
  id: string;
  name: string;
  pads: PcbPad[];
  silk: PcbSilk[];
  /** The area the part needs on the board, in the footprint frame: one simple loop. */
  courtyard: PcbLoop;
  /** Height of the part's body above the board (for the 3D view and checks), mm. */
  heightMm: number;
  generator?: PcbGenerator;
}

export const pcbSides = ['top', 'bottom'] as const;
export type PcbSide = (typeof pcbSides)[number];

/** A part placed on the board. */
export interface PcbComponent {
  id: string;
  /** Reference designator, unique on the board ("U1", "R3", "J8"). */
  ref: string;
  value: string;
  footprint: string;
  at: Vec2;
  /** Counter-clockwise, seen from the top; any angle in [0, 360). */
  rotationDeg: number;
  /** `bottom` mirrors the footprint in x (seen from the top) before rotating. */
  side: PcbSide;
  locked: boolean;
}

/**
 * Design rules for the nets of one class (PB3): the routing width and spacing (PB4–PB5 use
 * them) and the via a route of this class drops.
 */
export interface PcbNetClass {
  id: string;
  name: string;
  trackWidthMm: number;
  clearanceMm: number;
  viaDiameterMm: number;
  viaDrillMm: number;
}

/** A pad of a placed part: the part's ID and the pad's number in its footprint. */
export type PcbPinRef = [component: string, pad: string];

/** A net (PB3): the pads that must be joined in copper. A pad belongs to one net at most. */
export interface PcbNet {
  id: string;
  /** Unique on the board ("GND", "3V3", "GPIO2"). */
  name: string;
  /** The ID of its net class. */
  class: string;
  pins: PcbPinRef[];
}

/** A straight copper track segment on one copper layer (PB4); ends are round. */
export interface PcbTrack {
  id: string;
  /** The net it carries. */
  net: string;
  /** A copper layer name of the board ("F.Cu", "In1.Cu", "B.Cu"). */
  layer: string;
  widthMm: number;
  from: Vec2;
  to: Vec2;
}

/** A plated through via (PB4): copper on every layer around a drilled hole. */
export interface PcbVia {
  id: string;
  net: string;
  at: Vec2;
  diameterMm: number;
  drillMm: number;
}

export const pcbPadConnections = ['thermal', 'solid'] as const;
export type PcbPadConnection = (typeof pcbPadConnections)[number];

/**
 * A copper zone (pour) of one net on one copper layer (PB4b). Only its outline is stored; the
 * copper is derived by `pcbZoneFills`, clear of the board edge, holes and other nets' copper.
 */
export interface PcbZone {
  id: string;
  net: string;
  layer: string;
  /** The area to fill: one simple loop. */
  outline: PcbLoop;
  /** Higher fills first; a lower zone of another net keeps clear of a higher one's outline. */
  priority: number;
  /** Least gap to other nets' copper (a net class may ask for more). */
  clearanceMm: number;
  /** How pads of the zone's net join it: by spokes across a gap, or solid. */
  padConnection: PcbPadConnection;
  thermalGapMm: number;
  spokeWidthMm: number;
}

/**
 * PB8: another board drawn above this one in 3D, such as a HAT on the 40-pin header: an exact
 * saved version of another board, placed. Only the 3D view and its GLB/STEP read it; DRC,
 * fabrication files and the BOM are this board's alone.
 */
export interface PcbStackedBoard {
  id: string;
  name: string;
  /** The other board's exact version (as a building names a CAD part version). */
  source: { artifactId: string; versionId: string; contentHash: string };
  /** Where the other board's origin lands, seen from the top, and its turn (degrees, CCW). */
  at: Vec2;
  rotationDeg: number;
  /** From this board's top face to the other board's bottom face, mm. */
  gapMm: number;
}

export interface PcbDocument {
  schemaVersion: 1;
  units: 'mm';
  board: PcbBoard;
  holes: PcbHole[];
  footprints: PcbFootprint[];
  components: PcbComponent[];
  /** At least one; nets name one of them. */
  netClasses: PcbNetClass[];
  nets: PcbNet[];
  tracks: PcbTrack[];
  vias: PcbVia[];
  zones: PcbZone[];
  stack: PcbStackedBoard[];
}

export interface PcbDiagnostic {
  code: string;
  path: string;
  severity: 'error';
  id?: string;
  firstPath?: string;
}

/** Initial safety limits (refused as `limit-*`); not performance promises. */
export const pcbLimits = Object.freeze({
  /** |x|, |y| of any coordinate. */
  coordinateMm: 2000,
  /** Board outline's bounding box side. */
  boardSideMm: 1000,
  minDimensionMm: 0.001,
  minThicknessMm: 0.2,
  maxThicknessMm: 6,
  minDrillMm: 0.1,
  maxDrillMm: 20,
  loopVertices: 512,
  cutouts: 256,
  holes: 1000,
  footprints: 500,
  components: 2000,
  padsPerFootprint: 2000,
  pads: 20000,
  silkPerFootprint: 500,
  minPadMm: 0.05,
  netClasses: 64,
  nets: 4000,
  pinsPerNet: 2000,
  tracks: 50000,
  vias: 10000,
  zones: 256,
  /** Boards drawn above this one (PB8). */
  stack: 8,
  stackGapMm: 100,
  zonePriority: 100,
  /** Track widths, clearances and via sizes of a net class. */
  minRuleMm: 0.05,
  maxRuleMm: 10,
  maxPadMm: 50,
  refCodePoints: 32,
  idCodePoints: 128,
  nameCodePoints: 256,
  jsonDepth: 32,
  /** Canonical content bytes. */
  contentBytes: 16 * 1024 * 1024,
});

/** Lengths closer than this are equal (1 nm). */
export const pcbTolerance = 1e-6;

/** The layers a board has, in stack order from the top (KiCad-style names). */
export function pcbCopperLayerNames(count: PcbCopperCount): string[] {
  const inner = Array.from({ length: count - 2 }, (_, i) => `In${i + 1}.Cu`);
  return ['F.Cu', ...inner, 'B.Cu'];
}
export function pcbLayerNames(count: PcbCopperCount): string[] {
  return [
    'F.SilkS',
    'F.Paste',
    'F.Mask',
    ...pcbCopperLayerNames(count),
    'B.Mask',
    'B.Paste',
    'B.SilkS',
    'Edge.Cuts',
  ];
}
