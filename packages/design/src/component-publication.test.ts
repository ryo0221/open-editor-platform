import { expect, it } from 'vitest';
import { createDesign, createComponent, makeDesignElement } from './model';
import { publishDesignComponent } from './component-publication';
import type { DesignWebComponent } from './web-contract';
import { EditorSession } from '@editor-platform/editor-core';

function fixture() {
  const image = { ...makeDesignElement('image'), id: 'image', name: 'Image' };
  const body = { ...makeDesignElement('frame'), id: 'body', name: 'Body' };
  const content = createComponent([image.id, body.id], 'card').apply({
    ...createDesign(),
    elements: [image, body],
  });
  const web: DesignWebComponent = { symbol: 'Card', version: '1.0.0', props: {}, variants: {} };
  return { content, web };
}
it('refuses image parts with non-image semantics before constructing a publication command', () => {
  const { content, web } = fixture();
  expect(() => publishDesignComponent(content, 'card', web, { image: 'div', body: 'div' })).toThrow(
    /画像|image/i,
  );
  expect(content.components[0].web).toBeUndefined();
});
it('keeps compatible image/native fields and slot IDs undoable through the native command', () => {
  const { content, web } = fixture();
  web.props = Object.fromEntries(
    ['src', 'alt', 'text', 'fill'].map((field) => [
      field,
      {
        schema: { type: 'string' as const },
        required: false,
        target: { elementId: ['src', 'alt'].includes(field) ? 'image' : 'body', field },
      },
    ]),
  );
  web.slots = {
    body: {
      elementId: 'body',
      prop: 'children',
      minimum: 0,
      maximum: 1,
      accepts: [{ registryId: 'native-design', componentId: 'child' }],
    },
  };
  const session = new EditorSession(content);
  const published = session.execute(
    publishDesignComponent(content, 'card', web, { image: 'img', body: 'div' }),
  );
  expect(published.components[0].web).toEqual(web);
  expect(published.components[0].elements?.map((part) => part.id)).toEqual(['image', 'body']);
  expect(session.undo()).toEqual(content);
  expect(session.redo()).toEqual(published);
});
it.each(['text', 'fill'])(
  'refuses an img public %s field at the native publication boundary',
  (field) => {
    const { content, web } = fixture();
    web.props.title = {
      schema: { type: 'string' },
      required: false,
      target: { elementId: 'image', field },
    };
    expect(() =>
      publishDesignComponent(content, 'card', web, { image: 'img', body: 'div' }),
    ).toThrow(/public|公開/i);
    expect(content.components[0].web).toBeUndefined();
  },
);
it('refuses retagging an existing public slot target to img', () => {
  const { content, web } = fixture();
  web.slots = {
    body: {
      elementId: 'body',
      prop: 'children',
      minimum: 0,
      maximum: 1,
      accepts: [{ registryId: 'native-design', componentId: 'child' }],
    },
  };
  const saved = publishDesignComponent(content, 'card', web, { image: 'img', body: 'div' }).apply(
    content,
  );
  expect(() => publishDesignComponent(saved, 'card', web, { image: 'img', body: 'img' })).toThrow(
    /slot|公開/i,
  );
  expect(saved.components[0].elements?.find((part) => part.id === 'body')?.web?.tag).toBe('div');
});
