import { canonicalJson } from '@editor-platform/artifact-core';
import { type Bounds } from '@editor-platform/editor-core';
import { type GraphAttributeDraft } from './attribute-draft';
import { routeGraphEdge, type GraphRoute } from './routing';
import {
  graphNodeSize,
  placeMeasuredGraphEdgeLabels,
  type GraphCamera,
  type GraphEdgeLabel,
  type GraphNodeSize,
} from './display';
import { graphElementLabel } from './diagnostics';
import { type GraphDocument, type GraphEdge, type GraphNode, type Position } from './model';
import { type GraphProfile } from './profile';
import { type GraphIntent } from './commands';

export type GraphBox = Position & GraphNodeSize;
export type GraphScope = 'graph' | 'node' | 'edge';
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

export const defaultGraphPosition = (index: number): Position => ({
  x: 40 + (index % 3) * 260,
  y: 40 + Math.floor(index / 3) * 160,
});

export const hasComposingDraft = (drafts: Map<string, GraphAttributeDraft>) =>
  [...drafts.values()].some((draft) => draft.composing);

export function resolveGraphSelection(
  graph: GraphDocument,
  profile: GraphProfile,
  selected: string,
) {
  const node = graph.nodes.find((n) => n.id === selected),
    edge = graph.edges.find((e) => e.id === selected);
  const type = node ? profile.nodes[node.type] : edge ? profile.edges[edge.type] : profile.graph;
  const scope: GraphScope = node ? 'node' : edge ? 'edge' : 'graph',
    attributes = node?.attributes ?? edge?.attributes ?? graph.attributes;
  const id = node?.id ?? edge?.id ?? graph.id;
  return { node, edge, type, scope, attributes, id };
}

export function graphInspectorTitle(
  profile: GraphProfile,
  label: (id: string) => string,
  node: GraphNode | undefined,
  edge: GraphEdge | undefined,
) {
  return node
    ? label(node.id)
    : edge
      ? (profile.edges[edge.type].ui?.label ?? edge.type)
      : 'Graph properties';
}

export function graphEdgeText(profile: GraphProfile, edge: GraphEdge) {
  const ui = profile.edges[edge.type]?.ui;
  const text = ui?.label ?? edge.type;
  const value = ui?.labelField ? edge.attributes[ui.labelField] : undefined;
  return (typeof value === 'string' && value.trim()) ||
    typeof value === 'number' ||
    typeof value === 'boolean'
    ? `${text} · ${value}`
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
  visibleNodeIds?: string[];
  visibleEdgeTypes?: string[];
  nodeSize?: GraphNodeSizeOption;
  nodeHeights: GraphNodeHeights;
  labelSizes: GraphLabelSizes;
  overlay?: Record<string, string>;
  readOnly: boolean;
}

function graphNodePositions(graph: GraphDocument, drag: GraphDrag | undefined) {
  return Object.fromEntries(
    graph.nodes.map((n, i) => [
      n.id,
      drag?.id === n.id ? drag.position : (graph.layout[n.id] ?? defaultGraphPosition(i)),
    ]),
  );
}

function graphNodeSizing(input: GraphSceneInput, label: (id: string) => string) {
  const { graph, profile, overlay, readOnly, nodeSize, nodeHeights } = input;
  const nodeSizeKey = (node: GraphNode) =>
    canonicalJson([
      graph.id,
      label(node.id),
      profile.nodes[node.type].ui?.label ?? node.type,
      overlay?.[node.id] ?? null,
      readOnly,
    ]);
  const sizeOf = (node: GraphNode): GraphNodeSize => {
    if (nodeSize !== undefined)
      return graphNodeSize(typeof nodeSize === 'function' ? nodeSize(node) : nodeSize);
    const measured = nodeHeights.get(node.id);
    return { width: 200, height: measured?.key === nodeSizeKey(node) ? measured.height : 70 };
  };
  return { nodeSizeKey, sizeOf };
}

function graphEdgeLayout(
  input: GraphSceneInput,
  boxes: Record<string, GraphBox>,
  edgeText: (edge: GraphEdge) => string,
) {
  const { graph, visibleEdgeTypes, labelSizes } = input;
  const visibleEdges = graph.edges.filter(
    (edge) =>
      boxes[edge.from] &&
      boxes[edge.to] &&
      (!visibleEdgeTypes || visibleEdgeTypes.includes(edge.type)),
  );
  const routes = new Map(
    visibleEdges.map((edge) => [
      edge.id,
      routeGraphEdge(boxes[edge.from], boxes[edge.to], Object.values(boxes), edge.from === edge.to),
    ]),
  );
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
  const visible = graph.nodes.filter((n) => !visibleNodeIds || visibleNodeIds.includes(n.id));
  const label = (id: string) => graphElementLabel(graph, profile, id);
  const { nodeSizeKey, sizeOf } = graphNodeSizing(input, label);
  const boxes: Record<string, GraphBox> = Object.fromEntries(
    visible.map((node) => [
      node.id,
      {
        ...positions[node.id],
        ...sizeOf(node),
      },
    ]),
  );
  const edgeText = (edge: GraphEdge) => graphEdgeText(profile, edge);
  const { visibleEdges, routes, edgeLabels } = graphEdgeLayout(input, boxes, edgeText);
  const drawingBounds = graphDrawingBounds(boxes, routes, edgeLabels);
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
    visible,
    label,
    nodeSizeKey,
    boxes,
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
    draft.scope === 'node'
      ? !graph.nodes.some((node) => node.id === id)
      : draft.scope === 'edge'
        ? !graph.edges.some((edge) => edge.id === id)
        : id !== graph.id,
  );
}

export function graphDraftType(
  draft: GraphAttributeDraft,
  id: string,
  graph: GraphDocument,
  profile: GraphProfile,
  node: GraphNode | undefined,
  edge: GraphEdge | undefined,
) {
  return draft.scope === 'node'
    ? node && profile.nodes[node.type]
    : draft.scope === 'edge'
      ? edge && profile.edges[edge.type]
      : id === graph.id && profile.graph;
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
