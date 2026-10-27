import { canonicalJson } from '@editor-platform/artifact-core';
import { type Bounds } from '@editor-platform/editor-core';
import { type GraphAttributeDraft } from './attribute-draft';
import {
  fitGraphRoutesToShapes,
  routeGraphEdge,
  separateGraphRoutes,
  type GraphRoute,
  type GraphRouteEnds,
} from './routing';
import { graphShapeHeight, resolveGraphNodeLook, type GraphNodeLook } from './shape';
import {
  graphNodeSize,
  placeMeasuredGraphEdgeLabels,
  type GraphCamera,
  type GraphEdgeLabel,
  type GraphNodeSize,
} from './display';
import { graphElementLabel } from './diagnostics';
import {
  defaultGraphPosition,
  type GraphDocument,
  type GraphEdge,
  type GraphNode,
  type GraphSection,
  type Position,
} from './model';
import { type GraphProfile } from './profile';
import { graphCommand, type GraphIntent, type GraphSectionBounds } from './commands';
import { graphSectionAncestors, graphSectionSubtree } from './model';

export type GraphBox = Position & GraphNodeSize;
export type GraphScope = 'graph' | 'node' | 'edge' | 'section';
export type GraphApply = (intents: GraphIntent[], base?: string) => boolean;
export interface GraphDefinitionTarget {
  scope: GraphScope;
  type?: string;
}
export interface GraphDeletion {
  id: string;
  base: string;
}
export interface GraphDrag {
  id: string;
  pointer: number;
  start: Position;
  initial: Position;
  position: Position;
  base: string;
}
/** A Section frame gesture: a move takes its contents along, a resize changes the frame only. */
export interface GraphSectionDrag {
  id: string;
  mode: 'move' | 'resize';
  pointer: number;
  start: Position;
  initial: GraphSectionBounds;
  bounds: GraphSectionBounds;
  base: string;
}
export interface GraphEndpointGesture {
  id: string;
  side: 'from' | 'to';
  pointer: number;
  base: string;
  point: Position;
  target?: string;
  reason?: string;
}
export type GraphNodeSizeOption = GraphNodeSize | ((node: GraphNode) => GraphNodeSize);
export type GraphLabelSizes = Map<string, GraphNodeSize & { text: string }>;
export type GraphNodeHeights = Map<string, { key: string; height: number }>;

export const errorMessage = (error: unknown) =>
  String(error instanceof Error ? error.message : error);

export { defaultGraphPosition };

export const hasComposingDraft = (drafts: Map<string, GraphAttributeDraft>) =>
  [...drafts.values()].some((draft) => draft.composing);

export function resolveGraphSelection(
  graph: GraphDocument,
  profile: GraphProfile,
  selected: string,
) {
  const node = graph.nodes.find((n) => n.id === selected),
    edge = graph.edges.find((e) => e.id === selected),
    section = graph.sections.find((s) => s.id === selected);
  const type = node
    ? profile.nodes[node.type]
    : edge
      ? profile.edges[edge.type]
      : section
        ? (profile.sections[section.type] ?? { schema: {} })
        : profile.graph;
  const scope: GraphScope = node ? 'node' : edge ? 'edge' : section ? 'section' : 'graph',
    attributes = node?.attributes ?? edge?.attributes ?? section?.attributes ?? graph.attributes;
  const id = node?.id ?? edge?.id ?? section?.id ?? graph.id;
  return { node, edge, section, type, scope, attributes, id };
}

export function graphInspectorTitle(
  profile: GraphProfile,
  label: (id: string) => string,
  node: GraphNode | undefined,
  edge: GraphEdge | undefined,
  section?: GraphSection,
) {
  return node
    ? label(node.id)
    : edge
      ? (profile.edges[edge.type].ui?.label ?? edge.type)
      : section
        ? label(section.id)
        : 'Graph properties';
}

/** A named connection shows its name alone; an unnamed one shows its relation type. */
export function graphEdgeText(profile: GraphProfile, edge: GraphEdge) {
  const ui = profile.edges[edge.type]?.ui;
  const text = ui?.label ?? edge.type;
  const value = ui?.labelField ? edge.attributes[ui.labelField] : undefined;
  return typeof value === 'string' && value.trim()
    ? value
    : typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : text;
}

export function graphNeighbors(
  graph: GraphDocument,
  node: GraphNode | undefined,
  adjacent: boolean,
) {
  const neighbors = new Set(node ? [node.id] : []);
  if (node && adjacent)
    for (const edge of graph.edges) {
      if (edge.from === node.id) neighbors.add(edge.to);
      if (edge.to === node.id) neighbors.add(edge.from);
    }
  return neighbors;
}

