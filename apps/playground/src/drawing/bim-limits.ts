import {
  bimDrawingLimits,
  bimDrawingPrimitives,
  bimDrawingSvg,
  type BimDrawing,
} from '@editor-platform/bim-core';
import { drawingBimViewState } from '@editor-platform/drawing';
import type {
  DrawingBimDrawing,
  DrawingBuildingView,
  DrawingViewState,
} from '@editor-platform/drawing-core';

/**
 * A building drawing made here (a framing plan or frame, an elevation's axes) within the
 * building editor's limits, as `drawBim` keeps its own (Codex on #1238).
 */
export function bimDrawingState(
  view: DrawingBuildingView,
  d: BimDrawing & Pick<DrawingBimDrawing, 'members'>,
): DrawingViewState {
  if (bimDrawingPrimitives(d) > bimDrawingLimits.primitives)
    return { status: 'failed', code: 'drawing-too-large' };
  try {
    bimDrawingSvg(d);
  } catch {
    return { status: 'failed', code: 'drawing-too-large' };
  }
  return drawingBimViewState(view, d);
}
