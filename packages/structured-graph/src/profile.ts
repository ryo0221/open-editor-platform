import { canonicalJson, clone } from '@editor-platform/artifact-core';
import {
  assertGraphDocument,
  isGraphJson,
  plainRecord,
  validGraphId,
  type Attributes,
  type GraphDocument,
  type GraphDiagnostic,
  type JsonValue,
  type ProfileRef,
} from './model';
export interface AttributeSchema {
  type: 'string' | 'number' | 'boolean' | 'enum' | 'array' | 'object';
  required?: boolean;
  readOnly?: boolean;
  enum?: (string | number | boolean)[];
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  maxItems?: number;
  items?: AttributeSchema;
  properties?: Record<string, AttributeSchema>;
}
export interface AttributeUi {
  label?: string;
  description?: string;
  order?: string[];
  fields?: Record<string, AttributeUi>;
  labelField?: string;
  options?: { value: string | number | boolean; label: string }[];
}
export interface GraphType {
  schema: Record<string, AttributeSchema>;
  ui?: AttributeUi;
  readOnly?: boolean;
}
export interface GraphEdgeType extends GraphType {
  ui?: AttributeUi & {
    /** Declarative SVG line style. Color is a hex literal; dash lengths are logical pixels. */
    edgeStyle?: { color?: string; dash?: number[] };
  };
  connection?: {
    from?: string[];
    to?: string[];
    allowSelf?: boolean;
    allowParallel?: boolean;
    allowCycles?: boolean;
    maxIncoming?: number;
    maxOutgoing?: number;
  };
}
export interface GraphProfile extends ProfileRef {
  schemaVersion: 1;
  graph: GraphType;
  nodes: Record<string, GraphType>;
  edges: Record<string, GraphEdgeType>;
}
function schemaValid(s: unknown, depth = 0): s is AttributeSchema {
  if (
    depth > 8 ||
    !plainRecord(s) ||
    !['string', 'number', 'boolean', 'enum', 'array', 'object'].includes(String(s.type))
  )
    return false;
  if (
    Object.keys(s).some(
      (k) =>
        ![
          'type',
          'required',
          'readOnly',
          'enum',
          'minimum',
          'maximum',
          'maxLength',
          'maxItems',
          'items',
          'properties',
        ].includes(k),
    )
  )
    return false;
  if (['required', 'readOnly'].some((k) => s[k] !== undefined && typeof s[k] !== 'boolean'))
    return false;
  if (
    ['minimum', 'maximum'].some(
      (k) => s[k] !== undefined && (typeof s[k] !== 'number' || !Number.isFinite(s[k])),
    )
  )
    return false;
  if (typeof s.minimum === 'number' && typeof s.maximum === 'number' && s.minimum > s.maximum)
    return false;
  if (
    ['maxLength', 'maxItems'].some(
      (k) => s[k] !== undefined && (!Number.isSafeInteger(s[k]) || (s[k] as number) < 0),
    )
  )
    return false;
  if (
    s.type === 'enum' &&
    (!Array.isArray(s.enum) ||
      !s.enum.length ||
      s.enum.some((v) => !['string', 'number', 'boolean'].includes(typeof v)) ||
      new Set(s.enum.map(String)).size !== s.enum.length)
  )
    return false;
  if (s.type === 'array' && !schemaValid(s.items, depth + 1)) return false;
  if (
    s.type === 'object' &&
    (!plainRecord(s.properties) ||
      !Object.entries(s.properties).every(([k, v]) => validGraphId(k) && schemaValid(v, depth + 1)))
  )
    return false;
  return true;
}
function uiValid(ui: unknown, depth = 0, edge = false): boolean {
  return (
    depth <= 8 &&
    plainRecord(ui) &&
    Object.entries(ui).every(([key, v]) => {
      if (key === 'edgeStyle' && edge && depth === 0)
        return (
          plainRecord(v) &&
          Object.entries(v).every(([key, value]) =>
            key === 'color'
              ? typeof value === 'string' && /^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(value)
              : key === 'dash' &&
                Array.isArray(value) &&
                value.length <= 8 &&
                value.every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= 64),
          )
        );
      if (['label', 'description', 'labelField'].includes(key)) return typeof v === 'string';
      if (key === 'order')
        return Array.isArray(v) && v.every(validGraphId) && new Set(v).size === v.length;
      if (key === 'options')
        return (
          Array.isArray(v) &&
          v.every(
            (option) =>
              plainRecord(option) &&
              Object.keys(option).every((key) => key === 'value' || key === 'label') &&
              ['string', 'number', 'boolean'].includes(typeof option.value) &&
              typeof option.label === 'string',
          )
        );
      return (
        key === 'fields' &&
        plainRecord(v) &&
        Object.entries(v).every(([k, x]) => validGraphId(k) && uiValid(x, depth + 1))
      );
    })
  );
}
export function isGraphProfile(value: unknown): value is GraphProfile {
  if (!isGraphJson(value) || !plainRecord(value)) return false;
  if (
    Object.keys(value).some(
      (k) => !['schemaVersion', 'id', 'version', 'graph', 'nodes', 'edges'].includes(k),
    )
  )
    return false;
  const p = value as unknown as GraphProfile;
  const type = (t: unknown, edge = false): boolean => {
    if (
      !plainRecord(t) ||
      !plainRecord(t.schema) ||
      Object.keys(t).some(
        (k) => !['schema', 'ui', 'readOnly', ...(edge ? ['connection'] : [])].includes(k),
      ) ||
      !Object.entries(t.schema).every(([k, s]) => validGraphId(k) && schemaValid(s)) ||
      (t.ui !== undefined && !uiValid(t.ui, 0, edge)) ||
      (t.readOnly !== undefined && typeof t.readOnly !== 'boolean')
    )
      return false;
    if (!edge || t.connection === undefined) return true;
    const c = t.connection;
    return (
      plainRecord(c) &&
      Object.entries(c).every(([k, v]) => {
        if (k === 'from' || k === 'to')
          return (
            Array.isArray(v) &&
            v.every((id) => typeof id === 'string' && Object.hasOwn(p.nodes, id))
          );
        if (['allowSelf', 'allowParallel', 'allowCycles'].includes(k))
          return typeof v === 'boolean';
        return (
          ['maxIncoming', 'maxOutgoing'].includes(k) &&
          Number.isSafeInteger(v) &&
          (v as number) >= 0
        );
      })
    );
  };
  return (
    p.schemaVersion === 1 &&
    validGraphId(p.id) &&
    Number.isSafeInteger(p.version) &&
    p.version > 0 &&
    plainRecord(p.nodes) &&
    Object.keys(p.nodes).length > 0 &&
    plainRecord(p.edges) &&
    type(p.graph) &&
    Object.entries(p.nodes).every(([k, t]) => validGraphId(k) && type(t)) &&
    Object.entries(p.edges).every(([k, t]) => validGraphId(k) && type(t, true))
  );
}
export function assertGraphProfile(value: unknown): asserts value is GraphProfile {
  if (!isGraphProfile(value)) throw new Error('Invalid or unsupported declarative Graph Profile');
}
export function validateAttributes(
  attributes: Attributes,
  schema: Record<string, AttributeSchema>,
  address: Pick<GraphDiagnostic, 'scope' | 'elementId'>,
): GraphDiagnostic[] {
  const diagnostics: GraphDiagnostic[] = [];
  function check(value: JsonValue | undefined, s: AttributeSchema, path: string[]) {
    const add = (code: string, message: string, blocking = true) =>
      diagnostics.push({
        ...address,
        path,
        code,
        message,
        args: { type: s.type },
        severity: 'error',
        blocking,
      });
    if (value === undefined || value === null || (s.required && value === '')) {
      if (s.required) add('required', 'Required field', false);
      return;
    }
    const valid =
      s.type === 'string'
        ? typeof value === 'string'
        : s.type === 'number'
          ? typeof value === 'number'
          : s.type === 'boolean'
            ? typeof value === 'boolean'
            : s.type === 'enum'
              ? s.enum?.includes(value as string)
              : s.type === 'array'
                ? Array.isArray(value)
                : plainRecord(value);
    if (!valid) {
      add('type', `Expected ${s.type}`);
      return;
    }
    if (typeof value === 'string' && s.maxLength !== undefined && value.length > s.maxLength)
      add('length', 'Text is too long');
    if (
      typeof value === 'number' &&
      ((s.minimum !== undefined && value < s.minimum) ||
        (s.maximum !== undefined && value > s.maximum))
    )
      add('range', 'Number is outside the declared range');
    if (Array.isArray(value)) {
      if (s.maxItems !== undefined && value.length > s.maxItems) add('items', 'Too many items');
      value.forEach((v, i) => check(v, s.items!, [...path, String(i)]));
    }
    if (s.type === 'object')
      for (const [k, child] of Object.entries(s.properties!))
        check((value as Attributes)[k], child, [...path, k]);
  }
  for (const [k, s] of Object.entries(schema)) check(attributes[k], s, [k]);
  return diagnostics;
}
/** Two iterative DFS passes visit each vertex/edge once and identify exact cyclic components. */
function components(adjacency: Map<string, string[]>, reverse: Map<string, string[]>) {
  const seen = new Set<string>(),
    finish: string[] = [];
  for (const start of adjacency.keys()) {
    if (seen.has(start)) continue;
    seen.add(start);
    const stack = [{ id: start, index: 0 }];
    while (stack.length) {
      const frame = stack[stack.length - 1],
        children = adjacency.get(frame.id)!;
      if (frame.index < children.length) {
        const next = children[frame.index++];
        if (!seen.has(next)) {
          seen.add(next);
          stack.push({ id: next, index: 0 });
        }
      } else {
        finish.push(frame.id);
        stack.pop();
      }
    }
  }
  const group = new Map<string, number>(),
    sizes = new Map<number, number>();
  for (const start of finish.reverse()) {
    if (group.has(start)) continue;
    const id = sizes.size,
      stack = [start];
    group.set(start, id);
    let size = 0;
    while (stack.length) {
      const vertex = stack.pop()!;
      size++;
      for (const next of reverse.get(vertex)!)
        if (!group.has(next)) {
          group.set(next, id);
          stack.push(next);
        }
    }
    sizes.set(id, size);
  }
  return { group, sizes };
}
export function validateGraph(graph: GraphDocument, profile: GraphProfile): GraphDiagnostic[] {
  assertGraphDocument(graph);
  assertGraphProfile(profile);
  if (graph.profile.id !== profile.id || graph.profile.version !== profile.version)
    throw new Error('Graph Profile is missing or its version does not match');
  const result = validateAttributes(graph.attributes, profile.graph.schema, {
    scope: 'graph',
    elementId: graph.id,
  });
  const add = (id: string, code: string, message: string, scope: 'node' | 'edge') =>
    result.push({
      scope,
      elementId: id,
      path: [],
      code,
      message,
      args: { elementId: id },
      severity: 'error',
      blocking: true,
    });
  for (const n of graph.nodes) {
    const t = profile.nodes[n.type];
    if (!t) add(n.id, 'node-type', 'Unknown node type', 'node');
    else
      result.push(
        ...validateAttributes(n.attributes, t.schema, { scope: 'node', elementId: n.id }),
      );
  }
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const byType = new Map<string, typeof graph.edges>();
  for (const edge of graph.edges) {
    const list = byType.get(edge.type) ?? [];
    list.push(edge);
    byType.set(edge.type, list);
  }
  const counts = new Map<
    string,
    {
      incoming: Map<string, number>;
      outgoing: Map<string, number>;
      pairs: Map<string, number>;
      cyclic: Set<string>;
    }
  >();
  for (const [type, edges] of byType) {
    const incoming = new Map<string, number>(),
      outgoing = new Map<string, number>(),
      pairs = new Map<string, number>(),
      adjacency = new Map<string, string[]>(),
      reverse = new Map<string, string[]>(),
      cyclic = new Set<string>();
    for (const edge of edges) {
      incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
      outgoing.set(edge.from, (outgoing.get(edge.from) ?? 0) + 1);
      const key = canonicalJson([edge.from, edge.to]);
      pairs.set(key, (pairs.get(key) ?? 0) + 1);
      for (const id of [edge.from, edge.to]) {
        if (!adjacency.has(id)) adjacency.set(id, []);
        if (!reverse.has(id)) reverse.set(id, []);
      }
      adjacency.get(edge.from)!.push(edge.to);
      reverse.get(edge.to)!.push(edge.from);
    }
    if (profile.edges[type]?.connection?.allowCycles === false) {
      const { group, sizes } = components(adjacency, reverse);
      for (const edge of edges)
        if (
          group.get(edge.from) === group.get(edge.to) &&
          (edge.from === edge.to || sizes.get(group.get(edge.from)!)! > 1)
        )
          cyclic.add(edge.id);
    }
    counts.set(type, { incoming, outgoing, pairs, cyclic });
  }
  for (const e of graph.edges) {
    const t = profile.edges[e.type];
    if (!t) {
      add(e.id, 'edge-type', 'Unknown edge type', 'edge');
      continue;
    }
    result.push(...validateAttributes(e.attributes, t.schema, { scope: 'edge', elementId: e.id }));
    const c = t.connection;
    if (!c) continue;
    if (
      (c.from && !c.from.includes(nodes.get(e.from)!.type)) ||
      (c.to && !c.to.includes(nodes.get(e.to)!.type))
    )
      add(e.id, 'connection-type', 'This connection is outside the declared node types', 'edge');
    if (c.allowSelf === false && e.from === e.to)
      add(e.id, 'self', 'Self connections are prohibited', 'edge');
    const count = counts.get(e.type)!;
    if (c.allowParallel === false && count.pairs.get(canonicalJson([e.from, e.to]))! > 1)
      add(e.id, 'parallel', 'Parallel connections are prohibited', 'edge');
    if (
      (c.maxIncoming !== undefined && count.incoming.get(e.to)! > c.maxIncoming) ||
      (c.maxOutgoing !== undefined && count.outgoing.get(e.from)! > c.maxOutgoing)
    )
      add(e.id, 'degree', 'Connection count exceeds the declared limit', 'edge');
    if (count.cyclic.has(e.id)) add(e.id, 'cycle', 'Cycles are prohibited', 'edge');
  }
  return result;
}
export class GraphValidationError extends Error {
  constructor(
    readonly diagnostic: GraphDiagnostic,
    readonly graph: GraphDocument,
  ) {
    super(`${diagnostic.elementId} ${diagnostic.path.join('.')}: ${diagnostic.message}`);
  }
}
export function assertGraph(graph: GraphDocument, profile: GraphProfile) {
  const first = validateGraph(graph, profile).find((d) => d.blocking);
  if (first) throw new GraphValidationError(first, graph);
}
export function assertEditableAttributes(
  before: Attributes,
  after: Attributes,
  schema: Record<string, AttributeSchema>,
  initial = false,
) {
  function members(a: Attributes, b: Attributes, fields: Record<string, AttributeSchema>) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)]))
      if (
        !initial &&
        !Object.hasOwn(fields, k) &&
        (Object.hasOwn(a, k) !== Object.hasOwn(b, k) || canonicalJson(a[k]) !== canonicalJson(b[k]))
      )
        throw new Error(
          'Only declared attributes can be edited; undeclared child data must be retained',
        );
    for (const [k, s] of Object.entries(fields)) check(a[k], b[k], s);
  }
  function check(a: JsonValue | undefined, b: JsonValue | undefined, s: AttributeSchema) {
    if (
      s.readOnly &&
      ((a === undefined) !== (b === undefined) || canonicalJson(a) !== canonicalJson(b))
    )
      throw new Error('This attribute is read only');
    if (s.type === 'object')
      members(
        plainRecord(a) ? (a as Attributes) : {},
        plainRecord(b) ? (b as Attributes) : {},
        s.properties!,
      );
    if (s.type === 'array') {
      const aa = Array.isArray(a) ? a : [],
        bb = Array.isArray(b) ? b : [];
      for (let i = 0; i < Math.max(aa.length, bb.length); i++) check(aa[i], bb[i], s.items!);
    }
  }
  members(before, after, schema);
}
/** Whole-object inputs update declared children and preserve all unmapped members. */
export function mergeGraphAttribute(
  previous: JsonValue | undefined,
  value: JsonValue,
  schema: AttributeSchema,
): JsonValue {
  if (schema.type === 'object' && plainRecord(value)) {
    const original = plainRecord(previous) ? (previous as Attributes) : {},
      next = { ...original };
    for (const [key, child] of Object.entries(value)) {
      const field = schema.properties?.[key];
      if (!field) {
        if (!Object.hasOwn(original, key) || canonicalJson(original[key]) !== canonicalJson(child))
          throw new Error(
            'Only declared children can be edited; undeclared child data must be retained',
          );
      } else next[key] = mergeGraphAttribute(original[key], child as JsonValue, field);
    }
    return next;
  }
  return clone(value);
}
