import { clone, canonicalJson, deepFreeze } from '@editor-platform/artifact-core';
import { reuseHash } from '@editor-platform/reuse-core';
import { descendantIds } from '@editor-platform/editor-core';
import { isDesign, exportDesignSvg, type DesignContent } from '@editor-platform/design/model';
import { type DesignWebTag, type DesignWebSettings } from '@editor-platform/design/web-contract';
import {
  sealReactComponent,
  reactComponentKey,
  inspectReactUiDocument,
  loadReactUiDocument,
  prepareReactUiExport,
  exportReactUi,
  reactUiExpression,
  ReactUiError,
  type ReactUiDocument,
  type ReactUiNode,
  type RegisteredReactComponent,
  type ReactRuntimeResolution,
  type ReactUiDiagnostic,
  type ReactComponentRef,
  validateReactComponentRef,
} from '@editor-platform/react-ui-core';
import {
  err,
  safeSymbol,
  createConversionState,
  settingsDiagnostics,
  nativeComponent,
  buildDocument,
  acceptGeneratedChildren,
  finalizeDocument,
  allRegistrations,
  type ConversionState,
} from './convert-native';
export interface NativePrimitive {
  registration: RegisteredReactComponent;
  tag: DesignWebTag;
  href?: string;
  sourceId: string;
  imageFit?: 'fit' | 'fill';
  radius?: number;
}
export interface NativeComponentProgram {
  registration: RegisteredReactComponent;
  hasVariants: boolean;
  documents: Record<string, ReactUiDocument>;
  sourceId: string;
  slotTargets: Record<string, { elementId: string; prop: string }>;
}
export interface DesignReactConversion {
  schemaVersion: 1;
  sourceHash: string;
  settingsHash: string;
  document: ReactUiDocument;
  primitives: NativePrimitive[];
  components: NativeComponentProgram[];
  publishedComponentIds: string[];
  mappings: { nativeId: string; nodeId: string; symbol: string; sourceHash: string }[];
  diagnostics: ReactUiDiagnostic[];
}
/** HTML content-model rules the generated primitives must respect. */
function forbiddenNesting(tag: string, ancestors: string[]): boolean {
  if (['form', 'a', 'label'].includes(tag) && ancestors.includes(tag)) return true;
  if (ancestors.includes('a') && tag === 'form') return true;
  return (
    ancestors.some((a) => ['p', 'span', 'h1', 'h2'].includes(a)) &&
    !['span', 'img', 'a', 'label'].includes(tag)
  );
}
/** Check known native HTML across component documents and injected public slots. Original internals stay opaque. */
function inspectNativeHtml(conversion: DesignReactConversion): ReactUiDiagnostic[] {
  const problems: ReactUiDiagnostic[] = [];
  type Child = { document: ReactUiDocument; id: string };
  const walkComponent = (
    component: NativeComponentProgram,
    document: ReactUiDocument,
    node: ReactUiNode,
    ancestors: string[],
    context: Record<string, Child[]>,
    active: Set<string>,
  ) => {
    if (active.has(component.sourceId)) return;
    const scope = { ...context };
    for (const [slotId, target] of Object.entries(component.slotTargets))
      if (node.slots[slotId]?.length)
        scope[target.elementId] = node.slots[slotId].map((id) => ({ document, id }));
    for (const inner of Object.values(component.documents))
      for (const root of inner.roots)
        walk(inner, root, ancestors, scope, new Set([...active, component.sourceId]));
  };
  const walk = (
    document: ReactUiDocument,
    id: string,
    ancestors: string[],
    context: Record<string, Child[]>,
    active: Set<string>,
  ) => {
    const node = document.nodes.find((n) => n.id === id);
    if (!node) return;
    const key = reactComponentKey(node.component);
    const primitive = conversion.primitives.find(
      (p) => reactComponentKey(p.registration.ref) === key,
    );
    const component = conversion.components.find(
      (c) => reactComponentKey(c.registration.ref) === key,
    );
    const tag = primitive?.tag ?? (component ? 'div' : undefined);
    if (tag && forbiddenNesting(tag, ancestors))
      problems.push(
        err('html-content', id, `HTML ${tag} is not allowed inside ${ancestors.join(' / ')}`),
      );
    const next = tag ? [...ancestors, tag] : ancestors;
    if (component) walkComponent(component, document, node, next, context, active);
    else {
      const children =
        context[id] ??
        Object.values(node.slots)
          .flat()
          .map((id) => ({ document, id }));
      for (const child of children) walk(child.document, child.id, next, context, active);
    }
  };
  for (const doc of [
    conversion.document,
    ...conversion.components.flatMap((c) => Object.values(c.documents)),
  ])
    for (const root of doc.roots) walk(doc, root, [], {}, new Set());
  return [...new Map(problems.map((p) => [p.path + p.message, p])).values()];
}
export function designReactSourceHash(content: DesignContent): string {
  const source = clone(content);
  if (source.web) {
    delete source.web.accepted;
    delete source.web.publications;
  }
  return reuseHash(source);
}
/** Graphic renderers have no executable React content; refuse loss at every output entrypoint. */
export function designReactGraphicProblems(content: DesignContent, roots: string[]): string[] {
  const included = descendantIds(content.elements, roots);
  const hasOriginal = (componentId: string, seen = new Set<string>()): boolean => {
    if (seen.has(componentId)) return false;
    seen.add(componentId);
    return (
      content.components
        .find((c) => c.id === componentId)
        ?.elements?.some(
          (e) => e.type === 'react' || (e.componentId && hasOriginal(e.componentId, seen)),
        ) ?? false
    );
  };
  return content.elements
    .filter(
      (e) =>
        included.has(e.id) &&
        !e.hidden &&
        (e.type === 'react' || (e.componentId && hasOriginal(e.componentId))),
    )
    .map((e) => e.id);
}
export function designReactCanvasOwner(content: DesignContent, id: string): string | undefined {
  let current = content.elements.find((e) => e.id === id),
    owner: string | undefined;
  const seen = new Set<string>();
  while (current?.parentId && !seen.has(current.parentId)) {
    seen.add(current.parentId);
    const parent = content.elements.find((e) => e.id === current!.parentId);
    if (!parent) break;
    if (
      Object.values(parent.react?.slots ?? parent.webSlots ?? {}).some((ids) =>
        ids.includes(current!.id),
      )
    )
      owner = parent.id;
    current = parent;
  }
  return owner;
}
/** Deterministic projection of the native tree, never a second persisted editing model. */
/** Deterministic projection of the native tree, never a second persisted editing model. */
export function convertDesignToReact(
  content: DesignContent,
  rootIds?: string[],
): DesignReactConversion {
  if (content.schemaVersion === 3 || content.elements?.some((e) => e.path))
    throw new ReactUiError([
      err('path-unsupported', '$', 'Structured paths/schema3 cannot be converted to React'),
    ]);
  if (!isDesign(content) || !content.web)
    throw new ReactUiError([
      err('native-settings', '$', 'Valid native Design and explicit Web settings are required'),
    ]);
  if (content.elements.some((e) => e.reference))
    throw new ReactUiError([
      err(
        'reference-export-unsupported',
        '$',
        '参照埋め込みのReact変換は未対応です。参照付きnative JSONまたは静的画像出力を使ってください。',
      ),
    ]);
  const settings = content.web;
  const state = createConversionState(content, settings);
  const { diagnostics, primitives, components } = state;
  const sourceHash = designReactSourceHash(content);
  diagnostics.push(...settingsDiagnostics(content, settings));
  for (const c of content.components.filter((c) => c.web)) nativeComponent(state, c);
  const roots = rootIds ?? settings.pages.map((p) => p.frameId);
  if (!roots.length)
    diagnostics.push(
      err(
        'page-required',
        '$.web.pages',
        'Declare a page or selected composition root before Web export',
      ),
    );
  const document = buildDocument(state, content.elements, roots);
  acceptGeneratedChildren(state);
  for (const c of components)
    for (const [v, doc] of Object.entries(c.documents))
      c.documents[v] = finalizeDocument(state, doc);
  const final = finalizeDocument(state, document);
  const result: DesignReactConversion = {
    schemaVersion: 1,
    sourceHash,
    settingsHash: reuseHash({ ...settings, accepted: null, publications: null }),
    document: final,
    primitives,
    components,
    publishedComponentIds: content.components.filter((c) => c.web).map((c) => c.id),
    mappings: state.mappings,
    diagnostics,
  };
  diagnostics.push(...inspectNativeHtml(result));
  if (!diagnostics.length) {
    resealGeneratedPrograms(state, result);
    diagnostics.push(...publicationVersionDiagnostics(settings, result));
  }
  return deepFreeze(result);
}
/** Source of one component program: its dependency closure's modules and public contracts. */
function componentProgramSource(
  state: ConversionState,
  result: DesignReactConversion,
  declared: ReactRuntimeResolution,
  component: NativeComponentProgram,
): string {
  const { primitives, components, settings } = state;
  const closure = new Set<NativeComponentProgram>();
  const keys = new Set<string>();
  const visit = (c: NativeComponentProgram) => {
    if (closure.has(c)) return;
    closure.add(c);
    for (const doc of Object.values(c.documents))
      for (const node of doc.nodes) {
        const key = reactComponentKey(node.component);
        keys.add(key);
        const nested = components.find((p) => reactComponentKey(p.registration.ref) === key);
        if (nested) visit(nested);
      }
  };
  visit(component);
  return canonicalJson({
    modules: nativeModuleFiles(
      {
        ...result,
        primitives: primitives.filter((p) => keys.has(reactComponentKey(p.registration.ref))),
        components: components.filter((c) => closure.has(c)),
      },
      declared,
    ),
    contracts: [...closure].map((c) => ({
      id: c.sourceId,
      version: c.registration.ref.version,
      props: c.registration.props,
      slots: c.registration.slots,
      events: c.registration.events,
      controlledInputs: c.registration.controlledInputs,
      requires: c.registration.requires,
    })),
    original: settings.registrations
      .filter((c) => keys.has(reactComponentKey(c.ref)))
      .map((c) => c.ref),
  });
}
/** Seals each generated program with the hash of its own emitted source and updates references. */
function resealGeneratedPrograms(state: ConversionState, result: DesignReactConversion) {
  const { primitives, components, settings } = state;
  const declared: ReactRuntimeResolution = {
    environment: settings.environment.ref,
    components: allRegistrations(state).map((c) => c.ref),
    dependencies: settings.environment.dependencies.map((d) => ({ id: d.id, hash: d.hash })),
  };
  const reseal = (registration: RegisteredReactComponent, source: string) =>
    sealReactComponent({
      ...registration,
      ref: {
        registryId: registration.ref.registryId,
        componentId: registration.ref.componentId,
        version: registration.ref.version,
        implementationHash: reuseHash(source),
      },
    });
  // Hash only each program's dependency closure. Unrelated pages/publications cannot
  // change an immutable component's identity merely by joining the same export.
  const primitiveSources = primitives.map(
    (p) =>
      nativeModuleFiles({ ...result, primitives: [p], components: [] }, declared)[
        'NativeComponents.tsx'
      ],
  );
  const componentSources = components.map((c) =>
    componentProgramSource(state, result, declared, c),
  );
  primitives.forEach((p, i) => (p.registration = reseal(p.registration, primitiveSources[i])));
  components.forEach((c, i) => (c.registration = reseal(c.registration, componentSources[i])));
  const refs = allRegistrations(state);
  const find = (ref: ReactComponentRef) =>
    refs.find((r) => reactComponentKey(r.ref) === reactComponentKey(ref));
  for (const doc of [result.document, ...components.flatMap((c) => Object.values(c.documents))]) {
    doc.components = doc.components.map((c) => find(c.ref)!);
    doc.nodes = doc.nodes.map((n) => ({ ...n, component: find(n.component)?.ref ?? n.component }));
  }
}
function publicationVersionDiagnostics(
  settings: DesignWebSettings,
  result: DesignReactConversion,
): ReactUiDiagnostic[] {
  const out: ReactUiDiagnostic[] = [];
  for (const ref of retainedDesignPublications(settings)) {
    const current = designReactPublications(result).find(
      (c) => reactComponentKey(c) === reactComponentKey(ref),
    );
    if (current && reuseHash(current) !== reuseHash(ref))
      out.push(
        err(
          'publication-version',
          ref.componentId,
          'Published native component version is immutable; increment its explicit Web version before exporting changed content',
        ),
      );
  }
  return out;
}
/** Host verifies generated program bytes itself, then combines only the generated identities. */
export function designReactResolution(
  conversion: DesignReactConversion,
  original: ReactRuntimeResolution,
): ReactRuntimeResolution {
  const generated = [
    ...conversion.primitives.map((p) => p.registration.ref),
    ...conversion.components.map((c) => c.registration.ref),
  ];
  return { ...clone(original), components: [...clone(original.components), ...generated] };
}
export function designReactPublications(conversion: DesignReactConversion): ReactComponentRef[] {
  return conversion.components
    .filter((c) => conversion.publishedComponentIds.includes(c.sourceId))
    .map((c) => clone(c.registration.ref));
}
/** Native publication refs recorded in an accepted receipt's manifest. */
function manifestPublications(manifest: string | undefined): ReactComponentRef[] {
  if (!manifest) return [];
  const parsed: unknown = JSON.parse(manifest);
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('components' in parsed) ||
    !Array.isArray(parsed.components)
  )
    return [];
  const refs: ReactComponentRef[] = [];
  for (const c of parsed.components)
    if (c?.ref?.registryId === 'native-design' && c?.import?.source?.startsWith('./Component_')) {
      validateReactComponentRef(c.ref, '$.accepted.manifest.components');
      refs.push(c.ref);
    }
  return refs;
}
/** Old receipts remain readable; only validated native publication identities are retained. */
export function retainedDesignPublications(settings: DesignWebSettings): ReactComponentRef[] {
  const refs = [
    ...(settings.publications ?? []),
    ...manifestPublications(settings.accepted?.files?.['manifest.json']),
  ];
  const byKey = new Map<string, ReactComponentRef>();
  for (const ref of refs) {
    const key = reactComponentKey(ref),
      old = byKey.get(key);
    if (old && reuseHash(old) !== reuseHash(ref))
      throw new ReactUiError([
        err(
          'publication-version',
          ref.componentId,
          'Conflicting retained immutable native publication identities',
        ),
      ]);
    byKey.set(key, clone(ref));
  }
  return [...byKey.values()];
}
function putGeneratedFile(
  files: Record<string, string>,
  path: string,
  value: string,
  nativeId: string,
) {
  if (Object.keys(files).some((p) => p.toLowerCase() === path.toLowerCase()))
    throw new ReactUiError([
      err(
        'output-path-collision',
        nativeId,
        `Generated output path collision: ${path}; choose a distinct page/component symbol`,
      ),
    ]);
  files[path] = value;
}
function nativeModuleFiles(
  conversion: DesignReactConversion,
  resolution: ReactRuntimeResolution,
): Record<string, string> {
  const files: Record<string, string> = {};
  const primitiveLines = [
    'import {createContext,useContext,type ReactNode} from "react";',
    'export const NativeSlotContext=createContext<Record<string,ReactNode>>({});',
  ];
  for (const p of conversion.primitives) {
    const tag = p.tag,
      source = reactUiExpression(p.sourceId);
    const style =
      tag === 'img'
        ? `{objectFit:${reactUiExpression(p.imageFit === 'fit' ? 'contain' : 'cover')},borderRadius:${p.radius ?? 0}}`
        : ['span', 'p', 'h1', 'h2', 'label', 'a'].includes(tag)
          ? '{color:props.fill,margin:0}'
          : '{backgroundColor:props.fill,boxSizing:"border-box"}';
    primitiveLines.push(
      `export function ${p.registration.name}(props:{className?:string;children?:ReactNode;text?:string;fill?:string;src?:string;alt?:string;onSubmit?:()=>void}) {const slots=useContext(NativeSlotContext);return <${tag} className={props.className} style={${style}}${tag === 'a' ? ` href={${reactUiExpression(p.href)}}` : ''}${tag === 'form' ? ' onSubmit={event=>{event.preventDefault();props.onSubmit?.();}}' : ''}${tag === 'img' ? ' src={props.src} alt={props.alt}' : ''}${tag === 'img' ? ' />; }' : `>{props.text}{Object.hasOwn(slots,${source})?slots[${source}]:props.children}</${tag}>; }`}`,
    );
  }
  files['NativeComponents.tsx'] = primitiveLines.join('\n') + '\n';
  const putDocument = (doc: ReactUiDocument, name: string, nativeId: string) => {
    const out = exportReactUi(doc, resolution, {
      symbol: name,
      cssFile: `${name}.css`,
      optionalCallbacks: true,
    });
    putGeneratedFile(files, `${name}.tsx`, out.files['Screen.tsx'], nativeId);
    putGeneratedFile(files, `${name}.css`, out.files['Screen.css'], nativeId);
  };
  for (const c of conversion.components) {
    const variants = Object.entries(c.documents);
    const imports: string[] = [];
    for (const [v, doc] of variants) {
      const name = safeSymbol(c.sourceId + '-' + v);
      putDocument(doc, name, c.sourceId);
      imports.push(`import {${name},type ${name}Props} from "./${name}";`);
    }
    const first = safeSymbol(c.sourceId + '-' + variants[0][0]);
    const name = c.registration.name;
    const variantType = variants.map(([v]) => reactUiExpression(v)).join('|');
    const slots = Object.values(c.slotTargets);
    const slotType = slots.map((slot) => `${slot.prop}?:ReactNode;`).join('');
    const slotValues = slots
      .map(
        (slot) =>
          `...(${`props.${slot.prop}`}===undefined?{}:{[${reactUiExpression(slot.elementId)}]:props.${slot.prop}})`,
      )
      .join(',');
    const render = (v: string) =>
      `<NativeSlotContext.Provider value={{${slotValues}}}><div className={props.className}><${safeSymbol(c.sourceId + '-' + v)} {...props}/></div></NativeSlotContext.Provider>`;
    putGeneratedFile(
      files,
      `Component_${safeSymbol(c.sourceId)}.tsx`,
      `import type {ReactNode} from "react";import {NativeSlotContext} from "./NativeComponents";\n${imports.join('\n')}\nexport type ${name}Props=${first}Props & {className?:string;${c.hasVariants ? `variant?:${variantType};` : ''}${slotType}};\nexport function ${name}(props:${name}Props){${c.hasVariants ? variants.map(([v]) => `if((props.variant??${reactUiExpression(variants[0][0])})===${reactUiExpression(v)})return ${render(v)};`).join('') + 'return null;' : `return ${render(variants[0][0])};`}}\n`,
      c.sourceId,
    );
  }
  return files;
}
export interface DesignReactBundle {
  mode: 'web' | 'svg';
  /** Exact reviewed selection; undefined means declared pages / whole graphic. */
  rootIds?: string[];
  ownership: 'generated-directory-only';
  fingerprint: string;
  sourceHash: string;
  files: Record<string, string>;
  mappings: DesignReactConversion['mappings'];
  diagnostics: ReactUiDiagnostic[];
  publications: ReactComponentRef[];
}
type BundleOptions = { rootIds?: string[]; mode?: 'web' | 'svg' };
type BundlePage = { frameIds: string[]; frameId: string; symbol: string; path: string };
function exportDesignSvgBundle(
  content: DesignContent,
  options: BundleOptions,
  sourceHash: string,
  resume: DesignContent,
): DesignReactBundle {
  const roots = options.rootIds ?? content.elements.map((e) => e.id);
  const unsupported = designReactGraphicProblems(content, roots);
  if (unsupported.length)
    throw new ReactUiError([
      err(
        'svg-external',
        unsupported[0],
        'React SVG cannot preserve external React interaction; use Web UI mode',
      ),
    ]);
  const svg = exportDesignSvg(content, roots);
  const files = {
    'Graphic.tsx': `export function Graphic() { return <img alt="Design graphic (non-interactive)" src={${reactUiExpression('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg))}} />; }\n`,
    'native.json': canonicalJson(resume),
    'README.md':
      'React SVG auxiliary graphic: text semantics and interaction are lost. Native data retained.\n',
  };
  return {
    mode: 'svg',
    ...(options.rootIds ? { rootIds: clone(options.rootIds) } : {}),
    ownership: 'generated-directory-only',
    fingerprint: reuseHash(files),
    sourceHash,
    files,
    mappings: [],
    diagnostics: [
      {
        ...err('svg-loss', '$', 'Graphic output does not retain HTML semantics or interaction'),
        severity: 'warning',
      },
    ],
    publications: [],
  };
}
function bundlePages(content: DesignContent, rootIds: string[] | undefined): BundlePage[] {
  if (rootIds && (!rootIds.length || new Set(rootIds).size !== rootIds.length))
    throw new ReactUiError([
      err('selection', '$.roots', 'Choose distinct native composition roots'),
    ]);
  return rootIds
    ? [{ frameIds: rootIds, frameId: rootIds[0], symbol: 'DesignComposition', path: '/' }]
    : content.web!.pages.map((page) => ({ ...page, frameIds: [page.frameId] }));
}
/** The composition subtree reachable from one page's roots, with only its used registrations. */
function pageDocument(conversion: DesignReactConversion, page: BundlePage): ReactUiDocument {
  const all = conversion.document.nodes;
  const reachable = (id: string): boolean =>
    page.frameIds.includes(id) ||
    all.some(
      (parent) =>
        Object.values(parent.slots).some((ids) => ids.includes(id)) && reachable(parent.id),
    );
  const doc = clone(
    loadReactUiDocument({
      ...clone(conversion.document),
      roots: page.frameIds,
      nodes: all.filter((n) => reachable(n.id)),
    }),
  );
  const used = new Set(doc.nodes.map((n) => reactComponentKey(n.component)));
  doc.components = doc.components.filter((c) => used.has(reactComponentKey(c.ref)));
  return doc;
}
function siteModule(pages: BundlePage[]): string {
  const pageImports = pages
    .map((p) => `import {${p.symbol},type ${p.symbol}Props} from "./${p.symbol}";`)
    .join('\n');
  return `${pageImports}\nexport type SiteProps = ${pages.map((p) => `${p.symbol}Props`).join(' & ')} & { path:string };\nexport function Site({path,...props}:SiteProps) {${pages.map((p) => `if (path===${reactUiExpression(p.path)}) return <${p.symbol} {...props}/>;`).join('')}return <p>Page not found</p>; }\n`;
}
function webManifest(
  content: DesignContent,
  conversion: DesignReactConversion,
  resolution: ReactRuntimeResolution,
  files: Record<string, string>,
  pages: BundlePage[],
  sourceHash: string,
): string {
  return canonicalJson({
    schemaVersion: 1,
    sourceHash,
    sourceVersion: {
      kind: 'content-addressed-native-draft',
      hash: sourceHash,
      schemaVersion: content.schemaVersion,
      componentVersions: content.components
        .filter((c) => c.web)
        .map((c) => ({ id: c.id, version: c.web!.version })),
    },
    generatedImplementationBundleHash: reuseHash(
      canonicalJson(nativeModuleFiles(conversion, resolution)),
    ),
    generated: Object.fromEntries(
      Object.entries(files)
        .filter(([path]) => /\.(tsx|css)$/.test(path))
        .map(([path, value]) => [path, reuseHash(value)]),
    ),
    environment: content.web!.environment,
    components: [
      ...new Map(
        [
          ...conversion.document.components,
          ...conversion.components.map((c) => c.registration),
          ...conversion.components.flatMap((c) =>
            Object.values(c.documents).flatMap((d) => d.components),
          ),
        ].map((c) => [reactComponentKey(c.ref), c]),
      ).values(),
    ],
    routes: pages,
    ownership: 'generated-directory-only',
    mappings: conversion.mappings,
  });
}
export function exportDesignReact(
  content: DesignContent,
  original: ReactRuntimeResolution,
  options: BundleOptions = {},
): DesignReactBundle {
  const sourceHash = designReactSourceHash(content);
  const resume = clone(content);
  if (resume.web) delete resume.web.accepted;
  if (options.mode === 'svg') return exportDesignSvgBundle(content, options, sourceHash, resume);
  const conversion = convertDesignToReact(content, options.rootIds);
  if (!options.rootIds && !content.web!.pages.length)
    throw new ReactUiError([
      err(
        'page-missing',
        '$.pages',
        'Declare native page frames/routes or choose a selected component/composition export',
      ),
    ]);
  if (conversion.diagnostics.some((d) => d.severity === 'error'))
    throw new ReactUiError(conversion.diagnostics);
  const resolution = designReactResolution(conversion, original);
  resume.web!.publications = [
    ...new Map(
      [...retainedDesignPublications(content.web!), ...designReactPublications(conversion)].map(
        (ref) => [reactComponentKey(ref), ref],
      ),
    ).values(),
  ];
  const files: Record<string, string> = {};
  Object.assign(files, nativeModuleFiles(conversion, resolution));
  const pages = bundlePages(content, options.rootIds);
  for (const page of pages) {
    const out = exportReactUi(pageDocument(conversion, page), resolution, {
      symbol: page.symbol,
      cssFile: `${page.symbol}.css`,
    });
    putGeneratedFile(files, `${page.symbol}.tsx`, out.files['Screen.tsx'], page.frameId);
    putGeneratedFile(files, `${page.symbol}.css`, out.files['Screen.css'], page.frameId);
  }
  files['Site.tsx'] = siteModule(pages);
  files['native.json'] = canonicalJson(resume);
  files['conversion.json'] = canonicalJson({
    schemaVersion: 1,
    sourceHash,
    settingsHash: conversion.settingsHash,
    mappings: conversion.mappings,
    pages,
  });
  files['composition.json'] = canonicalJson(conversion.document);
  files['manifest.json'] = webManifest(content, conversion, resolution, files, pages, sourceHash);
  files['README.md'] =
    'Generated semantic React Web UI. Import the named Component/Page or Site; supply its typed data/callback props and a Host-owned path. Install pinned manifest dependencies and copy pinned CSS/assets through the Host adapter. Original React source is imported, never rewritten. native.json and conversion.json allow resuming native editing. Write this bundle only into a dedicated generated directory; do not overwrite hand-written Host files. Server/router/auth/API remain Host-owned.\n';
  for (const doc of [
    conversion.document,
    ...conversion.components.flatMap((c) => Object.values(c.documents)),
  ])
    prepareReactUiExport(doc, resolution, Object.keys(files));
  return deepFreeze({
    mode: 'web',
    ...(options.rootIds ? { rootIds: clone(options.rootIds) } : {}),
    ownership: 'generated-directory-only',
    fingerprint: reuseHash(files),
    sourceHash,
    files,
    mappings: conversion.mappings,
    diagnostics: conversion.diagnostics,
    publications: designReactPublications(conversion),
  });
}
export function reviewDesignReceiptRegeneration(
  previous: NonNullable<DesignWebSettings['accepted']>,
  next: DesignReactBundle,
) {
  const before =
    previous.fileHashes ??
    Object.fromEntries(
      Object.entries(previous.files ?? {}).map(([path, value]) => [path, reuseHash(value)]),
    );
  const after = Object.fromEntries(
    Object.entries(next.files).map(([path, value]) => [path, reuseHash(value)]),
  );
  return {
    changes: [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .sort()
      .filter((path) => before[path] !== after[path])
      .map((path) => ({
        path,
        before: before[path] ?? null,
        after: after[path] ?? null,
        conflict: false,
      })),
    conflicts: [],
  };
}
export function reviewDesignRegeneration(
  previous: DesignReactBundle,
  next: DesignReactBundle,
  existingFiles: Record<string, string> = { ...previous.files },
) {
  const paths = [...new Set([...Object.keys(previous.files), ...Object.keys(next.files)])].sort();
  const changes = paths
    .filter(
      (path) =>
        previous.files[path] !== next.files[path] || existingFiles[path] !== previous.files[path],
    )
    .map((path) => ({
      path,
      before: previous.files[path] ?? null,
      after: next.files[path] ?? null,
      conflict: existingFiles[path] !== previous.files[path],
    }));
  return deepFreeze({
    from: previous.fingerprint,
    to: next.fingerprint,
    changes,
    conflicts: changes.filter((c) => c.conflict).map((c) => c.path),
    ownership: 'generated-directory-only' as const,
  });
}
/** No disk writes. Host atomically accepts only after checking explicit review and current files. */
export function applyDesignRegeneration(
  previous: DesignReactBundle,
  next: DesignReactBundle,
  existingFiles: Record<string, string>,
  approvedFingerprint: string,
): Record<string, string> {
  const review = reviewDesignRegeneration(previous, next, existingFiles);
  if (approvedFingerprint !== next.fingerprint || review.conflicts.length)
    throw new ReactUiError([
      err(
        'regeneration-conflict',
        review.conflicts.join(',') || '$',
        'Generated files changed since review; keep edits and resolve explicitly',
      ),
    ]);
  const applied = { ...existingFiles };
  for (const path of Object.keys(previous.files))
    if (!Object.hasOwn(next.files, path)) delete applied[path];
  return { ...applied, ...next.files };
}

const equalJson = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null);
/** Three-way merge of one regenerated node; undefined when the user deleted it. */
function mergeRegeneratedNode(
  basis: ReactUiDocument,
  edited: ReactUiDocument,
  node: ReactUiNode,
  conflicts: string[],
): ReactUiNode | undefined {
  const before = basis.nodes.find((n) => n.id === node.id),
    current = edited.nodes.find((n) => n.id === node.id);
  if (!before) return clone(node);
  if (!current) {
    if (!equalJson(before, node)) conflicts.push(node.id + '/deleted');
    return undefined;
  }
  const merged = clone(node);
  for (const key of ['component', 'props', 'bindings', 'layout', 'slots'] as const) {
    if (equalJson(before[key], current[key])) continue;
    if (!equalJson(before[key], node[key]) && !equalJson(current[key], node[key]))
      conflicts.push(node.id + '/' + key);
    else Object.assign(merged, { [key]: clone(current[key]) });
  }
  return merged;
}
function mergeRegeneratedNodes(
  basis: ReactUiDocument,
  edited: ReactUiDocument,
  next: ReactUiDocument,
  conflicts: string[],
): ReactUiNode[] {
  const nodes = next.nodes
    .map((node) => mergeRegeneratedNode(basis, edited, node, conflicts))
    .filter((n): n is ReactUiNode => !!n);
  for (const current of edited.nodes)
    if (!next.nodes.some((n) => n.id === current.id)) {
      const old = basis.nodes.find((n) => n.id === current.id);
      if (!old) nodes.push(clone(current));
      else if (!equalJson(old, current)) conflicts.push(current.id + '/removed');
    }
  return nodes;
}
/** Preserve independently edited page schemas and Host-facing bindings too. */
function mergeRegeneratedRecord(
  key: 'inputs' | 'callbacks' | 'fixture',
  basis: ReactUiDocument,
  edited: ReactUiDocument,
  next: ReactUiDocument,
  conflicts: string[],
): Record<string, unknown> {
  const merged = { ...clone(next[key]) } as Record<string, unknown>;
  for (const name of new Set([...Object.keys(basis[key]), ...Object.keys(edited[key])])) {
    if (equalJson(basis[key][name], edited[key][name])) continue;
    if (
      !equalJson(basis[key][name], next[key][name]) &&
      !equalJson(edited[key][name], next[key][name])
    )
      conflicts.push(key + '/' + name);
    else if (Object.hasOwn(edited[key], name)) merged[name] = clone(edited[key][name]);
    else delete merged[name];
  }
  return merged;
}
/** Three-way merge of mapped React UI edits. Stable node IDs retain independent user changes. */
export function reviewDesignReactDocumentRegeneration(
  basis: ReactUiDocument,
  edited: ReactUiDocument,
  next: ReactUiDocument,
) {
  const conflicts: string[] = [];
  const equal = equalJson;
  const nodes = mergeRegeneratedNodes(basis, edited, next, conflicts);
  const output = {
    ...clone(next),
    nodes,
    roots: clone(equal(basis.roots, edited.roots) ? next.roots : edited.roots).filter((id) =>
      nodes.some((n) => n.id === id),
    ),
  };
  if (
    !equal(basis.roots, edited.roots) &&
    !equal(basis.roots, next.roots) &&
    !equal(edited.roots, next.roots)
  )
    conflicts.push('roots');
  for (const key of ['inputs', 'callbacks', 'fixture'] as const)
    Object.assign(output, { [key]: mergeRegeneratedRecord(key, basis, edited, next, conflicts) });
  for (const key of ['environment', 'breakpoints'] as const) {
    if (!equal(basis[key], edited[key])) {
      if (!equal(basis[key], next[key]) && !equal(edited[key], next[key])) conflicts.push(key);
      else Object.assign(output, { [key]: clone(edited[key]) });
    }
  }
  // User-added originals and explicit revision adoptions keep their retained registrations.
  const refs = new Map(output.nodes.map((n) => [reactComponentKey(n.component), n.component]));
  output.components = [...refs.values()].flatMap((ref) => {
    const registration = [...next.components, ...edited.components].find((c) => equal(c.ref, ref));
    if (!registration) {
      conflicts.push('components/' + ref.componentId);
      return [];
    }
    return [clone(registration)];
  });
  const inspection = inspectReactUiDocument(output);
  if (inspection.diagnostics.length) conflicts.push(...inspection.diagnostics.map((d) => d.path));
  return deepFreeze({
    document: output,
    conflicts,
    from: reuseHash(basis),
    target: reuseHash(edited),
    to: reuseHash(next),
  });
}
