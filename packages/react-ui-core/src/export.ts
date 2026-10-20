import { canonicalJson, deepFreeze } from '@editor-platform/artifact-core';
import { reuseHash } from '@editor-platform/reuse-core';
import { prepareReactUiExport } from './preflight';
import { reactComponentKey } from './registration';
import { ReactUiError, diagnostic } from './data';
import type { ReactRuntimeAdapter } from './adapters';
import type {
  JsonValue,
  ReactRuntimeResolution,
  ReactUiDocument,
  ReactUiNode,
  ReactUiStyle,
  ReactValueSchema,
} from './types';

/** Values are expressions, never interpolated JSX/HTML or executable user strings. */
export function reactUiExpression(value: unknown): string {
  return canonicalJson(value).replace(
    /[<>&\u2028\u2029]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}
const classNames = new Map<string, string>();
export function reactUiClassName(id: string): string {
  const cacheable = typeof id === 'string' && id.length <= 160;
  const known = cacheable ? classNames.get(id) : undefined;
  if (known) return known;
  const value = `rui-${reuseHash(id).slice(0, 20)}`;
  // Bound both the entry count and retained key length across many documents.
  if (cacheable) {
    if (classNames.size >= 4000) classNames.delete(classNames.keys().next().value!);
    classNames.set(id, value);
  }
  return value;
}
const unitless = new Set([
  'display',
  'flexDirection',
  'alignItems',
  'justifyContent',
  'flexWrap',
  'gridTemplateColumns',
  'fontWeight',
  'position',
]);
export function resolveReactUiStyle(
  document: ReactUiDocument,
  style: ReactUiStyle,
): Record<string, string | number> {
  return Object.fromEntries(
    Object.entries(style).map(([key, value]) => [
      key,
      value.kind === 'token'
        ? `var(${document.environment.tokenVariables[value.tokenId]})`
        : typeof value.value === 'number' && !unitless.has(key)
          ? `${value.value}px`
          : value.value,
    ]),
  );
}
export function reactUiLayoutAt(document: ReactUiDocument, node: ReactUiNode, width: number) {
  return resolveReactUiStyle(
    document,
    Object.assign(
      {},
      node.layout.base,
      ...document.breakpoints
        .filter((bp) => width >= bp.minWidth)
        .map((bp) => node.layout.breakpoints[bp.id] ?? {}),
    ),
  );
}
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
function declarations(document: ReactUiDocument, style: ReactUiStyle): string {
  return Object.entries(resolveReactUiStyle(document, style))
    .sort(([a], [b]) => compare(a, b))
    .map(([key, value]) => `${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}:${value};`)
    .join('');
}
export function reactUiCss(document: ReactUiDocument): string {
  return (
    document.nodes
      .slice()
      .sort((a, b) => compare(a.id, b.id))
      .flatMap((node) => [
        `.${reactUiClassName(node.id)}{${declarations(document, node.layout.base)}}`,
        ...document.breakpoints
          .filter((bp) => node.layout.breakpoints[bp.id])
          .map(
            (bp) =>
              `@media(min-width:${bp.minWidth}px){.${reactUiClassName(node.id)}{${declarations(document, node.layout.breakpoints[bp.id])}}}`,
          ),
      ])
      .join('\n') + '\n'
  );
}
function tsType(schema: ReactValueSchema): string {
  let result: string;
  switch (schema.type) {
    case 'string':
    case 'asset':
      result = 'string';
      break;
    case 'number':
      result = 'number';
      break;
    case 'boolean':
      result = 'boolean';
      break;
    case 'enum':
      result = schema.values.map(reactUiExpression).join(' | ');
      break;
    case 'array':
      result = `Array<${tsType(schema.items)}>`;
      break;
    case 'object':
      result = `{ ${Object.entries(schema.fields)
        .sort(([a], [b]) => compare(a, b))
        .map(([key, field]) => `${key}${field.required ? '' : '?'}: ${tsType(field.schema)};`)
        .join(' ')} }`;
      break;
  }
  return schema.nullable ? `(${result}) | null` : result;
}
export interface ReactUiExport {
  fingerprint: string;
  generator: typeof reactUiGenerator;
  files: Record<
    'Screen.tsx' | 'Screen.css' | 'manifest.json' | 'composition.json' | 'README.md',
    string
  >;
  ownership: 'generated-directory-only';
}
export const reactUiGenerator = Object.freeze({ id: 'react-ui-tsx', version: '2.0.1' });
/** Atomic text bundle; Host copies pinned dependency bytes into its generated directory. */
export function exportReactUi(
  document: ReactUiDocument,
  resolution: ReactRuntimeResolution,
  options: { symbol?: string; cssFile?: string; optionalCallbacks?: boolean } = {},
): ReactUiExport {
  const symbol = options.symbol ?? 'Screen';
  const cssFile = options.cssFile ?? 'Screen.css';
  if (
    !/^[A-Z][A-Za-z0-9_]{0,79}$/.test(symbol) ||
    !/^[A-Za-z][A-Za-z0-9_-]{0,100}\.css$/.test(cssFile)
  )
    throw new Error('Unsafe generated symbol or CSS filename');
  const plan = prepareReactUiExport(document, resolution, [
    `${symbol}.tsx`,
    cssFile,
    'manifest.json',
    'composition.json',
    'README.md',
  ]);
  document = plan.document;
  const components = document.components
    .slice()
    .sort((a, b) => compare(reactComponentKey(a.ref), reactComponentKey(b.ref)));
  const componentIndices = new Map(
    components.map((component, index) => [reactComponentKey(component.ref), index]),
  );
  const lines = [
    'import { Fragment, useEffect, useState } from "react";',
    `import ${reactUiExpression('./' + cssFile)};`,
  ];
  const importLine = (
    source: string,
    mode: 'named' | 'default',
    name: string | undefined,
    alias: string,
  ) =>
    `import ${mode === 'default' ? alias : `{ ${name} as ${alias} }`} from ${reactUiExpression(source)};`;
  components.forEach((c, i) =>
    lines.push(importLine(c.import.source, c.import.export, c.import.name, `C${i}`)),
  );
  const assets = new Map<string, string>();
  document.environment.dependencies.forEach((dependency, i) => {
    if (dependency.kind === 'css')
      lines.push(`import ${reactUiExpression(`./${dependency.path}`)};`);
    if (dependency.kind === 'asset') {
      assets.set(dependency.id, `asset${i}`);
      lines.push(`import asset${i} from ${reactUiExpression(`./${dependency.path}`)};`);
    }
    if (dependency.kind === 'provider')
      lines.push(
        importLine(
          dependency.import.source,
          dependency.import.export,
          dependency.import.name,
          `P${i}`,
        ),
      );
  });
  // Static asset props become bundler imports. Page asset inputs are already resolved URLs.
  const expr = (schema: ReactValueSchema, value: JsonValue): string => {
    if (value === null) return 'null';
    if (schema.type === 'asset') return assets.get(String(value))!;
    if (schema.type === 'array')
      return `[${(value as JsonValue[]).map((v) => expr(schema.items, v)).join(',')}]`;
    if (schema.type === 'object')
      return `{${Object.entries(value as Record<string, JsonValue>)
        .sort(([a], [b]) => compare(a, b))
        .map(([key, v]) => `${reactUiExpression(key)}:${expr(schema.fields[key].schema, v)}`)
        .join(',')}}`;
    return reactUiExpression(value);
  };
  const props = [
    ...Object.entries(document.inputs)
      .sort(([a], [b]) => compare(a, b))
      .map(([key, field]) => `  ${key}${field.required ? '' : '?'}: ${tsType(field.schema)};`),
    ...Object.entries(document.callbacks)
      .sort(([a], [b]) => compare(a, b))
      .map(
        ([key, callback]) =>
          `  ${key}${options.optionalCallbacks ? '?' : ''}: (${callback.parameters.map((schema, i) => `arg${i}: ${tsType(schema)}`).join(', ')}) => void;`,
      ),
  ];
  lines.push(`export interface ${symbol}Props {\n${props.join('\n')}\n}`);
  lines.push(
    'function useViewportWidth() {',
    '  const [width, setWidth] = useState(() => typeof window === "undefined" ? 0 : window.innerWidth);',
    '  useEffect(() => {',
    '    const update = () => setWidth(window.innerWidth);',
    '    window.addEventListener("resize", update);',
    '    update();',
    '    return () => window.removeEventListener("resize", update);',
    '  }, []);',
    '  return width;',
    '}',
  );
  lines.push(
    `export function ${symbol}(props: ${symbol}Props) {`,
    '  const width = useViewportWidth();',
  );
  for (const [key, field] of Object.entries(document.inputs).sort(([a], [b]) => compare(a, b)))
    lines.push(
      `  const input_${key} = ${Object.hasOwn(field, 'default') ? `props.${key} === undefined ? ${expr(field.schema, field.default!)} : props.${key}` : `props.${key}`};`,
    );
  const nodeMap = new Map(document.nodes.map((node) => [node.id, node]));
  const render = (id: string): string => {
    const node = nodeMap.get(id)!;
    const i = componentIndices.get(reactComponentKey(node.component))!;
    const component = components[i];
    const attributes = [`key={${reactUiExpression(node.id)}}`];
    for (const [key, field] of Object.entries(component.props).sort(([a], [b]) => compare(a, b))) {
      const binding = node.bindings[key];
      if (binding?.kind === 'data')
        attributes.push(
          `${key}={input_${binding.input}${binding.path.map((p) => `[${reactUiExpression(p)}]`).join('')}}`,
        );
      else if (Object.hasOwn(node.props, key) || Object.hasOwn(field, 'default'))
        attributes.push(
          `${key}={${expr(field.schema, Object.hasOwn(node.props, key) ? node.props[key] : field.default!)}}`,
        );
    }
    for (const [key, binding] of Object.entries(node.bindings).sort(([a], [b]) => compare(a, b)))
      if (binding.kind === 'callback') attributes.push(`${key}={props.${binding.callback}}`);
    if (component.layout === 'className')
      attributes.push(`className=${reactUiExpression(reactUiClassName(id))}`);
    if (component.layout === 'style') {
      const styles = document.breakpoints
        .filter((bp) => node.layout.breakpoints[bp.id])
        .map(
          (bp) =>
            `...(width >= ${bp.minWidth} ? ${reactUiExpression(resolveReactUiStyle(document, node.layout.breakpoints[bp.id]))} : {})`,
        );
      attributes.push(
        `style={{...${reactUiExpression(resolveReactUiStyle(document, node.layout.base))}${styles.length ? ',' + styles.join(',') : ''}}}`,
      );
    }
    for (const [key, slot] of Object.entries(component.slots).sort(([a], [b]) => compare(a, b))) {
      const children = node.slots[key] ?? [];
      if (children.length)
        attributes.push(
          `${slot.prop}={<Fragment>\n${children.map(render).join('\n')}\n</Fragment>}`,
        );
    }
    const element = `<C${i}\n${attributes.map((a) => '  ' + a.replace(/\n/g, '\n  ')).join('\n')}\n/>`;
    return component.layout === 'wrapper'
      ? `<div key={${reactUiExpression(id)}} className=${reactUiExpression(reactUiClassName(id))}>\n${element.replace(/^/gm, '  ')}\n</div>`
      : element;
  };
  let jsx = `<Fragment>\n${document.roots.map(render).join('\n')}\n</Fragment>`;
  for (const id of [...document.environment.providerOrder].reverse()) {
    const i = document.environment.dependencies.findIndex((d) => d.id === id);
    const dependency = document.environment.dependencies[i];
    if (dependency.kind === 'provider')
      jsx = `<P${i} {...${reactUiExpression(dependency.props)}}>\n${jsx.replace(/^/gm, '  ')}\n</P${i}>`;
  }
  lines.push(
    '  void width;',
    '  return (',
    jsx.replace(/^/gm, '    '),
    '  );',
    '}',
    `export default ${symbol};`,
  );
  const manifest = {
    schemaVersion: 1,
    generator: reactUiGenerator,
    fingerprint: plan.fingerprint,
    environment: document.environment,
    registrations: components,
    ownership: plan.ownership,
    files: plan.files,
    assetInputs:
      'Host supplies resolved URLs for page data; static props/defaults use declared bundler imports',
  };
  return deepFreeze({
    fingerprint: plan.fingerprint,
    generator: reactUiGenerator,
    ownership: plan.ownership,
    files: {
      'Screen.tsx': lines.join('\n') + '\n',
      'Screen.css': reactUiCss(document),
      'manifest.json': canonicalJson(manifest),
      'composition.json': canonicalJson(document),
      'README.md': `# React screen\n\nImport Screen and supply ScreenProps data/callbacks. No Editor runtime is required.\n\nUse React ${document.environment.reactVersion}. Install exact package versions from manifest.json. Resolve component/Provider import aliases to the pinned original implementations. Copy CSS/assets with their declared paths and verify all implementation/dependency hashes before building. Provider order is outermost first. Page asset inputs must be resolved URLs; static asset props/defaults use bundler imports.\n\nOnly replace files in a dedicated generated directory; do not overwrite hand-written code. Re-export is one way; edited TSX is not imported. The native composition retains unresolved references, not executable implementation bytes.\n\nEnvironment: ${document.environment.ref.id}@${document.environment.ref.version}\nFingerprint: ${plan.fingerprint}\n`,
    },
  });
}

/** Host diagnostics block output even when exact reference resolution is present. */
export async function exportReactUiFromRuntime(
  document: ReactUiDocument,
  runtime: Pick<ReactRuntimeAdapter, 'resolve'>,
  signal: AbortSignal,
): Promise<ReactUiExport> {
  const result = await runtime.resolve({
    environment: document.environment.ref,
    components: document.components.map((c) => c.ref),
    signal,
  });
  if (result.diagnostics.length) throw new ReactUiError(result.diagnostics);
  if (!result.resolution)
    throw new ReactUiError([
      diagnostic('runtime-unresolved', '$.resolution', 'Host did not resolve the pinned build'),
    ]);
  return exportReactUi(document, result.resolution);
}
