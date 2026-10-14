import implementation from './components.tsx?raw';
import revisionImplementation from './components-v2.tsx?raw';
import css from '../public/styles/tokens.css?raw';
import image from '../../../tests/fixtures/office/images/quadrants.png?inline';
import {
  reuseHash,
  validateReusableDefinitionSync,
  type TokenSet,
  type ReusableDefinition,
} from '@editor-platform/reuse-core';
import {
  sealReactComponent,
  sealReactEnvironment,
  loadReactUiDocument,
  type RegisteredReactComponent,
  type ReactUiDocument,
  type ReactRuntimeResolution,
  type ReactRuntimeAdapter,
} from '@editor-platform/react-ui-core';
const implementationHash = reuseHash(implementation);
const revisionImplementationHash = reuseHash(revisionImplementation);
export const referenceImage = image;
export const referenceEnvironment = sealReactEnvironment({
  schemaVersion: 1,
  ref: { id: 'reference-react', version: '1.0.0' },
  reactVersion: '19.1.1',
  stylePolicy: 'allow-literals',
  tokenVariables: {},
  dependencies: [
    {
      id: 'ui-revision',
      kind: 'package',
      name: '@reference/ui-revision',
      version: '2.0.0',
      hash: revisionImplementationHash,
    },
    {
      id: 'ui-package',
      kind: 'package',
      name: '@reference/ui',
      version: '1.0.0',
      hash: implementationHash,
    },
    { id: 'theme-css', kind: 'css', path: 'styles/tokens.css', hash: reuseHash(css) },
    {
      id: 'product-image',
      kind: 'asset',
      path: 'assets/product.png',
      mediaType: 'image/png',
      hash: reuseHash(image),
    },
    {
      id: 'theme-provider',
      kind: 'provider',
      import: { source: '@reference/ui', export: 'named', name: 'ThemeProvider' },
      props: { theme: 'light' },
      hash: implementationHash,
    },
  ],
  providerOrder: ['theme-provider'],
});
const accepted = ['Card', 'Button', 'Text', 'Image', 'Input'].map((componentId) => ({
  registryId: 'reference',
  componentId,
}));
const unsignedTokens: Omit<ReusableDefinition<TokenSet>, 'hash'> = {
  schemaVersion: 1,
  libraryId: 'reference',
  definitionId: 'theme',
  version: 1,
  kind: 'tokens',
  domain: 'shared',
  name: 'Reference theme',
  dependencies: [],
  payload: {
    schemaVersion: 1,
    modes: ['light'],
    defaultMode: 'light',
    tokens: {
      'space.gap': { type: 'dimension', value: { value: 16, unit: 'px' } },
      'brand.color': {
        type: 'color',
        value: { colorSpace: 'srgb', components: [0.1, 0.2, 0.3], alpha: 1 },
      },
    },
  },
};
const { ref: _oldRef, ...baseEnvironment } = referenceEnvironment;
export const referenceTokenEnvironment = sealReactEnvironment({
  ...baseEnvironment,
  ref: { id: 'reference-react', version: '1.1.0' },
  stylePolicy: 'tokens-only',
  tokens: validateReusableDefinitionSync<TokenSet>({
    ...unsignedTokens,
    hash: reuseHash(unsignedTokens),
  }),
  tokenMode: 'light',
  tokenVariables: { 'space.gap': '--space-gap', 'brand.color': '--brand-color' },
});
export const referenceEnvironmentRevision = sealReactEnvironment({
  ...baseEnvironment,
  ref: { id: 'reference-react', version: '2.0.0' },
  dependencies: referenceEnvironment.dependencies.map((dependency) =>
    dependency.kind === 'provider' ? { ...dependency, props: { theme: 'dark' } } : dependency,
  ),
});
const string = { type: 'string' as const, maxLength: 80 };
const register = (componentId: string, metadata: Partial<RegisteredReactComponent> = {}) =>
  sealReactComponent({
    schemaVersion: 1,
    name: componentId,
    import: { source: '@reference/ui', export: 'named', name: componentId },
    props: {},
    events: {},
    slots: {},
    controlledInputs: [],
    layout: 'className',
    requires: ['ui-package', 'theme-css', 'theme-provider'],
    sampleProps: {},
    ...metadata,
    ref: { registryId: 'reference', componentId, version: '1.0.0', implementationHash },
  });
