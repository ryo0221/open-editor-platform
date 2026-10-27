import { newId } from '@editor-platform/artifact-core';
export type JsonValue =
  | null
  | string
  | number
  | boolean
  | JsonValue[]
  | { [key: string]: JsonValue };
export type Attributes = Record<string, JsonValue>;
export interface ProfileRef {
  id: string;
  version: number;
}
export interface GraphNode {
  id: string;
  type: string;
  attributes: Attributes;
  /** The one Section the node belongs to, set explicitly; moving or resizing never changes it. */
  sectionId?: string;
}
export interface GraphEdge {
  id: string;
  type: string;
  from: string;
  to: string;
  attributes: Attributes;
}
/** A typed, named grouping with semantic attributes. Its bounds are presentation. */
export interface GraphSection {
  id: string;
  type: string;
  attributes: Attributes;
  parentId?: string;
}
export interface Position {
  x: number;
  y: number;
}
export const graphNodeShapes = [
  'rectangle',
  'rounded-rectangle',
  'ellipse',
  'diamond',
  'cylinder',
  'hexagon',
  'cloud',
] as const;
export type GraphNodeShape = (typeof graphNodeShapes)[number];
/** Declarative paint only: hex colours, a stroke width step and logical-pixel dashes. */
export interface GraphNodeStyle {
  fill?: string;
  stroke?: string;
  strokeWidth?: 1 | 2 | 3;
  dash?: number[];
}
/** Saved node presentation. Shape and style are optional overrides of the Profile type defaults. */
export interface GraphNodePresentation extends Position {
  shape?: GraphNodeShape;
  style?: GraphNodeStyle;
}
export type GraphNodePresentations = Record<string, GraphNodePresentation>;
export interface GraphSectionPresentation extends Position {
  width: number;
  height: number;
  style?: GraphNodeStyle;
}
export interface GraphPresentation {
  nodes: GraphNodePresentations;
  sections: Record<string, GraphSectionPresentation>;
}
export interface GraphDocument {
  schemaVersion: 2;
  id: string;
  profile: ProfileRef;
  attributes: Attributes;
  nodes: GraphNode[];
  edges: GraphEdge[];
  sections: GraphSection[];
  presentation: GraphPresentation;
}
export interface GraphDiagnostic {
  scope: 'graph' | 'node' | 'edge' | 'section';
  elementId: string;
  path: string[];
  code: string;
  /** Stable diagnostic parameters; Hosts choose the presentation language. */
  args?: Record<string, string | number | boolean>;
  message: string;
  severity: 'error' | 'warning';
  /** Missing required data is an incomplete semantic draft, not corrupt structure. */
  blocking: boolean;
}
export const graphLimits = {
  nodes: 1000,
  edges: 4000,
  attributeBytes: 65_536,
  documentBytes: 2_097_152,
  depth: 12,
  stringLength: 16_384,
  entries: 4096,
  coordinate: 100_000,
  sections: 500,
  sectionDepth: 8,
  sectionMinSize: 40,
  sectionMaxSize: 200_000,
} as const;
export const validGraphId = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.length > 0 &&
  v.length <= 512 &&
  !['__proto__', 'prototype', 'constructor'].includes(v);
export const plainRecord = (v: unknown): v is Record<string, unknown> =>
  !!v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
/** Data descriptors only: validation never reads an imported accessor or runs code. */
export function isGraphJson(
  value: unknown,
  depth = 0,
  seen = new Set<object>(),
): value is JsonValue {
  if (depth > graphLimits.depth) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.length <= graphLimits.stringLength;
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  if (!Array.isArray(value) && !plainRecord(value)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value),
    keys = Reflect.ownKeys(descriptors);
  if (keys.length > graphLimits.entries + (Array.isArray(value) ? 1 : 0)) return false;
  seen.add(value);
  const valid =
    keys.every((key) => {
      if (Array.isArray(value) && key === 'length') return true;
      const d = descriptors[key as string];
      return (
        typeof key === 'string' &&
        !['__proto__', 'prototype', 'constructor'].includes(key) &&
        d.enumerable &&
        'value' in d &&
        isGraphJson(d.value, depth + 1, seen)
      );
    }) &&
    (!Array.isArray(value) || Object.keys(value).length === value.length);
  seen.delete(value);
  return valid;
}
const positionValid = (v: Record<string, unknown>) =>
  ['x', 'y'].every(
    (k) =>
      typeof v[k] === 'number' &&
      Number.isFinite(v[k]) &&
      Math.abs(v[k] as number) <= graphLimits.coordinate,
  );
