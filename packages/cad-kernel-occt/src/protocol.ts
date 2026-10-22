import type { CadDocument, CadEvaluation } from '@editor-platform/cad-core';

/** Host-verified kernel build. The Worker fetches nothing else and runs no other code. */
export interface CadKernelBuild {
  /** `sha256:<hex>` of the Wasm bytes; equals `kernelProfile.buildHash` of documents it may evaluate. */
  buildHash: string;
  /** Emscripten module factory (ES module default export) that accepts `{ wasmBinary }`. */
  moduleUrl: string;
  wasmUrl: string;
}
/**
 * Per body, triangles in model space. `faceIds[t]` is the evaluation-scoped pick id of triangle t.
 * `positions` are relative to `origin` (model-space mm, full precision): add it back to place them.
 */
export interface CadMesh {
  bodyId: string;
  origin: [number, number, number];
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  faceIds: Uint32Array;
}
export type CadWorkerRequest =
  | { type: 'init'; build: CadKernelBuild }
  | {
      type: 'evaluate';
      requestId: string;
      generation: number;
      baseHash: string;
      candidateHash: string;
      document: CadDocument;
    }
  | { type: 'cancel'; requestId: string };
export type CadWorkerResponse =
  | { type: 'ready'; buildHash: string }
  | { type: 'init-failed'; code: string }
  | {
      type: 'result';
      requestId: string;
      generation: number;
      evaluation: CadEvaluation;
      meshes: CadMesh[];
    }
  | { type: 'cancelled'; requestId: string };

/** Initial evaluation output limits (docs/cad/model.md). Exceeding them is an explicit error. */
export const cadOutputLimits = Object.freeze({
  faces: 50_000,
  triangles: 500_000,
  bufferBytes: 64 * 1024 * 1024,
});
export const meshBytes = (meshes: readonly CadMesh[]) =>
  meshes.reduce(
    (n, m) =>
      n +
      m.positions.byteLength +
      m.normals.byteLength +
      m.indices.byteLength +
      m.faceIds.byteLength,
    0,
  );
