import { expect, it } from 'vitest';
import { clone, contentHash, canonicalJson } from '@editor-platform/artifact-core';
import {
  ReferenceResolver,
  referenceKey,
  validEmbeddedReference,
  validReferenceItems,
  validReferenceSource,
  assertReferenceItems,
  type ReferenceSnapshot,
} from '@editor-platform/artifact-references';
import { createRelationGraph, relationProfile } from '@editor-platform/structured-graph/model';
import { createData, isStructuredData, validateData } from '@editor-platform/structured-data';
import { defaultView } from '@editor-platform/structured-data/views';
import { createDeck, makeSlideObject, isDeck } from '@editor-platform/slide/model';
import { createDocument, makeBlock, isDocument } from '@editor-platform/document/model';
import { createDesign, makeDesignElement, isDesign } from '@editor-platform/design/model';
import {
  createWhiteboard,
  makeWhiteboardNode,
  isWhiteboard,
} from '@editor-platform/whiteboard/model';
import { nativeReferenceAdapters } from './index';

async function fixture() {
  const content = createRelationGraph();
  const snapshot: ReferenceSnapshot = {
    artifactId: 'graph',
    domain: 'structured-graph',
    revision: 1,
    versionId: 'v1',
    content,
    contentHash: await contentHash(content),
    dependencies: [
      {
        id: `profile:${relationProfile.id}:${relationProfile.version}`,
        content: clone(relationProfile),
        contentHash: await contentHash(relationProfile),
      },
    ],
  };
  const source = {
    artifactId: snapshot.artifactId,
    domain: snapshot.domain,
    target: { kind: 'graph', viewId: content.id },
  };
  const resolver = new ReferenceResolver(
    { list: async () => [], read: async () => snapshot, subscribe: () => () => {} },
    nativeReferenceAdapters,
    'destination',
  );
  return { resolver, reference: await resolver.create(source, 'fixed') };
}
for (const field of ['content', 'dependency'] as const) {
  for (const mode of ['fixed', 'follow'] as const) {
    for (const reverse of [false, true]) {
      it(`revalidates changed retained ${field} bytes with unchanged declared hashes (${mode}, reverse=${reverse})`, async () => {
        const { resolver, reference: original } = await fixture();
        const reference = { ...original, mode };
        expect((await resolver.refresh(reference)).status).toBe('ready');
        const bad = clone(reference);
        if (field === 'content')
          (
            bad.snapshot.content as ReturnType<typeof createRelationGraph>
          ).nodes[0].attributes.name = 'Tampered';
        else
          (bad.snapshot.dependencies[0].content as typeof relationProfile).nodes.entity.ui = {
            labelField: 'category',
          };
        expect(validEmbeddedReference(bad)).toBe(true);
        expect(bad.snapshot.contentHash).toBe(reference.snapshot.contentHash);
        expect(bad.snapshot.dependencies[0].contentHash).toBe(
          reference.snapshot.dependencies[0].contentHash,
        );
        expect(resolver.get(bad).status).toBe('loading');
        expect(referenceKey(bad)).not.toBe(referenceKey(reference));
        const stop = resolver.observe(reverse ? [bad, reference] : [reference, bad], () => {});
        try {
          await expect.poll(() => resolver.get(bad).status).toBe('error');
          expect(resolver.get(bad).projection).toBeUndefined();
          expect(resolver.get(bad).message).toContain('hash');
          await expect(resolver.capture([{ id: 'image', reference: bad }])).rejects.toMatchObject({
            status: 'error',
          });
          await expect.poll(() => resolver.get(reference).status).toBe('ready');
        } finally {
          stop();
        }
      });
    }
  }
}
for (const targetId of ['constructor', 'prototype', '__proto__']) {
  for (const mode of ['fixed', 'follow'] as const) {
    it(`retains native Data target ID ${targetId} through ${mode} create/refresh/capture`, async () => {
      const content = createData();
      content.columns = [{ id: targetId, name: 'Value', type: 'number' }];
      content.rows = [{ id: targetId, values: Object.fromEntries([[targetId, 95]]) }];
      content.views = [{ ...defaultView(content), id: targetId }];
      expect(isStructuredData(content)).toBe(true);
      expect(validateData(content)).toEqual([]);
      const snapshot: ReferenceSnapshot = {
        artifactId: 'data',
        domain: 'data',
        versionId: 'v1',
        revision: 1,
        content,
        contentHash: await contentHash(content),
        dependencies: [],
      };
      const source = {
        artifactId: 'data',
        domain: 'data',
        target: { kind: 'table', viewId: targetId, rowIds: [targetId], columnIds: [targetId] },
      };
      const resolver = new ReferenceResolver(
        {
          list: async () => [{ label: targetId, source }],
          read: async () => snapshot,
          subscribe: () => () => {},
        },
        nativeReferenceAdapters,
      );
      expect(validReferenceSource(source)).toBe(true);
      const before = canonicalJson(snapshot);
      for (const viewId of [targetId, 'default']) {
        const ref = await resolver.create(
          { ...source, target: { ...source.target, viewId } },
          mode,
        );
        expect((await resolver.refresh(ref)).status).toBe('ready');
        const captured = await resolver.capture([{ id: 'image', reference: ref, src: '' }]);
        expect(canonicalJson(captured[0].reference.snapshot)).toBe(before);
        expect(Buffer.from(captured[0].src!.split(',')[1], 'base64').toString()).toContain('>95<');
      }
      expect(Object.prototype).not.toHaveProperty('polluted');
    });
  }
}
it('still rejects empty, oversized, duplicate and non-string native target IDs', () => {
  const source = {
    artifactId: 'data',
    domain: 'data',
    target: { kind: 'table', viewId: 'default' },
  };
  for (const viewId of ['', 'x'.repeat(513), 7])
    expect(validReferenceSource({ ...source, target: { ...source.target, viewId } })).toBe(false);
  for (const rowIds of [[''], ['x'.repeat(513)], ['same', 'same'], [7], Array(1)])
    expect(validReferenceSource({ ...source, target: { ...source.target, rowIds } })).toBe(false);
});

