import { deepFreeze } from '@editor-platform/artifact-core';
import { reuseHash } from '@editor-platform/reuse-core';
import {
  array,
  checkData,
  diagnostic,
  fields,
  hash,
  id,
  object,
  ReactUiError,
  unique,
} from './data';
import { loadReactUiDocument } from './document';
import { styleProblem } from './layout';
import { checkComponentRef, checkEnvironmentRef, reactComponentKey } from './registration';
import { schemaAssignable, schemaAtPath, valueMatches } from './schema';
import {
  reactUiLimits,
  type JsonValue,
  type ReactUiDiagnostic,
  type ReactUiDocument,
  type ReactUiExportPlan,
  type ReactUiInspection,
  type ReactUiStyleProperty,
  type ReactValueSchema,
  type ReactRuntimeResolution,
} from './types';

const documentDiagnostics = new WeakMap<ReactUiDocument, readonly ReactUiDiagnostic[]>();
const documentFingerprints = new WeakMap<ReactUiDocument, string>();

function inspect(document: ReactUiDocument): ReactUiDiagnostic[] {
  const diagnostics: ReactUiDiagnostic[] = [];
  const add = (code: string, path: string, message: string) =>
    diagnostics.push(diagnostic(code, path, message));
  const components = new Map(document.components.map((c) => [reactComponentKey(c.ref), c]));
  const nodes = new Map(document.nodes.map((n) => [n.id, n]));
  const dependencies = new Map(document.environment.dependencies.map((d) => [d.id, d]));
  const imports = new Map<string, string>();
  document.components.forEach((component, index) => {
    const key = reuseHash(component.import),
      implementation = imports.get(key);
    if (implementation && implementation !== component.ref.implementationHash)
      add(
        'import-conflict',
        `$.components.${index}.import`,
        'The same import cannot select different pinned implementations; Host must provide distinct import paths',
      );
    else imports.set(key, component.ref.implementationHash);
  });
  const assetCheck = (schema: ReactValueSchema, value: JsonValue, path: string) => {
    if (value === null) return;
    if (schema.type === 'asset' && dependencies.get(String(value))?.kind !== 'asset')
      add('asset-missing', path, 'Image asset is not declared in the pinned environment');
    if (schema.type === 'object' && value && typeof value === 'object' && !Array.isArray(value))
      for (const [key, v] of Object.entries(value))
        if (Object.hasOwn(schema.fields, key))
          assetCheck(schema.fields[key].schema, v, `${path}.${key}`);
    if (schema.type === 'array' && Array.isArray(value))
      value.forEach((v, i) => assetCheck(schema.items, v, `${path}.${i}`));
  };
  for (const [key, value] of Object.entries(document.fixture))
    if (!Object.hasOwn(document.inputs, key))
      add('fixture-input', `$.fixture.${key}`, 'Fixture addresses an unknown page input');
    else if (!valueMatches(document.inputs[key].schema, value))
      add('fixture-type', `$.fixture.${key}`, 'Fixture does not match its declared input type');
    else assetCheck(document.inputs[key].schema, value, `$.fixture.${key}`);
  for (const [key, field] of Object.entries(document.inputs)) {
    if (field.required && !Object.hasOwn(field, 'default') && !Object.hasOwn(document.fixture, key))
      add('fixture-required', `$.fixture.${key}`, 'Required page input needs a preview fixture');
    if (Object.hasOwn(field, 'default'))
      assetCheck(field.schema, field.default!, `$.inputs.${key}.default`);
  }
  for (const [i, component] of document.components.entries()) {
    for (const dependency of component.requires)
      if (!dependencies.has(dependency))
        add(
          'dependency-missing',
          `$.components.${i}.requires`,
          `Runtime dependency ${dependency} is undeclared`,
        );
    for (const [key, field] of Object.entries(component.props)) {
      if (Object.hasOwn(field, 'default'))
        assetCheck(field.schema, field.default!, `$.components.${i}.props.${key}.default`);
      if (Object.hasOwn(component.sampleProps, key))
        assetCheck(
          field.schema,
          component.sampleProps[key],
          `$.components.${i}.sampleProps.${key}`,
        );
    }
  }
  const ownership = new Map<string, string>();
  const own = (child: string, path: string) => {
    if (!nodes.has(child)) add('node-missing', path, `Referenced node ${child} is missing`);
    if (ownership.has(child))
      add('node-parent', path, `Node ${child} already belongs to ${ownership.get(child)}`);
    else ownership.set(child, path);
  };
  document.roots.forEach((child, i) => own(child, `$.roots.${i}`));
  for (const [index, node] of document.nodes.entries()) {
    const path = `$.nodes.${index}`,
      component = components.get(reactComponentKey(node.component));
    for (const [slot, children] of Object.entries(node.slots))
      children.forEach((child, i) => own(child, `${path}.slots.${slot}.${i}`));
    if (!component)
      add(
        'component-missing',
        `${path}.component`,
        'Exact component registration is missing; retain the reference and obtain it from Host',
      );
    // The map key already matches registry/component/version, and load checked
    // all five reference fields. Compare both exact pins without hashing each
    // reference again for every node in the composition.
    else if (
      component.ref.contractHash !== node.component.contractHash ||
      component.ref.implementationHash !== node.component.implementationHash
    )
      add(
        'component-mismatch',
        `${path}.component`,
        'Component contract/implementation hash does not match the pinned registration',
      );
    if (component) {
      for (const [key, value] of Object.entries(node.props)) {
        const field = component.props[key];
        if (!field)
          add('prop-unknown', `${path}.props.${key}`, 'Prop is not published by this registration');
        else if (!valueMatches(field.schema, value))
          add('prop-type', `${path}.props.${key}`, 'Prop does not match its declared type');
        else assetCheck(field.schema, value, `${path}.props.${key}`);
      }
      for (const [key, field] of Object.entries(component.props))
        if (
          field.required &&
          !Object.hasOwn(field, 'default') &&
          !Object.hasOwn(node.props, key) &&
          !Object.hasOwn(node.bindings, key)
        )
          add(
            'prop-required',
            `${path}.props.${key}`,
            'Required prop is missing; preview samples are not production defaults',
          );
      for (const [key, binding] of Object.entries(node.bindings)) {
        if (Object.hasOwn(node.props, key))
          add(
            'binding-ownership',
            `${path}.bindings.${key}`,
            'A prop cannot have both a literal and a binding',
          );
        if (binding.kind === 'data') {
          const input = document.inputs[binding.input],
            prop = component.props[key];
          const source =
            input && (input.required || Object.hasOwn(input, 'default'))
              ? schemaAtPath(input.schema, binding.path)
              : undefined;
          if (!source || !prop || !schemaAssignable(source, prop.schema))
            add(
              'binding-type',
              `${path}.bindings.${key}`,
              'Data path is missing, optional/nullable, or not assignable to this prop',
            );
        } else {
          const callback = document.callbacks[binding.callback],
            event = component.events[key];
          if (
            !callback ||
            !event ||
            event.parameters.length !== callback.parameters.length ||
            event.parameters.some(
              (parameter, i) => !schemaAssignable(parameter, callback.parameters[i]),
            )
          )
            add(
              'callback-type',
              `${path}.bindings.${key}`,
              'Emitted event arguments are not assignable to this public callback',
            );
        }
      }
      for (const pair of component.controlledInputs)
        if (node.bindings[pair.valueProp] || node.bindings[pair.eventProp])
          if (
            node.bindings[pair.valueProp]?.kind !== 'data' ||
            node.bindings[pair.eventProp]?.kind !== 'callback'
          )
            add(
              'controlled-binding',
              `${path}.bindings`,
              'A controlled value binding requires its paired callback binding',
            );
      for (const slot of Object.keys(node.slots))
        if (!Object.hasOwn(component.slots, slot))
          add(
            'slot-unknown',
            `${path}.slots.${slot}`,
            'Slot is not published by this registration',
          );
      for (const [key, slot] of Object.entries(component.slots)) {
        const children = node.slots[key] ?? [];
        if (children.length < slot.minimum || children.length > slot.maximum)
          add(
            'slot-count',
            `${path}.slots.${key}`,
            'Slot cardinality is outside its declared range',
          );
        for (const child of children) {
          const target = nodes.get(child);
          if (
            target &&
            !slot.accepts.some(
              (ref) =>
                ref.registryId === target.component.registryId &&
                ref.componentId === target.component.componentId,
            )
          )
            add(
              'slot-component',
              `${path}.slots.${key}`,
              'Child component is not allowed in this slot',
            );
        }
      }
      if (
        component.layout === 'none' &&
        (Object.keys(node.layout.base).length ||
          Object.values(node.layout.breakpoints).some((style) => Object.keys(style).length))
      )
        add(
          'layout-capability',
          `${path}.layout`,
          'Component does not support layout props or a registered wrapper',
        );
    }
    for (const key of Object.keys(node.layout.breakpoints))
      if (!document.breakpoints.some((bp) => bp.id === key))
        add('layout-breakpoint', `${path}.layout.breakpoints.${key}`, 'Breakpoint is undeclared');
    for (const [prefix, style] of [
      ['base', node.layout.base],
      ...Object.entries(node.layout.breakpoints).map(
        ([key, value]) => [`breakpoints.${key}`, value] as const,
      ),
    ] as const)
      for (const [key, value] of Object.entries(style)) {
        const problem = styleProblem(document.environment, key as ReactUiStyleProperty, value);
        if (problem) add('style-value', `${path}.layout.${prefix}.${key}`, problem);
      }
  }
  for (const [index, node] of document.nodes.entries())
    if (!ownership.has(node.id))
      add('node-orphan', `$.nodes.${index}`, 'Node is not rooted or assigned to a slot');
  // Include disconnected subgraphs; a non-root cycle must not escape validation.
  const active = new Set<string>(),
    visited = new Set<string>(),
    heights = new Map<string, number>();
  const visit = (nodeId: string): number => {
    if (active.has(nodeId)) {
      add('slot-cycle', `$.nodes.${nodeId}.slots`, 'Component slot graph contains a cycle');
      return 0;
    }
    if (visited.has(nodeId)) return heights.get(nodeId) ?? 0;
    const node = nodes.get(nodeId);
    if (!node) return 0;
    if (active.size >= reactUiLimits.treeDepth) {
      add('tree-depth', `$.nodes.${nodeId}`, 'Component nesting exceeds the supported depth');
      return 0;
    }
    active.add(nodeId);
    const height = 1 + Math.max(0, ...Object.values(node.slots).flat().map(visit));
    if (height > reactUiLimits.treeDepth)
      add('tree-depth', `$.nodes.${nodeId}`, 'Component nesting exceeds the supported depth');
    active.delete(nodeId);
    visited.add(nodeId);
    heights.set(nodeId, height);
    return height;
  };
  document.nodes.forEach((node) => visit(node.id));
  return diagnostics;
}
export function inspectReactUiDocument(raw: unknown): ReactUiInspection {
  try {
    const document = loadReactUiDocument(raw);
    let diagnostics = documentDiagnostics.get(document);
    if (!diagnostics) {
      diagnostics = deepFreeze(inspect(document));
      documentDiagnostics.set(document, diagnostics);
    }
    // Public observations remain caller-owned; editing a diagnostic cannot turn
    // a cached invalid composition into a successful export.
    return { document, diagnostics: diagnostics.map((value) => ({ ...value })) };
  } catch (error) {
    return {
      diagnostics:
        error instanceof ReactUiError
          ? error.diagnostics
          : [
              diagnostic(
                'document-invalid',
                '$',
                error instanceof Error ? error.message : 'Invalid React UI data',
              ),
            ],
    };
  }
}
export function validateReactRuntimeResolution(raw: unknown): ReactRuntimeResolution {
  checkData(raw);
  const r = object(raw, '$.resolution');
  fields(r, ['environment', 'components', 'dependencies'], [], '$.resolution');
  checkEnvironmentRef(r.environment, '$.resolution.environment');
  const refs = array(r.components, '$.resolution.components', reactUiLimits.components);
  refs.forEach((ref, i) => checkComponentRef(ref, `$.resolution.components.${i}`));
  unique(
    (refs as ReactRuntimeResolution['components']).map(reactComponentKey),
    '$.resolution.components',
  );
  const deps = array(r.dependencies, '$.resolution.dependencies', reactUiLimits.dependencies);
  deps.forEach((raw, i) => {
    const path = `$.resolution.dependencies.${i}`,
      dep = object(raw, path);
    fields(dep, ['id', 'hash'], [], path);
    id(dep.id, path);
    hash(dep.hash, path);
  });
  unique(
    deps.map((dep) => (dep as { id: string }).id),
    '$.resolution.dependencies',
  );
  return deepFreeze(structuredClone(raw as ReactRuntimeResolution));
}
export function inspectReactRuntimeResolution(
  document: ReactUiDocument,
  raw: unknown,
): ReactUiDiagnostic[] {
  const resolution = validateReactRuntimeResolution(raw),
    diagnostics: ReactUiDiagnostic[] = [];
  const expectedEnvironment = document.environment.ref;
  if (
    expectedEnvironment.id !== resolution.environment.id ||
    expectedEnvironment.version !== resolution.environment.version ||
    expectedEnvironment.hash !== resolution.environment.hash
  )
    diagnostics.push(
      diagnostic(
        'runtime-environment',
        '$.resolution.environment',
        'Host resolved a different environment version/hash',
      ),
    );
  // Validation above admits exactly these reference fields. Match identities
  // once and compare both complete pins without rehashing every reference.
  const resolvedComponents = new Map(
    resolution.components.map((ref) => [reactComponentKey(ref), ref]),
  );
  for (const component of document.components) {
    const resolved = resolvedComponents.get(reactComponentKey(component.ref));
    if (
      !resolved ||
      resolved.contractHash !== component.ref.contractHash ||
      resolved.implementationHash !== component.ref.implementationHash
    )
      diagnostics.push(
        diagnostic(
          'runtime-component',
          `$.components.${component.ref.componentId}`,
          'Host has not resolved this exact implementation/registration',
        ),
      );
  }
  for (const dependency of document.environment.dependencies)
    if (!resolution.dependencies.some((d) => d.id === dependency.id && d.hash === dependency.hash))
      diagnostics.push(
        diagnostic(
          'runtime-dependency',
          `$.environment.dependencies.${dependency.id}`,
          'Host has not resolved the exact package, CSS, asset or Provider',
        ),
      );
  return diagnostics;
}
const defaultOutputPaths = Object.freeze([
  'Screen.tsx',
  'Screen.css',
  'manifest.json',
  'composition.json',
  'README.md',
]);
/** Validate the owned composition and current exact runtime/output constraints.
 * Rendering does not need to compute a fingerprint for an export plan. */
