import { useEffect, useRef, useState, type RefObject } from 'react';
import { type Bounds } from '@editor-platform/editor-core';
import { fitGraphView, type GraphCamera, type GraphNodeSize } from './display';
import { formatGraphDiagnostic, type GraphLocale } from './diagnostics';
import { type GraphDocument } from './model';
import { GraphValidationError, type GraphProfile } from './profile';
import { graphCommand, type GraphIntent } from './commands';
import { initialGraphCamera } from './view-model';

export interface GraphLatest {
  graph: GraphDocument;
  profile: GraphProfile;
  stamp: string;
  readOnly: boolean;
  onEdit: (intents: GraphIntent[], base: string) => void | boolean;
}

/** Validates and submits intents against the latest rendered projection. */
/** An edit refusal in the Surface's words: a blocking diagnostic is formatted for the locale. */
export const graphEditErrorMessage = (e: unknown, profile: GraphProfile, locale: GraphLocale) =>
  e instanceof GraphValidationError
    ? formatGraphDiagnostic(e.diagnostic, e.graph, profile, locale)
    : (e as Error).message;

export function useGraphApply(
  current: GraphLatest & {
    locale: GraphLocale;
    onError?: (message: string) => void;
    setError: (message: string) => void;
  },
) {
  const { graph, profile, stamp, readOnly, onEdit, locale, onError, setError } = current;
  const latest = useRef<GraphLatest>({ graph, profile, stamp, readOnly, onEdit });
  latest.current = { graph, profile, stamp, readOnly, onEdit };
  function apply(intents: GraphIntent[], base = stamp): boolean {
    try {
      const current = latest.current;
      if (current.readOnly) throw new Error('Graph is read only');
      if (base !== current.stamp) throw new Error('Stale Graph projection; reload current values');
      graphCommand(current.profile, intents).apply(current.graph);
      if (current.onEdit(intents, base) === false) return false;
      setError('');
      return true;
    } catch (e) {
      const message = graphEditErrorMessage(e, profile, locale);
      setError(message);
      onError?.(message);
      return false;
    }
  }
  return { latest, apply };
}

export function useClearGesturesWhenReadOnly(readOnly: boolean, clear: () => void) {
  useEffect(() => {
    if (readOnly) clear();
  }, [readOnly]);
}

export function useSelectionFallback(
  graph: GraphDocument,
  selected: string,
  setLocalSelection: (id: string) => void,
  select: (id: string) => void,
) {
  useEffect(() => {
    if (
      selected !== graph.id &&
      !graph.nodes.some((n) => n.id === selected) &&
      !graph.edges.some((e) => e.id === selected) &&
      !graph.sections.some((s) => s.id === selected)
    ) {
      setLocalSelection(graph.id);
      select(graph.id);
    }
  }, [graph.id, graph.nodes, graph.edges, graph.sections, selected, select]);
}

export function useGraphNodeType(profile: GraphProfile) {
  const [nodeType, setNodeType] = useState(Object.keys(profile.nodes)[0] ?? '');
  useEffect(() => {
    if (!Object.hasOwn(profile.nodes, nodeType)) setNodeType(Object.keys(profile.nodes)[0] ?? '');
  }, [profile, nodeType]);
  return [nodeType, setNodeType] as const;
}

/** The type chosen for Add section, kept to a type the current Profile still declares. */
export function useGraphSectionType(profile: GraphProfile) {
  const [sectionType, setSectionType] = useState(Object.keys(profile.sections)[0] ?? '');
  useEffect(() => {
    if (!Object.hasOwn(profile.sections, sectionType))
      setSectionType(Object.keys(profile.sections)[0] ?? '');
  }, [profile, sectionType]);
  return [sectionType, setSectionType] as const;
}

export interface GraphCameraInput {
  graphId: string;
  canvas: RefObject<HTMLDivElement | null>;
  viewport: GraphNodeSize;
  drawingBounds: Bounds[];
  initialView: 'origin' | 'fit' | GraphCamera;
  fitOnFilterChange: boolean;
  filterKey: string;
  visibleCount: number;
  labelsMeasured: boolean;
  nodesMeasured: boolean;
}

interface CameraSetup {
  graphId: string;
  initialized: boolean;
  filter: string;
}

function deferAutomaticFit(setup: CameraSetup, input: GraphCameraInput) {
  const { labelsMeasured, nodesMeasured, initialView, filterKey, fitOnFilterChange } = input;
  return (
    (!labelsMeasured || !nodesMeasured) &&
    ((!setup.initialized && initialView === 'fit') ||
      (setup.initialized && setup.filter !== filterKey && fitOnFilterChange))
  );
}

/** Zoom and pan state with the one-time initial view and optional refit on filter changes. */
export function useGraphCamera(input: GraphCameraInput) {
  const { graphId, canvas, viewport, drawingBounds, initialView, fitOnFilterChange } = input;
  const { filterKey, visibleCount, labelsMeasured, nodesMeasured } = input;
  const [zoom, setZoom] = useState(1),
    [pan, setPan] = useState({ x: 0, y: 0 });
  const cameraSetup = useRef<CameraSetup>({ graphId: '', initialized: false, filter: '' });
  const show = (view: GraphCamera) => {
    setZoom(view.zoom);
    setPan({ x: view.x, y: view.y });
    if (canvas.current) {
      canvas.current.scrollLeft = 0;
      canvas.current.scrollTop = 0;
    }
  };
  /** The whole drawing, or only the given boxes (such as one Section's frame). */
  function fit(boxes: Bounds[] = drawingBounds) {
    show(fitGraphView(boxes, viewport));
  }
  useEffect(() => {
    if (!viewport.width || !viewport.height) return;
    const setup = cameraSetup.current;
    if (setup.graphId !== graphId) {
      setup.graphId = graphId;
      setup.initialized = false;
    }
    // A retained Surface already has a viewport when new labels first render.
    // Defer only a pending automatic Fit until their actual glyph bounds arrive.
    if (deferAutomaticFit(setup, input)) return;
    if (!setup.initialized) {
      if (initialView === 'fit' && !visibleCount) return;
      setup.initialized = true;
      if (initialView === 'fit') fit();
      else show(initialGraphCamera(initialView));
    } else if (setup.filter !== filterKey && fitOnFilterChange) fit();
    setup.filter = filterKey;
  }, [
    graphId,
    filterKey,
    fitOnFilterChange,
    initialView,
    viewport.width,
    viewport.height,
    visibleCount,
    labelsMeasured,
    nodesMeasured,
  ]);
  return { zoom, setZoom, pan, setPan, fit };
}
