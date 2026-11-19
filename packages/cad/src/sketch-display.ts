import {
  rotateVector,
  sketchElement,
  sketchElementPoints,
  type CadDocument,
  type Vec3,
} from '@editor-platform/cad-core';
import { frameOf } from './sketch-underlay';

/**
 * CLF11 (docs/cad/car-look-process.md, CLF9〜CLF11): the sketches shown in the 3D view and the
 * drawing board, in model space. Each curve as a polyline in its colour (CLF9), each note as a
 * text on its plane (CLF10). Display only: which sketches are shown is view state, never stored.
 */
export interface CadSketchDisplay {
  lines: {
    sketchId: string;
    element: string;
    /** `#rrggbb`: the curve's own colour or the sketch canvas's default. */
    color: string;
    construction: boolean;
    points: Vec3[];
    /** The sketch plane's normal (unit), for the board's panes that face it. */
    normal: Vec3;
  }[];
  notes: {
    sketchId: string;
    id: string;
    text: string;
    /** Text height, mm. */
    size: number;
    color: string;
    /** The baseline's start, and the plane's u and v directions (unit). */
    at: Vec3;
    u: Vec3;
    v: Vec3;
    normal: Vec3;
  }[];
}

/** The sketch canvas's default line colour (style.css), used where a curve has none. */
export const sketchInk = '#1d2733';

/**
 * The display of the sketches in `shown` (by ID) that lie on a datum plane; a sketch on a face
 * has no frame outside the kernel's evaluation and is left out.
 */
export function sketchDisplay(doc: CadDocument, shown: ReadonlySet<string>): CadSketchDisplay {
  const out: CadSketchDisplay = { lines: [], notes: [] };
  for (const sketch of doc.sketches) {
    if (!shown.has(sketch.id)) continue;
    const frame = frameOf(doc, sketch);
    if (!frame) continue;
    const place = (u: number, v: number): Vec3 => {
      const w = rotateVector(frame.orientation, [u, v, 0]);
      return [w[0] + frame.origin[0], w[1] + frame.origin[1], w[2] + frame.origin[2]];
    };
    const normal = rotateVector(frame.orientation, [0, 0, 1]);
    for (const entity of sketch.entities) {
      if (entity.type === 'point') continue;
      const e = sketchElement(sketch, entity.id);
      if (!e) continue;
      out.lines.push({
        sketchId: sketch.id,
        element: entity.id,
        color: entity.color ?? sketchInk,
        construction: !!entity.construction,
        points: sketchElementPoints(e).map(([u, v]) => place(u, v)),
        normal,
      });
    }
    const u = rotateVector(frame.orientation, [1, 0, 0]);
    const v = rotateVector(frame.orientation, [0, 1, 0]);
    for (const n of sketch.notes ?? [])
      out.notes.push({
        sketchId: sketch.id,
        id: n.id,
        text: n.text,
        size: n.size,
        color: n.color ?? sketchInk,
        at: place(n.at[0], n.at[1]),
        u,
        v,
        normal,
      });
  }
  return out;
}
