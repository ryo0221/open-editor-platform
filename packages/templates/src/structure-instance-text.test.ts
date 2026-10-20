import { expect, it } from 'vitest';
import { createDesign, overrideInstance } from '@editor-platform/design/model';
import { structureTemplates } from './structure-builtins';
import { expandTemplate } from './engine';
import { prepareInsertion, applyLocalTemplate, localTemplateSnapshot } from './apply';
import { prepareStructureChange } from './structure-apply';
import { readStructure } from './structure';
import { TemplateError } from './types';

const definition = structureTemplates.find((d) => d.templateId === 'design-variable-comparison')!;
const identity = { actorId: 'A', clientId: 'local', sessionId: 'one' };
const longBody = '確認した内容を省略せずにすべて表示する必要がある。'.repeat(3);
const inputs = {
  ...definition.sample,
  items: [
    { id: 'first', title: '見出し', body: longBody, image: '' },
    { id: 'second', title: '次の見出し', body: '短い説明', image: '' },
  ],
};

it('diagnoses overflowing effective Design repeat text at its input field without rewriting v1', () => {
  const before = structuredClone(definition);
  expect(definition.templateVersion).toBe(1);
  expect(definition.overflow.textScope).toBeUndefined();
  expect(() => expandTemplate(definition, inputs)).toThrow(TemplateError);
  try {
    expandTemplate(definition, inputs);
  } catch (e) {
    expect((e as TemplateError).diagnostics).toContainEqual(
      expect.objectContaining({ code: 'overflow', path: 'items.first.body' }),
    );
  }
  expect(definition).toEqual(before);
  expect(() => expandTemplate(definition, definition.sample)).not.toThrow();
});

it('rejects a clipped Design insertion before proposing any mutation', async () => {
  const content = createDesign(),
    before = structuredClone(content);
  await expect(
    prepareInsertion(
      definition,
      inputs,
      localTemplateSnapshot('artifact', 'design', content),
      identity,
    ),
  ).rejects.toMatchObject({ code: 'overflow' });
  expect(content).toEqual(before);
});

it('rejects reflow that would keep clipped native inner text and preserves the editable source', async () => {
  const base = createDesign();
  const p = await prepareInsertion(
    definition,
    definition.sample,
    localTemplateSnapshot('artifact', 'design', base),
    identity,
  );
  const inserted = applyLocalTemplate(p, base);
  const instanceId = ('reuse' in inserted && inserted.reuse!.instances[0].id) as string;
  const current = readStructure(inserted, instanceId);
  const rootId = current.items[0].nativeIds[0];
  const content = overrideInstance(rootId, current.instance.nativeIds!.cardBody, {
    text: longBody,
  }).apply(inserted as ReturnType<typeof createDesign>);
  const before = structuredClone(content);
  await expect(
    prepareStructureChange({
      state: localTemplateSnapshot('artifact', 'design', content),
      identity,
      instanceId,
      items: current.items.map((i) => ({ id: i.id })),
    }),
  ).rejects.toMatchObject({ code: 'overflow' });
  expect(content).toEqual(before);
});