export interface GraphSceneInput {
  graph: GraphDocument;
  profile: GraphProfile;
  drag?: GraphDrag;
  sectionDrag?: GraphSectionDrag;
  /** Private view state: collapsed Sections draw as one box. Content never changes. */
  collapsed?: ReadonlySet<string>;
  visibleNodeIds?: string[];
  visibleEdgeTypes?: string[];
  nodeSize?: GraphNodeSizeOption;
  nodeHeights: GraphNodeHeights;
  labelSizes: GraphLabelSizes;
  overlay?: Record<string, string>;
  readOnly: boolean;
}

/** Only the coordinates: shape and style must not reach drag comparisons or move commands. */
function graphNodePosition(graph: GraphDocument, id: string, index: number): Position {
  const saved = graph.presentation.nodes[id];
  return saved ? { x: saved.x, y: saved.y } : defaultGraphPosition(index);
}

function graphNodePositions(graph: GraphDocument, drag: GraphDrag | undefined) {
  return Object.fromEntries(
    graph.nodes.map((n, i) => [
      n.id,
      drag?.id === n.id ? drag.position : graphNodePosition(graph, n.id, i),
    ]),
  );
}

function graphNodeSizing(
  input: GraphSceneInput,
  label: (id: string) => string,
  looks: Record<string, GraphNodeLook>,
) {
  const { graph, profile, overlay, readOnly, nodeSize, nodeHeights } = input;
  const nodeSizeKey = (node: GraphNode) =>
    canonicalJson([
      graph.id,
      label(node.id),
      profile.nodes[node.type].ui?.label ?? node.type,
      overlay?.[node.id] ?? null,
      readOnly,
      looks[node.id].shape,
    ]);
  const sizeOf = (node: GraphNode): GraphNodeSize => {
    if (nodeSize !== undefined)
      return graphNodeSize(typeof nodeSize === 'function' ? nodeSize(node) : nodeSize);
    const measured = nodeHeights.get(node.id);
    // The measured label height grows to the height the node's shape needs to hold it.
    return {
      width: 200,
      height:
        measured?.key === nodeSizeKey(node)
          ? graphShapeHeight(looks[node.id].shape, measured.height)
          : 70,
    };
  };
  return { nodeSizeKey, sizeOf };
}

function graphEdgeLayout(
  input: GraphSceneInput,
  edges: GraphEdge[],
  boxes: Record<string, GraphBox>,
  looks: Record<string, GraphNodeLook>,
  edgeText: (edge: GraphEdge) => string,
) {
  const { visibleEdgeTypes, labelSizes } = input;
  const visibleEdges = edges.filter(
    (edge) =>
      boxes[edge.from] &&
      boxes[edge.to] &&
      (!visibleEdgeTypes || visibleEdgeTypes.includes(edge.type)),
  );
  const ends = new Map<string, GraphRouteEnds>(
    visibleEdges.map((edge) => [
      edge.id,
      {
        source: boxes[edge.from],
        target: boxes[edge.to],
        sourceShape: looks[edge.from].shape,
        targetShape: looks[edge.to].shape,
      },
    ]),
  );
  const separated = separateGraphRoutes(
    new Map(
      visibleEdges.map((edge) => [
        edge.id,
        routeGraphEdge(
          boxes[edge.from],
          boxes[edge.to],
          Object.values(boxes),
          edge.from === edge.to,
        ),
      ]),
    ),
    ends,
    Object.values(boxes),
  );
  const routes = fitGraphRoutesToShapes(separated, ends);
  const edgeLabels = placeMeasuredGraphEdgeLabels(
    visibleEdges.map((edge) => ({
      id: edge.id,
      route: routes.get(edge.id)!,
      text: edgeText(edge),
      size: labelSizes.get(edge.id)?.text === edgeText(edge) ? labelSizes.get(edge.id) : undefined,
    })),
    Object.values(boxes),
  );
  return { visibleEdges, routes, edgeLabels };
}

const collapsedSize = { width: 240, height: 56 };
/** The ID of a summary line that stands for the connections into a collapsed Section. */
/** The collapsed Section a summary line stands for, whether the line leaves or enters it. */
export const graphSummaryTarget = (
  edge: Pick<GraphEdge, 'from' | 'to'>,
  collapsedBoxes: Record<string, unknown>,
) => (Object.hasOwn(collapsedBoxes, edge.from) ? edge.from : edge.to);
export const graphSummaryEdgeId = (from: string, to: string, type: string) =>
  `section-summary:${canonicalJson([from, to, type])}`;
