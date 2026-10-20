import { canonicalJson, clone, deepFreeze } from '@editor-platform/artifact-core';
import {
  array,
  checkData,
  fields,
  finite,
  id,
  identifier,
  object,
  reject,
  unique,
  isRetainableReactData,
} from './data';
import { checkFieldMap } from './schema';
import {
  checkCallbacks,
  checkComponentRef,
  reactComponentKey,
  validateReactComponent,
  validateReactEnvironment,
} from './registration';
import { reactUiLimits, reactUiStyleProperties, type ReactUiDocument } from './types';
// Only completely admitted immutable documents can be reused as the same root.
// External freezing alone does not certify schema, hashes or resource budgets.
const ownedDocuments = new WeakSet<object>();
const ownedNodes = new WeakSet<object>();
export function isReactUiDocument(raw: unknown): raw is ReactUiDocument {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Object.getOwnPropertyDescriptor(raw, 'domain')?.value !== 'react-ui'
  )
    return false;
  try {
    loadReactUiDocument(raw);
    return true;
  } catch {
    return false;
  }
}

function checkStyle(raw: unknown, path: string): void {
  const style = object(raw, path);
  for (const [key, raw] of Object.entries(style)) {
    if (!reactUiStyleProperties.includes(key as (typeof reactUiStyleProperties)[number]))
      reject('style-property', `${path}.${key}`, 'Unsupported CSS property');
    const value = object(raw, `${path}.${key}`);
    if (value.kind === 'token') {
      fields(value, ['kind', 'tokenId'], [], `${path}.${key}`);
      id(value.tokenId, `${path}.${key}`);
    } else if (value.kind === 'literal') {
      fields(value, ['kind', 'value'], [], `${path}.${key}`);
      if (typeof value.value !== 'string' && typeof value.value !== 'number')
        reject('style-value', `${path}.${key}`, 'Expected string/number style literal');
    } else reject('style-value', `${path}.${key}`, 'Expected token or literal style value');
  }
}
/** Shape/integrity boundary. Incomplete or unresolved references remain saved data for diagnostics. */
export function loadReactUiDocument(raw: unknown): ReactUiDocument {
  return admitReactUiDocument(raw, false);
}
/** Internal node edits retain the admitted base's other fields. Unknown nodes
 * and roots are copied after the same descriptor/schema/resource checks. */
