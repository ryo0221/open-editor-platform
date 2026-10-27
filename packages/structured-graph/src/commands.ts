import { canonicalJson, clone } from '@editor-platform/artifact-core';
import { command, type EditorCommand } from '@editor-platform/editor-core';
import {
  defaultGraphPosition,
  graphLimits,
  graphSectionAncestors,
  graphSectionSubtree,
  isGraphJson,
  isGraphNodeShape,
  plainRecord,
  validGraphId,
  validGraphStyle,
  validPosition,
  validSectionPresentation,
  type Attributes,
  type GraphDocument,
  type GraphNode,
  type GraphEdge,
  type GraphNodeShape,
  type GraphNodeStyle,
  type GraphSection,
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
  return { id, type, attributes: seedGraphAttributes(schema, 'New item') };
}
/** A new Section with the same bounded seed as a node. */
export function createGraphSection(
  profile: GraphProfile,
  type: string,
  id: string,
  parentId?: string,
): GraphSection {
  assertGraphProfile(profile);
  const schema = profile.sections[type]?.schema;
  if (!schema) throw new Error('Unknown Graph section type');
  return {
    id,
    type,
    attributes: seedGraphAttributes(schema, 'New section'),
    ...(parentId === undefined ? {} : { parentId }),
  };
}
function seedGraphAttributes(schema: Record<string, AttributeSchema>, text: string): Attributes {
  const seed = (s: AttributeSchema): JsonValue | undefined => {
    if (s.type === 'string') return text.slice(0, s.maxLength ?? text.length);
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
  return Object.fromEntries(
    Object.entries(schema).flatMap(([key, field]) => {
      const value = field.readOnly ? undefined : seed(field);
      return value === undefined ? [] : [[key, value]];
    }),
  );
}
/** A Section's frame: position and size in logical pixels. */
export interface GraphSectionBounds extends Position {
  width: number;
  height: number;
}
export type GraphIntent =
  | { type: 'add-node'; node: GraphNode; position: Position }
  | { type: 'add-edge'; edge: GraphEdge }
  | {
      type: 'set-attribute';
      scope: 'graph' | 'node' | 'edge' | 'section';
      id: string;
      path: string[];
      value: JsonValue;
    }
  | {
      type: 'remove-attribute';
      scope: 'graph' | 'node' | 'edge' | 'section';
      id: string;
      path: string[];
    }
  | { type: 'move-node'; id: string; position: Position }
  | { type: 'delete-node'; id: string; cascade: boolean }
  | { type: 'delete-edge'; id: string }
  | { type: 'reconnect-edge'; id: string; from: string; to: string }
  /** Presentation only: null returns the node to its Profile type default. */
  | { type: 'set-node-shape'; id: string; shape: GraphNodeShape | null }
  | { type: 'set-node-style'; id: string; style: GraphNodeStyle | null }
  | { type: 'add-section'; section: GraphSection; bounds: GraphSectionBounds }
  /** Membership is explicit: moving or resizing never changes it. Coordinates stay as they are. */
  | { type: 'set-node-section'; id: string; sectionId: string | null }
  | { type: 'set-section-parent'; id: string; parentId: string | null }
  /** Moves the Section, its nested Sections and every member node by the same offset. */
  | { type: 'move-section'; id: string; position: Position }
  /** Changes the frame only; membership and node positions stay. */
  | { type: 'resize-section'; id: string; bounds: GraphSectionBounds }
  | { type: 'set-section-style'; id: string; style: GraphNodeStyle | null }
  /** Removes the Section; its direct members move up to its parent. Nodes and edges stay. */
  | { type: 'delete-section'; id: string };
type RawGraphIntent = Record<string, unknown>;
function attributeIntentKeys(raw: RawGraphIntent): string[] {
  if (
    !['graph', 'node', 'edge', 'section'].includes(String(raw.scope)) ||
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
  'set-node-shape': (raw) => {
    if (raw.shape !== null && !isGraphNodeShape(raw.shape)) throw new Error('Unknown node shape');
    return ['type', 'id', 'shape'];
  },
  'set-node-style': (raw) => {
    if (raw.style !== null && !validGraphStyle(raw.style)) throw new Error('Invalid node style');
    return ['type', 'id', 'style'];
  },
  'add-section': (raw) => {
    const section = raw.section;
    if (
      !plainRecord(section) ||
      Object.keys(section).some((k) => !['id', 'type', 'attributes', 'parentId'].includes(k)) ||
      !validGraphId(section.id) ||
      !validGraphId(section.type) ||
      !plainRecord(section.attributes) ||
      (section.parentId !== undefined && !validGraphId(section.parentId)) ||
      !validBounds(raw.bounds)
    )
      throw new Error('Invalid new section');
    return ['type', 'section', 'bounds'];
  },
  'set-node-section': (raw) => {
    if (raw.sectionId !== null && !validGraphId(raw.sectionId)) throw new Error('Invalid section');
    return ['type', 'id', 'sectionId'];
  },
  'set-section-parent': (raw) => {
    if (raw.parentId !== null && !validGraphId(raw.parentId)) throw new Error('Invalid section');
    return ['type', 'id', 'parentId'];
  },
  'move-section': (raw) => {
    if (!validPosition(raw.position)) throw new Error('Invalid position');
    return ['type', 'id', 'position'];
  },
  'resize-section': (raw) => {
    if (!validBounds(raw.bounds)) throw new Error('Invalid section bounds');
    return ['type', 'id', 'bounds'];
  },
  'set-section-style': (raw) => {
    if (raw.style !== null && !validGraphStyle(raw.style)) throw new Error('Invalid section style');
    return ['type', 'id', 'style'];
  },
  'delete-section': () => ['type', 'id'],
};
export type GraphSectionIntent = Extract<
  GraphIntent,
  {
    type:
      | 'add-section'
      | 'set-node-section'
      | 'set-section-parent'
      | 'move-section'
      | 'resize-section'
      | 'set-section-style'
      | 'delete-section';
  }
>;
const sectionIntentTypes = new Set<string>([
  'add-section',
  'set-node-section',
  'set-section-parent',
  'move-section',
  'resize-section',
  'set-section-style',
  'delete-section',
]);
/** Intents that create or change Section structure or frames. */
export const isGraphSectionStructureIntent = (intent: GraphIntent): intent is GraphSectionIntent =>
  sectionIntentTypes.has(intent.type);
/** Whether an intent creates, changes or relies on a Section, including Section attributes. */
export const isGraphSectionIntent = (intent: GraphIntent) =>
  isGraphSectionStructureIntent(intent) ||
  ((intent.type === 'set-attribute' || intent.type === 'remove-attribute') &&
    intent.scope === 'section');
const validBounds = (v: unknown): v is GraphSectionBounds =>
  plainRecord(v) && Object.keys(v).length === 4 && validSectionPresentation(v);
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
          canonicalJson(current.presentation.nodes[n.id]) !==
            canonicalJson(next.presentation.nodes[n.id])
        )
          throw new Error('This node presentation is read only');
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
      guardSections(current, next, profile);
      return next;
    },
  };
}
/**
 * Read-only Section types keep the Section, its frame and its existence, and nothing enters or
 * leaves them. Rights over a parent Section never bypass a read-only descendant: the check is on
 * the content difference, so any batch or arbitrary command meets the same rule.
 */
