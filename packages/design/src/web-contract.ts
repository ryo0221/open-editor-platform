import { canonicalJson } from '@editor-platform/artifact-core';
import {
  validateReactComponent,
  validateReactEnvironment,
  validateReactJson,
  validateReactComponentRef,
  validateReactImport,
  loadReactUiDocument,
  sealReactComponent,
  sealReactEnvironment,
  type ReactEnvironment,
  type RegisteredReactComponent,
  type ReactComponentRef,
  type ReactImport,
  type JsonValue,
  type ReactUiBinding,
  type ReactFieldSchema,
  type ReactCallbackSchema,
  type ReactUiLayout,
} from '@editor-platform/react-ui-core';

/** Native identity/geometry remain canonical. No executable code or second editing tree. */
export interface DesignReactReference {
  component: ReactComponentRef;
  import: ReactImport;
  props: Record<string, JsonValue>;
  bindings: Record<string, ReactUiBinding>;
  slots: Record<string, string[]>;
}
export const designWebTags = [
  'div',
  'section',
  'main',
  'article',
  'form',
  'span',
  'p',
  'h1',
  'h2',
  'label',
  'img',
  'a',
] as const;
export type DesignWebTag = (typeof designWebTags)[number];
/** Semantic output must retain image content, including in existing native definitions. */
export function designWebTagsFor(type: string): readonly DesignWebTag[] {
  return type === 'image' ? ['img'] : designWebTags;
}
export interface DesignWebElement {
  tag?: DesignWebTag;
  layout?: ReactUiLayout;
  /** Route target is a stable native page/frame ID, never arbitrary script/HTML. */
  linkPageId?: string;
  bindings?: Record<string, ReactUiBinding>;
}
export interface DesignWebComponent {
  symbol: string;
  version: string;
  props: Record<string, ReactFieldSchema & { target: { elementId: string; field: string } }>;
  /** Explicit named native overrides; a typed variant input is generated. */
  variants: Record<string, Record<string, { text?: string; fill?: string }>>;
  callbacks?: Record<string, ReactCallbackSchema>;
  controlledInputs?: import('@editor-platform/react-ui-core').ReactControlledInput[];
  sampleProps?: Record<string, JsonValue>;
  slots?: Record<
    string,
    import('@editor-platform/react-ui-core').ReactSlotSchema & { elementId: string }
  >;
}
export interface DesignWebSettings {
  schemaVersion: 1;
  environment: ReactEnvironment;
  registrations: RegisteredReactComponent[];
  inputs: Record<string, ReactFieldSchema>;
  callbacks: Record<string, ReactCallbackSchema>;
  fixture: Record<string, JsonValue>;
  breakpoints: { id: string; minWidth: number }[];
  pages: { frameId: string; symbol: string; path: string }[];
  /** Immutable native publications, retained across subsequent conversion receipts. */
  publications?: ReactComponentRef[];
  /** Bounded conversion receipt. Legacy file bodies remain readable, but are never newly stored. */
  accepted?: {
    sourceHash: string;
    fingerprint: string;
    fileHashes?: Record<string, string>;
    files?: Record<string, string>;
  };
}
const identifier = /^[A-Za-z][A-Za-z0-9_]*$/;
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: object, allowed: string[]) => Object.keys(v).every((key) => allowed.includes(key));
function checkNodeData(
  r: Pick<DesignReactReference, 'props' | 'bindings' | 'slots'>,
  layout = { base: {}, breakpoints: {} },
) {
  // Reuse the #24 shape boundary without resolving dependencies or completeness.
  loadReactUiDocument({
    schemaVersion: 1,
    domain: 'react-ui',
    environment: emptyEnvironment,
    components: [],
    inputs: {},
    callbacks: {},
    fixture: {},
    breakpoints: [],
    roots: [],
    nodes: [{ id: 'shape', component: emptyRef, ...r, layout }],
  });
}
// No runtime attestation: these identities are used only for structural validation.
const emptyRef = {
  registryId: 'shape',
  componentId: 'shape',
  version: '1',
  contractHash: '0'.repeat(64),
  implementationHash: '0'.repeat(64),
};
const emptyEnvironment = sealReactEnvironment({
  schemaVersion: 1,
  ref: { id: 'shape', version: '1' },
  reactVersion: '19.1.1',
  dependencies: [],
  providerOrder: [],
  stylePolicy: 'allow-literals',
  tokenVariables: {},
});
export function validDesignWebData(value: unknown): boolean {
  try {
    validateReactJson(value);
    return canonicalJson(value).length <= 4 * 1024 * 1024;
  } catch {
    return false;
  }
}
export function validDesignReactReference(value: unknown): value is DesignReactReference {
  try {
    if (
      !validDesignWebData(value) ||
      !record(value) ||
      !keys(value, ['component', 'import', 'props', 'bindings', 'slots'])
    )
      return false;
    const r = value as unknown as DesignReactReference;
    validateReactComponentRef(r.component, '$.react.component');
    validateReactImport(r.import, '$.react.import');
    checkNodeData({ props: r.props, bindings: r.bindings, slots: r.slots });
    return true;
  } catch {
    return false;
  }
}
export function validDesignWebElement(value: unknown): value is DesignWebElement {
  if (
    !validDesignWebData(value) ||
    !record(value) ||
    !keys(value, ['tag', 'layout', 'linkPageId', 'bindings'])
  )
    return false;
  const w = value as DesignWebElement;
  try {
    checkNodeData({ props: {}, slots: {}, bindings: w.bindings ?? {} }, w.layout);
  } catch {
    return false;
  }
  return (
    !!w &&
    (w.tag === undefined || designWebTags.includes(w.tag)) &&
    (w.linkPageId === undefined || typeof w.linkPageId === 'string')
  );
}
/** Public prop schemas without their native targets; throws on an invalid target. */
function publicPropSchemas(props: DesignWebComponent['props']) {
  return Object.fromEntries(
    Object.entries(props).map(([key, field]) => {
      if (
        !record(field.target) ||
        !keys(field.target, ['elementId', 'field']) ||
        typeof field.target.elementId !== 'string' ||
        !identifier.test(field.target.field)
      )
        throw new Error('Invalid public target');
      const { target: _target, ...schema } = field;
      return [key, schema];
    }),
  );
}
function publicSlotSchemas(slots: NonNullable<DesignWebComponent['slots']>) {
  return Object.fromEntries(
    Object.entries(slots).map(([key, field]) => {
      if (typeof field.elementId !== 'string') throw new Error('Invalid slot target');
      const { elementId: _elementId, ...schema } = field;
      return [key, schema];
    }),
  );
}
/** Named variants patch only text and fill of parts with string values. */
function validVariants(variants: DesignWebComponent['variants']): boolean {
  for (const [variant, overrides] of Object.entries(variants)) {
    if (!identifier.test(variant) || !record(overrides)) return false;
    for (const patch of Object.values(overrides))
      if (
        !record(patch) ||
        !keys(patch, ['text', 'fill']) ||
        Object.values(patch).some((v) => typeof v !== 'string')
      )
        return false;
  }
  return true;
}
export function validDesignWebComponent(value: unknown): value is DesignWebComponent {
  if (
    !validDesignWebData(value) ||
    !record(value) ||
    !keys(value, [
      'symbol',
      'version',
      'props',
      'variants',
      'callbacks',
      'controlledInputs',
      'slots',
      'sampleProps',
    ])
  )
    return false;
  const w = value as unknown as DesignWebComponent;
  try {
    if (!record(w.props) || !record(w.variants)) return false;
    const props = publicPropSchemas(w.props);
    const slots = publicSlotSchemas(w.slots ?? {});
    const { contractHash: _contractHash, ...ref } = emptyRef;
    sealReactComponent({
      schemaVersion: 1,
      ref: { ...ref, version: w.version },
      name: w.symbol,
      import: { source: './Native', export: 'named', name: w.symbol },
      props,
      slots,
      events: w.callbacks ?? {},
      controlledInputs: w.controlledInputs ?? [],
      layout: 'className',
      requires: [],
      sampleProps: w.sampleProps ?? {},
    });
    if (!validVariants(w.variants)) return false;
  } catch {
    return false;
  }
  return (
    !!w &&
    typeof w.symbol === 'string' &&
    identifier.test(w.symbol) &&
    typeof w.version === 'string' &&
    !!w.props &&
    !!w.variants
  );
}
const validWebPage = (p: DesignWebSettings['pages'][number]) =>
  record(p) &&
  keys(p, ['frameId', 'symbol', 'path']) &&
  typeof p.frameId === 'string' &&
  identifier.test(p.symbol) &&
  typeof p.path === 'string';
