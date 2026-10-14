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
    const props = Object.fromEntries(
      Object.entries(w.props).map(([key, field]) => {
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
    const slots = Object.fromEntries(
      Object.entries(w.slots ?? {}).map(([key, field]) => {
        if (typeof field.elementId !== 'string') throw new Error('Invalid slot target');
        const { elementId: _elementId, ...schema } = field;
        return [key, schema];
      }),
    );
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
    for (const [variant, overrides] of Object.entries(w.variants)) {
      if (!identifier.test(variant) || !record(overrides)) return false;
      for (const patch of Object.values(overrides))
        if (
          !record(patch) ||
          !keys(patch, ['text', 'fill']) ||
          Object.values(patch).some((v) => typeof v !== 'string')
        )
          return false;
    }
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
    if (w.publications !== undefined) {
      if (!Array.isArray(w.publications) || w.publications.length > 1000) return false;
      w.publications.forEach((ref, i) => validateReactComponentRef(ref, `$.publications[${i}]`));
    }
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
    if (
      w.accepted &&
      (!record(w.accepted) ||
        !keys(w.accepted, ['sourceHash', 'fingerprint', 'files', 'fileHashes']) ||
        typeof w.accepted.sourceHash !== 'string' ||
        typeof w.accepted.fingerprint !== 'string' ||
        (!w.accepted.files && !w.accepted.fileHashes) ||
        (w.accepted.files !== undefined &&
          (!record(w.accepted.files) ||
            Object.values(w.accepted.files).some((v) => typeof v !== 'string'))) ||
        (w.accepted.fileHashes !== undefined &&
          (!record(w.accepted.fileHashes) ||
            Object.keys(w.accepted.fileHashes).length > 1000 ||
            Object.values(w.accepted.fileHashes).some(
              (v) => typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v),
            ))))
    )
      return false;
    return (
      w.pages.every(
        (p) =>
          record(p) &&
          keys(p, ['frameId', 'symbol', 'path']) &&
          typeof p.frameId === 'string' &&
          identifier.test(p.symbol) &&
          typeof p.path === 'string',
      ) && w.breakpoints.every((bp) => typeof bp.id === 'string' && Number.isFinite(bp.minWidth))
    );
  } catch {
    return false;
  }
}