function guardSections(current: GraphDocument, next: GraphDocument, profile: GraphProfile) {
  const members = (g: GraphDocument, id: string) =>
    canonicalJson([
      g.nodes.filter((n) => n.sectionId === id).map((n) => n.id),
      g.sections.filter((s) => s.parentId === id).map((s) => s.id),
    ]);
  for (const s of next.sections.filter((s) => !current.sections.some((x) => x.id === s.id))) {
    if (profile.sections[s.type].readOnly) throw new Error('This section type is read only');
    assertEditableAttributes({}, s.attributes, profile.sections[s.type].schema, true);
  }
  for (const s of current.sections) {
    const after = next.sections.find((x) => x.id === s.id),
      type = profile.sections[s.type];
    if (type.readOnly) {
      if (
        canonicalJson(s) !== canonicalJson(after) ||
        canonicalJson(current.presentation.sections[s.id]) !==
          canonicalJson(next.presentation.sections[s.id])
      )
        throw new Error('This section is read only');
      if (members(current, s.id) !== members(next, s.id))
        throw new Error('Nothing can enter or leave a read-only section');
    }
    if (after && after.type !== s.type)
      throw new Error('Changing the type of an existing identity is not supported');
    if (after) assertEditableAttributes(s.attributes, after.attributes, type.schema);
  }
}
const sectionIn = (g: GraphDocument, id: string) => {
  const section = g.sections.find((s) => s.id === id);
  if (!section) throw new Error('Section is missing');
  return section;
};
/** Refuses a parent that would make a loop or nest deeper than the limit, with a reason. */
function assertSectionParent(g: GraphDocument, id: string, parentId: string | undefined) {
  if (parentId === undefined) return;
  sectionIn(g, parentId);
  if (graphSectionSubtree(g.sections, id).has(parentId))
    throw new Error('A section cannot be placed inside itself');
  const depth = (graphSectionAncestors(g.sections, parentId)?.length ?? 0) + 2,
    below = Math.max(
      ...[...graphSectionSubtree(g.sections, id)].map(
        (x) => graphSectionAncestors(g.sections, x)!.indexOf(id) + 1,
      ),
    );
  if (depth + below > graphLimits.sectionDepth)
    throw new Error(`Sections can nest at most ${graphLimits.sectionDepth} levels`);
}
function applySectionIntent(next: GraphDocument, intent: GraphSectionIntent) {
  switch (intent.type) {
    case 'add-section': {
      if (next.sections.some((s) => s.id === intent.section.id))
        throw new Error('Section already exists');
      next.sections.push(clone(intent.section));
      assertSectionParent(next, intent.section.id, intent.section.parentId);
      next.presentation.sections[intent.section.id] = clone(intent.bounds);
      return;
    }
    case 'set-node-section': {
      const node = next.nodes.find((n) => n.id === intent.id);
      if (!node) throw new Error('Node is missing');
      if (intent.sectionId === null) delete node.sectionId;
      else {
        sectionIn(next, intent.sectionId);
        node.sectionId = intent.sectionId;
      }
      return;
    }
    case 'set-section-parent': {
      const section = sectionIn(next, intent.id);
      assertSectionParent(next, intent.id, intent.parentId ?? undefined);
      if (intent.parentId === null) delete section.parentId;
      else section.parentId = intent.parentId;
      return;
    }
    case 'move-section': {
      sectionIn(next, intent.id);
      const frame = next.presentation.sections[intent.id],
        dx = intent.position.x - frame.x,
        dy = intent.position.y - frame.y,
        subtree = graphSectionSubtree(next.sections, intent.id);
      for (const id of subtree) {
        const b = next.presentation.sections[id];
        next.presentation.sections[id] = { ...b, x: b.x + dx, y: b.y + dy };
      }
      next.nodes.forEach((n, index) => {
        if (n.sectionId === undefined || !subtree.has(n.sectionId)) return;
        const p = next.presentation.nodes[n.id] ?? defaultGraphPosition(index);
        next.presentation.nodes[n.id] = { ...p, x: p.x + dx, y: p.y + dy };
      });
      return;
    }
    case 'resize-section':
      sectionIn(next, intent.id);
      next.presentation.sections[intent.id] = {
        ...next.presentation.sections[intent.id],
        ...clone(intent.bounds),
      };
      return;
    case 'set-section-style': {
      sectionIn(next, intent.id);
      const frame = { ...next.presentation.sections[intent.id] };
      if (intent.style && Object.keys(intent.style).length) frame.style = clone(intent.style);
      else delete frame.style;
      next.presentation.sections[intent.id] = frame;
      return;
    }
    case 'delete-section': {
      const parent = sectionIn(next, intent.id).parentId;
      for (const n of next.nodes)
        if (n.sectionId === intent.id) {
          if (parent === undefined) delete n.sectionId;
          else n.sectionId = parent;
        }
      for (const s of next.sections)
        if (s.parentId === intent.id) {
          if (parent === undefined) delete s.parentId;
          else s.parentId = parent;
        }
      next.sections = next.sections.filter((s) => s.id !== intent.id);
      delete next.presentation.sections[intent.id];
    }
  }
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
            next.presentation.nodes[intent.node.id] = clone(intent.position);
            break;
          case 'add-edge':
            next.edges.push(clone(intent.edge));
            break;
          case 'move-node':
            if (!next.nodes.some((n) => n.id === intent.id)) throw new Error('Node is missing');
            next.presentation.nodes[intent.id] = {
              ...next.presentation.nodes[intent.id],
              ...clone(intent.position),
            };
            break;
          case 'set-node-shape':
          case 'set-node-style': {
            const index = next.nodes.findIndex((n) => n.id === intent.id);
            if (index < 0) throw new Error('Node is missing');
            // A node drawn at its default position keeps that position once it gets an override.
            const item = { ...(next.presentation.nodes[intent.id] ?? defaultGraphPosition(index)) };
            const [key, value] =
              intent.type === 'set-node-shape'
                ? (['shape', intent.shape] as const)
                : ([
                    'style',
                    intent.style && Object.keys(intent.style).length ? intent.style : null,
                  ] as const);
            if (value === null) delete item[key];
            else Object.assign(item, { [key]: clone(value) });
            next.presentation.nodes[intent.id] = item;
            break;
          }
          case 'delete-node': {
            if (!next.nodes.some((n) => n.id === intent.id)) throw new Error('Node is missing');
            if (
              !intent.cascade &&
              next.edges.some((e) => e.from === intent.id || e.to === intent.id)
            )
              throw new Error('Node has connections; confirm cascade deletion');
            next.nodes = next.nodes.filter((n) => n.id !== intent.id);
            next.edges = next.edges.filter((e) => e.from !== intent.id && e.to !== intent.id);
            delete next.presentation.nodes[intent.id];
            break;
          }
          case 'delete-edge':
            if (!next.edges.some((e) => e.id === intent.id)) throw new Error('Edge is missing');
            next.edges = next.edges.filter((e) => e.id !== intent.id);
            break;
          case 'add-section':
          case 'set-node-section':
          case 'set-section-parent':
          case 'move-section':
          case 'resize-section':
          case 'set-section-style':
          case 'delete-section':
            applySectionIntent(next, intent);
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
              const items: { id: string; type: string; attributes: Attributes }[] =
                  intent.scope === 'node'
                    ? next.nodes
                    : intent.scope === 'section'
                      ? next.sections
                      : next.edges,
                types: Record<string, { schema: Record<string, AttributeSchema> }> =
                  intent.scope === 'node'
                    ? profile.nodes
                    : intent.scope === 'section'
                      ? profile.sections
                      : profile.edges,
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
