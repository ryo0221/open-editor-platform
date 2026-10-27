import {
  Component,
  createElement,
  Fragment,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react';
import {
  prepareReactUiComposition,
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
  { children: ReactNode; onError(diagnostics: ReactUiDiagnostic[]): void; resetKey?: string },
  { failed: boolean; resetKey?: string }
> {
  state: { failed: boolean; resetKey?: string } = { failed: false };
  static getDerivedStateFromProps(props: { resetKey?: string }, state: { resetKey?: string }) {
    return props.resetKey !== state.resetKey ? { failed: false, resetKey: props.resetKey } : null;
  }
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
  // A controlled input without a data binding keeps a preview-only value in
  // Interact mode. It never reaches the composition, fixture or export, and a
  // new document (mode switch, edit) starts again from the composition value.
  const [local, setLocal] = useState<{ source: ReactUiDocument; values: Map<string, JsonValue> }>({
    source: document,
    values: new Map(),
  });
  const localValues = local.source === document ? local.values : new Map<string, JsonValue>();
  const source = document;
  document = prepareReactUiComposition(document, runtime.resolution);
  const nodeMap = new Map(document.nodes.map((node) => [node.id, node]));
  const componentMap = new Map(
    document.components.map((component) => [reactComponentKey(component.ref), component]),
  );
  const render = (id: string): ReactNode => {
    const node: ReactUiNode = nodeMap.get(id)!;
    const registered = componentMap.get(reactComponentKey(node.component))!;
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
    if (mode === 'interact')
      for (const pair of registered.controlledInputs) {
        if (node.bindings[pair.valueProp] || node.bindings[pair.eventProp]) continue;
        const key = `${node.id}\u0000${pair.valueProp}`;
        const field = registered.props[pair.valueProp];
        if (localValues.has(key))
          props[pair.valueProp] = assetValue(field.schema, localValues.get(key)!, runtime);
        const contract = registered.events[pair.eventProp];
        props[pair.eventProp] = (...args: unknown[]) => {
          if (
            args.length !== contract.parameters.length ||
            !args.every((v, i) => valueMatches(contract.parameters[i], v))
          )
            throw new Error(`Invalid Host event arguments: ${pair.eventProp}`);
          const value = args[pair.argumentIndex] as JsonValue;
          if (!valueMatches(field.schema, value)) return;
          setLocal((current) => {
            const values = new Map(current.source === source ? current.values : []);
            values.set(key, value);
            return { source, values };
          });
        };
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
