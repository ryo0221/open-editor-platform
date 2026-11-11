import {
  BakeError,
  bakeNormalMap,
  encodeRgbPng,
  multiresBase,
  multiresFrames,
  multiresPositions,
  type EpmMesh,
} from '@editor-platform/geometry-mesh';

/** A normal-map bake asked of the worker (C7d): the cage, its multires and the map's size. */
export interface BakeRequest {
  id: number;
  cage: EpmMesh;
  level: number;
  displacements: Float32Array;
  size: number;
}
export interface BakeDone {
  png: Uint8Array;
  size: number;
  covered: number;
  missed: number;
}
/** Its answers: progress while it runs, then the PNG or why it cannot be baked. */
export type BakeResponse =
  | { id: number; status: 'progress'; rows: number; size: number }
  | ({ id: number; status: 'done' } & BakeDone)
  | {
      id: number;
      status: 'refused';
      problem: BakeError['problem'];
      detail: string;
      faces: number[];
    }
  | { id: number; status: 'failed'; message: string };

/** The whole bake (worker or main thread): the sculpted surface, the bake, the PNG. */
export async function runBake(
  request: Omit<BakeRequest, 'id'>,
  progress?: (rows: number, size: number) => boolean | void,
  /** Measurement only (C7e): each phase's time (ms), the multires surface and the PNG included. */
  timing?: (phase: string, ms: number) => void,
): Promise<BakeDone> {
  let t = timing ? performance.now() : 0;
  const base = multiresBase(request.cage, request.level);
  const frames = multiresFrames(base);
  const positions = multiresPositions(base, frames, request.displacements);
  if (timing) timing('surface', performance.now() - t);
  const r = bakeNormalMap({
    cage: request.cage,
    high: { positions, quads: base.quads },
    size: request.size,
    ...(progress ? { progress } : {}),
    ...(timing ? { timing } : {}),
  });
  t = timing ? performance.now() : 0;
  const png = await encodeRgbPng(r.rgb, r.size, r.size);
  if (timing) timing('png', performance.now() - t);
  return { png, size: r.size, covered: r.covered, missed: r.missed };
}