export function loadReactUiNodeEdit(
  base: ReactUiDocument,
  nodes: ReactUiDocument['nodes'],
  roots: ReactUiDocument['roots'],
): ReactUiDocument {
  return admitReactUiDocument({ ...loadReactUiDocument(base), nodes, roots }, true);
}
function admitReactUiDocument(raw: unknown, nodeEdit: boolean, parsed = false): ReactUiDocument {
  if (raw && typeof raw === 'object' && ownedDocuments.has(raw)) return raw as ReactUiDocument;
  checkData(raw);
  const input = raw;
  // Reject Proxy inputs and own external data before schema traversal can call
  // inherited array methods. The native clone preserves the checked JSON values
  // and budgets; parsed JSON is already private. Node edits have an owned base.
  if (!nodeEdit && !parsed) raw = clone(raw);
  const d = object(raw, '$');
  fields(
    d,
    [
      'schemaVersion',
      'domain',
      'environment',
      'components',
      'inputs',
      'callbacks',
      'fixture',
      'breakpoints',
      'roots',
      'nodes',
    ],
    [],
    '$',
  );
  if (d.schemaVersion !== 1 || d.domain !== 'react-ui')
    reject('document-schema', '$', 'Expected React UI schema version 1');
  const environment = validateReactEnvironment(d.environment);
  const components = array(d.components, '$.components', reactUiLimits.components).map(
    validateReactComponent,
  );
  unique(
    components.map((c) => reactComponentKey(c.ref)),
    '$.components',
  );
  checkFieldMap(d.inputs, '$.inputs');
  checkCallbacks(d.callbacks, '$.callbacks');
  unique([...Object.keys(d.inputs), ...Object.keys(d.callbacks)], '$.inputs');
  object(d.fixture, '$.fixture');
  const bps = array(d.breakpoints, '$.breakpoints', reactUiLimits.breakpoints);
  let lastWidth = -1;
  bps.forEach((raw, i) => {
    const path = `$.breakpoints.${i}`,
      bp = object(raw, path);
    fields(bp, ['id', 'minWidth'], [], path);
    id(bp.id, path);
    finite(bp.minWidth, path, 0, 10000, true);
    if (bp.minWidth <= lastWidth)
      reject('breakpoints', path, 'Breakpoints must have strictly increasing minimum widths');
    lastWidth = bp.minWidth;
  });
  unique(
    bps.map((bp) => (bp as { id: string }).id),
    '$.breakpoints',
  );
  array(d.roots, '$.roots', reactUiLimits.nodes).forEach((value) => id(value, '$.roots'));
  unique(d.roots as string[], '$.roots');
  const nodes = array(d.nodes, '$.nodes', reactUiLimits.nodes);
  nodes.forEach((raw, i) => {
    // Only context-free shape was certified. New roots still pay full JSON and
    // global identity checks, then preflight checks the current catalog/graph.
    if (raw && typeof raw === 'object' && ownedNodes.has(raw)) return;
    const path = `$.nodes.${i}`,
      n = object(raw, path);
    fields(n, ['id', 'component', 'props', 'slots', 'bindings', 'layout'], [], path);
    id(n.id, `${path}.id`);
    checkComponentRef(n.component, `${path}.component`);
    const props = object(n.props, `${path}.props`),
      slots = object(n.slots, `${path}.slots`),
      bindings = object(n.bindings, `${path}.bindings`);
    if ([props, slots, bindings].some((map) => Object.keys(map).length > reactUiLimits.fields))
      reject('schema-limit', path, 'Too many props/slots/bindings');
    Object.keys(props).forEach((key) => identifier(key, `${path}.props.${key}`));
    for (const [key, values] of Object.entries(slots)) {
      id(key, `${path}.slots.${key}`);
      array(values, `${path}.slots.${key}`, reactUiLimits.nodes).forEach((value) =>
        id(value, `${path}.slots.${key}`),
      );
    }
    for (const [key, raw] of Object.entries(bindings)) {
      identifier(key, `${path}.bindings.${key}`);
      const binding = object(raw, `${path}.bindings.${key}`);
      if (binding.kind === 'data') {
        fields(binding, ['kind', 'input', 'path'], [], `${path}.bindings.${key}`);
        identifier(binding.input, `${path}.bindings.${key}`);
        array(binding.path, `${path}.bindings.${key}.path`, reactUiLimits.schemaDepth).forEach(
          (part) => identifier(part, `${path}.bindings.${key}.path`),
        );
      } else if (binding.kind === 'callback') {
        fields(binding, ['kind', 'callback'], [], `${path}.bindings.${key}`);
        identifier(binding.callback, `${path}.bindings.${key}`);
      } else
        reject(
          'binding',
          `${path}.bindings.${key}`,
          'Only declared data paths and callback names are supported',
        );
    }
    const layout = object(n.layout, `${path}.layout`);
    fields(layout, ['base', 'breakpoints'], [], `${path}.layout`);
    checkStyle(layout.base, `${path}.layout.base`);
    const overrides = object(layout.breakpoints, `${path}.layout.breakpoints`);
    if (Object.keys(overrides).length > reactUiLimits.breakpoints)
      reject('schema-limit', `${path}.layout.breakpoints`, 'Too many breakpoint overrides');
    for (const [key, style] of Object.entries(overrides)) {
      id(key, `${path}.layout.breakpoints.${key}`);
      checkStyle(style, `${path}.layout.breakpoints.${key}`);
    }
  });
  unique(
    nodes.map((n) => (n as { id: string }).id),
    '$.nodes',
  );
  // External object inputs were cloned completely before schema validation.
  // JSON.parse creates a private graph without external aliases. A node edit has an admitted base and
  // owns only its new nodes/roots; retaining that base avoids cloning hundreds
  // of immutable nodes merely to discard their copies. All new roots still pay
  // the descriptor, shape, identity and resource checks.
  const copy: ReactUiDocument = nodeEdit
    ? { ...(raw as ReactUiDocument), roots: clone(d.roots as string[]), nodes: [] }
    : (raw as ReactUiDocument);
  // The complete clone of external object inputs rejected Proxy inputs.
  // Only after every check can ordinary, fully frozen input nodes be retained. External freezing
  // alone never bypasses descriptors, schema, hashes or aggregate budgets.
  const retainInputNodes = !nodeEdit && !parsed && isRetainableReactData(input);
  copy.nodes = (nodeEdit ? nodes : copy.nodes).map((node, index) =>
    retainInputNodes
      ? (input as ReactUiDocument).nodes[index]
      : nodeEdit && ownedNodes.has(nodes[index] as object)
        ? (nodes[index] as ReactUiDocument['nodes'][number])
        : nodeEdit
          ? clone(node as ReactUiDocument['nodes'][number])
          : copy.nodes[index],
  );
  const owned = deepFreeze({ ...copy, environment, components });
  // External/parsed roots kept exactly the checked JSON through native cloning
  // and schema validation of that private graph. Edits assemble a new graph and
  // must charge its full aggregate budget again after copying new nodes.
  if (nodeEdit) checkData(owned);
  owned.nodes.forEach((node) => ownedNodes.add(node));
  ownedDocuments.add(owned);
  return owned;
}
/** Canonical JSON preserves IDs/slot order/overrides; it contains no executable implementation. */
export function serializeReactUiDocument(raw: unknown): string {
  return canonicalJson(loadReactUiDocument(raw));
}
export function parseReactUiDocument(source: string): ReactUiDocument {
  if (
    source.length > reactUiLimits.bytes ||
    // eslint-disable-next-line no-control-regex -- ASCII has exactly one UTF-8 byte per code unit
    (!/^[\x00-\x7f]*$/.test(source) &&
      new TextEncoder().encode(source).length > reactUiLimits.bytes)
  )
    reject('data-limit', '$', 'Native JSON exceeds byte budget');
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    reject('data-json', '$', 'Invalid native JSON');
  }
  return admitReactUiDocument(value, false, true);
}
