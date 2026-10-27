import type { GeometryGraph, GeometryRequest } from '@editor-platform/geometry-core';
import type { GeometryEvaluation, KernelBuild } from '@editor-platform/geometry-kernel-occt';

/** Messages to the bim kernel Worker: one batch of the element graph per `run`. */
export type BimWorkerRequest =
  | { type: 'init'; build: KernelBuild }
  | {
      type: 'run';
      requestId: string;
      graph: GeometryGraph;
      requests: GeometryRequest[];
      /** Normalized BRep assets (parts) by key. */
      assets: Record<string, Uint8Array>;
    }
  | { type: 'cancel'; requestId: string };

export type BimWorkerResponse =
  | { type: 'ready'; buildHash: string }
  | { type: 'init-failed'; code: 'kernel-load-failed' }
  | { type: 'result'; requestId: string; evaluation: GeometryEvaluation }
  | { type: 'cancelled'; requestId: string };
