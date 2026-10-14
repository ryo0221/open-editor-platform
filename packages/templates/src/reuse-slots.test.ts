import { expect, it } from 'vitest';
import { clone } from '@editor-platform/artifact-core';
import { Authority, initial } from '@editor-platform/collaboration-core';
import {
  createDesign,
  makeDesignElement,
  isDesign,
  exportDesignSvg,
} from '@editor-platform/design/model';
import type { DocumentContent } from '@editor-platform/document/model';
import { contentToNode } from '@editor-platform/document/engine';
import { definitionRef, lockClosure, sealReusableDefinition } from '@editor-platform/reuse-core';
import { authorReusableComponent } from './reuse-definition';
import { applyLocalTemplate, localTemplateSnapshot, templateCodec } from './apply';
import { prepareComponentInsertion } from './reuse-apply';
import { validateComponentSlotTree, type ComponentSlotValue } from './reuse-slots';
import { remapNative } from './native';
import { reusableParts } from './reuse-native';
const identity = { actorId: 'A', clientId: 'a', sessionId: 'one' };
const principal = { ...identity, writable: true, scopes: ['*'] };
async function required(domain: 'document' | 'design') {
  const source =
    domain === 'document'
      ? {
          schemaVersion: 2 as const,
          blocks: [{ id: 'title', type: 'paragraph' as const, text: '必須本文付き' }],
        }
      : {
          ...createDesign(),
          elements: [
            {
              ...makeDesignElement('frame'),
              id: 'frame',
              layout: {
                direction: 'column' as const,
                gap: 10,
                padding: 8,
                align: 'start' as const,
                sizing: 'fixed' as const,
              },
            },
          ],
        };
  const authored = await authorReusableComponent({
    domain,
    content: source,
    name: '必須スロット',
    ids: [],
  });
  const candidate = clone(authored.definition);
  candidate.payload.contract.slots[0].min = 1;
  const definition = await sealReusableDefinition(candidate);
  return {
    definition,
    closure: await lockClosure<unknown>([definitionRef(definition)], [definition]),
    slotId: definition.payload.contract.slots[0].id,
  };
}
it('required Document slots, including nested required slots, insert in one atomic Undo without invalid intermediate metadata', async () => {
  const value = await required('document');
  const content: DocumentContent = {
    schemaVersion: 2,
    blocks: [{ id: 'outside', type: 'paragraph', text: '既存' }],
  };
  const state = localTemplateSnapshot('artifact', 'document', content);
  await expect(
    prepareComponentInsertion({ ...value, state, identity, reuse: 'linked' }),
  ).rejects.toThrow('Required slot');
  const body: ComponentSlotValue = {
    kind: 'body',
    content: {
      schemaVersion: 2,
      blocks: [
        {
          id: 'a',
          type: 'paragraph',
          text: '日本語本文',
          rich: [{ text: '日本語本文', bold: true }],
        },
      ],
    },
  };
  const prepared = await prepareComponentInsertion({
    ...value,
    state,
    identity,
    reuse: 'linked',
    requestId: 'required',
    slots: { [value.slotId]: [{ kind: 'component', ...value, slots: { [value.slotId]: [body] } }] },
  });
  const result = applyLocalTemplate(prepared, content) as DocumentContent;
  expect(result.blocks.map((b) => b.text)).toEqual([
    '既存',
    '必須本文付き',
    '必須本文付き',
    '日本語本文',
  ]);
  expect(result.reuse?.instances).toHaveLength(2);
  expect(result.blocks[3].rich).toEqual([{ text: '日本語本文', bold: true }]);
  const codec = templateCodec('document'),
    authority = new Authority(codec, initial('artifact', codec, content));
  expect(authority.commit(principal, prepared.operation).status).toBe('accepted');
  expect(authority.undo(principal, prepared.operation.operationId).status).toBe('accepted');
  expect(contentToNode(authority.snapshot().content as DocumentContent).toJSON()).toEqual(
    contentToNode(content).toJSON(),
  );
  expect(authority.snapshot().content).not.toHaveProperty('reuse');
  const copy = await prepareComponentInsertion({
    ...value,
    state,
    identity,
    reuse: 'copy',
    slots: { [value.slotId]: [body] },
  });
  expect(applyLocalTemplate(copy, content)).not.toHaveProperty('reuse');
});
it('nested Design required slots retain scoped part/slot maps through native pack remapping and reload', async () => {
  const parent = await required('design'),
    child = await required('design');
  const leaf = await authorReusableComponent({
    domain: 'design',
    ids: [],
    name: 'ラベル',
    content: {
      ...createDesign(),
      elements: [{ ...makeDesignElement('text'), text: '子の日本語', id: 'text' }],
    },
  });
  const content = createDesign();
  const prepared = await prepareComponentInsertion({
    ...parent,
    state: localTemplateSnapshot('artifact', 'design', content),
    identity,
    reuse: 'linked',
    slots: {
      [parent.slotId]: [
        {
          kind: 'component',
          ...child,
          slots: { [child.slotId]: [{ kind: 'component', ...leaf }] },
        },
      ],
    },
    requestId: 'nested',
  });
  const result = applyLocalTemplate(prepared, content);
  if (!isDesign(result)) throw Error('Design');
  expect(result.reuse?.instances).toHaveLength(3);
  expect(exportDesignSvg(result)).toContain('子の日本語');
  const copied = JSON.parse(JSON.stringify(remapNative(result, new Map(), 'copy').content));
  expect(templateCodec('design').validate(copied)).toBe(true);
  const parts = reusableParts(copied);
  for (const instance of copied.reuse.instances) {
    for (const address of Object.values(instance.parts))
      expect(parts.has(address as string)).toBe(true);
    for (const addresses of Object.values(instance.slots))
      for (const address of addresses as string[]) expect(parts.has(address)).toBe(true);
  }
  const authority = new Authority(
    templateCodec('design'),
    initial('artifact', templateCodec('design'), content),
  );
  expect(authority.commit(principal, prepared.operation).status).toBe('accepted');
  expect(authority.undo(principal, prepared.operation.operationId).status).toBe('accepted');
  expect(authority.snapshot().content).toEqual(content);
});
it('cyclic and over-depth slot trees fail before native preparation; ordinary scoped addresses may exceed one ID length', async () => {
  const value = await required('document');
  const slots: Record<string, ComponentSlotValue[]> = {};
  slots[value.slotId] = [{ kind: 'component', ...value, slots }];
  expect(() => validateComponentSlotTree(slots)).toThrow('cycle');
  let deep: Record<string, ComponentSlotValue[]> = {};
  for (let i = 0; i < 17; i++)
    deep = { [value.slotId]: [{ kind: 'component', ...value, slots: deep }] };
  expect(() => validateComponentSlotTree(deep)).toThrow('depth');
  const design = createDesign();
  const root = {
    ...makeDesignElement('instance'),
    id: 'root_' + 'r'.repeat(80),
    componentId: 'one',
    bounds: { x: 0, y: 0, width: 100, height: 100 },
  };
  const child = {
    ...makeDesignElement('text'),
    id: 'text_' + 't'.repeat(80),
    text: '長いスコープ',
  };
  design.elements.push(root);
  design.components.push({
    id: 'one',
    name: 'Long IDs',
    width: 100,
    height: 100,
    template: { type: 'text', text: '', fill: '#ffffff' },
    elements: [child],
  });
  const authored = await authorReusableComponent({
    domain: 'design',
    ids: [],
    content: design,
    name: 'Scoped',
  });
  expect(authored.definition.payload.contract.parts.some((p) => p.nativeId.length > 160)).toBe(
    true,
  );
});
it('bounded nested requests use fixed-size IDs even when the outer request ID is at its limit', async () => {
  const value = await required('document');
  let slots: Record<string, ComponentSlotValue[]> = {
    [value.slotId]: [
      {
        kind: 'body',
        content: { schemaVersion: 2, blocks: [{ id: 'leaf', type: 'paragraph', text: '末端' }] },
      },
    ],
  };
  for (let i = 0; i < 5; i++) slots = { [value.slotId]: [{ kind: 'component', ...value, slots }] };
  const content: DocumentContent = { schemaVersion: 2, blocks: [] };
  const prepared = await prepareComponentInsertion({
    ...value,
    state: localTemplateSnapshot('artifact', 'document', content),
    identity,
    reuse: 'linked',
    requestId: 'r'.repeat(100),
    slots,
  });
  const next = applyLocalTemplate(prepared, content) as DocumentContent;
  expect(next.reuse?.instances).toHaveLength(6);
  expect(next.blocks.at(-1)?.text).toBe('末端');
});
