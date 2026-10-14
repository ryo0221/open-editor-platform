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
}
export interface GraphEdge {
  id: string;
  type: string;
  from: string;
  to: string;
  attributes: Attributes;
}
export interface Position {
  x: number;
  y: number;
}
export type GraphLayout = Record<string, Position>;
export interface GraphDocument {
  schemaVersion: 1;
  id: string;
  profile: ProfileRef;
  attributes: Attributes;
  nodes: GraphNode[];
  edges: GraphEdge[];
  layout: GraphLayout;
}
export interface GraphDiagnostic {
  scope: 'graph' | 'node' | 'edge';
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
export function validPosition(v: unknown): v is Position {
  return (
    plainRecord(v) &&
    Object.keys(v).length === 2 &&
    ['x', 'y'].every(
      (k) =>
        typeof v[k] === 'number' &&
        Number.isFinite(v[k]) &&
        Math.abs(v[k] as number) <= graphLimits.coordinate,
    )
  );
}
export function validGraphLayout(value: unknown): value is GraphLayout {
  return (
    isGraphJson(value) &&
    plainRecord(value) &&
    Object.entries(value).every(([id, pos]) => validGraphId(id) && validPosition(pos))
  );
}
export function isGraphDocument(value: unknown): value is GraphDocument {
  if (!isGraphJson(value) || !plainRecord(value)) return false;
  if (
    Object.keys(value).some(
      (k) =>
        !['schemaVersion', 'id', 'profile', 'attributes', 'nodes', 'edges', 'layout'].includes(k),
    )
  )
    return false;
  const g = value as unknown as GraphDocument;
  const attrs = (v: unknown) =>
    plainRecord(v) &&
    new TextEncoder().encode(JSON.stringify(v)).length <= graphLimits.attributeBytes;
  if (
    g.schemaVersion !== 1 ||
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
    !validGraphLayout(g.layout)
  )
    return false;
  const ids = new Set<string>([g.id]);
  for (const el of [...g.nodes, ...g.edges]) {
    const keys = g.nodes.includes(el as GraphNode)
      ? ['id', 'type', 'attributes']
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
  const nodes = new Set(g.nodes.map((n) => n.id));
  if (
    g.edges.some((e) => !nodes.has(e.from) || !nodes.has(e.to)) ||
    Object.keys(g.layout).some((id) => !nodes.has(id))
  )
    return false;
  return new TextEncoder().encode(JSON.stringify(g)).length <= graphLimits.documentBytes;
}
export function assertGraphDocument(value: unknown): asserts value is GraphDocument {
  if (!isGraphDocument(value))
    throw new Error('Invalid Graph schema, IDs, references, JSON values or size limits');
}
export function createGraph(
  profile: ProfileRef = { id: 'relations', version: 1 },
  id = newId('graph'),
): GraphDocument {
  return {
    schemaVersion: 1,
    id,
    profile: { ...profile },
    attributes: {},
    nodes: [],
    edges: [],
    layout: {},
  };
}