export function prepareReactUiComposition(
  raw: unknown,
  resolution: unknown,
  outputPaths: readonly string[] = defaultOutputPaths,
): ReactUiDocument {
  const inspected = inspectReactUiDocument(raw);
  if (!inspected.document || inspected.diagnostics.length)
    throw new ReactUiError(inspected.diagnostics);
  const document = inspected.document,
    diagnostics = inspectReactRuntimeResolution(document, resolution);
  const generated = new Set(outputPaths.map((path) => path.toLowerCase()));
  for (const dependency of document.environment.dependencies)
    if (
      (dependency.kind === 'css' || dependency.kind === 'asset') &&
      generated.has(dependency.path.toLowerCase())
    )
      diagnostics.push(
        diagnostic(
          'output-path-collision',
          `$.environment.dependencies.${dependency.id}.path`,
          `Dependency ${dependency.path} collides with generated output; choose a distinct dependency path`,
        ),
      );
  if (diagnostics.length) throw new ReactUiError(diagnostics);
  return document;
}
/** W1 deterministic plan. Every semantic/runtime failure blocks even a partial success plan. */
export function prepareReactUiExport(
  raw: unknown,
  resolution: unknown,
  outputPaths: readonly string[] = defaultOutputPaths,
): ReactUiExportPlan {
  const document = prepareReactUiComposition(raw, resolution, outputPaths);
  let fingerprint = documentFingerprints.get(document);
  if (!fingerprint) {
    fingerprint = reuseHash(document);
    documentFingerprints.set(document, fingerprint);
  }
  return deepFreeze({
    document,
    fingerprint,
    files: [...outputPaths],
    imports: document.components.map((c) => c.import),
    dependencies: document.environment.dependencies,
    ownership: 'generated-directory-only',
  });
}
