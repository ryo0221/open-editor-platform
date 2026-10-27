import { clone, canonicalJson } from '@editor-platform/artifact-core';
import { reuseHash } from '@editor-platform/reuse-core';
import {
  appearance,
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
  type ReactUiDocument,
  type ReactUiNode,
  type ReactUiLayout,
  type ReactUiStyle,
  type RegisteredReactComponent,
  type ReactUiDiagnostic,
  type JsonValue,
  type ReactFieldSchema,
} from '@editor-platform/react-ui-core';
import type { DesignReactConversion, NativeComponentProgram, NativePrimitive } from './convert';

// Internal building blocks of convertDesignToReact. Not re-exported from the package entrypoint.

export const err = (code: string, id: string, message: string): ReactUiDiagnostic => ({
  code,
  severity: 'error',
  path: id,
  message,
  recovery:
    'Correct the addressed native element or explicit Web settings; retain the native source and prepare again.',
});
export const safeSymbol = (id: string) => 'N' + reuseHash(id).slice(0, 16);
const stringField: ReactFieldSchema = { schema: { type: 'string' }, required: false };
export const primitiveFields = (tag: DesignWebTag): RegisteredReactComponent['props'] =>
  tag === 'img'
    ? {
        src: { schema: { type: 'string', maxLength: 4 * 1024 * 1024 }, required: false },
        alt: stringField,
      }
    : { text: stringField, fill: stringField };
const lit = (value: string | number) => ({ kind: 'literal' as const, value });
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

/** Mutable accumulator shared by one conversion run. */
export interface ConversionState {
  content: DesignContent;
  settings: DesignWebSettings;
  diagnostics: ReactUiDiagnostic[];
  primitives: NativePrimitive[];
  components: NativeComponentProgram[];
  mappings: DesignReactConversion['mappings'];
  routes: Map<string, string>;
  /** Components currently being converted, for cycle detection. */
  active: Set<string>;
}
export function createConversionState(
  content: DesignContent,
  settings: DesignWebSettings,
): ConversionState {
  return {
    content,
    settings,
    diagnostics: [],
    primitives: [],
    components: [],
    mappings: [],
    routes: new Map(settings.pages.map((p) => [p.frameId, p.path])),
    active: new Set(),
  };
}
export const allRegistrations = (state: ConversionState) => [
  ...state.settings.registrations,
  ...state.primitives.map((p) => p.registration),
  ...state.components.map((c) => c.registration),
];

