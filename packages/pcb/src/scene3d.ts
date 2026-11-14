import { ShapeUtils, Vector2 } from 'three';
import type { GeometryMesh } from '@editor-platform/geometry-kernel-occt';
import type { GeometryRequest, GeometryStepRequest } from '@editor-platform/geometry-core';
import {
  arcPolygon,
  loopBounds,
  type Pcb3dMaterial,
  type Pcb3dModel,
  type PcbDocument,
  type PcbSide,
  type PcbStackPlacement,
} from '@editor-platform/pcb-core';
import type { PcbKernelOutcome } from './kernel';

/** How finely the kernel meshes the model: fine enough for 0.4 mm pitch parts. */
export const pcbMeshQuality = Object.freeze({ deflectionMm: 0.02, angularDeflectionRad: 0.35 });

export const pcbFinishOf: Record<Pcb3dMaterial, { metalness: number; roughness: number }> = {
  board: { metalness: 0, roughness: 0.65 },
  plastic: { metalness: 0, roughness: 0.55 },
  'plastic-light': { metalness: 0, roughness: 0.6 },
  metal: { metalness: 1, roughness: 0.35 },
  gold: { metalness: 1, roughness: 0.3 },
  ceramic: { metalness: 0, roughness: 0.5 },
  substrate: { metalness: 0, roughness: 0.6 },
};

/** One coloured piece with its triangles. */
export interface Pcb3dPiece {
  name: string;
  component?: string;
  material: Pcb3dMaterial;
  color: string;
  mesh: GeometryMesh;
}

export const pcbMeshRequests = (model: Pcb3dModel): GeometryRequest[] =>
  model.parts.map((p) => ({ node: p.node, mesh: { ...pcbMeshQuality } }));

/**
 * The pieces from a kernel run, in the model's order, and the ones that failed (by name).
 * A failed part does not stop the others.
 */
export function pcbPieces(
  model: Pcb3dModel,
  outcome: PcbKernelOutcome,
): { pieces: Pcb3dPiece[]; failed: string[] } | { error: string } {
  if (outcome.status === 'invalid') return { error: `invalid:${outcome.issues[0]?.code}` };
  if (outcome.status !== 'ok')
    return { error: outcome.status === 'error' ? outcome.code : outcome.status };
  const results = new Map(outcome.results.map((r) => [r.node, r]));
  const pieces: Pcb3dPiece[] = [];
  const failed: string[] = [];
  for (const p of model.parts) {
    const r = results.get(p.node);
    if (r?.status === 'ok' && r.mesh)
      pieces.push({
        name: p.name,
        ...(p.component ? { component: p.component } : {}),
        material: p.material,
        color: p.color,
        mesh: r.mesh,
      });
    else failed.push(p.name);
  }
  return { pieces, failed };
}

/** Lift of the face pictures off the board, so they draw over its faces. */
export const pcbSheetLiftMm = 0.01;

/**
 * A sheet over one face of the board, the outline's area triangulated, with texture
 * coordinates over the outline's box (the face picture's extent; v up, as glTF and Three.js
 * read an image's top row at v = 1 when not flipped).
 */
export function pcbFaceSheet(doc: PcbDocument, side: PcbSide) {
  const poly = arcPolygon(doc.board.outline, 'within');
  const [x0, y0, x1, y1] = loopBounds(doc.board.outline);
  const z = side === 'top' ? doc.board.thicknessMm + pcbSheetLiftMm : -pcbSheetLiftMm;
  const contour = poly.map(([x, y]) => new Vector2(x, y));
  const tris = ShapeUtils.triangulateShape(contour, []);
  const positions = new Float32Array(poly.length * 3);
  const normals = new Float32Array(poly.length * 3);
  const uvs = new Float32Array(poly.length * 2);
  poly.forEach(([x, y], i) => {
    positions.set([x, y, z], i * 3);
    normals.set([0, 0, side === 'top' ? 1 : -1], i * 3);
    uvs.set([(x - x0) / (x1 - x0), (y - y0) / (y1 - y0)], i * 2);
  });
  // Each triangle wound to face away from the board: up on top, down below.
  const indices = new Uint32Array(tris.length * 3);
  tris.forEach(([a, b, c], i) => {
    const [p, q, r] = [poly[a]!, poly[b]!, poly[c]!];
    const up = (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]) > 0;
    indices.set(up === (side === 'top') ? [a, b, c] : [a, c, b], i * 3);
  });
  return { positions, normals, uvs, indices };
}

/**
 * PB8: a face sheet moved as a stacked board is (`pcbStackPlacement`): positions turned and
 * lifted, normals turned.
 */
export function pcbPlacedSheet<T extends ReturnType<typeof pcbFaceSheet>>(
  sheet: T,
  place: PcbStackPlacement,
): T {
  const [a, b, , c, d] = place.rotation;
  const [tx, ty, tz] = place.translation;
  const positions = new Float32Array(sheet.positions.length);
  const normals = new Float32Array(sheet.normals.length);
  for (let i = 0; i < positions.length; i += 3) {
    const [x, y, z] = [sheet.positions[i]!, sheet.positions[i + 1]!, sheet.positions[i + 2]!];
    positions.set([a! * x + b! * y + tx, c! * x + d! * y + ty, z + tz], i);
    const [nx, ny, nz] = [sheet.normals[i]!, sheet.normals[i + 1]!, sheet.normals[i + 2]!];
    normals.set([a! * nx + b! * ny, c! * nx + d! * ny, nz], i);
  }
  return { ...sheet, positions, normals };
}

/**
 * PB7c: the board and every piece as one STEP file, in the schema asked for: one product per
 * piece, named and coloured as in the view (`Board`, `J8 shell`), under a product named for
 * the file.
 */
export const pcbStepRequest = (
  model: Pcb3dModel,
  name: string,
  schema: GeometryStepRequest['schema'] = 'ap214',
): GeometryStepRequest => ({
  schema,
  name,
  parts: model.parts.map((p) => ({ node: p.node, name: p.name, color: p.color })),
});