for (const kind of ['slide', 'document', 'design', 'whiteboard'] as const) {
  it(`rejects inherited references in the ${kind} native validator and aggregate guard`, async () => {
    const { reference } = await fixture();
    const make = () =>
      kind === 'slide'
        ? makeSlideObject('image', 0)
        : kind === 'document'
          ? makeBlock('image')
          : kind === 'design'
            ? makeDesignElement('image')
            : makeWhiteboardNode('image');
    const items = Array.from({ length: 65 }, (_, index) => {
      const item = { ...make(), id: `image-${index}` };
      delete item.reference;
      return Object.setPrototypeOf(item, { reference });
    });
    expect(validReferenceItems([items[0]])).toBe(false);
    expect(validReferenceItems(items)).toBe(false);
    expect(() => assertReferenceItems(items)).toThrow();
    if (kind === 'slide') {
      const content = createDeck();
      content.slides[0].objects = items as (typeof content.slides)[0]['objects'];
      expect(isDeck(content)).toBe(false);
    } else if (kind === 'document')
      expect(isDocument({ ...createDocument(), blocks: items })).toBe(false);
    else if (kind === 'design')
      expect(isDesign({ ...createDesign(), elements: items })).toBe(false);
    else expect(isWhiteboard({ ...createWhiteboard(), nodes: items })).toBe(false);
    expect(validReferenceItems([{ id: 'own', reference }])).toBe(true);
  });
}
it('does not invoke inherited or own reference accessors, and allows an explicit own undefined shadow', async () => {
  const { reference } = await fixture();
  let reads = 0;
  const prototype = Object.defineProperty({}, 'reference', {
    get() {
      reads++;
      return reference;
    },
  });
  expect(validReferenceItems([Object.assign(Object.create(prototype), { id: 'inherited' })])).toBe(
    false,
  );
  expect(
    validReferenceItems([
      Object.defineProperty({ id: 'own' }, 'reference', {
        get() {
          reads++;
          return reference;
        },
      }),
    ]),
  ).toBe(false);
  const shadow = Object.assign(Object.create({ reference }), {
    id: 'shadow',
    reference: undefined,
  });
  expect(validReferenceItems([shadow])).toBe(true);
  expect(reads).toBe(0);
});
