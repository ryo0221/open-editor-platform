import { expect, it } from 'vitest';
import { clone, contentHash } from '@editor-platform/artifact-core';
import {
  ReferenceResolver,
  containsEmbeddedReference,
  referenceKey,
  validReferenceSnapshot,
  type ReferenceSnapshot,
} from '@editor-platform/artifact-references';
import {
  createRelationGraph,
  relationProfile,
  validateGraph,
} from '@editor-platform/structured-graph/model';
import { createDocument, makeBlock, captureDocumentReferences } from '@editor-platform/document';
import { createData } from '@editor-platform/structured-data';
import { nativeReferenceAdapters } from './index';

async function graphFixture() {
  const content = createRelationGraph();
  const profile = clone(relationProfile);
  const snapshot: ReferenceSnapshot = {
    artifactId: 'graph',
    domain: 'structured-graph',
    versionId: 'v1',
    revision: 1,
    content,
    contentHash: await contentHash(content),
    dependencies: [
      {
        id: `profile:${profile.id}:${profile.version}`,
        content: profile,
        contentHash: await contentHash(profile),
      },
    ],
  };
  const source = {
    artifactId: 'graph',
    domain: 'structured-graph',
    target: { kind: 'graph', viewId: content.id },
  };
  const resolver = new ReferenceResolver(
    { list: async () => [], read: async () => snapshot, subscribe: () => () => {} },
    nativeReferenceAdapters,
    'destination',
  );
  return { snapshot, source, resolver, content, profile };
}
for (const field of ['revision', 'dependency-id'] as const) {
  for (const reverse of [false, true]) {
    it(`observes distinct retained ${field} identities without shared projections (reverse=${reverse})`, async () => {
      const { resolver, source } = await graphFixture();
      const valid = await resolver.create(source, 'fixed');
      const invalid = clone(valid);
      if (field === 'revision') invalid.snapshot.revision++;
      else invalid.snapshot.dependencies[0].id = 'profile:wrong:1';
      expect(referenceKey(invalid)).not.toBe(referenceKey(valid));
      const stop = resolver.observe(reverse ? [invalid, valid] : [valid, invalid], () => {});
      try {
        await expect.poll(() => resolver.get(valid).status).toBe('ready');
        await expect
          .poll(() => resolver.get(invalid).status)
          .toBe(field === 'revision' ? 'stale' : 'error');
        expect(resolver.get(invalid).projection).toBeUndefined();
        expect(resolver.get(valid).snapshot).toEqual(valid.snapshot);
      } finally {
        stop();
      }
    });
  }
}
for (const schemaVersion of [undefined, 1]) {
  it(`accepts ordinary Graph reference-shaped attributes without a complete envelope (schemaVersion=${schemaVersion})`, async () => {
    const { content, profile, snapshot, resolver, source } = await graphFixture();
    profile.nodes.entity.schema.reference = {
      type: 'object',
      properties: {
        schemaVersion: { type: 'number' },
        source: { type: 'object', properties: { label: { type: 'string' } } },
        snapshot: { type: 'object', properties: { label: { type: 'string' } } },
      },
    };
    content.nodes[0].attributes.reference = {
      ...(schemaVersion === undefined ? {} : { schemaVersion }),
      source: { label: 'ordinary source' },
      snapshot: { label: 'ordinary snapshot' },
    };
    expect(validateGraph(content, profile)).toEqual([]);
    snapshot.contentHash = await contentHash(content);
    snapshot.dependencies[0].contentHash = await contentHash(profile);
    const before = JSON.stringify(snapshot);
    expect(validReferenceSnapshot(snapshot)).toBe(true);
    expect(containsEmbeddedReference(content)).toBe(false);
    const ref = await resolver.create(source, 'follow');
    expect((await resolver.refresh(ref)).status).toBe('ready');
    expect(
      (await resolver.capture([{ id: 'image', reference: ref }]))[0].reference.snapshot,
    ).toEqual(snapshot);
    expect(JSON.stringify(snapshot)).toBe(before);
    const nested = clone(snapshot);
    (nested.content as typeof content).nodes[0].attributes.reference = JSON.parse(
      JSON.stringify(ref),
    );
    expect(validReferenceSnapshot(nested)).toBe(false);
    expect(containsEmbeddedReference(nested.content)).toBe(true);
  });
}
it('captures visible Document references in place while leaving hidden closures and the draft untouched', async () => {
  const content = createData();
  const reads: string[] = [];
  const resolver = new ReferenceResolver(
    {
      list: async () => [],
      subscribe: () => () => {},
      read: async (source) => {
        reads.push(source.artifactId);
        return {
          artifactId: source.artifactId,
          domain: 'data',
          revision: 1,
          versionId: 'v1',
          content,
          contentHash: await contentHash(content),
          dependencies: [],
        };
      },
    },
    nativeReferenceAdapters,
  );
  const make = (artifactId: string) =>
    resolver.create(
      { artifactId, domain: 'data', target: { kind: 'table', viewId: 'default' } },
      'follow',
    );
  const document = createDocument();
  document.blocks = [
    { ...makeBlock('image'), id: 'hidden', hidden: true, reference: await make('hidden') },
    { ...makeBlock('paragraph'), id: 'paragraph', text: 'Keep order' },
    { ...makeBlock('image'), id: 'visible', reference: await make('visible') },
  ];
  const before = clone(document);
  reads.length = 0;
  const captured = await captureDocumentReferences(document, resolver);
  expect(reads).toEqual(['visible']);
  expect(captured.blocks.map((b) => b.id)).toEqual(['hidden', 'paragraph', 'visible']);
  expect(captured.blocks[0]).toEqual(before.blocks[0]);
  expect(document).toEqual(before);
  expect(captured.blocks[2].src).toContain('data:image/svg+xml');
  reads.length = 0;
  await captureDocumentReferences(document, resolver, true);
  expect(reads).toEqual(['hidden', 'visible']);
});
