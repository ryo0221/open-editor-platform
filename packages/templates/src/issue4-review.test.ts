import { expect, it } from 'vitest';
import {
  applyLocalTemplate,
  assertNative,
  localTemplateSnapshot,
  prepareInsertion,
  prepareInstantiation,
  saveAsTemplate,
  remapNative,
  mapDataFragment,
} from './index';
import { createData, validateData, cellValue } from '@editor-platform/structured-data/model';
import {
  createDesign,
  createComponent,
  insertElement,
  insertInstance,
  deleteElements,
  overrideInstance,
  designDrawings,
  type DesignContent,
} from '@editor-platform/design/model';
import { defaultView } from '@editor-platform/structured-data/views';
const actor = { actorId: 'local', sessionId: 'local', clientId: 'local' };
const metadata = {
  name: 'Review regression',
  purpose: 'Native reuse',
  category: 'test',
  slots: [],
};
function composite() {
  let content = insertElement('text').apply(insertElement('rectangle').apply(createDesign()));
  content = createComponent(content.elements.map((e) => e.id)).apply(content);
  return overrideInstance(content.elements[0].id, content.components[0].elements![1].id, {
    text: 'Instance override',
  }).apply(content);
}
it('R4-1: renamed Data fragment formulas retain their source column, not a same-named target', async () => {
  const source = createData();
  source.columns = [
    { id: 'source-amount', name: 'Amount', type: 'number', defaultValue: 3 },
    { id: 'source-total', name: 'Total', type: 'formula', formula: '[Amount] * 2' },
  ];
  source.rows = [{ id: 'source-row', values: { 'source-amount': 3 } }];
  source.views = [];
  const definition = await saveAsTemplate({
    ...metadata,
    domain: 'data',
    content: source,
    kind: 'fragment',
  });
  const target = createData();
  target.columns = [{ id: 'target-amount', name: 'Amount', type: 'number', defaultValue: 100 }];
  target.rows = [{ id: 'target-row', values: { 'target-amount': 100 } }];
  target.views = [];
  const prepared = await prepareInsertion(
    definition,
    {},
    localTemplateSnapshot('data', 'data', target),
    actor,
    { fieldMapping: { 'source-amount': { newName: 'Inserted Amount' } } },
  );
  const after = applyLocalTemplate(prepared, target) as typeof source;
  const total = after.columns.find((c) => c.name === 'Total')!;
  expect(validateData(after)).toEqual([]);
  expect(after.rows.map((r) => cellValue(after, r, total))).toEqual([6, 6]);
  expect(after.columns.find((c) => c.name === 'Amount')!.id).toBe('target-amount');
  expect(source.columns[1].formula).toBe('[Amount] * 2');
});
it('R4-3: a normally created composite component can be saved and instantiated with overrides', async () => {
  const content = composite();
  expect(content.components[0].elements![0].id).toBe(content.elements[0].id);
  const definition = await saveAsTemplate({
    ...metadata,
    domain: 'design',
    content,
    kind: 'whole',
  });
  const reused = (await prepareInstantiation(definition, {}, 'composite')).artifact.draft
    .content as DesignContent;
  expect(() => assertNative('design', reused)).not.toThrow();
  const visible = (d: DesignContent) =>
    designDrawings(d, d.elements[0]).map(({ bounds, text, fill }) => ({ bounds, text, fill }));
  expect(visible(reused)).toEqual(visible(content));
  expect(reused.elements[0].id).not.toBe(content.elements[0].id);
  const invalid = structuredClone(content);
  invalid.components[0].elements!.push(structuredClone(invalid.components[0].elements![0]));
  await expect(
    saveAsTemplate({ ...metadata, domain: 'design', content: invalid, kind: 'whole' }),
  ).rejects.toThrow();
});
it('R4-4: fragment translation moves instances once and preserves component-local geometry', async () => {
  let content = composite();
  const original = content.elements[0].id;
  content = insertInstance(content.components[0].id).apply(content);
  content = deleteElements([original]).apply(content);
  content = overrideInstance(content.elements[0].id, content.components[0].elements![1].id, {
    bounds: { x: 10, y: 12, width: 100, height: 30 },
  }).apply(content);
  const definition = await saveAsTemplate({
    ...metadata,
    domain: 'design',
    content,
    kind: 'fragment',
  });
  const target = createDesign();
  const prepared = await prepareInsertion(
    definition,
    {},
    localTemplateSnapshot('design', 'design', target),
    actor,
    { position: { x: 100, y: 80 } },
  );
  const after = applyLocalTemplate(prepared, target) as DesignContent;
  const beforeBounds = designDrawings(content, content.elements[0]).map((e) => e.bounds);
  expect(designDrawings(after, after.elements[0]).map((e) => e.bounds)).toEqual(
    beforeBounds.map((b) => ({ ...b, x: b.x + 100, y: b.y + 80 })),
  );
  expect(after.components[0].elements!.map((e) => e.bounds)).toEqual(
    content.components[0].elements!.map((e) => e.bounds),
  );
});
it('R4-2: authored Data templates remap relation cells/defaults without rewriting equal text', async () => {
  const content = createData();
  content.columns = [
    { id: 'label', name: 'Label', type: 'text' },
    { id: 'link', name: 'Link', type: 'relation', defaultValue: 'row-a' },
  ];
  content.rows = [
    { id: 'row-a', values: { label: 'row-a', link: null } },
    { id: 'row-b', values: { label: 'Child', link: 'row-a' } },
  ];
  const view = defaultView(content);
  view.filters = [{ id: 'filter', columnId: 'link', operator: 'equals', value: 'row-a' }];
  content.views = [view];
  const mapped = remapNative(content, undefined, 'new').content;
  expect(validateData(mapped)).toEqual([]);
  expect(mapped.rows[0].values[mapped.columns[0].id]).toBe('row-a');
  expect(mapped.rows[1].values[mapped.columns[1].id]).toBe(mapped.rows[0].id);
  expect(mapped.columns[1].defaultValue).toBe(mapped.rows[0].id);
  expect(mapped.views![0].filters[0].value).toBe(mapped.rows[0].id);
  const definition = await saveAsTemplate({
    domain: 'data',
    content,
    name: 'Linked records',
    purpose: 'Reuse real relations',
    category: 'quality',
    kind: 'whole',
    slots: [],
  });
  const prepared = await prepareInstantiation(definition, {}, 'linked-records');
  const reused = prepared.artifact.draft.content as typeof content;
  expect(validateData(reused)).toEqual([]);
  expect(reused.rows[1].values[reused.columns[1].id]).toBe(reused.rows[0].id);
});
it('R4-1: bare names and bracketed IDs bind before explicitly reusing a differently named field', () => {
  const source = createData();
  source.columns = [
    { id: 'amount', name: 'Amount', type: 'number' },
    { id: 'sum', name: 'Sum', type: 'formula', formula: 'Amount + [Amount] + [amount]' },
  ];
  source.rows = [{ id: 'r', values: { amount: 2 } }];
  const target = createData();
  target.columns = [{ id: 'reused', name: 'Renamed amount', type: 'number' }];
  const mapped = mapDataFragment(source, target, { amount: 'reused' }).content;
  const combined = { ...mapped, columns: [...target.columns, ...mapped.columns] };
  expect(cellValue(combined, combined.rows[0], combined.columns[1])).toBe(6);
  expect(mapped.columns[0].formula).toBe('[reused] + [reused] + [reused]');
});
it('R4-2: fragment rows keep relations when the relation field is explicitly reused', async () => {
  const source = createData();
  source.columns = [{ id: 'link', name: 'Link', type: 'relation' }];
  source.rows = [
    { id: 'a', values: { link: null } },
    { id: 'b', values: { link: 'a' } },
  ];
  const target = createData();
  target.columns = [{ id: 'existing', name: 'Existing relation', type: 'relation' }];
  const definition = await saveAsTemplate({
    ...metadata,
    domain: 'data',
    content: source,
    kind: 'fragment',
  });
  const prepared = await prepareInsertion(
    definition,
    {},
    localTemplateSnapshot('data', 'data', target),
    actor,
    { fieldMapping: { link: 'existing' } },
    'reuse-relations',
  );
  const after = applyLocalTemplate(prepared, target) as typeof source;
  expect(validateData(after)).toEqual([]);
  expect(after.rows[1].values.existing).toBe(after.rows[0].id);
  const retry = await prepareInsertion(
    definition,
    {},
    localTemplateSnapshot('data', 'data', target),
    actor,
    { fieldMapping: { link: 'existing' } },
    'reuse-relations',
  );
  expect(retry.preview).toEqual(prepared.preview);
});
it('R4-1: a new field name matching another source ID cannot rebind its formula', () => {
  const source = createData();
  source.columns = [
    { id: 'other', name: 'Other', type: 'number' },
    { id: 'amount', name: 'Amount', type: 'number' },
    { id: 'result', name: 'Result', type: 'formula', formula: 'Amount * 2' },
  ];
  source.rows = [{ id: 'r', values: { other: 100, amount: 3 } }];
  const mapped = mapDataFragment(
    source,
    { ...createData(), columns: [] },
    { other: { newName: 'amount' } },
  ).content;
  expect(cellValue(mapped, mapped.rows[0], mapped.columns[2])).toBe(6);
});
