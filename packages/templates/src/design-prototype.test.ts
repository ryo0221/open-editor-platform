import { expect, it } from 'vitest';
import { prototypeFixture } from '../../../tests/fixtures/design-prototype/content';
import { diagnoseDesignPrototype, designPrototypeTargets } from '@editor-platform/design';
import { type DesignContent } from '@editor-platform/design/model';
import { remapNative, saveAsTemplate, prepareInstantiation } from './index';
it('copies named flows and scoped component target references through native templates', async () => {
  const source = prototypeFixture();
  source.elements[0].webProps = {
    frameId: 'Review',
    frameIds: ['Home'],
    interactions: [{ trigger: 'click', action: { type: 'navigate', frameId: 'Done' } }],
  };
  const mapped = remapNative(source, undefined, 'copy');
  expect(diagnoseDesignPrototype(mapped.content)).toEqual([]);
  expect(mapped.content.prototyping!.flows[0].frameIds).toEqual(
    source.prototyping!.flows[0].frameIds.map((id) => mapped.ids.get(id)),
  );
  expect(mapped.content.prototyping!.flows[0].name).toBe('Five screen flow');
  expect(mapped.content.elements[0].webProps).toEqual(source.elements[0].webProps);
  const definition = await saveAsTemplate({
    domain: 'design',
    content: source,
    kind: 'whole',
    name: 'Prototype',
    purpose: 'Screen flow',
    category: 'test',
    slots: [],
  });
  const copy = (await prepareInstantiation(definition, {}, 'prototype-copy')).artifact.draft
    .content as DesignContent;
  expect(diagnoseDesignPrototype(copy)).toEqual([]);
  expect(copy.prototyping!.flows[0].frameIds[0]).not.toBe('Home');
  expect(
    designPrototypeTargets(copy, copy.prototyping!.flows[0].frameIds[0]).find(
      (t) => t.name === 'Continue',
    )!.interactions[0].action,
  ).toEqual({ type: 'navigate', frameId: copy.prototyping!.flows[0].frameIds[1] });
});
