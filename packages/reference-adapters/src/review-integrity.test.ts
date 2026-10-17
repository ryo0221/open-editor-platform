import { expect, it } from 'vitest';
import { clone, contentHash } from '@editor-platform/artifact-core';
import {
  containsEmbeddedReference,
  ReferenceError,
  ReferenceResolver,
  validEmbeddedReference,
  validReferenceSnapshot,
  validReferenceSource,
  type ReferenceSnapshot,
  type ReferenceSource,
} from '@editor-platform/artifact-references';
import { createData } from '@editor-platform/structured-data';
import { createDesign, isDesign, makeDesignElement } from '@editor-platform/design/model';
import { designEditorCodec } from '@editor-platform/collaboration-adapters';
import { saveAsTemplate, expandTemplate } from '@editor-platform/templates';
import { nativeReferenceAdapters } from './index';

async function fixture() {
  const source: ReferenceSource = {
    artifactId: 'source',
    domain: 'data',
    target: { kind: 'table', viewId: 'default' },
  };
  const content = createData();
  const snapshot: ReferenceSnapshot = {
    artifactId: source.artifactId,
    domain: source.domain,
    versionId: 'v1',
    revision: 1,
    content,
    contentHash: await contentHash(content),
    dependencies: [],
  };
  const resolver = new ReferenceResolver(
    {
      list: async () => [],
      read: async () => snapshot,
      subscribe: () => () => {},
    },
    nativeReferenceAdapters,
    'destination',
  );
  return { source, snapshot, resolver, reference: await resolver.create(source, 'follow') };
}

it('rejects sparse dependency, target and native arrays at synchronous and resolver boundaries', async () => {
  const { source, snapshot, reference, resolver } = await fixture();
  const sparse = Array(1);
  const malformed = { ...snapshot, dependencies: sparse };
  expect(validReferenceSnapshot(malformed)).toBe(false);
  expect(validEmbeddedReference({ ...reference, snapshot: malformed })).toBe(false);
  expect(validReferenceSource({ ...source, target: { ...source.target, rowIds: sparse } })).toBe(
    false,
  );
  expect(validReferenceSnapshot({ ...snapshot, content: { rows: sparse } })).toBe(false);
  // A partial hole and an inherited index are not own JSON values either.
  const partial = [null, null, null];
  delete partial[1];
  const inherited = Object.setPrototypeOf(Array(1), { 0: null });
  for (const values of [partial, inherited])
    expect(validReferenceSnapshot({ ...snapshot, content: values })).toBe(false);
  await expect(resolver.validate(malformed, source)).rejects.toMatchObject({ status: 'error' });
  expect(await resolver.refresh({ ...reference, snapshot: malformed })).toEqual({
    status: 'error',
    message: '参照情報が不正です。',
  });
  await expect(
    resolver.capture([{ id: 'image', reference: { ...reference, snapshot: malformed } }], false),
  ).rejects.toMatchObject({ status: 'error' });
  expect(validReferenceSnapshot({ ...snapshot, content: [null, 0, 'value'] })).toBe(true);
});

it('preserves ordinary reference web props through native, shared and template validation', async () => {
  const { reference } = await fixture();
  const design = createDesign();
  const webProps = {
    reference: 'label',
    nested: { reference: { source: 'ordinary', snapshot: 'data' } },
  };
  const part = { ...makeDesignElement('text'), webProps };
  design.components = [
    {
      id: 'component',
      name: 'Component',
      width: 100,
      height: 100,
      template: { type: 'text', text: '', fill: 'none' },
      elements: [part],
    },
  ];
  design.elements = [{ ...makeDesignElement('instance'), componentId: 'component', webProps }];
  expect(containsEmbeddedReference(design)).toBe(false);
  expect(isDesign(design)).toBe(true);
  expect(designEditorCodec.validate(design)).toBe(true);
  const definition = await saveAsTemplate({
    domain: 'design',
    content: design,
    name: 'Reference prop',
    purpose: 'Compatibility',
    category: 'test',
    kind: 'whole',
    slots: [],
  });
  const expanded = expandTemplate(definition, definition.sample).content;
  expect(isDesign(expanded)).toBe(true);
  expect(JSON.stringify(expanded)).toContain('"reference":"label"');
  const embedded = clone(design);
  embedded.elements.push({ ...makeDesignElement('image'), reference });
  expect(containsEmbeddedReference(embedded)).toBe(true);
  expect(designEditorCodec.validate(embedded)).toBe(false);
  // No accessor is evaluated by capability detection.
  expect(
    containsEmbeddedReference({
      reference: Object.defineProperty({}, 'source', {
        get() {
          throw Error('must not execute');
        },
      }),
    }),
  ).toBe(false);
});

for (const mode of ['fixed', 'follow'] as const) {
  for (const outcome of ['forbidden', 'offline'] as const) {
    it(`hides ready ${mode} pixels during asynchronous access revalidation (${outcome})`, async () => {
      const { resolver, reference } = await fixture();
      const ref = { ...reference, mode };
      await resolver.refresh(ref);
      const before = resolver.get(ref);
      expect(before.projection).toBeDefined();
      let deny!: () => void;
      let checks = 0;
      resolver.host.checkAccess = () => {
        checks++;
        return new Promise<void>((_resolve, reject) => {
          deny = () => reject(new ReferenceError(outcome, outcome));
        });
      };
      const pending = resolver.refresh(ref);
      expect(checks).toBe(1);
      expect(resolver.get(ref)).toEqual({ status: 'loading', snapshot: before.snapshot });
      deny();
      const result = await pending;
      expect(result.status).toBe(outcome);
      expect(result.projection).toEqual(outcome === 'offline' ? before.projection : undefined);
    });
  }
}
