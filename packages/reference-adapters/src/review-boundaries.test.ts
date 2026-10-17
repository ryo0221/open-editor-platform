import { expect, it } from 'vitest';
import { contentHash } from '@editor-platform/artifact-core';
import { ReferenceResolver, type ReferenceSnapshot } from '@editor-platform/artifact-references';
import { createData, isStructuredData } from '@editor-platform/structured-data/model';
import { defaultView } from '@editor-platform/structured-data/views';
import { createDeck, makeSlideObject } from '@editor-platform/slide/model';
import { createDesign, makeDesignElement } from '@editor-platform/design/model';
import { createWhiteboard, makeWhiteboardNode } from '@editor-platform/whiteboard/model';
import { createDocument, makeBlock, exportHtml } from '@editor-platform/document/model';
import {
  saveAsTemplate,
  authorReusableComponent,
  type NativeContent,
  type Domain,
} from '@editor-platform/templates';
import { nativeReferenceAdapters } from './index';

async function fixture(content = createData()) {
  const snapshot: ReferenceSnapshot = {
    artifactId: 'source',
    domain: 'data',
    versionId: 'v1',
    revision: 1,
    content,
    contentHash: await contentHash(content),
    dependencies: [],
  };
  const resolver = new ReferenceResolver(
    { list: async () => [], read: async () => snapshot, subscribe: () => () => {} },
    nativeReferenceAdapters,
    'destination',
  );
  const source = {
    artifactId: 'source',
    domain: 'data',
    target: { kind: 'table', viewId: 'default' },
  };
  return { snapshot, resolver, source };
}

for (const collision of ['duplicate', 'reserved']) {
  it(`rejects ${collision} Data view IDs only at the reference boundary`, async () => {
    const content = createData();
    const first = { ...defaultView(content), id: collision === 'reserved' ? 'default' : 'named' };
    content.views =
      collision === 'reserved'
        ? [first]
        : [first, { ...first, name: 'Different view', hidden: [content.columns[0].id] }];
    expect(isStructuredData(content)).toBe(true);
    const { snapshot, resolver, source } = await fixture(content);
    await expect(resolver.validate(snapshot, source)).rejects.toThrow('view ID');
    await expect(resolver.create(source, 'follow')).rejects.toThrow('view ID');
    content.views = [{ ...first, id: 'unique' }];
    const valid = await fixture(content);
    await expect(
      valid.resolver.create({ ...source, target: { kind: 'table', viewId: 'unique' } }, 'fixed'),
    ).resolves.toMatchObject({ mode: 'fixed' });
  });
}

for (const domain of ['slide', 'design', 'whiteboard', 'document'] as const) {
  it(`blocks ${domain} template/reuse authoring of references but allows an unrelated fragment`, async () => {
    const { resolver, source } = await fixture();
    const reference = await resolver.create(source, 'fixed');
    const patch = {
      id: 'linked',
      reference,
      src: resolver.project(reference.snapshot, reference.source.target).src,
    };
    let content: NativeContent;
    if (domain === 'slide') {
      const d = createDeck();
      d.slides[0].objects = [
        { ...makeSlideObject('image', 0), ...patch },
        { ...makeSlideObject('text', 1), id: 'plain' },
      ];
      content = d;
    } else if (domain === 'design') {
      const d = createDesign();
      d.elements = [
        { ...makeDesignElement('image'), ...patch },
        { ...makeDesignElement('text'), id: 'plain' },
      ];
      content = d;
    } else if (domain === 'whiteboard') {
      const d = createWhiteboard();
      d.nodes = [
        { ...makeWhiteboardNode('image'), ...patch },
        { ...makeWhiteboardNode('sticky'), id: 'plain' },
      ];
      content = d;
    } else {
      const d = createDocument();
      d.blocks = [
        { ...makeBlock('image'), ...patch },
        { ...makeBlock('paragraph'), id: 'plain' },
      ];
      content = d;
    }
    const before = JSON.stringify(content);
    const options = {
      domain: domain as Domain,
      content,
      name: 'Example',
      purpose: 'Reference boundary regression',
      category: 'Tests',
      slots: [],
    };
    await expect(saveAsTemplate({ ...options, kind: 'whole' })).rejects.toThrow('参照');
    await expect(saveAsTemplate({ ...options, kind: 'fragment', ids: ['linked'] })).rejects.toThrow(
      '参照',
    );
    await expect(
      authorReusableComponent({ domain, content, name: 'Example', ids: ['linked'] }),
    ).rejects.toThrow('参照');
    await expect(
      saveAsTemplate({ ...options, kind: 'fragment', ids: ['plain'] }),
    ).resolves.toBeDefined();
    expect(JSON.stringify(content)).toBe(before);
  });
}

it('keeps hidden Document references out of the HTML manifest', async () => {
  const { resolver, source } = await fixture();
  const reference = await resolver.create(source, 'fixed');
  const doc = createDocument();
  doc.blocks.push({
    ...makeBlock('image'),
    hidden: true,
    reference,
    src: 'data:image/png;base64,AA==',
  });
  expect(exportHtml(doc)).not.toContain('artifact-references');
});
