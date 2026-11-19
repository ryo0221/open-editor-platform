/// <reference lib="webworker" />
/**
 * DW2: projects bodies off the main thread. One request at a time; the answer carries the
 * request's ID so a superseded one is ignored by the caller.
 */
import {
  drawingProject,
  DrawingProjectionError,
  type DrawingDirection,
  type DrawingMeshBody,
  type DrawingProjectOptions,
  type DrawingViewFrame,
} from '@editor-platform/drawing-core';

export interface DrawingProjectRequest {
  id: number;
  bodies: DrawingMeshBody[];
  direction: DrawingDirection | DrawingViewFrame;
  options: DrawingProjectOptions;
}

const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = (e: MessageEvent<DrawingProjectRequest>) => {
  const { id, bodies, direction, options } = e.data;
  try {
    scope.postMessage({ id, view: drawingProject(bodies, direction, options) });
  } catch (err) {
    scope.postMessage({
      id,
      code: err instanceof DrawingProjectionError ? err.code : 'project-failed',
    });
  }
};
