import { clone, canonicalJson } from '@editor-platform/artifact-core';
import { immutableCommand, type EditorCommand } from '@editor-platform/editor-core';
import { applyReactUiEdits } from './edit';
import { loadReactUiDocument } from './document';
import {
  reactComponentKey,
  validateReactComponent,
  validateReactEnvironment,
} from './registration';
import type { RegisteredReactComponent, ReactEnvironment, ReactUiDocument } from './types';
import { checkData, identifier, id, object, fields } from './data';
export interface ReactUiRevisionCandidate {
  component?: RegisteredReactComponent;
  environment?: ReactEnvironment;
  nodeIds: string[];
  propMap: Record<string, string>;
  slotMap: Record<string, string>;
}
/** Candidate adoption is explicit, pinned to the reviewed native basis, and atomic. */
export function prepareReactUiRevision(
  document: ReactUiDocument,
  candidate: ReactUiRevisionCandidate,
): { before: ReactUiDocument; after: ReactUiDocument; command: EditorCommand<ReactUiDocument> } {
  checkData(candidate);
  const raw = object(candidate, '$.revision');
  fields(raw, ['nodeIds', 'propMap', 'slotMap'], ['component', 'environment'], '$.revision');
  for (const [source, target] of Object.entries(candidate.propMap)) {
    identifier(source, '$.revision.propMap');
    identifier(target, '$.revision.propMap');
  }
  for (const [source, target] of Object.entries(candidate.slotMap)) {
    id(source, '$.revision.slotMap');
    id(target, '$.revision.slotMap');
  }
  const before = loadReactUiDocument(document),
    next = clone(before);
  if (candidate.environment) next.environment = validateReactEnvironment(candidate.environment);
  if (
    next.environment.ref.id === before.environment.ref.id &&
    next.environment.ref.version === before.environment.ref.version &&
    canonicalJson(next.environment) !== canonicalJson(before.environment)
  )
    throw new Error('A published environment version cannot be rewritten');
  if (candidate.component) {
    const component = validateReactComponent(candidate.component);
    const nodes = candidate.nodeIds.map((id) => next.nodes.find((node) => node.id === id));
    if (!nodes.length || nodes.some((node) => !node))
      throw new Error('Select existing nodes for a revision');
    const from = nodes[0]!.component;
    if (
      nodes.some((node) => canonicalJson(node!.component) !== canonicalJson(from)) ||
      from.registryId !== component.ref.registryId ||
      from.componentId !== component.ref.componentId
    )
      throw new Error('Revision nodes must share one exact registered component identity');
    if (reactComponentKey(from) === reactComponentKey(component.ref))
      throw new Error('A published version cannot be rewritten; retain it or adopt a new version');
    const existing = next.components.find(
      (c) => reactComponentKey(c.ref) === reactComponentKey(component.ref),
    );
    if (existing && canonicalJson(existing) !== canonicalJson(component))
      throw new Error('New immutable identity conflicts with retained registration');
    if (!existing) next.components.push(component);
    for (const node of nodes)
      for (const [keys, mapping] of [
        [Object.keys(node!.props), candidate.propMap],
        [Object.keys(node!.bindings), candidate.propMap],
        [Object.keys(node!.slots), candidate.slotMap],
      ] as const) {
        const mapped = keys.map((key) => mapping[key] ?? key);
        if (new Set(mapped).size !== mapped.length)
          throw new Error('Mapping would discard an explicit prop, binding or slot');
      }
    const after = applyReactUiEdits(next, [
      {
        type: 'adopt-component',
        nodeIds: candidate.nodeIds,
        from,
        to: component.ref,
        propMap: candidate.propMap,
        slotMap: candidate.slotMap,
      },
    ]);
    return prepared(before, after);
  }
  if (
    candidate.nodeIds.length ||
    Object.keys(candidate.propMap).length ||
    Object.keys(candidate.slotMap).length
  )
    throw new Error('Environment-only revision does not map nodes');
  return prepared(before, applyReactUiEdits(next, []));
}
function prepared(before: ReactUiDocument, after: ReactUiDocument) {
  const basis = canonicalJson(before);
  const command = immutableCommand<ReactUiDocument>(
    'react-ui.revision',
    'Adopt reviewed pinned React revision',
    (current) => {
      if (canonicalJson(current) !== basis)
        throw new Error(
          'Revision review is stale; compare the current draft again. Old version is retained.',
        );
      return after;
    },
  );
  return { before, after, command };
}
