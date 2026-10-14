import { expect, it } from 'vitest';
import {
  createReferenceDocument,
  referenceEnvironmentRevision,
  referenceTextRevision,
} from '../../../apps/react-ui-reference/src/catalog';
import { prepareReactUiRevision, reactUiCommand, sealReactComponent } from './index';
it('keeps old pins and requires explicit prop mapping, preserving stable IDs, bindings and explicit values', () => {
  const document = createReferenceDocument('form');
  const candidate = {
    component: referenceTextRevision,
    nodeIds: ['title'],
    propMap: {},
    slotMap: {},
  };
  expect(() => prepareReactUiRevision(document, candidate)).toThrow();
  const prepared = prepareReactUiRevision(document, { ...candidate, propMap: { text: 'content' } });
  expect(prepared.after.nodes.find((n) => n.id === 'title')!.bindings).toEqual({
    content: { kind: 'data', input: 'title', path: [] },
  });
  expect(prepared.after.roots).toEqual(document.roots);
  expect(prepared.after.nodes.map((n) => n.id)).toEqual(document.nodes.map((n) => n.id));
  expect(prepared.after.components).toContainEqual(
    document.components.find((c) => c.name === 'Text'),
  );
  const changed = reactUiCommand([
    { type: 'set-prop', nodeId: 'buy', prop: 'label', value: 'Changed' },
  ]).apply(document);
  expect(() => prepared.command.apply(changed)).toThrow(/stale/);
  expect(prepared.command.apply(document)).toEqual(prepared.after);
});
it('maps a renamed named slot while retaining children order and rejects destructive collisions', () => {
  const document = createReferenceDocument();
  const original = document.components.find((c) => c.name === 'Card')!;
  const revision = sealReactComponent({
    ...original,
    ref: {
      registryId: original.ref.registryId,
      componentId: original.ref.componentId,
      version: '2.0.0',
      implementationHash: original.ref.implementationHash,
    },
    import: { source: '@reference/card-v2', export: 'named', name: 'Card' },
    slots: { main: original.slots.body, aside: { ...original.slots.footer, prop: 'aside' } },
  });
  const candidate = {
    component: revision,
    nodeIds: ['card'],
    propMap: {},
    slotMap: { body: 'main', footer: 'aside' },
  };
  const prepared = prepareReactUiRevision(document, candidate);
  expect(prepared.after.nodes[0].slots).toEqual({
    main: ['image', 'title', 'buy'],
    aside: ['footer'],
  });
  expect(() =>
    prepareReactUiRevision(document, { ...candidate, slotMap: { body: 'main', footer: 'main' } }),
  ).toThrow(/discard/);
});
it('adopts an explicit environment revision without replacing references or data', () => {
  const document = createReferenceDocument('form');
  const prepared = prepareReactUiRevision(document, {
    environment: referenceEnvironmentRevision,
    nodeIds: [],
    propMap: {},
    slotMap: {},
  });
  expect(prepared.after.nodes).toEqual(document.nodes);
  expect(prepared.after.fixture).toEqual(document.fixture);
  expect(prepared.after.environment.ref.version).toBe('2.0.0');
});