export function validPosition(v: unknown): v is Position {
  return plainRecord(v) && Object.keys(v).length === 2 && positionValid(v);
}
const hexColor = (v: unknown) => typeof v === 'string' && /^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(v);
/** Shared by node/Section styles and Profile edge styles: at most 8 dashes, each in (0, 64]. */
export const validGraphDash = (v: unknown) =>
  Array.isArray(v) &&
  v.length <= 8 &&
  v.every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= 64);
export function validGraphStyle(v: unknown): v is GraphNodeStyle {
  return (
    plainRecord(v) &&
    Object.entries(v).every(([key, value]) =>
      key === 'fill' || key === 'stroke'
        ? hexColor(value)
        : key === 'strokeWidth'
          ? value === 1 || value === 2 || value === 3
          : key === 'dash' && validGraphDash(value),
    )
  );
}
export const isGraphNodeShape = (v: unknown): v is GraphNodeShape =>
  graphNodeShapes.includes(v as GraphNodeShape);
export function validNodePresentation(v: unknown): v is GraphNodePresentation {
  return (
    plainRecord(v) &&
    Object.keys(v).every((k) => ['x', 'y', 'shape', 'style'].includes(k)) &&
    positionValid(v) &&
    (v.shape === undefined || isGraphNodeShape(v.shape)) &&
    (v.style === undefined || validGraphStyle(v.style))
  );
}
export function validNodePresentations(value: unknown): value is GraphNodePresentations {
  return (
    isGraphJson(value) &&
    plainRecord(value) &&
    Object.entries(value).every(([id, item]) => validGraphId(id) && validNodePresentation(item))
  );
}
const sizeValid = (v: unknown) =>
  typeof v === 'number' &&
  Number.isFinite(v) &&
  v >= graphLimits.sectionMinSize &&
  v <= graphLimits.sectionMaxSize;
export function validSectionPresentation(v: unknown): v is GraphSectionPresentation {
  return (
    plainRecord(v) &&
    Object.keys(v).every((k) => ['x', 'y', 'width', 'height', 'style'].includes(k)) &&
    positionValid(v) &&
    sizeValid(v.width) &&
    sizeValid(v.height) &&
    (v.style === undefined || validGraphStyle(v.style))
  );
}
export function validGraphPresentation(value: unknown): value is GraphPresentation {
  return (
    plainRecord(value) &&
    Object.keys(value).length === 2 &&
    validNodePresentations(value.nodes) &&
    plainRecord(value.sections) &&
    Object.entries(value.sections).every(
      ([id, item]) => validGraphId(id) && validSectionPresentation(item),
    )
  );
}
/** Each Section's ancestors, nearest first; undefined when a parent is missing or loops. */
export function graphSectionAncestors(
  sections: readonly GraphSection[],
  id: string,
): string[] | undefined {
  const byId = new Map(sections.map((s) => [s.id, s]));
  const chain: string[] = [];
  for (let parent = byId.get(id)?.parentId; parent !== undefined; ) {
    if (parent === id || chain.includes(parent) || !byId.has(parent)) return undefined;
    chain.push(parent);
    parent = byId.get(parent)!.parentId;
  }
  return chain;
}
/** Nesting depth counted from 1 for a top-level Section. */
export const graphSectionDepth = (sections: readonly GraphSection[], id: string) =>
  (graphSectionAncestors(sections, id)?.length ?? Infinity) + 1;