/**
 * Section frames (with a move or resize preview), what collapsed Sections hide, and the
 * connections redrawn to them: one summary line per other end, direction and type.
 */
function graphSectionLayout(input: GraphSceneInput, positions: Record<string, Position>) {
  const { graph, sectionDrag, collapsed = new Set<string>(), visibleNodeIds } = input;
  const shown = visibleNodeIds && new Set(visibleNodeIds);
  const frames: Record<string, GraphSectionBounds> = {};
  for (const s of graph.sections) {
    const { x, y, width, height } = graph.presentation.sections[s.id];
    frames[s.id] = { x, y, width, height };
  }
  if (sectionDrag && frames[sectionDrag.id]) {
    if (sectionDrag.mode === 'resize') frames[sectionDrag.id] = sectionDrag.bounds;
    else {
      const dx = sectionDrag.bounds.x - sectionDrag.initial.x,
        dy = sectionDrag.bounds.y - sectionDrag.initial.y,
        subtree = graphSectionSubtree(graph.sections, sectionDrag.id);
      for (const id of subtree)
        frames[id] = { ...frames[id], x: frames[id].x + dx, y: frames[id].y + dy };
      for (const n of graph.nodes)
        if (n.sectionId !== undefined && subtree.has(n.sectionId))
          positions[n.id] = { x: positions[n.id].x + dx, y: positions[n.id].y + dy };
    }
  }
  // The outermost collapsed Section that holds each Section (itself included).
  const holder = (sectionId: string) =>
    [...(graphSectionAncestors(graph.sections, sectionId) ?? []).reverse(), sectionId].find((id) =>
      collapsed.has(id),
    );
  const hiddenSections = new Set(
    graph.sections.filter((s) => s.parentId !== undefined && holder(s.parentId)).map((s) => s.id),
  );
  const representative = new Map<string, string>();
  for (const n of graph.nodes) {
    const h = n.sectionId === undefined ? undefined : holder(n.sectionId);
    if (h) representative.set(n.id, h);
  }
  const collapsedBoxes: Record<string, GraphBox> = {};
  for (const id of collapsed)
    if (frames[id] && !hiddenSections.has(id))
      collapsedBoxes[id] = {
        x: frames[id].x,
        y: frames[id].y,
        width: Math.min(frames[id].width, collapsedSize.width),
        height: collapsedSize.height,
      };
  const summaries = new Map<string, { edge: GraphEdge; count: number }>(),
    edges: GraphEdge[] = [],
    edgeIds = new Set(graph.edges.map((e) => e.id));
  for (const edge of graph.edges) {
    // The Host filter applies to the real ends, before members are replaced by their Section.
    if (shown && !(shown.has(edge.from) && shown.has(edge.to))) continue;
    const from = representative.get(edge.from) ?? edge.from,
      to = representative.get(edge.to) ?? edge.to;
    if (from === edge.from && to === edge.to) {
      edges.push(edge);
      continue;
    }
    // Both ends inside the same collapsed Section: nothing crosses its edge.
    if (from === to) continue;
    const key = graphSummaryEdgeId(from, to, edge.type),
      summary = summaries.get(key);
    if (summary) summary.count++;
    else {
      // A saved edge may carry any valid ID, so a summary never reuses one.
      let id = key;
      while (edgeIds.has(id)) id += '~';
      edgeIds.add(id);
      const line = { id, type: edge.type, from, to, attributes: {} };
      summaries.set(key, { edge: line, count: 1 });
      edges.push(line);
    }
  }
  const depth = (id: string) => graphSectionAncestors(graph.sections, id)?.length ?? 0;
  const order = [...graph.sections]
    .filter((s) => !hiddenSections.has(s.id))
    .sort((a, b) => depth(a.id) - depth(b.id));
  return {
    frames,
    order,
    representative,
    collapsedBoxes,
    edges,
    // Keyed by the drawn line's ID, which differs from the grouping key after a collision.
    summaries: new Map([...summaries.values()].map((s) => [s.edge.id, s])),
  };
}

function graphDrawingBounds(
  boxes: Record<string, GraphBox>,
  routes: Map<string, GraphRoute>,
  edgeLabels: Map<string, GraphEdgeLabel>,
): Bounds[] {
  return [
    ...Object.values(boxes),
    ...[...routes.values()].flatMap((route) =>
      route.points.map((point) => ({ ...point, width: 1, height: 1 })),
    ),
    ...[...edgeLabels.values()].filter((label) => !label.deferred).map((label) => label.bounds),
  ];
}

