import {
  drawingBimViewGraphics,
  drawingCadViewGraphics,
  drawingIsBuildingView,
  drawingScaleFactor,
  drawingViewSpec,
  type DrawingBimDrawing,
  type DrawingBuildingView,
  type DrawingDocument,
  type DrawingPartsInfo,
  type DrawingPmiLive,
  type DrawingProjectedView,
  type DrawingProjectOptions,
  type DrawingView,
  type DrawingViewFrame,
  type DrawingViewSpec,
  type DrawingViewState,
  type Vec2,
} from '@editor-platform/drawing-core';

/** One projection a view needs: what the Host's projector runs (DW2, DW2b). */
export interface DrawingProjectionJob {
  spec: DrawingViewSpec;
  frame: DrawingViewFrame;
  options: DrawingProjectOptions;
  /** Equal for jobs with equal projections: a moved view, or a view and its twin, share one. */
  key: string;
}

/**
 * The projection job of a view: its spec, and about 0.25 mm on paper per visibility sample at
 * the view's own scale (a detail at its scale, only over its circle).
 */
export function drawingProjectionJob(
  doc: DrawingDocument,
  view: DrawingView,
  sourceHash: string,
): DrawingProjectionJob | { code: string } {
  const spec = drawingViewSpec(doc, view);
  if ('code' in spec) return spec;
  const step = 0.25 / drawingScaleFactor(view.scale);
  const window: [Vec2, Vec2] | undefined = spec.clip && [
    [spec.clip.center[0] - spec.clip.radius - step, spec.clip.center[1] - spec.clip.radius - step],
    [spec.clip.center[0] + spec.clip.radius + step, spec.clip.center[1] + spec.clip.radius + step],
  ];
  const options: DrawingProjectOptions = {
    step,
    hidden: spec.hidden,
    centers: spec.centers,
    ...(spec.cut ? { cut: spec.cut } : {}),
    ...(window ? { window } : {}),
  };
  return {
    spec,
    frame: spec.frame,
    options,
    key: JSON.stringify([sourceHash, spec.only, spec.frame, options]),
  };
}

/** The derive key of a view: its projection and where it sits on the paper. */
export function drawingDeriveKey(doc: DrawingDocument, view: DrawingView, sourceHash: string) {
  // A building's view: its version, which of its views, at what scale and where (DW5a).
  if (drawingIsBuildingView(view)) {
    const {
      id: _id,
      sheetId: _sheet,
      name: _name,
      label: _label,
      sourceId: _source,
      ...what
    } = view;
    return JSON.stringify(['bim', sourceHash, what]);
  }
  const job = drawingProjectionJob(doc, view, sourceHash);
  return JSON.stringify(['code' in job ? job.code : job.key, view.scale, view.at]);
}

/** A view's graphics from its projection. */
export function drawingViewState(
  view: DrawingView,
  job: DrawingProjectionJob,
  projected: DrawingProjectedView,
  /**
   * DW3c-2b: the PMI items of the bodies the view shows (none when its parts have no PMI). A
   * Host that reads no PMI passes none, and imported PMI annotations then stay pending.
   */
  pmi?: DrawingPmiLive[],
  /** DW4: the parts of the version the view shows (its flat BOM), for balloons and the list. */
  parts?: DrawingPartsInfo,
): DrawingViewState {
  const { items, bounds, frame, features } = drawingCadViewGraphics(
    { at: view.at, scale: view.scale, hiddenLines: job.spec.hidden, centerLines: job.spec.centers },
    projected,
    job.spec.clip,
  );
  return {
    status: 'ready',
    graphics: {
      items,
      bounds,
      ...(frame ? { frame } : {}),
      ...(features ? { features } : {}),
      ...(pmi ? { pmi } : {}),
      ...(parts ? { parts } : {}),
    },
  };
}

/** DW5a: a building view's graphics from the building editor's drawing of it. */
export function drawingBimViewState(
  view: DrawingBuildingView,
  drawing: DrawingBimDrawing,
): DrawingViewState {
  return { status: 'ready', graphics: drawingBimViewGraphics(view, drawing) };
}