function pageDiagnostics(
  content: DesignContent,
  page: DesignWebSettings['pages'][number],
): ReactUiDiagnostic[] {
  const out: ReactUiDiagnostic[] = [];
  if (
    !/^\/(?:[A-Za-z0-9_-]+\/?)*$/.test(page.path) ||
    !/^[A-Z][A-Za-z0-9_]{0,79}$/.test(page.symbol)
  )
    out.push(
      err(
        'route-invalid',
        page.frameId,
        'Use a safe route path and explicit PascalCase page symbol',
      ),
    );
  const frame = content.elements.find((e) => e.id === page.frameId && e.type === 'frame');
  if (!frame)
    out.push(err('page-missing', page.frameId, 'Route must address an existing native Frame'));
  else if (content.elements.find((e) => e.id === page.frameId)!.hidden)
    out.push(
      err(
        'page-hidden',
        page.frameId,
        'A hidden Frame cannot be a routed page; show it or remove its route',
      ),
    );
  if (['Site', 'NativeComponents'].some((s) => s.toLowerCase() === page.symbol.toLowerCase()))
    out.push(
      err(
        'output-path-collision',
        page.frameId,
        `Page symbol ${page.symbol} is reserved for generated support modules`,
      ),
    );
  return out;
}
/** Site-level checks of explicit Web settings: reserved inputs, unique and valid routes. */
export function settingsDiagnostics(
  content: DesignContent,
  settings: DesignWebSettings,
): ReactUiDiagnostic[] {
  const out: ReactUiDiagnostic[] = [];
  const symbols = settings.pages.map((p) => p.symbol);
  if (Object.hasOwn(settings.inputs, 'path') || Object.hasOwn(settings.callbacks, 'path'))
    out.push(
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
    out.push(err('route-duplicate', '$.web.pages', 'Page symbols and route paths must be unique'));
  for (const p of settings.pages) out.push(...pageDiagnostics(content, p));
  return out;
}

function makeRegistration(
  componentId: string,
  symbol: string,
  props: RegisteredReactComponent['props'],
  events: RegisteredReactComponent['events'],
  slots: RegisteredReactComponent['slots'],
  implementation: unknown,
  version = '1.0.0',
  source = './NativeComponents',
  sampleProps: RegisteredReactComponent['sampleProps'] = {},
) {
  return sealReactComponent({
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
}

/** Absolute placement relative to a non-flow native parent; reports unsupported constraints. */
function placeAbsolutely(
  state: ConversionState,
  base: ReactUiStyle,
  e: DesignElement,
  parent: DesignElement,
) {
  base.position = lit('absolute');
  base.left = lit(e.bounds.x - parent.bounds.x);
  base.top = lit(e.bounds.y - parent.bounds.y);
  if (e.constraints?.horizontal === 'stretch') {
    base.width = lit(`${(e.bounds.width / parent.bounds.width) * 100}%`);
    base.left = lit(`${((e.bounds.x - parent.bounds.x) / parent.bounds.width) * 100}%`);
  } else if (e.constraints && e.constraints.horizontal !== 'left')
    state.diagnostics.push(
      err(
        'constraint-unsupported',
        e.id,
        'Map right/center/scale constraints to an explicit responsive layout before Web export',
      ),
    );
  if (e.constraints && e.constraints.vertical !== 'top')
    state.diagnostics.push(
      err('constraint-unsupported', e.id, 'Vertical constraints need an explicit Web layout'),
    );
}
function applyTypographyAndSizing(base: ReactUiStyle, e: DesignElement) {
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
  applyFlexLayout(base, e);
}
function applyFlexLayout(base: ReactUiStyle, e: DesignElement) {
  if (e.layout && e.layout.direction !== 'absolute')
    Object.assign(base, {
      display: lit('flex'),
      flexDirection: lit(e.layout.direction),
      gap: lit(e.layout.gap),
      padding: lit(e.layout.padding),
      alignItems: lit(e.layout.align),
      ...(e.layout.sizing === 'hug' ? { height: lit('auto') } : {}),
    });
}
function layoutFor(
  state: ConversionState,
  e: DesignElement,
  parent: DesignElement | undefined,
  root: boolean,
): ReactUiLayout {
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
  if (parent && !slotParent && (!parent.layout || parent.layout.direction === 'absolute'))
    placeAbsolutely(state, base, e, parent);
  applyTypographyAndSizing(base, e);
  return {
    base: { ...base, ...e.web?.layout?.base },
    breakpoints: clone(e.web?.layout?.breakpoints ?? {}),
  };
}

interface NodeParts {
  registration?: RegisteredReactComponent;
  props: Record<string, JsonValue>;
  bindings: ReactUiNode['bindings'];
  slots: ReactUiNode['slots'];
}
interface BuildScope {
  elements: DesignElement[];
  byId: Map<string, DesignElement>;
}
const emptyParts = (): NodeParts => ({ props: {}, bindings: {}, slots: {} });
const visibleChildIds = (scope: BuildScope, parentId: string) =>
  scope.elements.filter((c) => c.parentId === parentId && !c.hidden).map((c) => c.id);
const defaultProps = (c: DesignComponent) =>
  Object.fromEntries(
    Object.entries(c.web!.props)
      .filter(([, p]) => Object.hasOwn(p, 'default'))
      .map(([k, p]) => [k, p.default!]),
  );

function reactNodeParts(
  state: ConversionState,
  scope: BuildScope,
  e: DesignElement & { react: NonNullable<DesignElement['react']> },
): NodeParts {
  const registration = state.settings.registrations.find(
    (c) => reactComponentKey(c.ref) === reactComponentKey(e.react.component),
  );
  if (
    !registration ||
    reuseHash(registration.ref) !== reuseHash(e.react.component) ||
    reuseHash(registration.import) !== reuseHash(e.react.import)
  )
    state.diagnostics.push(
      err(
        'component-missing',
        e.id,
        'Exact external registration/import is unavailable; its native reference is retained',
      ),
    );
  const slots = clone(e.react.slots);
  const assigned = Object.values(slots).flat();
  if (
    assigned.some((child) => scope.byId.get(child)?.parentId !== e.id) ||
    visibleChildIds(scope, e.id).some((child) => !assigned.includes(child))
  )
    state.diagnostics.push(
      err(
        'slot-ownership',
        e.id,
        'External children must belong to this native parent and exactly one declared slot',
      ),
    );
  return {
    registration,
    props: clone(e.react.props),
    bindings: clone(e.react.bindings),
    slots,
  };
}

/** Instance overrides are kept as a distinct generated variant of the immutable definition. */
function overriddenComponent(c: DesignComponent, e: DesignElement): DesignComponent {
  return {
    ...clone(c),
    id: `${c.id}-${reuseHash(e.overrides).slice(0, 10)}`,
    elements: c.elements?.map((part) => ({
      ...part,
      ...clone(e.overrides?.[part.id] ?? {}),
      id: part.id,
    })),
    web: { ...clone(c.web!), symbol: safeSymbol(`${e.id}-override`) },
  };
}
function instanceNodeParts(state: ConversionState, scope: BuildScope, e: DesignElement): NodeParts {
  const c = state.content.components.find((c) => c.id === e.componentId);
  if (!c?.web) {
    state.diagnostics.push(
      err(
        'component-semantics',
        e.id,
        'Publish explicit semantics/public inputs for this native component',
      ),
    );
    return emptyParts();
  }
  let registration = nativeComponent(state, c);
  const props = { ...defaultProps(c), ...clone(e.webProps ?? {}) };
  if (e.overrides && Object.keys(e.overrides).length)
    registration = nativeComponent(state, overriddenComponent(c, e));
  const slots = clone(e.webSlots ?? {});
  const owned = Object.values(slots).flat();
  if (
    owned.some((child) => scope.byId.get(child)?.parentId !== e.id) ||
    visibleChildIds(scope, e.id).some((child) => !owned.includes(child))
  )
    state.diagnostics.push(
      err(
        'slot-ownership',
        e.id,
        'Native component children must belong to this instance and a declared public slot',
      ),
    );
  return { registration, props, bindings: clone(e.web?.bindings ?? {}), slots };
}

/** Features that a semantic HTML primitive cannot render faithfully. */
const unsupportedPrimitiveVisuals: ((e: DesignElement) => unknown)[] = [
  (e) => e.typography?.italic,
  (e) => e.typography?.underline,
  (e) => e.typography?.strike,
  (e) => e.typography?.letterSpacing,
  (e) => e.typography?.lineHeight,
  (e) => e.typography?.padding,
  (e) => e.typography?.list,
  (e) => e.typography?.overflow,
  (e) => e.typography?.verticalAlign && e.typography.verticalAlign !== 'top',
  (e) => e.crop && (e.crop.x !== 0 || e.crop.y !== 0 || e.crop.scale !== 1),
  (e) => e.typography?.align && e.typography.align !== 'left',
  (e) => e.runs?.length,
  (e) => e.vector,
  (e) => e.path,
  (e) => e.strokeWidth,
  (e) => e.rotation,
  (e) => e.opacity !== undefined && e.opacity !== 1,
  (e) => e.shape && e.shape !== 'rectangle',
];
const hasUnsupportedPrimitiveVisual = (e: DesignElement) =>
  unsupportedPrimitiveVisuals.some((unsupported) => unsupported(e));
function primitiveDiagnostics(
  state: ConversionState,
  e: DesignElement,
  tag: DesignWebTag,
  href: string | undefined,
) {
  const push = (code: string, message: string) => state.diagnostics.push(err(code, e.id, message));
  if (!designWebTagsFor(e.type).includes(tag))
    push('image-semantics', 'Native image requires img semantics to retain its image content');
  if (hasUnsupportedPrimitiveVisual(e))
    push(
      'visual-unsupported',
      'Rich runs/strokes/rotation/non-rectangular shapes need the separate React SVG mode',
    );
  if (tag === 'img' && (!e.alt || !validEmbeddedImage(e.src)))
    push('asset-invalid', 'Semantic image needs alt text and a retained PNG/JPEG/WebP asset');
  if (tag === 'a' && !href) push('link-missing', 'Select a retained native page as link target');
}
function primitiveRegistration(
  state: ConversionState,
  e: DesignElement,
  tag: DesignWebTag,
  href: string | undefined,
): RegisteredReactComponent {
  const primitiveId = `element-${e.id}`;
  const existing = state.primitives.find((p) => p.registration.ref.componentId === primitiveId);
  if (existing) return existing.registration;
  const registration = makeRegistration(
    primitiveId,
    safeSymbol(primitiveId),
    primitiveFields(tag),
    tag === 'form' ? { onSubmit: { parameters: [], returns: 'void' } } : {},
    {},
    { tag, href: href ?? null, sourceId: e.id },
  );
  state.primitives.push({
    registration,
    tag,
    sourceId: e.id,
    ...(href ? { href } : {}),
    ...(tag === 'img' ? { imageFit: e.imageFit ?? 'fill', radius: e.radius ?? 0 } : {}),
  });
  return registration;
}
function primitiveNodeParts(
  state: ConversionState,
  scope: BuildScope,
  e: DesignElement,
): NodeParts {
  const tag = e.web?.tag;
  if (!tag) {
    state.diagnostics.push(
      err(
        'semantics-missing',
        e.id,
        'Choose an explicit HTML role; layer names are not interpreted',
      ),
    );
    return emptyParts();
  }
  const href = e.web?.linkPageId ? state.routes.get(e.web.linkPageId) : undefined;
  primitiveDiagnostics(state, e, tag, href);
  const registration = primitiveRegistration(state, e, tag, href);
  const props: Record<string, JsonValue> =
    tag === 'img' ? { src: e.src!, alt: e.alt! } : { text: e.text, fill: e.fill };
  const bindings = clone(e.web?.bindings ?? {});
  for (const k of Object.keys(bindings)) delete props[k];
  const slots: ReactUiNode['slots'] = tag === 'img' ? {} : { body: visibleChildIds(scope, e.id) };
  return { registration, props, bindings, slots };
}

function nodeParts(state: ConversionState, scope: BuildScope, e: DesignElement): NodeParts {
  if (e.type === 'react' && e.react) return reactNodeParts(state, scope, { ...e, react: e.react });
  if (e.type === 'instance') return instanceNodeParts(state, scope, e);
  return primitiveNodeParts(state, scope, e);
}

const resolvedAppearance = (content: DesignContent, raw: DesignElement): DesignElement => ({
  ...raw,
  ...(raw.type !== 'instance' ? appearance(content, raw) : {}),
  type: raw.type,
});
const hasUnsupportedTransform = (e: DesignElement) =>
  !!(e.rotation || e.flipX || e.flipY || (e.opacity !== undefined && e.opacity !== 1));

/** Converts one native tree into a React UI document, accumulating diagnostics and programs. */
export function buildDocument(
  state: ConversionState,
  elements: DesignElement[],
  roots: string[],
  inputs = state.settings.inputs,
  fixture = state.settings.fixture,
  callbacks = state.settings.callbacks,
): ReactUiDocument {
  const { content, settings, diagnostics } = state;
  const nodes: ReactUiNode[] = [];
  const scope: BuildScope = { elements, byId: new Map(elements.map((e) => [e.id, e])) };
  const seen = new Set<string>();
  const visit = (id: string, root = false) => {
    if (seen.has(id)) {
      diagnostics.push(
        err('node-ownership', id, 'Native node is owned by more than one parent or slot'),
      );
      return;
    }
    const raw = scope.byId.get(id);
    if (!raw) {
      diagnostics.push(err('node-missing', id, 'Native child/slot target is missing'));
      return;
    }
    const e = resolvedAppearance(content, raw);
    seen.add(id);
    if (e.hidden) return;
    if (hasUnsupportedTransform(e))
      diagnostics.push(
        err(
          'visual-unsupported',
          e.id,
          'Rotation/reflection/opacity need explicit supported Web styling or graphic output',
        ),
      );
    const { registration, props, bindings, slots } = nodeParts(state, scope, e);
    const ref = registration?.ref ?? e.react?.component;
    if (!ref) return;
    for (const key of Object.keys(bindings)) delete props[key];
    nodes.push({
      id: e.id,
      component: ref,
      props,
      bindings,
      slots,
      layout: layoutFor(state, e, scope.byId.get(e.parentId ?? ''), root),
    });
    state.mappings.push({
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
}

type WebComponent = DesignComponent & {
  web: NonNullable<DesignComponent['web']>;
  elements: NonNullable<DesignComponent['elements']>;
};

/** A part that renders as a generated HTML primitive (not original React or a nested instance). */
const renderedPrimitiveTag = (target: DesignElement) =>
  target.type === 'react' || target.type === 'instance' ? undefined : target.web?.tag;

function publicTargetDiagnostics(state: ConversionState, c: WebComponent) {
  for (const [key, p] of Object.entries(c.web.props)) {
    const target = c.elements.find((e) => e.id === p.target.elementId);
    if (!target)
      state.diagnostics.push(
        err('public-target', c.id, `Public input ${key} targets a missing native part`),
      );
    else if (
      target.type !== 'react' &&
      target.type !== 'instance' &&
      target.web?.tag &&
      !Object.hasOwn(primitiveFields(target.web.tag), p.target.field)
    )
      state.diagnostics.push(
        err(
          'public-target',
          `${c.id}/${target.id}`,
          `Public input ${key} targets ${target.web.tag}.${p.target.field}, which is not rendered`,
        ),
      );
  }
}
function variantPatchDiagnostics(
  state: ConversionState,
  c: WebComponent,
  variant: string,
  patches: Record<string, Record<string, unknown>>,
) {
  for (const [id, patch] of Object.entries(patches)) {
    const target = c.elements.find((e) => e.id === id);
    if (!target) {
      state.diagnostics.push(
        err('variant-target', c.id, `Variant ${variant} targets missing part ${id}`),
      );
      continue;
    }
    const tag = renderedPrimitiveTag(target);
    if (
      Object.keys(patch).length &&
      (!tag || Object.keys(patch).some((field) => !Object.hasOwn(primitiveFields(tag), field)))
    )
      state.diagnostics.push(
        err(
          'variant-target',
          `${c.id}/${id}`,
          `Variant ${variant} patches fields that this part does not render`,
        ),
      );
  }
}
const prefixIds = (prefix: string, slots: Record<string, string[]>) =>
  Object.fromEntries(
    Object.entries(slots).map(([slot, ids]) => [slot, ids.map((id) => prefix + id)]),
  );
/** Applies one variant's patches, binds public inputs and namespaces part ids under the component. */
function variantElements(
  c: WebComponent,
  patches: Record<string, Record<string, unknown>>,
): DesignElement[] {
  const prefix = c.id + '--';
  return c.elements.map((e) => {
    const next = { ...clone(e), ...clone(patches[e.id] ?? {}) } as DesignElement;
    const targeted = Object.entries(c.web.props).filter(([, p]) => p.target.elementId === e.id);
    if (next.react) {
      const react = clone(next.react);
      for (const [key, p] of targeted) {
        react.bindings[p.target.field] = { kind: 'data', input: key, path: [] };
        delete react.props[p.target.field];
      }
      next.react = react;
    } else {
      const bindings = { ...next.web?.bindings };
      for (const [key, p] of targeted)
        bindings[p.target.field] = { kind: 'data', input: key, path: [] };
      next.web = { ...next.web, bindings };
    }
    return {
      ...next,
      id: prefix + next.id,
      ...(next.parentId ? { parentId: prefix + next.parentId } : {}),
      ...(next.react
        ? { react: { ...next.react, slots: prefixIds(prefix, next.react.slots) } }
        : {}),
      ...(next.webSlots ? { webSlots: prefixIds(prefix, next.webSlots) } : {}),
    };
  });
}
function slotTargetDiagnostics(
  state: ConversionState,
  c: WebComponent,
  documents: Record<string, ReactUiDocument>,
) {
  for (const [key, slot] of Object.entries(c.web.slots ?? {})) {
    const target = c.elements.find((e) => e.id === slot.elementId);
    if (!target) {
      state.diagnostics.push(
        err('slot-target', c.id, 'Published native slot ' + key + ' targets a missing part'),
      );
      continue;
    }
    const tag = renderedPrimitiveTag(target);
    const generatedId = c.id + '--' + target.id;
    if (
      !tag ||
      tag === 'img' ||
      Object.values(documents).some((doc) => !doc.nodes.some((node) => node.id === generatedId))
    )
      state.diagnostics.push(
        err(
          'slot-target',
          `${c.id}/${target.id}`,
          `Native public slot ${key} requires a visible generated non-image HTML part; original React, nested instances and images cannot consume its context`,
        ),
      );
  }
}
/** Pre-conditions for converting a published component; false means it was rejected. */
function acceptsComponent(state: ConversionState, c: DesignComponent): c is WebComponent {
  if (state.active.has(c.id)) {
    state.diagnostics.push(
      err('component-cycle', c.id, 'Recursive native component cannot be exported'),
    );
    return false;
  }
  if (!c.web || !c.elements?.length) {
    state.diagnostics.push(
      err('component-subset', c.id, 'Publish a compound native component with explicit semantics'),
    );
    return false;
  }
  if (Object.keys(c.web.variants).length && Object.hasOwn(c.web.props, 'variant')) {
    state.diagnostics.push(
      err(
        'reserved-input',
        c.id,
        'Named variants reserve the public input variant; rename that input',
      ),
    );
    return false;
  }
  return true;
}
function componentInputs(c: WebComponent) {
  return Object.fromEntries(
    Object.entries(c.web.props).map(([k, p]) => [
      k,
      {
        schema: p.schema,
        required: p.required,
        ...(Object.hasOwn(p, 'default') ? { default: p.default } : {}),
      },
    ]),
  );
}
function componentRegistration(
  c: WebComponent,
  inputs: RegisteredReactComponent['props'],
  variantNames: string[],
  documents: Record<string, ReactUiDocument>,
  fixture: RegisteredReactComponent['sampleProps'],
) {
  const props = {
    ...inputs,
    ...(Object.keys(c.web.variants).length
      ? {
          variant: {
            schema: { type: 'enum' as const, values: variantNames },
            required: false,
            default: variantNames[0],
          },
        }
      : {}),
  };
  const registration = makeRegistration(
    c.id,
    c.web.symbol,
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
  return sealReactComponent({
    ...registration,
    ref: {
      registryId: registration.ref.registryId,
      componentId: registration.ref.componentId,
      version: registration.ref.version,
      implementationHash: registration.ref.implementationHash,
    },
    controlledInputs: clone(c.web.controlledInputs ?? []),
  });
}

/** Converts a published native component once, returning its generated registration. */
export function nativeComponent(
  state: ConversionState,
  c: DesignComponent,
): RegisteredReactComponent | undefined {
  const existing = state.components.find((p) => p.sourceId === c.id);
  if (existing) return existing.registration;
  if (!acceptsComponent(state, c)) return;
  state.active.add(c.id);
  const inputs = componentInputs(c);
  const fixture = { ...clone(c.web.sampleProps ?? {}), ...defaultProps(c) };
  publicTargetDiagnostics(state, c);
  const documents: Record<string, ReactUiDocument> = {};
  const variants = Object.keys(c.web.variants).length ? c.web.variants : { default: {} };
  for (const [variant, patches] of Object.entries(variants)) {
    variantPatchDiagnostics(state, c, variant, patches);
    const elements = variantElements(c, patches);
    documents[variant] = buildDocument(
      state,
      elements,
      elements.filter((e) => !e.parentId && !e.hidden).map((e) => e.id),
      inputs,
      fixture,
      c.web.callbacks ?? {},
    );
  }
  const published = componentRegistration(c, inputs, Object.keys(variants), documents, fixture);
  const slotTargets = Object.fromEntries(
    Object.entries(c.web.slots ?? {}).map(([key, slot]) => [
      key,
      { elementId: c.id + '--' + slot.elementId, prop: slot.prop },
    ]),
  );
  slotTargetDiagnostics(state, c, documents);
  state.components.push({
    registration: published,
    hasVariants: Object.keys(c.web.variants).length > 0,
    documents,
    sourceId: c.id,
    slotTargets,
  });
  state.active.delete(c.id);
  return published;
}

/** Native containers explicitly accept the generated + retained child identities. */
export function acceptGeneratedChildren(state: ConversionState) {
  const accepted = [
    ...new Map(
      allRegistrations(state)
        .map((c) => ({ registryId: c.ref.registryId, componentId: c.ref.componentId }))
        .map((kind) => [canonicalJson(kind), kind]),
    ).values(),
  ];
  for (const p of state.primitives) {
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
}

const primaryConversionErrors = [
  'component-semantics',
  'component-subset',
  'semantics-missing',
  'component-missing',
  'node-missing',
  'component-cycle',
];
/** Resolves final registrations for a document and runs the React UI inspection. */
export function finalizeDocument(state: ConversionState, doc: ReactUiDocument): ReactUiDocument {
  const registrations = allRegistrations(state);
  doc.nodes = doc.nodes.map((n) => ({
    ...n,
    component:
      registrations.find((c) => reactComponentKey(c.ref) === reactComponentKey(n.component))?.ref ??
      n.component,
  }));
  const used = new Set(doc.nodes.map((n) => reactComponentKey(n.component)));
  doc.components = registrations.filter((c) => used.has(reactComponentKey(c.ref)));
  // A skipped node caused by a primary conversion error creates dangling slot references.
  // Report the actionable native error first; successful conversions still undergo every check.
  if (state.diagnostics.some((d) => primaryConversionErrors.includes(d.code))) return doc;
  const inspection = inspectReactUiDocument(doc);
  state.diagnostics.push(...inspection.diagnostics);
  if (inspection.document) return clone(inspection.document);
  return doc;
}