export function computeGraphScene(input: GraphSceneInput) {
  const { graph, profile, visibleNodeIds, nodeSize, nodeHeights, labelSizes } = input;
  const positions = graphNodePositions(graph, input.drag);
  const sections = graphSectionLayout(input, positions);
  const visible = graph.nodes.filter(
    (n) => !sections.representative.has(n.id) && (!visibleNodeIds || visibleNodeIds.includes(n.id)),
  );
  const label = (id: string) => graphElementLabel(graph, profile, id);
  const looks: Record<string, GraphNodeLook> = Object.fromEntries([
    ...graph.nodes.map((node) => [node.id, resolveGraphNodeLook(graph, profile, node)]),
    ...Object.keys(sections.collapsedBoxes).map((id) => [id, { shape: 'rectangle', style: {} }]),
  ]);
  const { nodeSizeKey, sizeOf } = graphNodeSizing(input, label, looks);
  const boxes: Record<string, GraphBox> = {
    ...Object.fromEntries(
      visible.map((node) => [
        node.id,
        {
          ...positions[node.id],
          ...sizeOf(node),
        },
      ]),
    ),
    ...sections.collapsedBoxes,
  };
  const edgeText = (edge: GraphEdge) => {
    const summary = sections.summaries.get(edge.id);
    return summary
      ? `${profile.edges[edge.type]?.ui?.label ?? edge.type} ×${summary.count}`
      : graphEdgeText(profile, edge);
  };
  const { visibleEdges, routes, edgeLabels } = graphEdgeLayout(
    input,
    sections.edges,
    boxes,
    looks,
    edgeText,
  );
  const drawingBounds = [
    ...graphDrawingBounds(boxes, routes, edgeLabels),
    ...sections.order
      .filter((s) => !sections.collapsedBoxes[s.id])
      .map((s) => sections.frames[s.id]),
  ];
  const filterKey = canonicalJson(visibleNodeIds ? [...new Set(visibleNodeIds)].sort() : null);
  const labelsMeasured = visibleEdges.every(
    // Refused routes retain their diagnostic, but mount no edge label to measure.
    (edge) =>
      !routes.get(edge.id)!.path ||
      !edgeText(edge) ||
      labelSizes.get(edge.id)?.text === edgeText(edge),
  );
  const nodesMeasured =
    nodeSize !== undefined ||
    visible.every((node) => nodeHeights.get(node.id)?.key === nodeSizeKey(node));
  const worldWidth = Math.max(900, ...drawingBounds.map((box) => box.x + box.width + 60)),
    worldHeight = Math.max(500, ...drawingBounds.map((box) => box.y + box.height + 70));
  return {
    positions,
    sections,
    visible,
    label,
    nodeSizeKey,
    /** Size of any node, drawn or hidden by a filter or a collapsed Section. */
    sizeOf,
    boxes,
    looks,
    visibleEdges,
    routes,
    edgeText,
    edgeLabels,
    drawingBounds,
    filterKey,
    labelsMeasured,
    nodesMeasured,
    worldWidth,
    worldHeight,
  };
}
export type GraphScene = ReturnType<typeof computeGraphScene>;

/**
 * The Section a point lands in: the innermost drawn, open frame that holds it. Among frames of
 * the same depth the one drawn last wins. `null` means outside every frame.
 */
export function graphDropSection(
  graph: GraphDocument,
  sections: Pick<GraphScene['sections'], 'frames' | 'order' | 'collapsedBoxes'>,
  point: Position,
): string | null {
  let found: string | null = null,
    foundDepth = -1;
  for (const s of sections.order) {
    const frame = sections.frames[s.id];
    if (!frame || Object.hasOwn(sections.collapsedBoxes, s.id)) continue;
    const { x, y } = point;
    if (x < frame.x || y < frame.y || x > frame.x + frame.width || y > frame.y + frame.height)
      continue;
    const depth = graphSectionAncestors(graph.sections, s.id)?.length ?? 0;
    if (depth >= foundDepth) [found, foundDepth] = [s.id, depth];
  }
  return found;
}

/**
 * A node drop as one edit: the move, plus the membership of the frame its centre lands in. Outside
 * every frame the membership is cleared, or kept with `outside: 'keep'`. A membership the Profile
 * or a read-only Section refuses leaves the node in its Section and only moves it; `refused` says
 * why.
 */
