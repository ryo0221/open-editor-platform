import { clone, canonicalJson, deepFreeze } from '@editor-platform/artifact-core';
import { reuseHash } from '@editor-platform/reuse-core';
import { descendantIds } from '@editor-platform/editor-core';
import {
  isDesign,
  appearance,
  exportDesignSvg,
  type DesignContent,
  type DesignElement,
  type DesignComponent,
} from '@editor-platform/design/model';
import {
  designWebTagsFor,
  type DesignWebTag,
  type DesignWebSettings,
} from '@editor-platform/design/web-contract';
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
  type ReactUiLayout,
  type ReactUiStyle,
  type RegisteredReactComponent,
  type ReactRuntimeResolution,
  type ReactUiDiagnostic,
  type JsonValue,
  type ReactFieldSchema,
  type ReactComponentRef,
  validateReactComponentRef,
} from '@editor-platform/react-ui-core';
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
const err = (code: string, id: string, message: string): ReactUiDiagnostic => ({
  code,
  severity: 'error',
  path: id,
  message,
  recovery:
    'Correct the addressed native element or explicit Web settings; retain the native source and prepare again.',
});
const safeSymbol = (id: string) => 'N' + reuseHash(id).slice(0, 16);
const stringField: ReactFieldSchema = { schema: { type: 'string' }, required: false };
const primitiveFields = (tag: DesignWebTag): RegisteredReactComponent['props'] =>
  tag === 'img'
    ? {
        src: { schema: { type: 'string', maxLength: 4 * 1024 * 1024 }, required: false },
        alt: stringField,
      }
    : { text: stringField, fill: stringField };
