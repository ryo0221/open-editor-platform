import { clone, canonicalJson } from '@editor-platform/artifact-core';
import {
  isReactUiDocument,
  inspectReactUiDocument,
  loadReactUiDocument,
  reactComponentKey,
  reactUiParent,
  type ReactUiDocument,
  type ReactUiNode,
} from '@editor-platform/react-ui-core';
import {
  canonical,
  copy,
  fail,
  type Action,
  type DomainCodec,
  type Effect,
} from '@editor-platform/collaboration-core';

type Change = { path: string[]; present: boolean; value: unknown; beforeId?: string | null };
type Patch = { changes: Change[]; reads: string[] };
const key = (path: string[]) => `react-ui:${canonicalJson(path)}`;
const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const maps = { input: 'inputs', callback: 'callbacks', fixture: 'fixture' } as const;
const roots = ['environment', 'components', 'breakpoints', 'roots'];
function validPath(path: unknown): path is string[] {
  if (
    !Array.isArray(path) ||
    !path.every((p) => typeof p === 'string' && p.length > 0 && p.length <= 512)
  )
    return false;
  return (
    (path.length === 1 && roots.includes(path[0])) ||
    (path.length === 2 &&
      ['node', 'life', 'parent', ...Object.keys(maps), 'component'].includes(path[0])) ||
    (path.length === 3 &&
      ['prop', 'binding', 'slot', 'baseStyle', 'breakpoint', 'breakpointLife'].includes(path[0])) ||
    (path.length === 4 && path[0] === 'breakStyle') ||
    (path.length === 2 && path[0] === 'registration')
  );
}
function parseKey(value: string): string[] {
  if (!value.startsWith('react-ui:')) fail('schema-mismatch', 'Unknown React UI resource');
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.slice(9));
  } catch {
    fail('schema-mismatch', 'Malformed React UI resource');
  }
  if (!validPath(parsed)) fail('schema-mismatch', 'Unknown React UI resource path');
  return parsed;
}
function owner(
  document: ReactUiDocument,
  path: string[],
): { object: Record<string, unknown>; field: string } | undefined {
  const [kind, id, field, property] = path;
  if (roots.includes(kind))
    return { object: document as unknown as Record<string, unknown>, field: kind };
  if (Object.hasOwn(maps, kind))
    return {
      object: document[maps[kind as keyof typeof maps]] as Record<string, unknown>,
      field: id,
    };
  const node = document.nodes.find((n) => n.id === id);
  if (!node) return;
  if (kind === 'component')
    return { object: node as unknown as Record<string, unknown>, field: 'component' };
  if (kind === 'prop') return { object: node.props, field };
  if (kind === 'binding') return { object: node.bindings, field };
  if (kind === 'slot') return { object: node.slots, field };
  if (kind === 'breakpoint') return { object: node.layout.breakpoints, field };
  if (kind === 'baseStyle') return { object: node.layout.base, field };
  if (kind === 'breakStyle')
    return { object: node.layout.breakpoints[field] ?? {}, field: property };
}
function resource(document: ReactUiDocument, path: string[]): unknown {
  if (path[0] === 'node') return document.nodes.find((n) => n.id === path[1]) ?? null;
  if (path[0] === 'life') return document.nodes.some((n) => n.id === path[1]);
  if (path[0] === 'parent')
    return document.nodes.some((n) => n.id === path[1])
      ? (reactUiParent(document, path[1]) ?? { root: document.roots.includes(path[1]) })
      : null;
  if (path[0] === 'breakpointLife')
    return !!document.nodes.find((n) => n.id === path[1])?.layout.breakpoints[path[2]];
  if (path[0] === 'registration')
    return document.components.find((c) => reactComponentKey(c.ref) === path[1]) ?? null;
  const target = owner(document, path);
  return target
    ? {
        present: Object.hasOwn(target.object, target.field),
        value: target.object[target.field] ?? null,
      }
    : null;
}
function value(document: ReactUiDocument, path: string[]): { present: boolean; value: unknown } {
  if (path[0] === 'node') {
    const node = document.nodes.find((n) => n.id === path[1]);
    return { present: !!node, value: node ?? null };
  }
  const target = owner(document, path);
  return {
    present: !!target && Object.hasOwn(target.object, target.field),
    value: target?.object[target.field] ?? null,
  };
}
/** Domain-specific diff, consumed by existing normal editor preparation and proposals. */
export function reactUiPatchAction(
  before: ReactUiDocument,
  after: ReactUiDocument,
  sourceIds: readonly string[] = [],
): Action | undefined {
  loadReactUiDocument(after);
  const changes: Change[] = [];
  const add = (path: string[]) => {
    const old = value(before, path),
      next = value(after, path);
    if (!equal(old, next)) changes.push({ path, ...copy(next) });
  };
  roots.forEach((field) => add([field]));
  for (const [kind, field] of Object.entries(maps))
    for (const id of new Set([...Object.keys(before[field]), ...Object.keys(after[field])]))
      add([kind, id]);
  for (const id of new Set([...before.nodes.map((n) => n.id), ...after.nodes.map((n) => n.id)])) {
    const old = before.nodes.find((n) => n.id === id),
      next = after.nodes.find((n) => n.id === id);
    if (!old || !next) {
      changes.push({
        path: ['node', id],
        present: !!next,
        value: next ? copy(next) : null,
        beforeId: next ? (after.nodes[after.nodes.indexOf(next) + 1]?.id ?? null) : null,
      });
      continue;
    }
    add(['component', id]);
    for (const [kind, field] of [
      ['prop', 'props'],
      ['binding', 'bindings'],
      ['slot', 'slots'],
    ] as const)
      for (const name of new Set([...Object.keys(old[field]), ...Object.keys(next[field])]))
        add([kind, id, name]);
    for (const name of new Set([...Object.keys(old.layout.base), ...Object.keys(next.layout.base)]))
      add(['baseStyle', id, name]);
    for (const bp of new Set([
      ...Object.keys(old.layout.breakpoints),
      ...Object.keys(next.layout.breakpoints),
    ])) {
      if (!old.layout.breakpoints[bp] || !next.layout.breakpoints[bp]) add(['breakpoint', id, bp]);
      else
        for (const name of new Set([
          ...Object.keys(old.layout.breakpoints[bp]),
          ...Object.keys(next.layout.breakpoints[bp]),
        ]))
          add(['breakStyle', id, bp, name]);
    }
  }
  return changes.length
    ? {
        type: 'react-ui.patch',
        target: '*',
        payload: { changes, reads: sourceIds.map((id) => key(['node', id])) } satisfies Patch,
      }
    : undefined;
}
function apply(document: ReactUiDocument, action: Action): Effect<ReactUiDocument> {
  if (action.type !== 'react-ui.patch')
    fail('unsupported-operation', 'React UI edits require the normal domain patch API');
  const payload = action.payload as unknown as Patch;
  if (
    !payload ||
    Object.keys(payload).sort().join(',') !== 'changes,reads' ||
    !Array.isArray(payload.changes) ||
    !payload.changes.length ||
    payload.changes.length > 10000 ||
    !Array.isArray(payload.reads) ||
    payload.reads.length > 2000
  )
    fail('schema-mismatch', 'Invalid bounded React UI patch');
  const next = clone(loadReactUiDocument(document));
  const required = new Set(
    payload.reads.map((read) => {
      parseKey(read);
      return read;
    }),
  );
  const touched = new Set<string>(),
    invalidates = new Set<string>(),
    targets = new Set<string>();
  const inverse: Change[] = [];
  const addresses = new Set<string>();
  const depend = (path: string[]) => required.add(key(path));
  const invalidate = (id: string) => invalidates.add(key(['node', id]));
  for (const change of payload.changes) {
    if (
      !change ||
      !validPath(change.path) ||
      ['life', 'parent', 'registration', 'breakpointLife'].includes(change.path[0]) ||
      typeof change.present !== 'boolean' ||
      !Object.hasOwn(change, 'value') ||
      Object.keys(change).some((k) => !['path', 'present', 'value', 'beforeId'].includes(k))
    )
      fail('schema-mismatch', 'Invalid React UI change');
    const address = key(change.path);
    if (addresses.has(address)) fail('schema-mismatch', 'Duplicate patch address');
    addresses.add(address);
    depend(change.path);
    touched.add(address);
    const [kind, id] = change.path;
    const old = value(document, change.path);
    const oldNode = document.nodes.find((n) => n.id === id);
    inverse.unshift({
      path: change.path,
      ...copy(old),
      ...(kind === 'node'
        ? {
            beforeId: oldNode
              ? (document.nodes[document.nodes.indexOf(oldNode) + 1]?.id ?? null)
              : null,
          }
        : {}),
    });
    if (roots.includes(kind) || Object.hasOwn(maps, kind)) targets.add('*');
    else targets.add(id);
    if (kind === 'node') {
      touched.add(key(['life', id]));
      invalidate(id);
      depend(['parent', id]);
      if (oldNode) depend(['node', id]);
      next.nodes = next.nodes.filter((n) => n.id !== id);
      if (change.present) {
        const node = change.value as ReactUiNode;
        if (
          !node ||
          node.id !== id ||
          (change.beforeId !== null && typeof change.beforeId !== 'string')
        )
          fail('schema-mismatch', 'Inserted node identity/address does not match');
        // Storage order is not layout order. An absent future neighbor in this atomic batch may be inserted later.
        const index = change.beforeId ? next.nodes.findIndex((n) => n.id === change.beforeId) : -1;
        next.nodes.splice(index < 0 ? next.nodes.length : index, 0, copy(node));
        depend(['registration', reactComponentKey(node.component)]);
        depend(['environment']);
        for (const binding of Object.values(node.bindings ?? {})) {
          if (binding.kind === 'data') depend(['input', binding.input]);
          else if (binding.kind === 'callback') depend(['callback', binding.callback]);
        }
      }
    } else {
      if (!roots.includes(kind) && !Object.hasOwn(maps, kind)) {
        if (!next.nodes.some((n) => n.id === id))
          fail('target-deleted', 'React UI node was deleted');
        depend(['life', id]);
        depend(['component', id]);
        invalidate(id);
        const currentNode = next.nodes.find((n) => n.id === id)!;
        depend(['registration', reactComponentKey(currentNode.component)]);
        depend(['environment']);
        if (kind === 'component') {
          depend(['node', id]);
        }
        if (kind === 'breakStyle') {
          depend(['breakpoints']);
          depend(['breakpointLife', id, change.path[2]]);
          invalidates.add(key(['breakpoint', id, change.path[2]]));
          if (!currentNode.layout.breakpoints[change.path[2]])
            fail('target-deleted', 'Breakpoint override is absent');
        }
        if (kind === 'breakpoint') {
          depend(['breakpoints']);
          touched.add(key(['breakpointLife', id, change.path[2]]));
        }
        if (kind === 'binding' && change.present) {
          const binding = change.value as { kind: string; input: string; callback: string };
          if (binding?.kind === 'data') depend(['input', binding.input]);
          else if (binding?.kind === 'callback') depend(['callback', binding.callback]);
        }
      }
      const target = owner(next, change.path);
      if (!target) fail('target-deleted', 'React UI owner is missing');
      if (change.present) target.object[target.field] = copy(change.value);
      else delete target.object[target.field];
    }
    if (kind === 'slot' || kind === 'roots') {
      const beforeChildren = old.present ? (old.value as string[]) : [],
        afterChildren = change.present ? (change.value as string[]) : [];
      if (!Array.isArray(afterChildren) || !afterChildren.every((id) => typeof id === 'string'))
        fail('schema-mismatch', 'Invalid slot children');
      for (const child of new Set([...beforeChildren, ...afterChildren])) {
        targets.add(child);
        depend(['life', child]);
        depend(['component', child]);
        depend(['parent', child]);
        touched.add(key(['parent', child]));
      }
    }
  }
  for (const id of new Set([
    ...document.nodes.map((node) => node.id),
    ...next.nodes.map((node) => node.id),
  ]))
    if (!equal(resource(document, ['parent', id]), resource(next, ['parent', id]))) {
      depend(['parent', id]);
      touched.add(key(['parent', id]));
    }
  const inspected = inspectReactUiDocument(next);
  if (!inspected.document || inspected.diagnostics.length)
    fail('invalid-operation', inspected.diagnostics.map((d) => d.message).join('; '));
  // Immutable published identities cannot be silently rewritten, even with re-sealed metadata.
  for (const old of document.components) {
    const current = next.components.find(
      (c) => reactComponentKey(c.ref) === reactComponentKey(old.ref),
    );
    if (current && !equal(current, old))
      fail('invalid-operation', 'Published registration identity is immutable');
  }
  if (
    next.environment.ref.id === document.environment.ref.id &&
    next.environment.ref.version === document.environment.ref.version &&
    !equal(next.environment, document.environment)
  )
    fail('invalid-operation', 'Published environment identity is immutable');
  if (addresses.has(key(['components']))) {
    for (const component of [...document.components, ...next.components]) {
      const id = reactComponentKey(component.ref);
      if (!equal(resource(document, ['registration', id]), resource(next, ['registration', id])))
        touched.add(key(['registration', id]));
    }
  }
  return {
    content: inspected.document,
    required: [...required],
    touched: [...touched],
    invalidates: [...invalidates],
    targets: [...targets],
    inverse: [{ type: 'react-ui.patch', target: '*', payload: { changes: inverse, reads: [] } }],
  };
}
export const reactUiEditorCodec: DomainCodec<ReactUiDocument> = {
  domain: 'react-ui',
  validate: isReactUiDocument,
  resource(document, address) {
    return resource(document, parseKey(address));
  },
  apply,
  applyReadonly: apply,
  validateAnchor(document, anchor) {
    return anchor.type === 'element' && document.nodes.some((n) => n.id === anchor.elementId);
  },
  mapAnchor(anchor, _before, action) {
    if (anchor.type !== 'element' || action.type !== 'react-ui.patch') return anchor;
    const removed = (action.payload.changes as Change[]).some(
      (c) => c.path[0] === 'node' && c.path[1] === anchor.elementId && !c.present,
    );
    return removed ? { ...anchor, orphan: true } : anchor;
  },
};
