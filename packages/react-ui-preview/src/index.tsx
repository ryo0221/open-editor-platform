import { Component, createElement, Fragment, type ComponentType, type ReactNode } from 'react';
import {
  inspectReactRuntimeResolution,
  prepareReactUiExport,
  reactComponentKey,
  reactUiClassName,
  reactUiLayoutAt,
  reactUiCss,
  valueMatches,
  type JsonValue,
  type ReactUiDocument,
  type ReactUiNode,
  type ReactValueSchema,
  type ReactRuntimeResolution,
  type ReactUiDiagnostic,
} from '@editor-platform/react-ui-core';

/** Executable functions exist only in the Host's separately built origin. */
export interface ReactPreviewRuntime {
  resolution: ReactRuntimeResolution;
  components: Record<string, ComponentType<Record<string, unknown>>>;
  providers: Record<string, ComponentType<{ children?: ReactNode } & Record<string, unknown>>>;
  assets: Record<string, string>;
}
export class ReactPreviewBoundary extends Component<
  { children: ReactNode; onError(diagnostics: ReactUiDiagnostic[]): void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error) {
    this.props.onError([
      {
        code: 'component-exception',
        severity: 'error',
        path: '$.preview',
        message: String(error.message).slice(0, 1024),
        recovery:
          'Restart the preview; composition is retained. Check the pinned Host component implementation.',
      },
    ]);
  }
  render() {
    return this.state.failed ? (
      <p role="alert">Component failed. Restart preview.</p>
    ) : (
      this.props.children
    );
  }
}
function assetValue(
  schema: ReactValueSchema,
  value: JsonValue,
  runtime: ReactPreviewRuntime,
): unknown {
  if (value === null) return null;
  if (schema.type === 'asset') {
    const asset = runtime.assets[String(value)];
    if (!asset) throw new Error('Missing pinned asset: ' + String(value));
    return asset;
  }
  if (schema.type === 'array')
    return (value as JsonValue[]).map((v) => assetValue(schema.items, v, runtime));
  if (schema.type === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, JsonValue>).map(([key, v]) => [
        key,
        assetValue(schema.fields[key].schema, v, runtime),
      ]),
    );
  return value;
}
export function ReactComposition({
  document,
  runtime,
  width,
  inputs = document.fixture,
  callback,
  mode = 'interact',
  select,
}: {
  document: ReactUiDocument;
  runtime: ReactPreviewRuntime;
  width: number;
  inputs?: Record<string, JsonValue>;
  callback?(nodeId: string, event: string, args: JsonValue[]): void;
  mode?: 'edit' | 'interact';
  select?(nodeId: string): void;
}) {
  prepareReactUiExport(document, runtime.resolution);
  const issues = inspectReactRuntimeResolution(document, runtime.resolution);
  if (issues.length) throw new Error(issues.map((d) => d.message).join('; '));
  const nodeMap = new Map(document.nodes.map((node) => [node.id, node]));
  const render = (id: string): ReactNode => {
    const node: ReactUiNode = nodeMap.get(id)!;
    const registered = document.components.find(
      (c) => reactComponentKey(c.ref) === reactComponentKey(node.component),
    )!;
    const implementation = runtime.components[reactComponentKey(node.component)];
    if (!implementation) throw new Error(`Missing pinned implementation: ${registered.name}`);
    const props: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(registered.props)) {
      const binding = node.bindings[key];
      if (binding?.kind === 'data') {
        let value: JsonValue = Object.hasOwn(inputs, binding.input)
          ? inputs[binding.input]
          : document.inputs[binding.input].default!;
        for (const path of binding.path) value = (value as Record<string, JsonValue>)[path];
        // Fixture data retains asset IDs; resolve only through the pinned Host map.
        props[key] = assetValue(field.schema, value, runtime);
      } else if (Object.hasOwn(node.props, key) || Object.hasOwn(field, 'default'))
        props[key] = assetValue(
          field.schema,
          Object.hasOwn(node.props, key) ? node.props[key] : field.default!,
          runtime,
        );
    }
    for (const [event, contract] of Object.entries(registered.events))
      if (node.bindings[event]?.kind === 'callback')
        props[event] = (...args: unknown[]) => {
          if (mode !== 'interact') return;
          if (
            args.length !== contract.parameters.length ||
            !args.every((v, i) => valueMatches(contract.parameters[i], v))
          )
            throw new Error(`Invalid Host event arguments: ${event}`);
          callback?.(node.id, event, args as JsonValue[]);
        };
    for (const [slotId, slot] of Object.entries(registered.slots)) {
      const children = node.slots[slotId] ?? [];
      if (children.length)
        props[slot.prop] = createElement(Fragment, null, ...children.map(render));
    }
    const className = reactUiClassName(node.id);
    if (registered.layout === 'className') props.className = className;
    if (registered.layout === 'style') props.style = reactUiLayoutAt(document, node, width);
    let element = createElement(implementation, { ...props, key: node.id });
    if (registered.layout === 'wrapper')
      element = createElement('div', { key: node.id, className }, element);
    // Display-contents addressing is preview-only, never exported or used to infer component internals.
    return (
      <div
        key={node.id}
        data-react-ui-node={node.id}
        style={{ display: 'contents' }}
        onClickCapture={(event) => {
          if (mode === 'edit') {
            event.preventDefault();
            event.stopPropagation();
            select?.(
              (event.target as HTMLElement)
                .closest('[data-react-ui-node]')
                ?.getAttribute('data-react-ui-node') ?? node.id,
            );
          }
        }}
      >
        {element}
      </div>
    );
  };
  let output: ReactNode = <>{document.roots.map(render)}</>;
  for (const id of [...document.environment.providerOrder].reverse()) {
    const provider = document.environment.dependencies.find((d) => d.id === id)!;
    const implementation = runtime.providers[id];
    if (provider.kind !== 'provider' || !implementation)
      throw new Error(`Missing pinned Provider: ${id}`);
    output = createElement(implementation, { ...provider.props }, output);
  }
  return (
    <>
      <style>{reactUiCss(document)}</style>
      {output}
    </>
  );
}
