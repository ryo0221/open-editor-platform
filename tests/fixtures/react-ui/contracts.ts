import { reuseHash, sealReusableDefinition, type TokenSet } from '@editor-platform/reuse-core';
import {
  sealReactComponent,
  sealReactEnvironment,
  type RegisteredReactComponent,
  type ReactUiDocument,
  type ReactRuntimeResolution,
} from '@editor-platform/react-ui-core';

/** Synthetic W1 metadata only: these hashes do not attest to real React implementation bytes. */
export async function reactUiContractFixture(): Promise<{
  document: ReactUiDocument;
  resolution: ReactRuntimeResolution;
}> {
  const tokens = await sealReusableDefinition<TokenSet>({
    schemaVersion: 1,
    libraryId: 'fixture',
    definitionId: 'theme',
    version: 1,
    kind: 'tokens',
    domain: 'shared',
    name: 'Fixture theme',
    dependencies: [],
    payload: {
      schemaVersion: 1,
      modes: ['light'],
      defaultMode: 'light',
      tokens: {
        'space.base': { type: 'dimension', value: { value: 16, unit: 'px' } },
        'space.gap': { type: 'dimension', value: { alias: 'space.base' } },
        'brand.color': {
          type: 'color',
          value: { colorSpace: 'srgb', components: [0.1, 0.2, 0.3], alpha: 1 },
        },
      },
    },
  });
  const environment = sealReactEnvironment({
    schemaVersion: 1,
    ref: { id: 'fixture-preview', version: '1.0.0' },
    reactVersion: '19.1.1',
    stylePolicy: 'tokens-only',
    tokens,
    tokenMode: 'light',
    tokenVariables: { 'space.gap': '--space-gap', 'brand.color': '--brand-color' },
    dependencies: [
      {
        id: 'ui-package',
        kind: 'package',
        name: '@fixture/ui',
        version: '1.0.0',
        hash: reuseHash('fixture package'),
      },
      { id: 'theme-css', kind: 'css', path: 'styles/tokens.css', hash: reuseHash('fixture CSS') },
      {
        id: 'product-image',
        kind: 'asset',
        path: 'assets/product.png',
        mediaType: 'image/png',
        hash: reuseHash('fixture PNG'),
      },
      {
        id: 'theme-provider',
        kind: 'provider',
        import: { source: '@fixture/ui', export: 'named', name: 'ThemeProvider' },
        props: { theme: 'light' },
        hash: reuseHash('fixture Provider'),
      },
    ],
    providerOrder: ['theme-provider'],
  });
  const register = (componentId: string, value: Partial<RegisteredReactComponent> = {}) =>
    sealReactComponent({
      schemaVersion: 1,
      name: componentId,
      import: { source: '@fixture/ui', export: 'named', name: componentId },
      props: {},
      events: {},
      slots: {},
      controlledInputs: [],
      layout: 'className',
      requires: ['ui-package', 'theme-css', 'theme-provider'],
      sampleProps: {},
      ...value,
      ref: {
        registryId: 'fixture',
        componentId,
        version: '1.0.0',
        implementationHash: reuseHash(`synthetic ${componentId}`),
      },
    });
  const accepted = ['Card', 'Button', 'Image', 'Text', 'Input'].map((componentId) => ({
    registryId: 'fixture',
    componentId,
  }));
  const components = [
    register('Card', {
      slots: {
        body: { prop: 'children', minimum: 1, maximum: 8, accepts: accepted },
        footer: { prop: 'footer', minimum: 0, maximum: 1, accepts: accepted },
      },
    }),
    register('Button', {
      props: {
        label: { schema: { type: 'string', maxLength: 80 }, required: true },
        variant: {
          schema: { type: 'enum', values: ['primary', 'secondary'] },
          required: false,
          default: 'secondary',
        },
      },
      events: { onPress: { parameters: [], returns: 'void' } },
      sampleProps: { label: 'Sample', variant: 'primary' },
    }),
    register('Image', {
      props: {
        source: { schema: { type: 'asset' }, required: true },
        alt: { schema: { type: 'string', maxLength: 80 }, required: true },
      },
      requires: ['ui-package', 'product-image'],
      sampleProps: { source: 'product-image', alt: 'Sample image' },
    }),
    register('Text', {
      props: { text: { schema: { type: 'string', maxLength: 80 }, required: true } },
      sampleProps: { text: 'Sample text' },
    }),
    register('Input', {
      props: { value: { schema: { type: 'string', maxLength: 80 }, required: true } },
      events: { onChange: { parameters: [{ type: 'string', maxLength: 80 }], returns: 'void' } },
      controlledInputs: [{ valueProp: 'value', eventProp: 'onChange', argumentIndex: 0 }],
      sampleProps: { value: 'Sample input' },
    }),
  ];
  const ref = (id: string) => ({ ...components.find((c) => c.ref.componentId === id)!.ref });
  const document: ReactUiDocument = {
    schemaVersion: 1,
    domain: 'react-ui',
    environment,
    components,
    inputs: {
      product: {
        required: true,
        schema: {
          type: 'object',
          fields: { title: { required: true, schema: { type: 'string', maxLength: 80 } } },
        },
      },
      name: { required: true, schema: { type: 'string', maxLength: 80 } },
    },
    callbacks: {
      onBuy: { parameters: [], returns: 'void' },
      onNameChange: { parameters: [{ type: 'string', maxLength: 80 }], returns: 'void' },
    },
    fixture: { product: { title: '商品' }, name: '' },
    breakpoints: [
      { id: 'desktop', minWidth: 1024 },
      { id: 'wide', minWidth: 1400 },
    ],
    roots: ['card'],
    nodes: [
      {
        id: 'card',
        component: ref('Card'),
        props: {},
        bindings: {},
        slots: { body: ['image', 'title', 'input', 'buy'], footer: ['footer'] },
        layout: {
          base: {
            display: { kind: 'literal', value: 'flex' },
            flexDirection: { kind: 'literal', value: 'column' },
            gap: { kind: 'token', tokenId: 'space.gap' },
          },
          breakpoints: {
            desktop: {
              display: { kind: 'literal', value: 'grid' },
              gridTemplateColumns: { kind: 'literal', value: 'repeat(2, minmax(0, 1fr))' },
            },
          },
        },
      },
      {
        id: 'image',
        component: ref('Image'),
        props: { source: 'product-image', alt: '商品画像' },
        bindings: {},
        slots: {},
        layout: { base: {}, breakpoints: {} },
      },
      {
        id: 'title',
        component: ref('Text'),
        props: {},
        bindings: { text: { kind: 'data', input: 'product', path: ['title'] } },
        slots: {},
        layout: { base: { color: { kind: 'token', tokenId: 'brand.color' } }, breakpoints: {} },
      },
      {
        id: 'input',
        component: ref('Input'),
        props: {},
        bindings: {
          value: { kind: 'data', input: 'name', path: [] },
          onChange: { kind: 'callback', callback: 'onNameChange' },
        },
        slots: {},
        layout: { base: {}, breakpoints: {} },
      },
      {
        id: 'buy',
        component: ref('Button'),
        props: { label: '購入する', variant: 'primary' },
        bindings: { onPress: { kind: 'callback', callback: 'onBuy' } },
        slots: {},
        layout: { base: {}, breakpoints: {} },
      },
      {
        id: 'footer',
        component: ref('Text'),
        props: { text: '利用規約' },
        bindings: {},
        slots: {},
        layout: { base: {}, breakpoints: {} },
      },
    ],
  };
  return {
    document,
    resolution: {
      environment: environment.ref,
      components: components.map((c) => c.ref),
      dependencies: environment.dependencies.map(({ id, hash }) => ({ id, hash })),
    },
  };
}
