import { clone } from '@editor-platform/artifact-core';
import {
  createDesign,
  makeDesignElement,
  type DesignContent,
  type DesignElement,
} from '@editor-platform/design/model';
import { referenceDesignSettings } from '../../../apps/react-ui-reference/src/design-catalog';
import { referenceComponents } from '../../../apps/react-ui-reference/src/catalog';
/** Native contract fixture only. Ordinary UI authors its own acceptance artifacts. */
export function designReactFixture(): DesignContent {
  const native = (
    type: DesignElement['type'],
    id: string,
    parentId: string | undefined,
    tag: NonNullable<DesignElement['web']>['tag'],
    text = '',
    width = 320,
    height = 80,
  ): DesignElement => ({
    ...makeDesignElement(type),
    id,
    name: id,
    text,
    bounds: { x: 0, y: 0, width, height },
    fill: type === 'text' ? '#243a53' : '#ffffff',
    ...(parentId ? { parentId } : {}),
    ...(tag ? { web: { tag } } : {}),
    sizing: 'hug',
  });
  const frame = native('frame', 'home', undefined, 'main', '', 800, 600);
  frame.sizing = 'fill';
  frame.layout = { direction: 'column', gap: 16, padding: 24, align: 'start', sizing: 'hug' };
  const contact = native('frame', 'contact', undefined, 'main', '', 800, 600);
  contact.layout = clone(frame.layout);
  contact.bounds.x = 1000;
  const part = native('frame', 'card-frame', undefined, 'article', '', 320, 160);
  part.layout = { direction: 'column', gap: 8, padding: 16, align: 'start', sizing: 'hug' };
  const title = native('text', 'card-title', 'card-frame', 'h2', 'Color study', 280, 64);
  const original = (
    name: string,
    id: string,
    parentId: string,
    bindings: NonNullable<DesignElement['react']>['bindings'] = {},
  ): DesignElement => {
    const c = referenceComponents.find((c) => c.name === name)!;
    const props = clone(c.sampleProps);
    for (const key of Object.keys(bindings)) delete props[key];
    return {
      ...native('react', id, parentId, undefined),
      react: { component: c.ref, import: c.import, props, bindings, slots: {} },
    };
  };
  const design: DesignContent = {
    ...createDesign(),
    web: {
      ...clone(referenceDesignSettings),
      inputs: {
        title: { schema: { type: 'string', maxLength: 80 }, required: true },
        name: { schema: { type: 'string', maxLength: 80 }, required: true },
      },
      callbacks: {
        onBuy: { parameters: [], returns: 'void' },
        onNameChange: { parameters: [{ type: 'string', maxLength: 80 }], returns: 'void' },
      },
      fixture: { title: 'Color study', name: '' },
      pages: [
        { frameId: 'home', symbol: 'ProductPage', path: '/' },
        { frameId: 'contact', symbol: 'ContactPage', path: '/contact' },
      ],
    },
    components: [
      {
        id: 'product-card',
        name: 'ProductCard',
        width: 320,
        height: 160,
        template: { type: 'frame', text: '', fill: '#ffffff' },
        elements: [part, title],
        web: {
          symbol: 'ProductCard',
          version: '1.0.0',
          props: {
            title: {
              schema: { type: 'string', maxLength: 80 },
              required: false,
              default: 'Color study',
              target: { elementId: 'card-title', field: 'text' },
            },
          },
          variants: { default: {}, blue: { 'card-title': { fill: '#1266aa' } } },
        },
      },
    ],
    elements: [
      frame,
      {
        ...native('instance', 'card', 'home', undefined),
        componentId: 'product-card',
        webProps: { title: 'Native product' },
      },
      original('Button', 'buy', 'home', { onPress: { kind: 'callback', callback: 'onBuy' } }),
      {
        ...native('text', 'link', 'home', 'a', 'Contact us'),
        web: { tag: 'a', linkPageId: 'contact' },
      },
      contact,
      {
        ...native('text', 'heading', 'contact', 'h1', 'Contact us'),
        web: { tag: 'h1', bindings: { text: { kind: 'data', input: 'title', path: [] } } },
      },
      original('Input', 'name-input', 'contact', {
        value: { kind: 'data', input: 'name', path: [] },
        onChange: { kind: 'callback', callback: 'onNameChange' },
      }),
      original('Button', 'submit', 'contact', { onPress: { kind: 'callback', callback: 'onBuy' } }),
    ],
  };
  return design;
}
