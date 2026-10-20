import { clone, newId } from '@editor-platform/artifact-core';
import { immutableCommand, type EditorCommand } from '@editor-platform/editor-core';
import { ReactUiError, diagnostic, same, checkData } from './data';
import { loadReactUiDocument, loadReactUiNodeEdit } from './document';
import { inspectReactUiDocument } from './preflight';
import { reactComponentKey } from './registration';
import type { ReactUiEdit } from './adapters';
import type { ReactUiDocument, ReactUiNode, RegisteredReactComponent } from './types';

/** Library inserts one node. Required slots need a complete, atomically validated composition. */
export function reactUiInsertionProblem(component: RegisteredReactComponent): string | undefined {
  const required = Object.entries(component.slots).filter(([, slot]) => slot.minimum > 0);
  if (!required.length) return undefined;
  return `${component.name} requires ${required.map(([id, slot]) => `${id} (at least ${slot.minimum})`).join(', ')}. Import composition JSON with these children, or ask Host to propose a complete composition; a single empty node cannot be inserted.`;
}

export function reactUiParent(
  document: ReactUiDocument,
  nodeId: string,
): { nodeId: string; slotId: string } | null {
  for (const node of document.nodes)
    for (const [slotId, children] of Object.entries(node.slots))
      if (children.includes(nodeId)) return { nodeId: node.id, slotId };
  return null;
}
export function reactUiSubtree(document: ReactUiDocument, id: string): string[] {
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    Object.values(document.nodes.find((n) => n.id === id)?.slots ?? {})
      .flat()
      .forEach(visit);
  };
  visit(id);
  return [...seen];
}
export function applyReactUiEdits(
  document: ReactUiDocument,
  edits: readonly ReactUiEdit[],
): ReactUiDocument {
  checkData(edits);
  const owned = loadReactUiDocument(document);
  // Every supported edit writes nodes/roots. Other fields are validated owned
  // metadata; keep them immutable rather than cloning their complete catalogs.
  const next = { ...owned, nodes: [...owned.nodes], roots: [...owned.roots] };
  const copied = new Set<string>();
  const reject = (message: string): never => {
    throw new ReactUiError([diagnostic('edit-invalid', '$.edit', message)]);
  };
  const get = (id: string) => {
    const index = next.nodes.findIndex((node) => node.id === id);
    if (index < 0) return reject(`Node ${id} is missing`);
    if (!copied.has(id)) {
      next.nodes[index] = clone(next.nodes[index]);
      copied.add(id);
    }
    return next.nodes[index];
  };
  const children = (parent: { nodeId: string; slotId: string } | null): string[] => {
    if (!parent) return next.roots;
    const node = get(parent.nodeId),
      registration = next.components.find(
        (c) => reactComponentKey(c.ref) === reactComponentKey(node.component),
      );
    if (!registration?.slots[parent.slotId]) reject('Target slot is not registered');
    return (node.slots[parent.slotId] ??= []);
  };
  const detach = (id: string) => {
    const parent = reactUiParent(next, id),
      list = children(parent),
      index = list.indexOf(id);
    if (index < 0) reject('Node is not attached');
    list.splice(index, 1);
  };
  const attach = (
    id: string,
    parent: { nodeId: string; slotId: string } | null,
    beforeId: string | null,
  ) => {
    const list = children(parent),
      index = beforeId === null ? list.length : list.indexOf(beforeId);
    if (index < 0) reject('Insertion address is missing');
    list.splice(index, 0, id);
  };
  for (const edit of edits) {
    switch (edit.type) {
      case 'set-prop': {
        const node = get(edit.nodeId);
        node.props[edit.prop] = clone(edit.value);
        delete node.bindings[edit.prop];
        break;
      }
      case 'reset-prop':
        delete get(edit.nodeId).props[edit.prop];
        delete get(edit.nodeId).bindings[edit.prop];
        break;
      case 'set-binding': {
        const node = get(edit.nodeId);
        if (edit.binding) {
          node.bindings[edit.prop] = clone(edit.binding);
          delete node.props[edit.prop];
        } else delete node.bindings[edit.prop];
        break;
      }
      case 'set-layout': {
        const layout = get(edit.nodeId).layout;
        if (edit.breakpoint === null) layout.base = clone(edit.style);
        else layout.breakpoints[edit.breakpoint] = clone(edit.style);
        break;
      }
      case 'insert':
        if (next.nodes.some((n) => n.id === edit.node.id)) reject('Node ID already exists');
        next.nodes.push(clone(edit.node));
        attach(edit.node.id, edit.parent, edit.beforeId);
        break;
      case 'move':
        if (edit.parent && reactUiSubtree(next, edit.nodeId).includes(edit.parent.nodeId))
          reject('Cannot move into own subtree');
        get(edit.nodeId);
        if (edit.beforeId === edit.nodeId) break;
        detach(edit.nodeId);
        attach(edit.nodeId, edit.parent, edit.beforeId);
        break;
      case 'delete': {
        get(edit.nodeId);
        const ids = new Set(reactUiSubtree(next, edit.nodeId));
        detach(edit.nodeId);
        next.nodes = next.nodes.filter((n) => !ids.has(n.id));
        break;
      }
      case 'adopt-component': {
        const target = next.components.find((c) => same(c.ref, edit.to));
        if (!target) reject('Exact new registration is unavailable');
        for (const id of edit.nodeIds) {
          const node = get(id);
          if (!same(node.component, edit.from)) reject('Revision candidate is stale');
          for (const [keys, mapping] of [
            [Object.keys(node.props), edit.propMap],
            [Object.keys(node.bindings), edit.propMap],
            [Object.keys(node.slots), edit.slotMap],
          ] as const) {
            const mapped = keys.map((key) => mapping[key] ?? key);
            if (new Set(mapped).size !== mapped.length)
              reject('Mapping would discard explicit values or slots');
          }
          node.component = clone(edit.to);
          node.props = Object.fromEntries(
            Object.entries(node.props).map(([key, value]) => [edit.propMap[key] ?? key, value]),
          );
          node.bindings = Object.fromEntries(
            Object.entries(node.bindings).map(([key, value]) => [edit.propMap[key] ?? key, value]),
          );
          node.slots = Object.fromEntries(
            Object.entries(node.slots).map(([key, value]) => [edit.slotMap[key] ?? key, value]),
          );
        }
        break;
      }
      default:
        reject('Unsupported React edit intent');
    }
  }
  const result = inspectReactUiDocument(loadReactUiNodeEdit(owned, next.nodes, next.roots));
  if (!result.document || result.diagnostics.length) throw new ReactUiError(result.diagnostics);
  return result.document;
}
export function reactUiCommand(
  edits: readonly ReactUiEdit[],
  label = 'Edit React composition',
): EditorCommand<ReactUiDocument> {
  checkData(edits);
  const owned = clone(edits);
  return immutableCommand('react-ui.edit', label, (document) => applyReactUiEdits(document, owned));
}
export function makeReactUiNode(component: ReactUiDocument['components'][number]): ReactUiNode {
  return {
    id: newId('react-node'),
    component: clone(component.ref),
    props: clone(component.sampleProps),
    slots: Object.fromEntries(Object.keys(component.slots).map((key) => [key, []])),
    bindings: {},
    layout: { base: {}, breakpoints: {} },
  };
}
export function duplicateReactUiCommand(
  document: ReactUiDocument,
  nodeId: string,
): EditorCommand<ReactUiDocument> {
  const ids = reactUiSubtree(document, nodeId),
    mapping = new Map(ids.map((id) => [id, newId('react-node')]));
  const edits: ReactUiEdit[] = [];
  const visit = (id: string, parent: { nodeId: string; slotId: string } | null) => {
    const source = document.nodes.find((n) => n.id === id)!;
    const node = {
      ...clone(source),
      id: mapping.get(id)!,
      slots: Object.fromEntries(Object.keys(source.slots).map((key) => [key, []])),
    };
    edits.push({ type: 'insert', node, parent, beforeId: null });
    for (const [slotId, children] of Object.entries(source.slots))
      children.forEach((child) => visit(child, { nodeId: node.id, slotId }));
  };
  visit(nodeId, reactUiParent(document, nodeId));
  return { ...reactUiCommand(edits, 'Duplicate component subtree'), reads: { content: ids } };
}
