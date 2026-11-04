import type { EpmMesh } from '@editor-platform/geometry-mesh';

/** A subdivision asked of the worker (C3i). */
export interface SubdivisionRequest {
  id: number;
  mesh: EpmMesh;
  levels: number;
}
/** Its answer: the smoothed mesh, or why the cage cannot be smoothed. */
export type SubdivisionResponse =
  | { id: number; status: 'done'; mesh: EpmMesh }
  | { id: number; status: 'refused'; problem: string; detail: string }
  | { id: number; status: 'failed'; message: string };

/** The buffers of a mesh, to transfer instead of copy. */
export function meshBuffers(mesh: EpmMesh): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  const add = (a: ArrayBufferView | undefined) => {
    if (a && a.buffer instanceof ArrayBuffer) out.add(a.buffer);
  };
  add(mesh.positions);
  add(mesh.faceSizes);
  add(mesh.faceIndices);
  add(mesh.faceMaterials);
  add(mesh.uvs);
  add(mesh.creases?.edges);
  add(mesh.creases?.values);
  add(mesh.weights?.offsets);
  add(mesh.weights?.bones);
  add(mesh.weights?.values);
  for (const m of mesh.morphs) add(m.deltas);
  return [...out];
}
