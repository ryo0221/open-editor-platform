import implementation from './components.tsx?raw';
import css from './styles.css?raw';
import image from '../office/images/quadrants.png?inline';
import { reuseHash } from '@editor-platform/reuse-core';
import {
  sealReactComponent,
  sealReactEnvironment,
  loadReactUiDocument,
  type ReactUiDocument,
  type RegisteredReactComponent,
  type ReactRuntimeResolution,
} from '@editor-platform/react-ui-core';

export const scaleSource = { implementation, css, image };
export const scaleNames = [
  'Box',
  'Section',
  'Card',
  'Text',
  'Heading',
  'Button',
  'Input',
  'Image',
  'Badge',
  'Link',
  'Divider',
  'Metric',
  'Notice',
  'Label',
  'Progress',
  'Avatar',
  'Status',
  'Code',
  'Quote',
  'Caption',
  'Tag',
] as const;
const implementationHash = reuseHash(implementation);
const string = { type: 'string' as const, maxLength: 128 };
export const scaleEnvironment = sealReactEnvironment({
  schemaVersion: 1,
  ref: { id: 'react-ui-scale', version: '1.0.0' },
  reactVersion: '19.1.1',
  dependencies: [
    {
      id: 'scale-ui',
      kind: 'package',
      name: '@scale/ui',
      version: '1.0.0',
      hash: implementationHash,
    },
    { id: 'scale-css', kind: 'css', path: 'styles/scale.css', hash: reuseHash(css) },
    {
      id: 'scale-image',
      kind: 'asset',
      path: 'assets/scale.png',
      mediaType: 'image/png',
      hash: reuseHash(image),
    },
    {
      id: 'scale-provider',
      kind: 'provider',
      import: { source: '@scale/ui', export: 'named', name: 'ThemeProvider' },
      props: {},
      hash: implementationHash,
    },
  ],
  providerOrder: ['scale-provider'],
  stylePolicy: 'allow-literals',
  tokenVariables: {},
});
export const scaleComponents = scaleNames.map((name, index) => {
  const component: Parameters<typeof sealReactComponent>[0] = {
    schemaVersion: 1,
    ref: { registryId: 'scale', componentId: name, version: '1.0.0', implementationHash },
    name,
    import: { source: '@scale/ui', export: 'named', name },
    props: index < 3 ? {} : { text: { schema: string, required: true } },
    events: {},
    slots: {},
    controlledInputs: [],
    layout: 'className',
    requires: ['scale-ui', 'scale-css', 'scale-provider'],
    sampleProps: index < 3 ? {} : { text: `Scale ${name}` },
  };
  if (index < 3)
    component.slots = {
      body: {
        prop: 'children',
        minimum: 0,
        maximum: 32,
        accepts: scaleNames.map((componentId) => ({ registryId: 'scale', componentId })),
      },
      footer: {
        prop: 'footer',
        minimum: 0,
        maximum: 4,
        accepts: scaleNames.map((componentId) => ({ registryId: 'scale', componentId })),
      },
    };
  if (name === 'Input') {
    component.props.value = { schema: string, required: true };
    component.sampleProps.value = '';
    component.events.onChange = { parameters: [string], returns: 'void' };
    component.controlledInputs = [{ valueProp: 'value', eventProp: 'onChange', argumentIndex: 0 }];
  }
  if (name === 'Button') component.events.onPress = { parameters: [], returns: 'void' };
  if (name === 'Image') {
    component.props.source = { schema: { type: 'asset' }, required: true };
    component.sampleProps.source = 'scale-image';
    component.requires.push('scale-image');
  }
  return sealReactComponent(component);
});
export const scaleResolution: ReactRuntimeResolution = {
  environment: scaleEnvironment.ref,
  components: scaleComponents.map((c) => c.ref),
  dependencies: scaleEnvironment.dependencies.map(({ id, hash }) => ({ id, hash })),
};
export function scaleNode(
  id: string,
  component: RegisteredReactComponent,
): ReactUiDocument['nodes'][number] {
  return {
    id,
    component: component.ref,
    props: { ...component.sampleProps },
    bindings: {},
    slots: {},
    layout: { base: {}, breakpoints: {} },
  };
}
export function createScaleDocument(): ReactUiDocument {
  const root = scaleNode('root', scaleComponents[0]);
  root.slots = { body: [], footer: [] };
  root.layout = {
    base: {
      display: { kind: 'literal', value: 'grid' },
      gridTemplateColumns: { kind: 'literal', value: '1fr' },
    },
    breakpoints: {
      desktop: { gridTemplateColumns: { kind: 'literal', value: 'repeat(2, minmax(0, 1fr))' } },
      wide: { gridTemplateColumns: { kind: 'literal', value: 'repeat(3, minmax(0, 1fr))' } },
    },
  };
  const nodes = [root];
  let leafIndex = 0;
  for (let sectionIndex = 0; sectionIndex < 6; sectionIndex++) {
    const section = scaleNode(`section-${sectionIndex}`, scaleComponents[1]);
    section.slots = { body: [], footer: [] };
    nodes.push(section);
    root.slots.body.push(section.id);
    for (let within = 0; within < 3; within++) {
      const cardIndex = sectionIndex * 3 + within;
      const card = scaleNode(`card-${cardIndex}`, scaleComponents[2]);
      card.slots = { body: [], footer: [] };
      nodes.push(card);
      section.slots.body.push(card.id);
      for (let i = 0; i < 26 + Number(cardIndex < 7); i++, leafIndex++) {
        const component = scaleComponents[3 + (leafIndex % 18)];
        const leaf = scaleNode(`leaf-${String(leafIndex).padStart(3, '0')}`, component);
        leaf.props.text = `Item ${leafIndex}`;
        if (component.name === 'Input') {
          delete leaf.props.value;
          leaf.bindings = {
            value: { kind: 'data', input: 'name', path: [] },
            onChange: { kind: 'callback', callback: 'onNameChange' },
          };
        }
        if (component.name === 'Button')
          leaf.bindings.onPress = { kind: 'callback', callback: 'onAction' };
        nodes.push(leaf);
        card.slots[cardIndex === 0 && i === 26 ? 'footer' : 'body'].push(leaf.id);
      }
    }
  }
  return loadReactUiDocument({
    schemaVersion: 1,
    domain: 'react-ui',
    environment: scaleEnvironment,
    components: scaleComponents,
    inputs: { name: { schema: string, required: true } },
    callbacks: {
      onNameChange: { parameters: [string], returns: 'void' },
      onAction: { parameters: [], returns: 'void' },
    },
    fixture: { name: '' },
    breakpoints: [
      { id: 'desktop', minWidth: 1024 },
      { id: 'wide', minWidth: 1400 },
    ],
    roots: ['root'],
    nodes,
  });
}