/** The Section and every Section nested inside it. */
export function graphSectionSubtree(sections: readonly GraphSection[], id: string): Set<string> {
  const out = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const s of sections)
      if (s.parentId !== undefined && out.has(s.parentId) && !out.has(s.id)) {
        out.add(s.id);
        grew = true;
      }
  }
  return out;
}
/** Schema 1 Graphs are refused rather than read: the preview has no reader for older formats. */
export const graphSchemaMessage = (value: unknown) =>
  plainRecord(value) && value.schemaVersion === 1
    ? 'Graph schema 1 is not supported by this preview; export it with the previous version or recreate it'
    : 'Invalid Graph schema, IDs, references, JSON values or size limits';
export function isGraphDocument(value: unknown): value is GraphDocument {
  if (!isGraphJson(value) || !plainRecord(value)) return false;
  if (
    Object.keys(value).some(
      (k) =>
        ![
          'schemaVersion',
          'id',
          'profile',
          'attributes',
          'nodes',
          'edges',
          'sections',
          'presentation',
        ].includes(k),
    )
  )
    return false;
  const g = value as unknown as GraphDocument;
  const attrs = (v: unknown) =>
    plainRecord(v) &&
    new TextEncoder().encode(JSON.stringify(v)).length <= graphLimits.attributeBytes;
  if (
    g.schemaVersion !== 2 ||
    !validGraphId(g.id) ||
    !plainRecord(g.profile) ||
    !validGraphId(g.profile.id) ||
    !Number.isSafeInteger(g.profile.version) ||
    g.profile.version < 1 ||
    !attrs(g.attributes) ||
    !Array.isArray(g.nodes) ||
    g.nodes.length > graphLimits.nodes ||
    !Array.isArray(g.edges) ||
    g.edges.length > graphLimits.edges ||
    !Array.isArray(g.sections) ||
    g.sections.length > graphLimits.sections ||
    !validGraphPresentation(g.presentation)
  )
    return false;
  const ids = new Set<string>([g.id]);
  const nodeSet = new Set<unknown>(g.nodes),
    sectionSet = new Set<unknown>(g.sections);
  for (const el of [...g.nodes, ...g.edges, ...g.sections]) {
    const keys = nodeSet.has(el)
      ? ['id', 'type', 'attributes', 'sectionId']
      : sectionSet.has(el)
        ? ['id', 'type', 'attributes', 'parentId']
        : ['id', 'type', 'from', 'to', 'attributes'];
    if (Object.keys(el ?? {}).some((k) => !keys.includes(k))) return false;
    if (
      !plainRecord(el) ||
      !validGraphId(el.id) ||
      ids.has(el.id) ||
      !validGraphId(el.type) ||
      !attrs(el.attributes)
    )
      return false;
    ids.add(el.id);
  }
  const nodes = new Set(g.nodes.map((n) => n.id)),
    sections = new Set(g.sections.map((s) => s.id));
  if (
    g.edges.some((e) => !nodes.has(e.from) || !nodes.has(e.to)) ||
    Object.keys(g.presentation.nodes).some((id) => !nodes.has(id)) ||
    g.nodes.some((n) => n.sectionId !== undefined && !sections.has(n.sectionId)) ||
    g.sections.some(
      (s) =>
        (s.parentId !== undefined && !sections.has(s.parentId)) ||
        graphSectionDepth(g.sections, s.id) > graphLimits.sectionDepth,
    ) ||
    // Every Section has bounds, and only Sections do.
    Object.keys(g.presentation.sections).length !== sections.size ||
    Object.keys(g.presentation.sections).some((id) => !sections.has(id))
  )
    return false;
  return new TextEncoder().encode(JSON.stringify(g)).length <= graphLimits.documentBytes;
}
export function assertGraphDocument(value: unknown): asserts value is GraphDocument {
  if (!isGraphDocument(value)) throw new Error(graphSchemaMessage(value));
}
/** The deterministic position of a node that has no saved presentation, by its list index. */
export const defaultGraphPosition = (index: number): Position => ({
  x: 40 + (index % 3) * 260,
  y: 40 + Math.floor(index / 3) * 160,
});
export function createGraph(
  profile: ProfileRef = { id: 'relations', version: 1 },
  id = newId('graph'),
): GraphDocument {
  return {
    schemaVersion: 2,
    id,
    profile: { ...profile },
    attributes: {},
    nodes: [],
    edges: [],
    sections: [],
    presentation: { nodes: {}, sections: {} },
  };
}
