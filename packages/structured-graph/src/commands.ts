import { canonicalJson, clone } from '@editor-platform/artifact-core';
import { command, type EditorCommand } from '@editor-platform/editor-core';
import {
  isGraphJson,
  plainRecord,
  validGraphId,
  validPosition,
  type Attributes,
  type GraphDocument,
  type GraphNode,
  type GraphEdge,
  type Position,
  type JsonValue,
} from './model';
import {
  assertEditableAttributes,
  assertGraph,
  assertGraphProfile,
  mergeGraphAttribute,
  type GraphProfile,
  type AttributeSchema,
} from './profile';
/** A bounded scalar draft seed; complex or unsatisfiable fields remain incomplete. */
export function createGraphNode(profile: GraphProfile, type: string, id: string): GraphNode {
  assertGraphProfile(profile);
  const schema = profile.nodes[type]?.schema;
  if (!schema) throw new Error('Unknown Graph node type');
  const seed = (s: AttributeSchema): JsonValue | undefined => {
    if (s.type === 'string') return 'New item'.slice(0, s.maxLength ?? 8);
    if (s.type === 'number')
      return Math.min(s.maximum ?? Infinity, Math.max(s.minimum ?? -Infinity, 0));
    if (s.type === 'boolean') return false;
    if (s.type === 'enum')
      return s.enum!.find(
        (value) =>
          !(typeof value === 'string' && s.maxLength !== undefined && value.length > s.maxLength) &&
          !(
            typeof value === 'number' &&
            ((s.minimum !== undefined && value < s.minimum) ||
              (s.maximum !== undefined && value > s.maximum))
          ),
      );
    return undefined;
  };
  return {
    id,
    type,
    attributes: Object.fromEntries(
      Object.entries(schema).flatMap(([key, field]) => {
        const value = field.readOnly ? undefined : seed(field);
        return value === undefined ? [] : [[key, value]];
      }),
    ),
  };
}
export type GraphIntent =
  | { type: 'add-node'; node: GraphNode; position: Position }
  | { type: 'add-edge'; edge: GraphEdge }
  | {
      type: 'set-attribute';
      scope: 'graph' | 'node' | 'edge';
      id: string;
      path: string[];
      value: JsonValue;
    }
  | { type: 'remove-attribute'; scope: 'graph' | 'node' | 'edge'; id: string; path: string[] }
  | { type: 'move-node'; id: string; position: Position }
  | { type: 'delete-node'; id: string; cascade: boolean }
  | { type: 'delete-edge'; id: string }
  | { type: 'reconnect-edge'; id: string; from: string; to: string };
