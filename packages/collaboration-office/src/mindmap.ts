import {
  canonical,
  copy,
  fail,
  type Action,
  type DomainCodec,
  type Effect,
} from '@editor-platform/collaboration-core';
import {
  isMindmap,
  NODE_ID,
  type MindmapContent,
  type MindmapNode,
} from '@editor-platform/mindmap-core';

const nodeFields = [
  'text',
  'children',
  'side',
  'collapsed',
  'color',
  'marks',
  'note',
  'link',
] as const;
type NodeField = (typeof nodeFields)[number];
type Change =
  | { kind: 'node'; id: string; value: MindmapNode | null }
  | { kind: 'field'; id: string; field: NodeField; value: unknown }
  | { kind: 'layout'; value: MindmapContent['layout'] };

const entity = (id: string) => `entity:nodes:${id}`;
const equal = (a: unknown, b: unknown) => a === b || canonical(a) === canonical(b);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function mindmapEditAction(
  before: MindmapContent,
  after: MindmapContent,
): Action | undefined {
  if (before.id !== after.id || before.rootId !== after.rootId)
    fail('unsupported-operation', 'A shared Mind Map keeps its document and root IDs');
  const changes: Change[] = [];
  if (before.layout !== after.layout) changes.push({ kind: 'layout', value: after.layout });
  for (const id of new Set([...Object.keys(before.nodes), ...Object.keys(after.nodes)])) {
    const old = before.nodes[id];
    const next = after.nodes[id];
    if (!old || !next) {
      changes.push({ kind: 'node', id, value: next ?? null });
      continue;
    }
    for (const field of nodeFields)
      if (!equal(old[field], next[field]))
        changes.push({ kind: 'field', id, field, value: next[field] ?? null });
  }
  if (changes.length) return { type: 'mindmap.edit', target: '*', payload: { changes } };
}

function read(content: MindmapContent, key: string): unknown {
  if (key === 'root/layout') return content.layout;
  const match = /^entity:nodes:(n-[0-9a-f]{32})(?:\/(\w+))?$/.exec(key);
  if (!match) return;
  const [, id, field] = match;
  const node = content.nodes[id];
  return !field
    ? node
    : field === 'id' || nodeFields.includes(field as NodeField)
      ? node?.[field as keyof MindmapNode]
      : undefined;
}

function changedChildren(old: readonly string[], next: readonly string[]): string[] {
  const oldIds = new Set(old),
    nextIds = new Set(next);
  const commonOld = old.filter((id) => nextIds.has(id));
  const commonNext = next.filter((id) => oldIds.has(id));
  return [
    ...old.filter((id) => !nextIds.has(id)),
    ...next.filter((id) => !oldIds.has(id)),
    ...commonOld.filter((id, index) => id !== commonNext[index]),
  ];
}

function apply(source: MindmapContent, action: Action): Effect<MindmapContent> {
  if (action.type === 'domain.restore') {
    const { content } = action.payload;
    if (!isMindmap(content) || content.id !== source.id || content.rootId !== source.rootId)
      fail('invalid-operation', 'Invalid saved Mind Map');
    return {
      content: copy(content),
      required: ['*'],
      touched: ['*'],
      targets: ['*'],
      inverse: [{ type: 'domain.restore', target: '*', payload: { content: source } }],
    };
  }
  if (action.type !== 'mindmap.edit') fail('unsupported-operation', 'Unknown Mind Map operation');
  const { changes } = action.payload;
  if (action.target !== '*' || !Array.isArray(changes) || !changes.length)
    fail('schema-mismatch', 'Expected Mind Map changes');

  const content = { ...source, nodes: { ...source.nodes } };
  const required = new Set<string>(),
    touched = new Set<string>(),
    targets = new Set<string>();
  const changedNodes = new Set<string>();
  function write(key: string, target: string) {
    if (touched.has(key))
      fail('invalid-operation', 'A Mind Map resource can be edited once per action');
    required.add(key);
    touched.add(key);
    targets.add(target);
  }
  for (const change of changes) {
    if (!record(change) || !Object.hasOwn(change, 'value'))
      fail('schema-mismatch', 'Malformed Mind Map change');
    const { id, value } = change;
    if (change.kind === 'layout') {
      write('root/layout', '*');
      content.layout = value as MindmapContent['layout'];
      continue;
    }
    if (typeof id !== 'string' || !NODE_ID.test(id))
      fail('schema-mismatch', 'Invalid Mind Map node ID');
    const key = entity(id);
    const node = content.nodes[id];
    changedNodes.add(id);
    if (change.kind === 'node') {
      if (id === source.rootId) fail('invalid-operation', 'The root cannot be inserted or removed');
      write(key, id);
      if (value === null) {
        if (!node) fail('target-deleted', 'The Mind Map node was deleted');
        delete content.nodes[id];
      } else {
        if (!record(value) || value.id !== id || node)
          fail('invalid-operation', 'Expected a new Mind Map node');
        content.nodes[id] = copy(value) as unknown as MindmapNode;
      }
    } else if (change.kind === 'field') {
      const { field } = change;
      if (!nodeFields.includes(field as NodeField))
        fail('schema-mismatch', 'Unknown Mind Map node field');
      if (!node) fail('target-deleted', 'The Mind Map node was deleted');
      required.add(`${key}/id`);
      write(`${key}/${field}`, id);
      const next = { ...node } as Record<string, unknown>;
      if (value === null) delete next[field as string];
      else next[field as string] = copy(value);
      content.nodes[id] = next as unknown as MindmapNode;
    } else fail('schema-mismatch', 'Unknown Mind Map change');
  }
  if (!isMindmap(content)) fail('invalid-operation', 'The edit must leave one valid Mind Map tree');

  // Child arrays own order, and changing a relationship requires access to the child too.
  for (const id of changedNodes) {
    const before = source.nodes[id]?.children ?? [];
    const after = content.nodes[id]?.children ?? [];
    for (const child of changedChildren(before, after)) {
      required.add(`${entity(child)}/id`);
      targets.add(child);
    }
  }
  const inverse = mindmapEditAction(content, source);
  if (!inverse) fail('invalid-operation', 'The Mind Map did not change');
  return {
    content,
    required: [...required],
    touched: [...touched],
    targets: [...targets],
    inverse: [inverse],
  };
}

export const mindmapEditorCodec: DomainCodec<MindmapContent> = {
  domain: 'mindmap',
  validate: isMindmap,
  resource: read,
  apply,
  applyReadonly: apply,
  validateAnchor(content, anchor) {
    return (
      anchor.type === 'element' && !anchor.region && Object.hasOwn(content.nodes, anchor.elementId)
    );
  },
  mapAnchor(anchor, _before, _action, after) {
    return anchor.type === 'element' && after && !Object.hasOwn(after.nodes, anchor.elementId)
      ? { ...anchor, orphan: true }
      : anchor;
  },
};
