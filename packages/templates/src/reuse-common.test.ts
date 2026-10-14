import { expect, it } from 'vitest';
import { clone } from '@editor-platform/artifact-core';
import { createDesign, makeDesignElement } from '@editor-platform/design/model';
import type { DocumentContent } from '@editor-platform/document/model';
import {
  authorReusableComponent,
  materializeComponent,
  reusablePrototype,
} from './reuse-definition';
import { publicPropertySuggestions, reusableParts, reusablePartRich } from './reuse-native';
import { applyLocalTemplate, localTemplateSnapshot } from './apply';
import { prepareComponentInsertion, retainedComponent } from './reuse-apply';
import { remapNative } from './native';

it('captures all 1000 native parts while bounding automatically published controls', async () => {
  const content: DocumentContent = {
    schemaVersion: 2,
    blocks: Array.from({ length: 1000 }, (_, i) => ({
      id: `block_${i}`,
      type: 'paragraph',
      text: `本文 ${i}`,
    })),
  };
  const authored = await authorReusableComponent({
    domain: 'document',
    content,
    ids: [],
    name: '大きな文書',
  });
  expect(authored.definition.payload.contract.parts).toHaveLength(1000);
  expect(authored.definition.payload.contract.properties).toHaveLength(256);
  expect(authored.definition.payload.contract.slots).toHaveLength(256);
  expect(authored.notices.join()).toContain('256');
  const materialized = (await materializeComponent(authored.definition, authored.closure))
    .content as DocumentContent;
  expect(materialized.blocks.map(({ id, type, text }) => ({ id, type, text }))).toEqual(
    content.blocks,
  );
  expect(materialized.blocks.some((block) => block.hidden)).toBe(false);
}, 15000);

it('retains canvas rich marks and rejects unsupported rich formatting without flattening it', async () => {
  const content = {
    ...createDesign(),
    elements: [
      {
        ...makeDesignElement('text'),
        id: 'label',
        text: '装飾',
        runs: [{ text: '装飾', style: { bold: true, color: '#cc0000' } }],
      },
    ],
  };
  const base = await authorReusableComponent({ domain: 'design', content, ids: [], name: '装飾' });
  const prototype = reusablePrototype(base.definition);
  const part = base.definition.payload.contract.parts.find(
    (p) => reusableParts(prototype).get(p.nativeId)?.type === 'text',
  )!;
  const rich = {
    ...publicPropertySuggestions(prototype, part).find((p) => p.type === 'rich-text')!,
    id: 'rich_body',
  };
  const authored = await authorReusableComponent({
    domain: 'design',
    content: prototype,
    ids: [],
    name: '装飾',
    contract: { ...base.definition.payload.contract, properties: [rich] },
  });
  const result = await materializeComponent(authored.definition, authored.closure);
  expect(reusablePartRich(reusableParts(result.content).get(part.nativeId)!)).toEqual([
    { text: '装飾', bold: true, color: '#cc0000' },
  ]);
  await expect(
    materializeComponent(authored.definition, authored.closure, {
      [rich.id]: [{ text: 'コード', code: true }],
    }),
  ).rejects.toThrow(/canvas supports/);
  content.elements[0].runs[0].style = {
    ...content.elements[0].runs[0].style,
    fontSize: 28,
  } as (typeof content.elements)[0]['runs'][number]['style'];
  const mixed = await authorReusableComponent({
    domain: 'design',
    content,
    ids: [],
    name: '個別サイズ',
  });
  const mixedPrototype = reusablePrototype(mixed.definition);
  const mixedPart = mixed.definition.payload.contract.parts.find(
    (p) => reusableParts(mixedPrototype).get(p.nativeId)?.type === 'text',
  )!;
  expect(
    publicPropertySuggestions(mixedPrototype, mixedPart).some((p) => p.type === 'rich-text'),
  ).toBe(false);
  expect(JSON.stringify(mixedPrototype)).toContain('"fontSize":28');
});

it('remaps full native IDs containing slash before considering Design scoped addresses', async () => {
  const content: DocumentContent = {
    schemaVersion: 2,
    blocks: [{ id: 'source/body', type: 'paragraph', text: '本文' }],
  };
  const authored = await authorReusableComponent({
    domain: 'document',
    content,
    ids: [],
    name: '本文',
  });
  const base: DocumentContent = { schemaVersion: 2, blocks: [] };
  const linked = clone(
    applyLocalTemplate(
      await prepareComponentInsertion({
        ...authored,
        state: localTemplateSnapshot('doc', 'document', base),
        identity: { actorId: 'a', clientId: 'a', sessionId: 'a' },
        requestId: 'insert',
        reuse: 'linked',
      }),
      base,
    ),
  ) as DocumentContent;
  const instance = retainedComponent(linked, 'reuse_insert').instance;
  const oldId = Object.values(instance.parts)[0];
  linked.blocks.find((block) => block.id === oldId)!.id = 'legacy/body';
  Object.keys(instance.parts).forEach((key) => {
    if (instance.parts[key] === oldId) instance.parts[key] = 'legacy/body';
  });
  // The retained accessor returns a clone; update the serialized artifact as a legacy Host would.
  linked.reuse!.instances[0].parts = instance.parts;
  linked.reuse!.instances[0].slots = { body: ['legacy/body'] };
  const mapped = remapNative(linked, undefined, 'copy');
  expect(Object.values(mapped.content.reuse!.instances[0].parts)).toContain(
    mapped.content.blocks.find((block) => block.text === '本文')!.id,
  );
  expect(mapped.content.reuse!.instances[0].slots.body).toEqual([
    mapped.content.blocks.find((block) => block.text === '本文')!.id,
  ]);
  expect(mapped.content.reuse!.closures).toEqual(linked.reuse!.closures);
});

it('holds ambiguous legacy Design addresses with a diagnostic and leaves the native input intact', async () => {
  const content = {
    ...createDesign(),
    elements: [{ ...makeDesignElement('text'), id: 'legacy/part', text: '保持' }],
  };
  const before = JSON.stringify(content);
  await expect(
    authorReusableComponent({ domain: 'design', content, ids: [], name: '保持' }),
  ).rejects.toThrow(/reserve/);
  expect(JSON.stringify(content)).toBe(before);
});
