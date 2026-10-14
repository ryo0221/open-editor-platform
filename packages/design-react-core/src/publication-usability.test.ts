import { expect, it } from 'vitest';
import { clone } from '@editor-platform/artifact-core';
import { EditorSession } from '@editor-platform/editor-core';
import {
  createComponent,
  isDesign,
  designDrawings,
  makeDesignElement,
} from '@editor-platform/design/model';
import { readFileSync } from 'node:fs';
import { publicationParts, publishDesignComponent } from '@editor-platform/design/publication';
import { designReactFixture } from './fixture';
import { convertDesignToReact, exportDesignReact } from './convert';
import { retainDesignPublications } from './commands';
import { referenceResolution } from '../../../apps/react-ui-reference/src/catalog';
it('retains singleton image semantics/alt/fit/crop through creation and strict publication, Undo and native reload', () => {
  const source = designReactFixture();
  const image = {
    ...makeDesignElement('image'),
    id: 'native-image',
    parentId: 'home',
    src: `data:image/png;base64,${readFileSync('tests/fixtures/office/images/quadrants.png').toString('base64')}`,
    alt: '色の比較画像',
    imageFit: 'fit' as const,
    crop: { x: 0, y: 0, scale: 1 },
    web: { tag: 'img' as const },
  };
  source.elements.push(image);
  expect(convertDesignToReact(source).diagnostics).toEqual([]);
  const session = new EditorSession(source);
  session.execute(createComponent(image.id, 'image-component'));
  const created = session.content;
  const component = created.components.find((component) => component.id === 'image-component')!;
  expect(component.template).toMatchObject({
    alt: image.alt,
    web: image.web,
    imageFit: image.imageFit,
    crop: image.crop,
  });
  const root = publicationParts(component)[0];
  session.execute(
    publishDesignComponent(
      created,
      component.id,
      { symbol: 'NativeImage', version: '1.0.0', props: {}, variants: {} },
      { [root.id]: 'img' },
    ),
  );
  const reloaded = JSON.parse(JSON.stringify(session.content));
  expect(isDesign(reloaded)).toBe(true);
  expect(convertDesignToReact(reloaded).diagnostics).toEqual([]);
  const output = exportDesignReact(reloaded, referenceResolution);
  expect(Object.values(output.files).join('\n')).toContain('色の比較画像');
  expect(Object.values(output.files).join('\n')).toContain('contain');
  expect(session.undo()).toEqual(created);
  expect(session.undo()).toEqual(source);
  expect(source.elements.find((element) => element.id === image.id)).toEqual(image);
});
it('publishes a singleton made from text without detaching and exports its public prop/slot contract', () => {
  const source = designReactFixture();
  const original = source.elements.find((element) => element.id === 'heading')!;
  const create = createComponent(original.id, 'new-public-component');
  expect(create.apply(source)).toEqual(create.apply(source));
  const native = create.apply(source),
    component = native.components.find((component) => component.id === 'new-public-component')!;
  const part = publicationParts(component)[0];
  const web = {
    symbol: 'UiMadeText',
    version: '1.0.0',
    props: {
      text: {
        schema: { type: 'string' as const },
        required: false,
        default: original.text,
        target: { elementId: part.id, field: 'text' },
      },
    },
    variants: {},
    slots: {
      body: {
        elementId: part.id,
        prop: 'children',
        minimum: 0,
        maximum: 10,
        accepts: [
          {
            registryId: source.web!.registrations[0].ref.registryId,
            componentId: source.web!.registrations[0].ref.componentId,
          },
        ],
      },
    },
  };
  const session = new EditorSession(native),
    before = clone(native);
  session.execute(publishDesignComponent(native, component.id, web, { [part.id]: 'h1' }));
  expect(isDesign(session.content)).toBe(true);
  expect(session.content.elements.find((element) => element.id === original.id)?.type).toBe(
    'instance',
  );
  expect(session.content.elements.find((element) => element.id === original.id)?.bounds).toEqual(
    original.bounds,
  );
  const converted = convertDesignToReact(session.content);
  expect(converted.diagnostics).toEqual([]);
  const generated = converted.components.find(
    (component) => component.sourceId === 'new-public-component',
  )!;
  expect(generated.registration.props.text.default).toBe(original.text);
  expect(generated.registration.slots.body.prop).toBe('children');
  expect(
    Object.values(exportDesignReact(session.content, referenceResolution).files).join('\n'),
  ).toContain('UiMadeText');
  expect(session.undo()).toEqual(before);
});
it('reports the unpublished native component as the primary error and retains strict validation on success', () => {
  const native = createComponent('heading').apply(designReactFixture());
  const diagnostics = convertDesignToReact(native).diagnostics;
  expect(diagnostics.some((diagnostic) => diagnostic.code === 'component-semantics')).toBe(true);
  expect(
    diagnostics.some((diagnostic) =>
      diagnostic.message.includes('Referenced node heading is missing'),
    ),
  ).toBe(false);
  expect(() => exportDesignReact(native, referenceResolution)).toThrow(
    'Publish explicit semantics',
  );
});
it('rejects stale edits and changes to an already published version while allowing a new version', () => {
  const source = designReactFixture(),
    component = source.components[0];
  const semantics = Object.fromEntries(
    component.elements!.map((part) => [part.id, part.web!.tag!]),
  );
  const retained = retainDesignPublications(convertDesignToReact(source)).apply(source);
  const changed = { ...component.web!, symbol: 'UpdatedCard' };
  const pending = publishDesignComponent(source, component.id, changed, semantics);
  expect(() => pending.apply(retained)).toThrow('公開版');
  expect(() => publishDesignComponent(retained, component.id, changed, semantics)).toThrow(
    '公開版',
  );
  const edit = publishDesignComponent(
    retained,
    component.id,
    { ...changed, version: '2.0.0' },
    semantics,
  );
  const updated = edit.apply(retained);
  expect(updated.web!.publications).toEqual(retained.web!.publications);
  const stale = clone(retained);
  stale.components[0].name = 'Externally changed';
  expect(() => edit.apply(stale)).toThrow('変更されました');
});
it('preserves existing singleton root text/fill overrides on every instance across publication and Undo', () => {
  const source = designReactFixture();
  // This is a literal-text publication; page input bindings belong to a public prop.
  delete source.elements.find((element) => element.id === 'heading')!.web!.bindings;
  const native = createComponent('heading', 'singleton').apply(source);
  const first = native.elements.find((element) => element.id === 'heading')!;
  first.overrides = { root: { text: '日本語の個別本文', fill: '#cc2233' } };
  if (first.web) delete first.web.bindings;
  native.elements.push({
    ...clone(first),
    id: 'second-instance',
    overrides: { root: { text: '別の本文', fill: '#2244cc' } },
  });
  const component = native.components.find((component) => component.id === 'singleton')!;
  const part = publicationParts(component)[0];
  const session = new EditorSession(native);
  session.execute(
    publishDesignComponent(
      native,
      component.id,
      { symbol: 'SingletonText', version: '1.0.0', props: {}, variants: {} },
      { [part.id]: 'h1' },
    ),
  );
  expect(
    session.content.elements
      .filter((element) => element.componentId === 'singleton')
      .map((element) => element.overrides?.[part.id]?.text),
  ).toEqual(['日本語の個別本文', '別の本文']);
  const converted = convertDesignToReact(session.content);
  expect(converted.diagnostics).toEqual([]);
  const rendered = session.content.elements
    .filter((element) => element.componentId === 'singleton')
    .map((element) => designDrawings(session.content, element)[0]);
  expect(rendered.map((drawing) => drawing.text)).toEqual(['日本語の個別本文', '別の本文']);
  expect(rendered.map((drawing) => drawing.fill)).toEqual(['#cc2233', '#2244cc']);
  expect(session.undo()).toEqual(native);
  session.redo();
  expect(
    session.content.elements.find((element) => element.id === 'heading')?.overrides?.[part.id]
      ?.fill,
  ).toBe('#cc2233');
});