const lit = (value: string | number) => ({ kind: 'literal' as const, value });
/** Check known native HTML across component documents and injected public slots. Original internals stay opaque. */
function inspectNativeHtml(conversion: DesignReactConversion): ReactUiDiagnostic[] {
  const problems: ReactUiDiagnostic[] = [];
  type Child = { document: ReactUiDocument; id: string };
  const walk = (
    document: ReactUiDocument,
    id: string,
    ancestors: string[],
    context: Record<string, Child[]>,
    active: Set<string>,
  ) => {
    const node = document.nodes.find((n) => n.id === id);
    if (!node) return;
    const primitive = conversion.primitives.find(
      (p) => reactComponentKey(p.registration.ref) === reactComponentKey(node.component),
    );
    const component = conversion.components.find(
      (c) => reactComponentKey(c.registration.ref) === reactComponentKey(node.component),
    );
    const tag = primitive?.tag ?? (component ? 'div' : undefined);
    if (
      tag &&
      ((['form', 'a', 'label'].includes(tag) && ancestors.includes(tag)) ||
        (ancestors.includes('a') && tag === 'form') ||
        (ancestors.some((a) => ['p', 'span', 'h1', 'h2'].includes(a)) &&
          !['span', 'img', 'a', 'label'].includes(tag)))
    )
      problems.push(
        err('html-content', id, `HTML ${tag} is not allowed inside ${ancestors.join(' / ')}`),
      );
    const next = tag ? [...ancestors, tag] : ancestors;
    if (component) {
      if (active.has(component.sourceId)) return;
      const scope = { ...context };
      for (const [slotId, target] of Object.entries(component.slotTargets))
        if (node.slots[slotId]?.length)
          scope[target.elementId] = node.slots[slotId].map((id) => ({ document, id }));
      for (const inner of Object.values(component.documents))
        for (const root of inner.roots)
          walk(inner, root, next, scope, new Set([...active, component.sourceId]));
    } else {
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
function validEmbeddedImage(src: string | undefined): boolean {
  const match = src?.match(
    /^data:image\/(png|jpeg|webp);base64,((?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?)$/,
  );
  if (!match) return false;
  try {
    const bytes = atob(match[2]);
    if (btoa(bytes) !== match[2]) return false;
    const signature = (offset: number, values: number[]) =>
      values.every((v, i) => bytes.charCodeAt(offset + i) === v);
    return match[1] === 'png'
      ? bytes.length >= 45 &&
          signature(0, [137, 80, 78, 71, 13, 10, 26, 10]) &&
          signature(8, [0, 0, 0, 13]) &&
          bytes.slice(12, 16) === 'IHDR'
      : match[1] === 'jpeg'
        ? signature(0, [255, 216, 255])
        : bytes.length >= 12 && bytes.slice(0, 4) === 'RIFF' && bytes.slice(8, 12) === 'WEBP';
  } catch {
    return false;
  }
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
export function convertDesignToReact(
  content: DesignContent,
  rootIds?: string[],
): DesignReactConversion {
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
  const diagnostics: ReactUiDiagnostic[] = [];
  const primitives: NativePrimitive[] = [];
  const components: NativeComponentProgram[] = [];
  const mappings: DesignReactConversion['mappings'] = [];
  const sourceHash = designReactSourceHash(content);
  const routes = new Map(settings.pages.map((p) => [p.frameId, p.path]));
  const symbols = settings.pages.map((p) => p.symbol);
  if (Object.hasOwn(settings.inputs, 'path') || Object.hasOwn(settings.callbacks, 'path'))
    diagnostics.push(
      err(
        'reserved-input',
        '$.web',
        'The Site router reserves path; rename the page input or callback',
      ),
    );
  if (
    new Set(symbols).size !== symbols.length ||
    new Set(settings.pages.map((p) => p.path)).size !== settings.pages.length
  )
    diagnostics.push(
      err('route-duplicate', '$.web.pages', 'Page symbols and route paths must be unique'),
    );
  for (const p of settings.pages) {
    if (!/^\/(?:[A-Za-z0-9_-]+\/?)*$/.test(p.path) || !/^[A-Z][A-Za-z0-9_]{0,79}$/.test(p.symbol))
      diagnostics.push(
        err(
          'route-invalid',
          p.frameId,
          'Use a safe route path and explicit PascalCase page symbol',
        ),
      );
    if (!content.elements.some((e) => e.id === p.frameId && e.type === 'frame'))
      diagnostics.push(
        err('page-missing', p.frameId, 'Route must address an existing native Frame'),
      );
    else if (content.elements.find((e) => e.id === p.frameId)!.hidden)
      diagnostics.push(
        err(
          'page-hidden',
          p.frameId,
          'A hidden Frame cannot be a routed page; show it or remove its route',
        ),
      );
    if (
      ['Site', 'NativeComponents'].some((symbol) => symbol.toLowerCase() === p.symbol.toLowerCase())
    )
      diagnostics.push(
        err(
          'output-path-collision',
          p.frameId,
          `Page symbol ${p.symbol} is reserved for generated support modules`,
        ),
      );
  }
  const active = new Set<string>();
  const allRegistrations = () => [
    ...settings.registrations,
    ...primitives.map((p) => p.registration),
    ...components.map((c) => c.registration),
  ];
  const makeRegistration = (
    componentId: string,
    symbol: string,
    props: RegisteredReactComponent['props'],
    events: RegisteredReactComponent['events'],
    slots: RegisteredReactComponent['slots'],
    implementation: unknown,
    version = '1.0.0',
    source = './NativeComponents',
    sampleProps: RegisteredReactComponent['sampleProps'] = {},
  ) =>
    sealReactComponent({
      schemaVersion: 1,
      ref: {
        registryId: 'native-design',
        componentId,
        version,
        implementationHash: reuseHash(implementation),
      },
      name: symbol,
      import: { source, export: 'named', name: symbol },
      props,
      events,
      slots,
      controlledInputs: [],
      layout: 'className',
      requires: [],
      sampleProps,
    });
  const layoutFor = (
    e: DesignElement,
    parent: DesignElement | undefined,
    root: boolean,
  ): ReactUiLayout => {
    const base: ReactUiStyle = {
      position: lit('relative'),
      width: lit(e.bounds.width),
      height: lit(e.bounds.height),
    };
    if (root) {
      base.width = lit('100%');
      base.maxWidth = lit(e.bounds.width);
    }
    // Public React slots own their flow. Native global offsets are not DOM addresses.
    const slotParent =
      parent && (parent.type === 'react' || (parent.type === 'instance' && parent.webSlots));
    if (parent && !slotParent && (!parent.layout || parent.layout.direction === 'absolute')) {
      base.position = lit('absolute');
      base.left = lit(e.bounds.x - parent.bounds.x);
      base.top = lit(e.bounds.y - parent.bounds.y);
      if (e.constraints?.horizontal === 'stretch') {
        base.width = lit(`${(e.bounds.width / parent.bounds.width) * 100}%`);
        base.left = lit(`${((e.bounds.x - parent.bounds.x) / parent.bounds.width) * 100}%`);
      } else if (e.constraints && e.constraints.horizontal !== 'left')
        diagnostics.push(
          err(
            'constraint-unsupported',
            e.id,
            'Map right/center/scale constraints to an explicit responsive layout before Web export',
          ),
        );
      if (e.constraints && e.constraints.vertical !== 'top')
        diagnostics.push(
          err('constraint-unsupported', e.id, 'Vertical constraints need an explicit Web layout'),
        );
    }
    if (e.typography?.fontSize) base.fontSize = lit(e.typography.fontSize);
    if (e.typography?.fontFamily) base.fontFamily = lit(e.typography.fontFamily);
    if (e.radius) base.borderRadius = lit(e.radius);
    if (e.type === 'text') base.fontWeight = lit(e.typography?.bold ? 700 : 400);
    if (e.type === 'text' && !e.typography?.fontSize) base.fontSize = lit(28);
    if (e.sizing === 'hug') {
      base.width = lit('auto');
      base.height = lit('auto');
    }
    if (e.sizing === 'fill') base.width = lit('100%');
    if (e.layout && e.layout.direction !== 'absolute')
      Object.assign(base, {
        display: lit('flex'),
        flexDirection: lit(e.layout.direction),
        gap: lit(e.layout.gap),
        padding: lit(e.layout.padding),
        alignItems: lit(e.layout.align),
        ...(e.layout.sizing === 'hug' ? { height: lit('auto') } : {}),
      });
    return {
      base: { ...base, ...e.web?.layout?.base },
      breakpoints: clone(e.web?.layout?.breakpoints ?? {}),
    };
  };
  const build = (
    elements: DesignElement[],
    roots: string[],
    inputs = settings.inputs,
    fixture = settings.fixture,
    callbacks = settings.callbacks,
  ): ReactUiDocument => {
    const nodes: ReactUiNode[] = [];
    const byId = new Map(elements.map((e) => [e.id, e]));
    const seen = new Set<string>();
    const visit = (id: string, root = false) => {
      if (seen.has(id)) {
        diagnostics.push(
          err('node-ownership', id, 'Native node is owned by more than one parent or slot'),
        );
        return;
      }
      const raw = byId.get(id);
      const e = raw
        ? { ...raw, ...(raw.type !== 'instance' ? appearance(content, raw) : {}), type: raw.type }
        : undefined;
      if (!e) {
        diagnostics.push(err('node-missing', id, 'Native child/slot target is missing'));
        return;
      }
      seen.add(id);
      if (e.hidden) return;
      if (e.rotation || e.flipX || e.flipY || (e.opacity !== undefined && e.opacity !== 1))
        diagnostics.push(
          err(
            'visual-unsupported',
            e.id,
            'Rotation/reflection/opacity need explicit supported Web styling or graphic output',
          ),
        );
      let registration: RegisteredReactComponent | undefined;
      let props: Record<string, JsonValue> = {};
      let bindings: ReactUiNode['bindings'] = {};
      let slots: ReactUiNode['slots'] = {};
      if (e.type === 'react' && e.react) {
        registration = settings.registrations.find(
          (c) => reactComponentKey(c.ref) === reactComponentKey(e.react!.component),
        );
        if (
          !registration ||
          reuseHash(registration.ref) !== reuseHash(e.react.component) ||
          reuseHash(registration.import) !== reuseHash(e.react.import)
        )
          diagnostics.push(
            err(
              'component-missing',
              e.id,
              'Exact external registration/import is unavailable; its native reference is retained',
            ),
          );
        props = clone(e.react.props);
        bindings = clone(e.react.bindings);
        slots = clone(e.react.slots);
        const actualChildren = elements
          .filter((c) => c.parentId === id && !c.hidden)
          .map((c) => c.id);
        const assigned = Object.values(slots).flat();
        if (
          assigned.some((child) => byId.get(child)?.parentId !== id) ||
          actualChildren.some((child) => !assigned.includes(child))
        )
          diagnostics.push(
            err(
              'slot-ownership',
              id,
              'External children must belong to this native parent and exactly one declared slot',
            ),
          );
      } else if (e.type === 'instance') {
        const c = content.components.find((c) => c.id === e.componentId);
        if (!c?.web)
          diagnostics.push(
            err(
              'component-semantics',
              id,
              'Publish explicit semantics/public inputs for this native component',
            ),
          );
        else {
          registration = component(c);
          props = {
            ...Object.fromEntries(
              Object.entries(c.web.props)
                .filter(([, p]) => Object.hasOwn(p, 'default'))
                .map(([k, p]) => [k, p.default!]),
            ),
            ...clone(e.webProps ?? {}),
          };
          // Instance overrides are kept as a distinct generated variant of the immutable definition.
          if (e.overrides && Object.keys(e.overrides).length) {
            const overridden = {
              ...clone(c),
              id: `${c.id}-${reuseHash(e.overrides).slice(0, 10)}`,
              elements: c.elements?.map((part) => ({
                ...part,
                ...clone(e.overrides?.[part.id] ?? {}),
                id: part.id,
              })),
              web: { ...clone(c.web), symbol: safeSymbol(`${id}-override`) },
            };
            registration = component(overridden);
          }
          bindings = clone(e.web?.bindings ?? {});
          slots = clone(e.webSlots ?? {});
          const owned = Object.values(slots).flat();
          if (
            owned.some((child) => byId.get(child)?.parentId !== e.id) ||
            elements.some(
              (child) => child.parentId === e.id && !child.hidden && !owned.includes(child.id),
            )
          )
            diagnostics.push(
              err(
                'slot-ownership',
                e.id,
                'Native component children must belong to this instance and a declared public slot',
              ),
            );
        }
      } else {
        const tag = e.web?.tag;
        if (!tag)
          diagnostics.push(
            err(
              'semantics-missing',
              e.id,
              'Choose an explicit HTML role; layer names are not interpreted',
            ),
          );
        else {
          if (!designWebTagsFor(e.type).includes(tag))
            diagnostics.push(
              err(
                'image-semantics',
                e.id,
                'Native image requires img semantics to retain its image content',
              ),
            );
          if (
            e.typography?.italic ||
            e.typography?.underline ||
            e.typography?.strike ||
            e.typography?.letterSpacing ||
            e.typography?.lineHeight ||
            e.typography?.padding ||
            e.typography?.list ||
            e.typography?.overflow ||
            (e.typography?.verticalAlign && e.typography.verticalAlign !== 'top') ||
            (e.crop && (e.crop.x !== 0 || e.crop.y !== 0 || e.crop.scale !== 1)) ||
            (e.typography?.align && e.typography.align !== 'left') ||
            e.runs?.length ||
            e.vector ||
            e.strokeWidth ||
            e.rotation ||
            (e.opacity !== undefined && e.opacity !== 1) ||
            (e.shape && e.shape !== 'rectangle')
          )
            diagnostics.push(
              err(
                'visual-unsupported',
                e.id,
                'Rich runs/strokes/rotation/non-rectangular shapes need the separate React SVG mode',
              ),
            );
          if (tag === 'img' && (!e.alt || !validEmbeddedImage(e.src)))
            diagnostics.push(
              err(
                'asset-invalid',
                e.id,
                'Semantic image needs alt text and a retained PNG/JPEG/WebP asset',
              ),
            );
          const href = e.web?.linkPageId ? routes.get(e.web.linkPageId) : undefined;
          if (tag === 'a' && !href)
            diagnostics.push(
              err('link-missing', e.id, 'Select a retained native page as link target'),
            );
          const primitiveId = `element-${e.id}`,
            symbol = safeSymbol(primitiveId);
          registration = primitives.find(
            (p) => p.registration.ref.componentId === primitiveId,
          )?.registration;
          if (!registration) {
            registration = makeRegistration(
              primitiveId,
              symbol,
              primitiveFields(tag),
              tag === 'form' ? { onSubmit: { parameters: [], returns: 'void' } } : {},
              {},
              { tag, href: href ?? null, sourceId: e.id },
            );
            primitives.push({
              registration,
              tag,
              sourceId: e.id,
              ...(href ? { href } : {}),
              ...(tag === 'img' ? { imageFit: e.imageFit ?? 'fill', radius: e.radius ?? 0 } : {}),
            });
          }
          props = tag === 'img' ? { src: e.src!, alt: e.alt! } : { text: e.text, fill: e.fill };
          bindings = clone(e.web?.bindings ?? {});
          for (const k of Object.keys(bindings)) delete props[k];
          slots =
            tag === 'img'
              ? {}
              : { body: elements.filter((c) => c.parentId === id && !c.hidden).map((c) => c.id) };
        }
      }
      const ref = registration?.ref ?? e.react?.component;
      if (!ref) return;
      for (const key of Object.keys(bindings)) delete props[key];
      nodes.push({
        id: e.id,
        component: ref,
        props,
        bindings,
        slots,
        layout: layoutFor(e, byId.get(e.parentId ?? ''), root),
      });
      mappings.push({
        nativeId: e.id,
        nodeId: e.id,
        symbol: registration?.import.name ?? 'unresolved',
        sourceHash: reuseHash(e),
      });
      Object.values(slots)
        .flat()
        .forEach((child) => visit(child));
    };
    roots.forEach((id) => visit(id, true));
    return {
      schemaVersion: 1,
      domain: 'react-ui',
      environment: clone(settings.environment),
      components: [],
      inputs: clone(inputs),
      callbacks: clone(callbacks),
      fixture: clone(fixture),
      breakpoints: clone(settings.breakpoints),
      roots: roots.filter((id) => nodes.some((n) => n.id === id)),
      nodes,
    };
  };
  const component = (c: DesignComponent): RegisteredReactComponent | undefined => {
    const existing = components.find((p) => p.sourceId === c.id);
    if (existing) return existing.registration;
    if (active.has(c.id)) {
      diagnostics.push(
        err('component-cycle', c.id, 'Recursive native component cannot be exported'),
      );
      return;
    }
    if (!c.web || !c.elements?.length) {
      diagnostics.push(
        err(
          'component-subset',
          c.id,
          'Publish a compound native component with explicit semantics',
        ),
      );
      return;
    }
    active.add(c.id);
    if (Object.keys(c.web.variants).length && Object.hasOwn(c.web.props, 'variant')) {
      diagnostics.push(
        err(
          'reserved-input',
          c.id,
          'Named variants reserve the public input variant; rename that input',
        ),
      );
      active.delete(c.id);
      return;
    }
    const inputs = Object.fromEntries(
      Object.entries(c.web.props).map(([k, p]) => [
        k,
        {
          schema: p.schema,
          required: p.required,
          ...(Object.hasOwn(p, 'default') ? { default: p.default } : {}),
        },
      ]),
    );
    const fixture = {
      ...clone(c.web.sampleProps ?? {}),
      ...Object.fromEntries(
        Object.entries(c.web.props)
          .filter(([, p]) => Object.hasOwn(p, 'default'))
          .map(([k, p]) => [k, p.default!]),
      ),
    };
    for (const [key, p] of Object.entries(c.web.props)) {
      const target = c.elements.find((e) => e.id === p.target.elementId);
      if (!target)
        diagnostics.push(
          err('public-target', c.id, `Public input ${key} targets a missing native part`),
        );
      else if (
        target.type !== 'react' &&
        target.type !== 'instance' &&
        target.web?.tag &&
        !Object.hasOwn(primitiveFields(target.web.tag), p.target.field)
      )
        diagnostics.push(
          err(
            'public-target',
            `${c.id}/${target.id}`,
            `Public input ${key} targets ${target.web.tag}.${p.target.field}, which is not rendered`,
          ),
        );
    }
    const documents: Record<string, ReactUiDocument> = {};
    const variants = Object.keys(c.web.variants).length ? c.web.variants : { default: {} };
    for (const [variant, patches] of Object.entries(variants)) {
      for (const [id, patch] of Object.entries(patches)) {
        const target = c.elements.find((e) => e.id === id);
        if (!target)
          diagnostics.push(
            err('variant-target', c.id, `Variant ${variant} targets missing part ${id}`),
          );
        else if (
          Object.keys(patch).length &&
          (target.type === 'react' ||
            target.type === 'instance' ||
            !target.web?.tag ||
            Object.keys(patch).some(
              (field) => !Object.hasOwn(primitiveFields(target.web!.tag!), field),
            ))
        )
          diagnostics.push(
            err(
              'variant-target',
              `${c.id}/${id}`,
              `Variant ${variant} patches fields that this part does not render`,
            ),
          );
      }
      const elements = c.elements.map((e) => {
        const next = { ...clone(e), ...clone(patches[e.id] ?? {}) };
        const bindings = { ...next.web?.bindings };
        for (const [key, p] of Object.entries(c.web!.props))
          if (p.target.elementId === e.id)
            bindings[p.target.field] = { kind: 'data', input: key, path: [] };
        if (next.react) {
          const react = clone(next.react);
          for (const [key, p] of Object.entries(c.web!.props))
            if (p.target.elementId === e.id) {
              react.bindings[p.target.field] = { kind: 'data', input: key, path: [] };
              delete react.props[p.target.field];
            }
          next.react = react;
        } else next.web = { ...next.web, bindings };
        return {
          ...next,
          id: c.id + '--' + next.id,
          ...(next.parentId ? { parentId: c.id + '--' + next.parentId } : {}),
          ...(next.react
            ? {
                react: {
                  ...next.react,
                  slots: Object.fromEntries(
                    Object.entries(next.react.slots).map(([slot, ids]) => [
                      slot,
                      ids.map((id) => c.id + '--' + id),
                    ]),
                  ),
                },
              }
            : {}),
          ...(next.webSlots
            ? {
                webSlots: Object.fromEntries(
                  Object.entries(next.webSlots).map(([slot, ids]) => [
                    slot,
                    ids.map((id) => c.id + '--' + id),
                  ]),
                ),
              }
            : {}),
        };
      });
      documents[variant] = build(
        elements,
        elements.filter((e) => !e.parentId && !e.hidden).map((e) => e.id),
        inputs,
        fixture,
        c.web.callbacks ?? {},
      );
    }
    const symbol = c.web.symbol;
    const props = {
      ...inputs,
      ...(Object.keys(c.web.variants).length
        ? {
            variant: {
              schema: { type: 'enum' as const, values: Object.keys(variants) },
              required: false,
              default: Object.keys(variants)[0],
            },
          }
        : {}),
    };
    const registration = makeRegistration(
      c.id,
      symbol,
      props,
      c.web.callbacks ?? {},
      Object.fromEntries(
        Object.entries(c.web.slots ?? {}).map(([key, { elementId: _id, ...slot }]) => [key, slot]),
      ),
      { source: c, documents },
      c.web.version,
      `./Component_${safeSymbol(c.id)}`,
      fixture,
    );
    const slotTargets = Object.fromEntries(
      Object.entries(c.web.slots ?? {}).map(([key, slot]) => [
        key,
        { elementId: c.id + '--' + slot.elementId, prop: slot.prop },
      ]),
    );
    for (const [key, slot] of Object.entries(c.web.slots ?? {})) {
      const target = c.elements.find((e) => e.id === slot.elementId);
      if (!target)
        diagnostics.push(
          err('slot-target', c.id, 'Published native slot ' + key + ' targets a missing part'),
        );
      else if (
        target.type === 'react' ||
        target.type === 'instance' ||
        !target.web?.tag ||
        target.web.tag === 'img' ||
        Object.values(documents).some(
          (doc) => !doc.nodes.some((node) => node.id === c.id + '--' + target.id),
        )
      )
        diagnostics.push(
          err(
            'slot-target',
            `${c.id}/${target.id}`,
            `Native public slot ${key} requires a visible generated non-image HTML part; original React, nested instances and images cannot consume its context`,
          ),
        );
    }
    const published = sealReactComponent({
      ...registration,
      ref: {
        registryId: registration.ref.registryId,
        componentId: registration.ref.componentId,
        version: registration.ref.version,
        implementationHash: registration.ref.implementationHash,
      },
      controlledInputs: clone(c.web.controlledInputs ?? []),
    });
    components.push({
      registration: published,
      hasVariants: Object.keys(c.web.variants).length > 0,
      documents,
      sourceId: c.id,
      slotTargets,
    });
    active.delete(c.id);
    return published;
  };
  for (const c of content.components.filter((c) => c.web)) component(c);
  const roots = rootIds ?? settings.pages.map((p) => p.frameId);
  if (!roots.length)
    diagnostics.push(
      err(
        'page-required',
        '$.web.pages',
        'Declare a page or selected composition root before Web export',
      ),
    );
  const document = build(content.elements, roots);
  // Native containers explicitly accept the generated + retained child identities.
  const accepted = [
    ...new Map(
      allRegistrations()
        .map((c) => ({ registryId: c.ref.registryId, componentId: c.ref.componentId }))
        .map((kind) => [canonicalJson(kind), kind]),
    ).values(),
  ];
  for (const p of primitives) {
    if (p.tag !== 'img')
      p.registration = sealReactComponent({
        ...p.registration,
        ref: {
          registryId: p.registration.ref.registryId,
          componentId: p.registration.ref.componentId,
          version: p.registration.ref.version,
          implementationHash: p.registration.ref.implementationHash,
        },
        slots: { body: { prop: 'children', minimum: 0, maximum: 2000, accepts: accepted } },
      });
  }
  const finalize = (doc: ReactUiDocument) => {
    const registrations = allRegistrations();
    doc.nodes = doc.nodes.map((n) => ({
      ...n,
      component:
        registrations.find((c) => reactComponentKey(c.ref) === reactComponentKey(n.component))
          ?.ref ?? n.component,
    }));
    const used = new Set(doc.nodes.map((n) => reactComponentKey(n.component)));
    doc.components = registrations.filter((c) => used.has(reactComponentKey(c.ref)));
    // A skipped node caused by a primary conversion error creates dangling slot references.
    // Report the actionable native error first; successful conversions still undergo every check.
    if (
      diagnostics.some((diagnostic) =>
        [
          'component-semantics',
          'component-subset',
          'semantics-missing',
          'component-missing',
          'node-missing',
          'component-cycle',
        ].includes(diagnostic.code),
      )
    )
      return doc;
    const inspection = inspectReactUiDocument(doc);
    diagnostics.push(...inspection.diagnostics);
    if (inspection.document) return clone(inspection.document);
    return doc;
  };
  for (const c of components)
    for (const [v, doc] of Object.entries(c.documents)) c.documents[v] = finalize(doc);
  const final = finalize(document);
  const result: DesignReactConversion = {
    schemaVersion: 1,
    sourceHash,
    settingsHash: reuseHash({ ...settings, accepted: null, publications: null }),
    document: final,
    primitives,
    components,
    publishedComponentIds: content.components.filter((c) => c.web).map((c) => c.id),
    mappings,
    diagnostics,
  };
  diagnostics.push(...inspectNativeHtml(result));
  if (!diagnostics.length) {
    const declared: ReactRuntimeResolution = {
      environment: settings.environment.ref,
      components: allRegistrations().map((c) => c.ref),
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
    const componentSources = components.map((component) => {
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
    });
    primitives.forEach((p, i) => (p.registration = reseal(p.registration, primitiveSources[i])));
    components.forEach((c, i) => (c.registration = reseal(c.registration, componentSources[i])));
    const refs = allRegistrations();
    for (const doc of [result.document, ...components.flatMap((c) => Object.values(c.documents))]) {
      doc.components = doc.components.map(
        (c) => refs.find((r) => reactComponentKey(r.ref) === reactComponentKey(c.ref))!,
      );
      doc.nodes = doc.nodes.map((n) => ({
        ...n,
        component:
          refs.find((r) => reactComponentKey(r.ref) === reactComponentKey(n.component))?.ref ??
          n.component,
      }));
    }
    for (const ref of retainedDesignPublications(settings)) {
      const current = designReactPublications(result).find(
        (c) => reactComponentKey(c) === reactComponentKey(ref),
      );
      if (current && reuseHash(current) !== reuseHash(ref))
        diagnostics.push(
          err(
            'publication-version',
            ref.componentId,
            'Published native component version is immutable; increment its explicit Web version before exporting changed content',
          ),
        );
    }
  }
  return deepFreeze(result);
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
/** Old receipts remain readable; only validated native publication identities are retained. */
export function retainedDesignPublications(settings: DesignWebSettings): ReactComponentRef[] {
  const refs = [...(settings.publications ?? [])];
  const manifest = settings.accepted?.files?.['manifest.json'];
  if (manifest) {
    const parsed: unknown = JSON.parse(manifest);
    if (
      parsed &&
      typeof parsed === 'object' &&
      'components' in parsed &&
      Array.isArray(parsed.components)
    ) {
      for (const c of parsed.components)
        if (
          c?.ref?.registryId === 'native-design' &&
          c?.import?.source?.startsWith('./Component_')
        ) {
          validateReactComponentRef(c.ref, '$.accepted.manifest.components');
          refs.push(c.ref);
        }
    }
  }
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
export function exportDesignReact(
  content: DesignContent,
  original: ReactRuntimeResolution,
  options: { rootIds?: string[]; mode?: 'web' | 'svg' } = {},
): DesignReactBundle {
  const sourceHash = designReactSourceHash(content);
  const resume = clone(content);
  if (resume.web) delete resume.web.accepted;
  if (options.mode === 'svg') {
    const unsupported = designReactGraphicProblems(
      content,
      options.rootIds ?? content.elements.map((e) => e.id),
    );
    if (unsupported.length)
      throw new ReactUiError([
        err(
          'svg-external',
          unsupported[0],
          'React SVG cannot preserve external React interaction; use Web UI mode',
        ),
      ]);
    const svg = exportDesignSvg(content, options.rootIds ?? content.elements.map((e) => e.id));
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
  const putDocument = (doc: ReactUiDocument, name: string, nativeId: string) => {
    const out = exportReactUi(doc, resolution, { symbol: name, cssFile: `${name}.css` });
    putGeneratedFile(files, `${name}.tsx`, out.files['Screen.tsx'], nativeId);
    putGeneratedFile(files, `${name}.css`, out.files['Screen.css'], nativeId);
  };
  if (
    options.rootIds &&
    (!options.rootIds.length || new Set(options.rootIds).size !== options.rootIds.length)
  )
    throw new ReactUiError([
      err('selection', '$.roots', 'Choose distinct native composition roots'),
    ]);
  const pages = options.rootIds
    ? [
        {
          frameIds: options.rootIds,
          frameId: options.rootIds[0],
          symbol: 'DesignComposition',
          path: '/',
        },
      ]
    : content.web!.pages.map((page) => ({ ...page, frameIds: [page.frameId] }));
  for (const page of pages) {
    const doc = clone(
      loadReactUiDocument({
        ...clone(conversion.document),
        roots: page.frameIds,
        nodes: conversion.document.nodes.filter((n) => {
          const visit = (id: string): boolean =>
            page.frameIds.includes(id) ||
            conversion.document.nodes.some(
              (parent) =>
                Object.values(parent.slots).some((ids) => ids.includes(id)) && visit(parent.id),
            );
          return visit(n.id);
        }),
      }),
    );
    const used = new Set(doc.nodes.map((n) => reactComponentKey(n.component)));
    doc.components = doc.components.filter((c) => used.has(reactComponentKey(c.ref)));
    putDocument(doc, page.symbol, page.frameId);
  }
  const pageImports = pages
    .map((p) => `import {${p.symbol},type ${p.symbol}Props} from "./${p.symbol}";`)
    .join('\n');
  files['Site.tsx'] =
    `${pageImports}\nexport type SiteProps = ${pages.map((p) => `${p.symbol}Props`).join(' & ')} & { path:string };\nexport function Site({path,...props}:SiteProps) {${pages.map((p) => `if (path===${reactUiExpression(p.path)}) return <${p.symbol} {...props}/>;`).join('')}return <p>Page not found</p>; }\n`;
  files['native.json'] = canonicalJson(resume);
  files['conversion.json'] = canonicalJson({
    schemaVersion: 1,
    sourceHash,
    settingsHash: conversion.settingsHash,
    mappings: conversion.mappings,
    pages,
  });
  files['composition.json'] = canonicalJson(conversion.document);
  files['manifest.json'] = canonicalJson({
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

/** Three-way merge of mapped React UI edits. Stable node IDs retain independent user changes. */
export function reviewDesignReactDocumentRegeneration(
  basis: ReactUiDocument,
  edited: ReactUiDocument,
  next: ReactUiDocument,
) {
  const conflicts: string[] = [];
  const equal = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null);
  const nodes = next.nodes
    .map((node) => {
      const before = basis.nodes.find((n) => n.id === node.id),
        current = edited.nodes.find((n) => n.id === node.id);
      if (!before) return clone(node);
      if (!current) {
        if (!equal(before, node)) conflicts.push(node.id + '/deleted');
        return undefined;
      }
      const merged = clone(node);
      for (const key of ['component', 'props', 'bindings', 'layout', 'slots'] as const) {
        if (equal(before[key], current[key])) continue;
        if (!equal(before[key], node[key]) && !equal(current[key], node[key]))
          conflicts.push(node.id + '/' + key);
        else Object.assign(merged, { [key]: clone(current[key]) });
      }
      return merged;
    })
    .filter((n): n is ReactUiNode => !!n);
  for (const current of edited.nodes)
    if (!next.nodes.some((n) => n.id === current.id)) {
      const old = basis.nodes.find((n) => n.id === current.id);
      if (old) {
        if (!equal(old, current)) conflicts.push(current.id + '/removed');
      } else nodes.push(clone(current));
    }
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
  // Preserve independently edited page schemas and Host-facing bindings too.
  for (const key of ['inputs', 'callbacks', 'fixture'] as const) {
    const merged = { ...clone(next[key]) } as Record<string, unknown>;
    for (const name of new Set([...Object.keys(basis[key]), ...Object.keys(edited[key])])) {
      if (equal(basis[key][name], edited[key][name])) continue;
      if (!equal(basis[key][name], next[key][name]) && !equal(edited[key][name], next[key][name]))
        conflicts.push(key + '/' + name);
      else if (Object.hasOwn(edited[key], name)) merged[name] = clone(edited[key][name]);
      else delete merged[name];
    }
    Object.assign(output, { [key]: merged });
  }
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
