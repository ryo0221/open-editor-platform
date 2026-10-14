import { expect, it } from 'vitest';
import { clone } from '@editor-platform/artifact-core';
import { isStructuredData, type StructuredData } from '@editor-platform/structured-data/model';
import { defaultView } from '@editor-platform/structured-data/views';
import { assertNative, nativeIds, remapNative } from './native';
import { saveAsTemplate } from './author';
import { prepareInstantiation, exportTemplatePack, importTemplatePack } from './index';
import { MemoryCatalog } from './catalog';

function data(): StructuredData {
  const source: StructuredData = {
    schemaVersion: 2,
    columns: [
      { id: 'id', name: 'Name', type: 'text' },
      { id: 'from', name: 'Start', type: 'date' },
      { id: 'to', name: 'End', type: 'date' },
      { id: 'formula', name: 'Note', type: 'text' },
      { id: 'parentId', name: 'Parent', type: 'relation', defaultValue: 'first' },
      { id: 'amount', name: 'Amount', type: 'number' },
      { id: 'total', name: 'Total', type: 'formula', formula: '[amount] * 2' },
    ],
    rows: [
      {
        id: 'first',
        values: {
          id: 'first',
          from: '2026-11-02',
          to: '2026-11-08',
          formula: '[amount]',
          parentId: null,
          amount: 2,
        },
      },
      {
        id: 'second',
        values: {
          id: 'amount',
          from: '2026-11-04',
          to: '2026-11-10',
          formula: '[amount]',
          parentId: 'first',
          amount: 3,
        },
      },
    ],
  };
  const view = defaultView(source);
  view.id = 'view';
  view.timeline = { ...view.timeline, from: '2026-11-01', to: '2026-11-20' };
  view.widths = { id: 200 };
  view.filters = [{ id: 'filter', columnId: 'id', operator: 'not-equals', value: 'first' }];
  view.widgets = [{ id: 'widget', type: 'chart', title: 'amount', chart: view.chart }];
  source.views = [view];
  return source;
}

it('roundtrips a date-range Data template through the catalog and creates independently mapped native content', async () => {
  const source = data(),
    before = clone(source);
  const definition = await saveAsTemplate({
    domain: 'data',
    content: source,
    name: 'Dated records',
    purpose: 'Date range',
    category: 'test',
    kind: 'whole',
    slots: [],
  });
  const catalog = new MemoryCatalog();
  await importTemplatePack(await exportTemplatePack([definition]), catalog);
  const retained = await catalog.getVersion(definition.templateId, definition.templateVersion);
  const created = await prepareInstantiation(retained!, {}, 'dated-records');
  const result = created.artifact.draft.content as StructuredData;
  expect(isStructuredData(result)).toBe(true);
  expect(result.views![0].timeline).toMatchObject({
    from: '2026-11-01',
    to: '2026-11-20',
    start: result.columns[1].id,
    end: result.columns[2].id,
  });
  expect(result.rows[0].values[result.columns[0].id]).toBe('first');
  expect(result.rows[1].values[result.columns[0].id]).toBe('amount');
  expect(result.rows[0].values[result.columns[3].id]).toBe('[amount]');
  expect(result.rows[1].values[result.columns[4].id]).toBe(result.rows[0].id);
  expect(result.columns[6].formula).toBe(`[${result.columns[5].id}] * 2`);
  expect(result.views![0].filters[0].value).toBe('first');
  expect(result.views![0].widgets[0].title).toBe('amount');
  expect(source).toEqual(before);
  expect(retained).toEqual(definition);
});

it('maps Graph record/column bindings and preserves date literals even if equal to a supplied native ID', () => {
  const source = data();
  source.graphView = {
    schemaVersion: 1,
    labelColumnId: 'id',
    positions: { first: { x: 10, y: 20 } },
  };
  const { content, ids } = remapNative(source, new Map([['2026-11-01', 'external-row']]), 'copy');
  expect(isStructuredData(content)).toBe(true);
  expect(content.graphView).toEqual({
    schemaVersion: 1,
    labelColumnId: ids.get('id'),
    positions: { [ids.get('first')!]: { x: 10, y: 20 } },
  });
  expect(content.views![0].timeline.from).toBe('2026-11-01');
  expect(() => assertNative('data', content)).not.toThrow();
  expect(nativeIds(source)).toEqual([
    'id',
    'from',
    'to',
    'formula',
    'parentId',
    'amount',
    'total',
    'first',
    'second',
    'view',
    'filter',
    'widget',
  ]);
});

it('continues to reject missing Data field references and duplicate native entities', () => {
  const source = data();
  source.views![0].timeline.start = 'missing';
  expect(() => assertNative('data', source)).toThrow(/missing field/);
  source.views![0].timeline.start = 'from';
  source.views![0].widgets[0].id = source.views![0].id;
  expect(() => assertNative('data', source)).toThrow(/Duplicate native IDs/);
});