export function graphNodeDropIntents(input: {
  graph: GraphDocument;
  profile: GraphProfile;
  sections: Pick<GraphScene['sections'], 'frames' | 'order' | 'collapsedBoxes'>;
  id: string;
  position: Position;
  /** The node's drawn size; its centre decides the frame. */
  size: GraphNodeSize;
  outside?: 'clear' | 'keep';
}): { intents: GraphIntent[]; target: string | null; refused?: unknown } {
  const { graph, profile, sections, id, position, size, outside = 'clear' } = input;
  const move: GraphIntent = { type: 'move-node', id, position };
  const node = graph.nodes.find((n) => n.id === id);
  const target = graphDropSection(graph, sections, {
    x: position.x + size.width / 2,
    y: position.y + size.height / 2,
  });
  if (!node || target === (node.sectionId ?? null) || (target === null && outside === 'keep'))
    return { intents: [move], target };
  const intents: GraphIntent[] = [move, { type: 'set-node-section', id, sectionId: target }];
  try {
    graphCommand(profile, intents).apply(graph);
    return { intents, target };
  } catch (refused) {
    return { intents: [move], target, refused };
  }
}

export function initialGraphCamera(initialView: 'origin' | 'fit' | GraphCamera): GraphCamera {
  const view =
    typeof initialView === 'object' &&
    [initialView.x, initialView.y, initialView.zoom].every(Number.isFinite) &&
    initialView.zoom > 0
      ? initialView
      : { x: 0, y: 0, zoom: 1 };
  return { x: view.x, y: view.y, zoom: Math.max(0.001, Math.min(2, view.zoom)) };
}

export const zoomOutStep = (z: number) =>
  Math.max(0.001, z > 0.25 ? Math.max(0.25, z - 0.25) : z / 2);
export const zoomInStep = (z: number) => Math.min(2, z + 0.25);

export const graphArrowKeys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
export const nudgedGraphPosition = (key: string, p: Position): Position => ({
  x: p.x + (key === 'ArrowRight' ? 10 : key === 'ArrowLeft' ? -10 : 0),
  y: p.y + (key === 'ArrowDown' ? 10 : key === 'ArrowUp' ? -10 : 0),
});

export function findEndpointTarget(
  point: Position,
  visible: GraphNode[],
  boxes: Record<string, GraphBox>,
) {
  return [...visible].reverse().find((node) => {
    const box = boxes[node.id];
    return (
      point.x >= box.x - 14 &&
      point.x <= box.x + box.width + 14 &&
      point.y >= box.y - 14 &&
      point.y <= box.y + box.height + 14
    );
  })?.id;
}

export function retainedDeletedDrafts(
  drafts: Map<string, GraphAttributeDraft>,
  graph: GraphDocument,
) {
  return [...drafts].filter(([id, draft]) =>
    draft.scope === 'graph' ? id !== graph.id : !graphDraftElement(draft, id, graph),
  );
}

function graphDraftElement(draft: GraphAttributeDraft, id: string, graph: GraphDocument) {
  const list =
    draft.scope === 'node'
      ? graph.nodes
      : draft.scope === 'edge'
        ? graph.edges
        : draft.scope === 'section'
          ? graph.sections
          : [];
  return list.find((element: { id: string }) => element.id === id);
}

/** The draft's current element attributes and type, or undefined when the element is gone. */
export function graphDraftTarget(
  draft: GraphAttributeDraft,
  id: string,
  graph: GraphDocument,
  profile: GraphProfile,
) {
  if (draft.scope === 'graph')
    return id === graph.id ? { type: profile.graph, attributes: graph.attributes } : undefined;
  const element = graphDraftElement(draft, id, graph);
  if (!element) return undefined;
  const type =
    draft.scope === 'node'
      ? profile.nodes[element.type]
      : draft.scope === 'edge'
        ? profile.edges[element.type]
        : profile.sections[element.type];
  return type && { type, attributes: element.attributes };
}

export function isGraphEdgeDimmed(
  edge: GraphEdge,
  node: GraphNode | undefined,
  highlightAdjacent: boolean,
) {
  return !!(highlightAdjacent && node && edge.from !== node.id && edge.to !== node.id);
}

export function graphNodeClassName(
  id: string,
  state: {
    selected: string;
    highlightAdjacent: boolean;
    node?: GraphNode;
    edge?: GraphEdge;
    neighbors: Set<string>;
    endpoint?: GraphEndpointGesture;
  },
) {
  const { selected, highlightAdjacent, node, edge, neighbors, endpoint } = state;
  return `ep-graph-node ${selected === id ? 'selected' : ''} ${highlightAdjacent && node && !neighbors.has(id) ? 'dimmed' : ''} ${edge && (edge.from === id || edge.to === id) ? 'connected' : ''} ${endpoint?.target === id ? (endpoint.reason ? 'invalid-target' : 'valid-target') : ''}`;
}