type RawGraphIntent = Record<string, unknown>;
function attributeIntentKeys(raw: RawGraphIntent): string[] {
  if (
    !['graph', 'node', 'edge'].includes(String(raw.scope)) ||
    !Array.isArray(raw.path) ||
    !raw.path.length ||
    raw.path.length > 8 ||
    !raw.path.every(validGraphId) ||
    (raw.type === 'set-attribute' && !Object.hasOwn(raw, 'value'))
  )
    throw new Error('Invalid attribute intent');
  return ['type', 'scope', 'id', 'path', ...(raw.type === 'set-attribute' ? ['value'] : [])];
}
/** Validates each intent's own fields and returns the exact key set it may carry. */
const graphIntentKeys: Record<GraphIntent['type'], (raw: RawGraphIntent) => string[]> = {
  'add-node': (raw) => {
    if (
      !plainRecord(raw.node) ||
      !validGraphId(raw.node.id) ||
      !validGraphId(raw.node.type) ||
      !plainRecord(raw.node.attributes) ||
      !validPosition(raw.position)
    )
      throw new Error('Invalid new node');
    return ['type', 'node', 'position'];
  },
  'add-edge': (raw) => {
    if (
      !plainRecord(raw.edge) ||
      !['id', 'type', 'from', 'to'].every((k) =>
        validGraphId((raw.edge as Record<string, unknown>)[k]),
      ) ||
      !plainRecord(raw.edge.attributes)
    )
      throw new Error('Invalid new edge');
    return ['type', 'edge'];
  },
  'set-attribute': attributeIntentKeys,
  'remove-attribute': attributeIntentKeys,
  'move-node': (raw) => {
    if (!validPosition(raw.position)) throw new Error('Invalid position');
    return ['type', 'id', 'position'];
  },
  'delete-node': (raw) => {
    if (typeof raw.cascade !== 'boolean')
      throw new Error('Deletion requires an explicit cascade choice');
    return ['type', 'id', 'cascade'];
  },
  'delete-edge': () => ['type', 'id'],
  'reconnect-edge': (raw) => {
    if (!validGraphId(raw.from) || !validGraphId(raw.to)) throw new Error('Invalid connection');
    return ['type', 'id', 'from', 'to'];
  },
};
function assertGraphIntent(raw: unknown) {
  if (!plainRecord(raw) || typeof raw.type !== 'string') throw new Error('Invalid Graph intent');
  if (!Object.hasOwn(graphIntentKeys, raw.type)) throw new Error('Unsupported Graph intent');
  const keys = graphIntentKeys[raw.type as GraphIntent['type']](raw);
  if (
    Object.keys(raw).some((k) => !keys.includes(k)) ||
    keys.some((k) => !Object.hasOwn(raw, k)) ||
    ('id' in raw && !validGraphId(raw.id))
  )
    throw new Error('Invalid Graph intent fields');
}
export function parseGraphIntents(value: unknown): GraphIntent[] {
  if (!isGraphJson(value) || !Array.isArray(value) || !value.length || value.length > 1000)
    throw new Error('Expected a bounded Graph intent batch');
  for (const raw of value) assertGraphIntent(raw);
  return clone(value as unknown as GraphIntent[]);
}
function updateAttribute(
  attributes: Attributes,
  schema: Record<string, AttributeSchema>,
  path: string[],
  value: JsonValue | undefined,
): Attributes {
  const [key, ...rest] = path,
    s = schema[key];
  if (!s) throw new Error('This attribute is not declared editable');
  if (s.readOnly) throw new Error('This attribute is read only');
  const next = { ...attributes };
  if (rest.length) {
    if (s.type !== 'object') throw new Error('Only declared object fields support a nested path');
    const current = attributes[key];
    if (current !== undefined && current !== null && !plainRecord(current))
      throw new Error('Attribute object is invalid');
    next[key] = updateAttribute((current ?? {}) as Attributes, s.properties!, rest, value);
  } else if (value === undefined) delete next[key];
  else next[key] = mergeGraphAttribute(attributes[key], value, s);
  return next;
}
/** The same final-content/read-only boundary also guards trusted arbitrary commands. */
export function guardGraphCommand(
  cmd: EditorCommand<GraphDocument>,
  profile: GraphProfile,
  writable: () => boolean = () => true,
): EditorCommand<GraphDocument> {
  return {
    ...cmd,
    readonlyInput: undefined,
    apply(current) {
      if (!writable()) throw new Error('Graph is read only');
      assertGraph(current, profile);
      const next = cmd.apply(clone(current));
      assertGraph(next, profile);
      if (next.id !== current.id || canonicalJson(next.profile) !== canonicalJson(current.profile))
        throw new Error('Graph identity and Profile cannot be replaced by an edit');
      const protectedType = (
        a: GraphNode | GraphEdge,
        b: GraphNode | GraphEdge | undefined,
        type: { readOnly?: boolean; schema: Record<string, AttributeSchema> },
      ) => {
        if (type.readOnly && canonicalJson(a) !== canonicalJson(b))
          throw new Error('This element is read only');
        if (b && a.type !== b.type)
          throw new Error('Changing the type of an existing identity is not supported');
        if (b) assertEditableAttributes(a.attributes, b.attributes, type.schema);
      };
      if (profile.graph.readOnly && canonicalJson(current) !== canonicalJson(next))
        throw new Error('Graph is read only');
      assertEditableAttributes(current.attributes, next.attributes, profile.graph.schema);
      for (const n of current.nodes)
        if (
          profile.nodes[n.type].readOnly &&
          canonicalJson(current.layout[n.id]) !== canonicalJson(next.layout[n.id])
        )
          throw new Error('This node layout is read only');
      for (const n of next.nodes.filter((n) => !current.nodes.some((x) => x.id === n.id))) {
        if (profile.nodes[n.type].readOnly) throw new Error('This node type is read only');
        assertEditableAttributes({}, n.attributes, profile.nodes[n.type].schema, true);
      }
      for (const e of next.edges.filter((e) => !current.edges.some((x) => x.id === e.id))) {
        if (profile.edges[e.type].readOnly) throw new Error('This edge type is read only');
        assertEditableAttributes({}, e.attributes, profile.edges[e.type].schema, true);
      }
      current.nodes.forEach((n) =>
        protectedType(
          n,
          next.nodes.find((x) => x.id === n.id),
          profile.nodes[n.type],
        ),
      );
      current.edges.forEach((e) =>
        protectedType(
          e,
          next.edges.find((x) => x.id === e.id),
          profile.edges[e.type],
        ),
      );
      return next;
    },
  };
}
export function graphCommand(
  profile: GraphProfile,
  value: unknown,
  baseFingerprint?: string,
): EditorCommand<GraphDocument> {
  const intents = parseGraphIntents(value);
  return guardGraphCommand(
    command('graph.edit', 'Edit graph', (current) => {
      if (baseFingerprint !== undefined && canonicalJson(current) !== baseFingerprint)
        throw new Error('Stale Graph projection; reload the current graph');
      const next = clone(current);
      for (const intent of intents) {
        switch (intent.type) {
          case 'add-node':
            next.nodes.push(clone(intent.node));
            next.layout[intent.node.id] = clone(intent.position);
            break;
          case 'add-edge':
            next.edges.push(clone(intent.edge));
            break;
          case 'move-node':
            if (!next.nodes.some((n) => n.id === intent.id)) throw new Error('Node is missing');
            next.layout[intent.id] = clone(intent.position);
            break;
          case 'delete-node': {
            if (!next.nodes.some((n) => n.id === intent.id)) throw new Error('Node is missing');
            if (
              !intent.cascade &&
              next.edges.some((e) => e.from === intent.id || e.to === intent.id)
            )
              throw new Error('Node has connections; confirm cascade deletion');
            next.nodes = next.nodes.filter((n) => n.id !== intent.id);
            next.edges = next.edges.filter((e) => e.from !== intent.id && e.to !== intent.id);
            delete next.layout[intent.id];
            break;
          }
          case 'delete-edge':
            if (!next.edges.some((e) => e.id === intent.id)) throw new Error('Edge is missing');
            next.edges = next.edges.filter((e) => e.id !== intent.id);
            break;
          case 'reconnect-edge':
            if (!next.edges.some((e) => e.id === intent.id)) throw new Error('Edge is missing');
            next.edges = next.edges.map((e) =>
              e.id === intent.id ? { ...e, from: intent.from, to: intent.to } : e,
            );
            break;
          case 'set-attribute':
          case 'remove-attribute': {
            const value = intent.type === 'set-attribute' ? intent.value : undefined;
            if (intent.scope === 'graph') {
              if (next.id !== intent.id) throw new Error('Graph target is missing');
              next.attributes = updateAttribute(
                next.attributes,
                profile.graph.schema,
                intent.path,
                value,
              );
            } else {
              const items = intent.scope === 'node' ? next.nodes : next.edges,
                types = intent.scope === 'node' ? profile.nodes : profile.edges,
                item = items.find((x) => x.id === intent.id);
              if (!item) throw new Error('Attribute target is missing');
              item.attributes = updateAttribute(
                item.attributes,
                types[item.type].schema,
                intent.path,
                value,
              );
            }
          }
        }
      }
      return next;
    }),
    profile,
  );
}
