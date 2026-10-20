import { expect, it } from 'vitest';
import { clone, deepFreeze } from '@editor-platform/artifact-core';
import { validateReuseStateSync } from '@editor-platform/reuse-core';
import type { StructuredData } from '@editor-platform/structured-data/model';
import { nativeLoadFixture } from '../../../tests/fixtures/reuse/native-load';
import { authorReusableComponent } from './reuse-definition';
import { prepareComponentInsertion } from './reuse-apply';
import { applyLocalTemplate, localTemplateSnapshot } from './apply';
import { validateNativeReusableDefinitions } from './reuse-load';
import {
  createDesign,
  makeDesignElement,
  isDesign,
  type DesignContent,
} from '@editor-platform/design/model';

it('loads 101 distinct linked Design components with retained native recipes and hashes', async () => {
  const source = { ...createDesign(), elements: [makeDesignElement('rectangle')] };
  let content = createDesign();
  content.reuse = { schemaVersion: 1, closures: [], instances: [] };
  for (let index = 0; index < 101; index++) {
    const authored = await authorReusableComponent({
      domain: 'design',
      content: source,
      ids: [],
      name: `Component ${index}`,
      definitionId: `component-${index}`,
    });
    // Assemble the first 100 independently through public author/insert APIs,
    // then exercise insertion against that retained 100-closure artifact.
    const target = index === 100 ? content : createDesign();
    const inserted = applyLocalTemplate(
      await prepareComponentInsertion({
        ...authored,
        identity: { actorId: 'A', clientId: 'a', sessionId: 'a' },
        requestId: `insert-${index}`,
        state: localTemplateSnapshot('design', 'design', target),
        reuse: 'linked',
      }),
      target,
    ) as DesignContent;
    if (index === 100) content = inserted;
    else {
      content.elements.push(...inserted.elements);
      content.components.push(...inserted.components);
      content.reuse!.closures.push(...inserted.reuse!.closures);
      content.reuse!.instances.push(...inserted.reuse!.instances);
    }
  }
  const reloaded = JSON.parse(JSON.stringify(content));
  expect(content.reuse?.closures).toHaveLength(101);
  expect(content.reuse?.instances).toHaveLength(101);
  expect(isDesign(reloaded)).toBe(true);
  await validateNativeReusableDefinitions('design', reloaded);
  expect(reloaded).toStrictEqual(content);
}, 30000);

it('checks native recipes beyond valid closure hashes while preserving edited native bodies and immutable input', async () => {
  const { valid, invalid } = await nativeLoadFixture(),
    before = clone(valid);
  await validateNativeReusableDefinitions('document', deepFreeze(valid));
  expect(valid).toEqual(before);
  expect(() => validateReuseStateSync(invalid.reuse)).not.toThrow();
  await expect(validateNativeReusableDefinitions('document', invalid)).rejects.toThrow();
  const input = clone(before);
  input.reuse!.instances[0].inputs = { missingProperty: 'unsupported' };
  await expect(validateNativeReusableDefinitions('document', input)).rejects.toThrow();
});

it('allows native Data diagnostics and legacy content without treating ordinary records as template samples', async () => {
  const content: StructuredData = {
    schemaVersion: 2,
    columns: [{ id: 'number', name: '数量', type: 'number' }],
    rows: [{ id: 'record', values: { number: 2 } }],
  };
  const source = await authorReusableComponent({
    domain: 'data',
    content,
    ids: [],
    name: '数量',
    data: 'fields',
  });
  const result = applyLocalTemplate(
    await prepareComponentInsertion({
      ...source,
      identity: { actorId: 'A', clientId: 'a', sessionId: 'a' },
      state: localTemplateSnapshot('artifact', 'data', content),
      reuse: 'linked',
      target: { fieldMapping: { number: 'number' } },
    }),
    content,
  ) as StructuredData;
  result.rows[0].values.number = '修正待ち';
  const before = clone(result);
  await validateNativeReusableDefinitions('data', result);
  expect(result).toEqual(before);
  delete result.reuse;
  await validateNativeReusableDefinitions('data', result);
});