/** Bounded retained publication refs; an invalid ref throws. */
function validPublications(publications: unknown): boolean {
  if (!Array.isArray(publications) || publications.length > 1000) return false;
  publications.forEach((ref, i) => validateReactComponentRef(ref, `$.publications[${i}]`));
  return true;
}
const stringValues = (value: unknown) =>
  record(value) && Object.values(value).every((v) => typeof v === 'string');
const validFileHashes = (value: unknown) =>
  record(value) &&
  Object.keys(value).length <= 1000 &&
  Object.values(value).every((v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v));
/** Accepted receipt: hashes plus legacy file bodies or bounded per-file hashes. */
function validAcceptedReceipt(accepted: NonNullable<DesignWebSettings['accepted']>): boolean {
  return (
    record(accepted) &&
    keys(accepted, ['sourceHash', 'fingerprint', 'files', 'fileHashes']) &&
    typeof accepted.sourceHash === 'string' &&
    typeof accepted.fingerprint === 'string' &&
    !!(accepted.files || accepted.fileHashes) &&
    (accepted.files === undefined || stringValues(accepted.files)) &&
    (accepted.fileHashes === undefined || validFileHashes(accepted.fileHashes))
  );
}
export function validDesignWebSettings(value: unknown): value is DesignWebSettings {
  try {
    if (
      !validDesignWebData(value) ||
      !record(value) ||
      !keys(value, [
        'schemaVersion',
        'environment',
        'registrations',
        'inputs',
        'callbacks',
        'fixture',
        'breakpoints',
        'pages',
        'accepted',
        'publications',
      ])
    )
      return false;
    const w = value as unknown as DesignWebSettings;
    if (
      !w ||
      w.schemaVersion !== 1 ||
      !Array.isArray(w.registrations) ||
      !Array.isArray(w.pages) ||
      !Array.isArray(w.breakpoints) ||
      !w.inputs ||
      !w.callbacks ||
      !w.fixture
    )
      return false;
    validateReactEnvironment(w.environment);
    w.registrations.forEach(validateReactComponent);
    if (w.publications !== undefined && !validPublications(w.publications)) return false;
    loadReactUiDocument({
      schemaVersion: 1,
      domain: 'react-ui',
      environment: w.environment,
      components: w.registrations,
      inputs: w.inputs,
      callbacks: w.callbacks,
      fixture: w.fixture,
      breakpoints: w.breakpoints,
      roots: [],
      nodes: [],
    });
    if (w.accepted && !validAcceptedReceipt(w.accepted)) return false;
    return (
      w.pages.every(validWebPage) &&
      w.breakpoints.every((bp) => typeof bp.id === 'string' && Number.isFinite(bp.minWidth))
    );
  } catch {
    return false;
  }
}