export const referenceComponents = [
  register('Card', {
    slots: {
      body: { prop: 'children', minimum: 0, maximum: 32, accepts: accepted },
      footer: { prop: 'footer', minimum: 0, maximum: 4, accepts: accepted },
    },
  }),
  register('Button', {
    props: {
      label: { schema: string, required: true },
      variant: {
        schema: { type: 'enum', values: ['primary', 'secondary'] },
        required: false,
        default: 'secondary',
      },
    },
    events: { onPress: { parameters: [], returns: 'void' } },
    sampleProps: { label: 'Continue', variant: 'primary' },
  }),
  register('Text', {
    props: { text: { schema: string, required: true } },
    sampleProps: { text: 'New text' },
  }),
  register('Image', {
    props: {
      source: { schema: { type: 'asset' }, required: true },
      alt: { schema: string, required: true },
    },
    requires: ['ui-package', 'theme-css', 'product-image'],
    sampleProps: { source: 'product-image', alt: 'Color study' },
  }),
  register('Input', {
    props: {
      value: { schema: string, required: true },
      label: { schema: string, required: false, default: 'Name' },
    },
    events: { onChange: { parameters: [string], returns: 'void' } },
    controlledInputs: [{ valueProp: 'value', eventProp: 'onChange', argumentIndex: 0 }],
    sampleProps: { value: '', label: 'Name' },
  }),
];
export const referenceTextRevision = sealReactComponent({
  ...referenceComponents.find((c) => c.name === 'Text')!,
  ref: {
    registryId: 'reference',
    componentId: 'Text',
    version: '2.0.0',
    implementationHash: revisionImplementationHash,
  },
  import: { source: '@reference/ui-revision', export: 'named', name: 'Text' },
  props: { content: { schema: string, required: true } },
  requires: ['ui-revision', 'theme-css'],
  sampleProps: { content: 'New text' },
});
export const referenceResolution: ReactRuntimeResolution = {
  environment: referenceEnvironment.ref,
  components: [...referenceComponents, referenceTextRevision].map((c) => c.ref),
  dependencies: referenceEnvironment.dependencies.map(({ id, hash }) => ({ id, hash })),
};
export function createReferenceDocument(
  screen: 'product' | 'form' | 'unbound' | 'tokens' = 'unbound',
): ReactUiDocument {
  const node = (
    id: string,
    name: string,
    props: ReactUiDocument['nodes'][number]['props'] = {},
  ): ReactUiDocument['nodes'][number] => ({
    id,
    component: referenceComponents.find((c) => c.name === name)!.ref,
    props,
    bindings: {},
    slots: {},
    layout: { base: {}, breakpoints: {} },
  });
  const root = node('card', 'Card');
  root.slots = {
    body: screen === 'form' ? ['title', 'input', 'buy'] : ['image', 'title', 'buy'],
    footer: ['footer'],
  };
  root.layout = {
    base: {
      display: { kind: 'literal', value: 'flex' },
      flexDirection: { kind: 'literal', value: 'column' },
      gap: { kind: 'literal', value: 16 },
    },
    breakpoints: {
      desktop: {
        display: { kind: 'literal', value: 'grid' },
        gridTemplateColumns: { kind: 'literal', value: 'repeat(2, minmax(0, 1fr))' },
      },
    },
  };
  const title = node('title', 'Text', { text: screen === 'form' ? 'Contact us' : 'Color study' });
  const button = node('buy', 'Button', {
    label: screen === 'form' ? 'Send' : 'Add to cart',
    variant: 'primary',
  });
  const input = node('input', 'Input', { value: '', label: 'Name' });
  const document: ReactUiDocument = {
    schemaVersion: 1,
    domain: 'react-ui',
    environment: referenceEnvironment,
    components: referenceComponents,
    inputs: {},
    callbacks: {},
    fixture: {},
    breakpoints: [
      { id: 'desktop', minWidth: 1024 },
      { id: 'wide', minWidth: 1400 },
    ],
    roots: ['card'],
    nodes: [
      root,
      title,
      button,
      node('footer', 'Text', { text: 'Powered by original React components' }),
      ...(screen === 'form'
        ? [input]
        : [node('image', 'Image', { source: 'product-image', alt: 'Color study' })]),
    ],
  };
  if (screen !== 'unbound') {
    document.inputs = {
      title: { schema: string, required: true },
      name: { schema: string, required: true },
    };
    document.callbacks = {
      onBuy: { parameters: [], returns: 'void' },
      onNameChange: { parameters: [string], returns: 'void' },
    };
    document.fixture = { title: screen === 'form' ? 'Contact us' : 'Color study', name: '' };
    title.props = {};
    title.bindings.text = { kind: 'data', input: 'title', path: [] };
    button.bindings.onPress = { kind: 'callback', callback: 'onBuy' };
    if (screen === 'form') {
      delete input.props.value;
      input.bindings = {
        value: { kind: 'data', input: 'name', path: [] },
        onChange: { kind: 'callback', callback: 'onNameChange' },
      };
    }
  }
  if (screen === 'tokens') {
    document.environment = referenceTokenEnvironment;
    root.layout.base.gap = { kind: 'token', tokenId: 'space.gap' };
    title.layout.base.color = { kind: 'token', tokenId: 'brand.color' };
  }
  return loadReactUiDocument(document);
}
export function referenceResolutionFor(
  environment: ReactUiDocument['environment']['ref'],
): ReactRuntimeResolution | undefined {
  const supported = [
    referenceEnvironment,
    referenceTokenEnvironment,
    referenceEnvironmentRevision,
  ].find((candidate) => reuseHash(candidate.ref) === reuseHash(environment));
  return supported ? { ...referenceResolution, environment: supported.ref } : undefined;
}
export const referenceRuntimeAdapter: ReactRuntimeAdapter = {
  async exportDependencies({ environment, signal }) {
    if (signal.aborted || !referenceResolutionFor(environment))
      throw new Error('Pinned export environment unavailable');
    const dependencies = referenceEnvironment.dependencies;
    return {
      diagnostics: [],
      files: [
        {
          dependencyId: 'theme-css',
          path: 'styles/tokens.css',
          hash: dependencies.find((d) => d.id === 'theme-css')!.hash,
          bytes: new TextEncoder().encode(css),
        },
        {
          dependencyId: 'product-image',
          path: 'assets/product.png',
          hash: dependencies.find((d) => d.id === 'product-image')!.hash,
          bytes: Uint8Array.from(atob(image.split(',')[1]), (c) => c.charCodeAt(0)),
        },
      ],
    };
  },
  async resolve({ environment, components, signal }) {
    if (signal.aborted) throw new Error('Resolution aborted');
    const resolution = referenceResolutionFor(environment);
    const ok =
      resolution &&
      components.every((ref) =>
        referenceResolution.components.some((c) => reuseHash(c) === reuseHash(ref)),
      );
    return ok
      ? { resolution, diagnostics: [] }
      : {
          diagnostics: [
            {
              code: 'runtime-unresolved',
              severity: 'error',
              path: '$.environment',
              message: 'The pinned Host build is unavailable.',
              recovery:
                'Keep the composition and supply the matching Host build or explicitly adopt a revision.',
            },
          ],
        };
  },
  previewEndpoint(environment) {
    const url = new URL(window.location.origin);
    url.port = import.meta.env.DEV ? '5174' : '4174';
    url.pathname = '/';
    url.searchParams.set('parentOrigin', window.location.origin);
    return { url: url.href, environment };
  },
};
