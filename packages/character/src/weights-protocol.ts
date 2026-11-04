import type { EpmMesh, WeightBone } from '@editor-platform/geometry-mesh';

/** Automatic weights asked of the worker (C5b). */
export interface WeightsRequest {
  id: number;
  mesh: EpmMesh;
  bones: WeightBone[];
  boneIds: string[];
}
/** Progress (bones solved), then the weighted mesh or why it could not be weighted. */
export type WeightsResponse =
  | { id: number; status: 'progress'; done: number; total: number }
  | { id: number; status: 'done'; mesh: EpmMesh }
  | { id: number; status: 'refused'; problem: string; detail: string }
  | { id: number; status: 'failed'; message: string };
