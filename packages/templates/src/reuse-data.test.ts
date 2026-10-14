import { it, expect } from 'vitest';
import { clone } from '@editor-platform/artifact-core';
import { command } from '@editor-platform/editor-core';
import { Authority, initial, type Identity } from '@editor-platform/collaboration-core';
import { prepareEditorCommand } from '@editor-platform/collaboration-adapters';
import {
  cellValue,
  isStructuredData,
  setCell,
  type StructuredData,
} from '@editor-platform/structured-data/model';
import { defaultView } from '@editor-platform/structured-data/views';
import { authorReusableComponent, defaultComponentContract } from './reuse-definition';
import { prepareComponentInsertion, retainedComponent } from './reuse-apply';
import { localTemplateSnapshot, templateCodec, applyLocalTemplate } from './apply';
import { previewComponentUpdate } from './reuse-update';
import { createReusableVersion } from './reuse-catalog';
import { remapNative } from './native';
import { nativePropertyPatch } from './reuse-native';
import { dataRowReferences } from './reuse-data';
const identity: Identity = { actorId: 'A', clientId: 'a', sessionId: 'one' };
const principal = { ...identity, writable: true, scopes: ['*'] };
const basis = (content: StructuredData) => ({
  identity,
  state: localTemplateSnapshot('data', 'data', content),
});
const source = (): StructuredData => {
  const data: StructuredData = {
    schemaVersion: 2,
    columns: [
      { id: 'q', name: 'Quantity', type: 'number', defaultValue: 2 },
      { id: 'p', name: 'Price', type: 'number', defaultValue: 3 },
      { id: 'total', name: 'Total', type: 'formula', formula: 'Quantity * Price' },
      { id: 'rel', name: 'Related', type: 'relation', defaultValue: 'sample' },
    ],
    rows: [{ id: 'sample', values: { q: 2, p: 3, rel: 'sample' } }],
  };
  data.views = [
    {
      ...defaultView(data),
      id: 'view',
      name: 'Totals',
      projection: 'Chart',
      chart: { ...defaultView(data).chart, x: 'rel', y: 'total' },
      widgets: [
        { id: 'widget', title: 'Sum', type: 'metric', columnId: 'total', aggregate: 'sum' },
      ],
      filters: [{ id: 'filter', columnId: 'rel', operator: 'equals', value: 'sample' }],
    },
  ];
  return data;
};
const target = (): StructuredData => ({
  schemaVersion: 2,
  columns: [
    { id: 'existing', name: 'Quantity', type: 'number', defaultValue: 100 },
    { id: 'body', name: 'Case', type: 'text' },
  ],
  rows: [
    { id: 'record1', values: { existing: 100, body: '案件 A' } },
    { id: 'record2', values: { existing: 200, body: '案件 B' } },
  ],
});
const author = (content = source(), data: 'fields' | 'view' = 'fields') =>
  authorReusableComponent({ domain: 'data', content, name: 'Reusable fields', ids: [], data });
const linked = async (value: Awaited<ReturnType<typeof author>>, requestId = 'fields') =>
  prepareComponentInsertion({
    ...basis(target()),
    ...value,
    reuse: 'linked',
    requestId,
    target: {
      fieldMapping: (value.definition.payload.template.content as StructuredData).columns.some(
        (c) => c.id === 'q',
      )
        ? { q: { newName: 'Units' } }
        : {},
      rowMapping: Object.fromEntries(
        dataRowReferences(value.definition.payload.template.content as StructuredData).map((id) => [
          id,
          'record1',
        ]),
      ),
    },
  });

it('R11 inserts typed fields with exact column/row bindings, six remains six after rename, and never copies sample records', async () => {
  const value = await author();
  expect((value.definition.payload.template.content as StructuredData).rows).toEqual([]);
  await expect(
    prepareComponentInsertion({ ...basis(target()), ...value, reuse: 'linked' }),
  ).rejects.toThrow(/target record/);
  const prepared = await linked(value),
    next = prepared.preview as StructuredData;
  expect(next.rows.map((r) => r.id)).toEqual(['record1', 'record2']);
  expect(next.rows.map((r) => r.values.body)).toEqual(['案件 A', '案件 B']);
  const ids = next.reuse!.instances[0].nativeIds!;
  expect(cellValue(next, next.rows[0], next.columns.find((c) => c.id === ids.total)!)).toBe(6);
  expect(next.columns.find((c) => c.id === ids.total)?.formula).toBe(`[${ids.q}] * [${ids.p}]`);
  expect(next.rows[1].values[ids.rel]).toBe('record1');
  expect(next.views![0].filters[0].value).toBe('record1');
  expect(next.views![0].widgets[0].columnId).toBe(ids.total);
  expect(isStructuredData(JSON.parse(JSON.stringify(next)))).toBe(true);
  const copied = remapNative(next).content;
  expect(copied.rows[0].id).not.toBe('record1');
  expect(copied.rows[0].values[copied.columns.find((c) => c.name === 'Related')!.id]).toBe(
    copied.rows[0].id,
  );
  expect(copied.reuse!.instances[0].nativeIds!.total).toBe(
    copied.columns.find((c) => c.name === 'Total')!.id,
  );
});

it('view reuse requires explicit field mapping and preserves all record values and target schema', async () => {
  const original = source(),
    value = await author(original, 'view');
  const before = clone(original);
  before.rows[0].values.q = 7;
  await expect(
    prepareComponentInsertion({
      ...basis(before),
      ...value,
      reuse: 'linked',
      target: { rowMapping: { sample: 'sample' } },
    }),
  ).rejects.toThrow(/field bindings/);
  const prepared = await prepareComponentInsertion({
    ...basis(before),
    ...value,
    reuse: 'linked',
    requestId: 'view',
    target: {
      fieldMapping: Object.fromEntries(before.columns.map((c) => [c.id, c.id])),
      rowMapping: { sample: 'sample' },
    },
  });
  const next = prepared.preview as StructuredData;
  expect(next.rows).toEqual(before.rows);
  expect(next.columns).toEqual(before.columns);
  expect(next.views).toHaveLength(2);
  expect(Object.keys(next.reuse!.instances[0].parts)).toHaveLength(1);
  expect(next.views![1].chart.y).toBe('total');
  expect(next.views![1].widgets[0].columnId).toBe('total');
  expect(nativePropertyPatch(next, next.views![1].id, 'accent', 'text', '#336699')).toEqual({
    accent: '#336699',
  });
  expect(() => nativePropertyPatch(next, 'total', 'formula', 'text', '2')).toThrow(/migration/);
});

it('date-range view reuse preserves literal windows through linked insertion, revision adoption and Undo', async () => {
  const original = source();
  original.columns.find((column) => column.id === 'total')!.formula = '[q] * [p]';
  original.columns.push(
    { id: 'start', name: 'Start', type: 'date' },
    { id: 'end', name: 'End', type: 'date' },
  );
  original.rows[0].values.start = '2026-11-02';
  original.rows[0].values.end = '2026-11-08';
  original.views![0].timeline = {
    start: 'start',
    end: 'end',
    group: '',
    scale: 'day',
    from: '2026-11-01',
    to: '2026-11-20',
  };
  const value = await author(original, 'view');
  const inserted = await prepareComponentInsertion({
    ...basis(original),
    ...value,
    reuse: 'linked',
    requestId: 'date-view',
    target: {
      fieldMapping: Object.fromEntries(original.columns.map((column) => [column.id, column.id])),
      rowMapping: { sample: 'sample' },
    },
  });
  const current = inserted.preview as StructuredData;
  expect(current.views![1].timeline).toEqual(original.views![0].timeline);
  const payload = clone(value.definition.payload);
  (payload.template.content as StructuredData).views![0].timeline.to = '2026-11-30';
  const update = await createReusableVersion(value.definition, { payload });
  const ready = await previewComponentUpdate({
    ...basis(current),
    ...update,
    requestId: 'date-view-update',
    selections: [{ instanceId: current.reuse!.instances[0].id, choice: 'adopt' }],
  });
  expect(ready.conflicts).toEqual([]);
  const codec = templateCodec('data'),
    authority = new Authority(codec, initial('data', codec, current));
  expect(authority.commit(principal, ready.prepared!.operation).status).toBe('accepted');
  const next = authority.snapshot().content as StructuredData;
  expect(next.views![1].timeline).toEqual({ ...original.views![0].timeline, to: '2026-11-30' });
  expect(next.rows).toEqual(original.rows);
  expect(next.columns).toEqual(current.columns);
  expect(authority.undo(principal, ready.prepared!.operation.operationId).status).toBe('accepted');
  expect(authority.snapshot().content).toEqual(current);
});

it('type conversion is held until explicit migration, addresses cast failures, preserves unrelated peer cells and has one selective Undo', async () => {
  const data: StructuredData = {
    schemaVersion: 2,
    columns: [{ id: 'value', name: 'Amount', type: 'text', defaultValue: '12' }],
    rows: [],
  };
  const value = await author(data),
    inserted = await linked(value),
    current = inserted.preview as StructuredData;
  const instance = current.reuse!.instances[0],
    id = instance.nativeIds!.value,
    part = value.definition.payload.contract.parts[0].id;
  current.rows[1].values[id] = 'wrong';
  const payload = clone(value.definition.payload);
  (payload.template.content as StructuredData).columns[0] = {
    id: 'value',
    name: 'Amount',
    type: 'number',
    defaultValue: 12,
  };
  const update = await createReusableVersion(value.definition, { payload });
  const codec = templateCodec('data'),
    authority = new Authority(codec, initial('data', codec, current));
  const preview = (values?: Record<string, number>) =>
    previewComponentUpdate({
      state: authority.snapshot(),
      identity,
      ...update,
      selections: [
        {
          instanceId: instance.id,
          choice: 'adopt',
          dataMigration: { [part]: { action: 'cast', values } },
        },
      ],
    });
  const held = await previewComponentUpdate({
    ...basis(current),
    ...update,
    selections: [{ instanceId: instance.id, choice: 'adopt' }],
  });
  expect(held.prepared).toBeUndefined();
  expect(held.conflicts[0].field).toBe('schema');
  const failed = await preview();
  expect(failed.prepared).toBeUndefined();
  expect(failed.conflicts.some((c) => c.field.includes('record2'))).toBe(true);
  const ready = await preview({ wrong: 25 });
  expect(ready.conflicts).toEqual([]);
  const peer = { actorId: 'B', clientId: 'b', sessionId: 'two', writable: true, scopes: ['*'] };
  authority.commit(
    peer,
    prepareEditorCommand(
      codec,
      authority.snapshot(),
      peer,
      setCell('record1', 'body', '共同編集'),
    )!,
  );
  expect(authority.commit(principal, ready.prepared!.operation).status).toBe('accepted');
  const after = authority.snapshot().content as StructuredData;
  expect(after.rows.map((r) => r.values[id])).toEqual([12, 25]);
  expect(after.rows[0].values.body).toBe('共同編集');
  expect(authority.undo(principal, ready.prepared!.operation.operationId).status).toBe('accepted');
  const undone = authority.snapshot().content as StructuredData;
  expect(undone.columns.find((c) => c.id === id)!.type).toBe('text');
  expect(undone.rows[1].values[id]).toBe('wrong');
  expect(undone.rows[0].values.body).toBe('共同編集');
  expect(undone.reuse!.instances[0].ref.version).toBe(1);
});

it('materializes formulas only through a schema migration and rejects stale dependent inputs/new rows', async () => {
  const value = await author(),
    current = (await linked(value)).preview as StructuredData;
  const instance = current.reuse!.instances[0],
    part = value.definition.payload.contract.parts.find((p) => p.nativeId === 'total')!.id;
  const payload = clone(value.definition.payload),
    prototype = payload.template.content as StructuredData;
  prototype.columns.find((c) => c.id === 'total')!.type = 'number';
  delete prototype.columns.find((c) => c.id === 'total')!.formula;
  const update = await createReusableVersion(value.definition, { payload });
  const args = {
    ...basis(current),
    ...update,
    selections: [
      {
        instanceId: instance.id,
        choice: 'adopt' as const,
        dataMigration: { [part]: { action: 'cast' as const } },
      },
    ],
  };
  const result = await previewComponentUpdate(args);
  expect(result.conflicts).toEqual([]);
  const next = result.prepared!.preview as StructuredData;
  expect(next.rows.map((r) => r.values[instance.nativeIds!.total])).toEqual([6, 6]);
  const changed = clone(current);
  changed.rows[0].values[instance.nativeIds!.q] = 9;
  expect(() => applyLocalTemplate(result.prepared!, changed)).toThrow();
  const codec = templateCodec('data'),
    authority = new Authority(codec, initial('data', codec, current));
  expect(authority.commit(principal, result.prepared!.operation).status).toBe('accepted');
  expect(authority.undo(principal, result.prepared!.operation.operationId).status).toBe('accepted');
  expect(
    (authority.snapshot().content as StructuredData).rows[0].values[instance.nativeIds!.total],
  ).toBeUndefined();
});

it('field deletion cannot strand formulas/views and explicit keep leaves a local field without changing records', async () => {
  const value = await author(),
    current = (await linked(value)).preview as StructuredData;
  const instance = current.reuse!.instances[0],
    id = instance.nativeIds!.rel,
    part = value.definition.payload.contract.parts.find((p) => p.nativeId === 'rel')!.id;
  const payload = clone(value.definition.payload),
    prototype = payload.template.content as StructuredData;
  prototype.columns = prototype.columns.filter((c) => c.id !== 'rel');
  prototype.views = [];
  payload.contract.parts = payload.contract.parts.filter(
    (p) => !['rel', 'view'].includes(p.nativeId),
  );
  const viewPart = value.definition.payload.contract.parts.find((p) => p.nativeId === 'view')!.id;
  const update = await createReusableVersion(value.definition, { payload });
  const options = {
    ...basis(current),
    ...update,
    selections: [
      {
        instanceId: instance.id,
        choice: 'adopt' as const,
        dataMigration: {
          [part]: { action: 'drop' as const },
          [viewPart]: { action: 'keep' as const },
        },
      },
    ],
  };
  const failed = await previewComponentUpdate(options);
  expect(failed.prepared).toBeUndefined();
  expect(failed.conflicts.some((c) => c.field === 'references')).toBe(true);
  options.selections[0].dataMigration[part] = { action: 'keep' as never };
  const ready = await previewComponentUpdate(options);
  expect(ready.conflicts).toEqual([]);
  const next = ready.prepared!.preview as StructuredData;
  expect(next.rows).toEqual(current.rows);
  expect(next.columns.some((c) => c.id === id)).toBe(true);
  expect(Object.values(next.reuse!.instances[0].parts)).not.toContain(id);
});

it('new fields require explicit addition and deterministic request IDs preserve publication retry with no sample rows', async () => {
  const value = await author({
      schemaVersion: 2,
      columns: [{ id: 'a', name: 'Amount', type: 'number', defaultValue: 2 }],
      rows: [],
    }),
    current = (await linked(value)).preview as StructuredData;
  const payload = clone(value.definition.payload),
    prototype = payload.template.content as StructuredData;
  prototype.columns.push({ id: 'new', name: 'Count', type: 'number', defaultValue: 3 });
  payload.contract.parts = defaultComponentContract(prototype).parts;
  const part = payload.contract.parts.find((p) => p.nativeId === 'new')!.id,
    update = await createReusableVersion(value.definition, { payload });
  const args = {
    ...basis(current),
    ...update,
    requestId: 'stable_request',
    selections: [{ instanceId: current.reuse!.instances[0].id, choice: 'adopt' as const }],
  };
  expect((await previewComponentUpdate(args)).prepared).toBeUndefined();
  const ready = {
    ...args,
    selections: [{ ...args.selections[0], dataMigration: { [part]: { action: 'add' as const } } }],
  };
  const a = await previewComponentUpdate(ready),
    b = await previewComponentUpdate(ready);
  expect(a.conflicts).toEqual([]);
  expect(a.prepared!.operation.actions).toEqual(b.prepared!.operation.actions);
  const next = a.prepared!.preview as StructuredData;
  expect(next.rows.map((r) => r.id)).toEqual(current.rows.map((r) => r.id));
  expect(next.rows[0].values[next.columns.find((c) => c.name === 'Count')!.id]).toBe(3);
  const codec = templateCodec('data'),
    authority = new Authority(codec, initial('data', codec, current));
  expect(authority.commit({ ...principal, writable: false }, a.prepared!.operation).status).toBe(
    'rejected',
  );
  expect(authority.snapshot().content).toEqual(current);
  const changed = clone(current);
  changed.rows.push({
    id: 'late',
    values: {
      existing: 1,
      body: 'late',
      [current.columns.find((c) => c.name === 'Amount')!.id]: 2,
    },
  });
  expect(() => applyLocalTemplate(a.prepared!, changed)).toThrow();
  expect(retainedComponent(next, next.reuse!.instances[0].id).definition.version).toBe(2);
});

it('ordinary cell writes cannot bypass readonly/formula fields by changing an unrelated schema property', () => {
  const data = source();
  data.columns[0].readOnly = true;
  const codec = templateCodec('data'),
    state = initial('data', codec, data);
  expect(() =>
    prepareEditorCommand(
      codec,
      state,
      identity,
      command('malformed', 'malformed', (value) => {
        const next = clone(value) as StructuredData;
        next.columns[0].required = true;
        next.rows[0].values.q = 30;
        return next;
      }),
    ),
  ).toThrow(/read-only/);
});

it('explicit value mapping migrates text into existing-record relations and unknown source bindings are rejected', async () => {
  const value = await author({
    schemaVersion: 2,
    columns: [{ id: 'target', name: 'Target record', type: 'text', defaultValue: 'first' }],
    rows: [],
  });
  const current = (await linked(value)).preview as StructuredData,
    instance = current.reuse!.instances[0],
    part = value.definition.payload.contract.parts[0].id;
  const payload = clone(value.definition.payload);
  (payload.template.content as StructuredData).columns[0] = {
    id: 'target',
    name: 'Target record',
    type: 'relation',
  };
  const update = await createReusableVersion(value.definition, { payload });
  const args = {
    ...basis(current),
    ...update,
    selections: [
      {
        instanceId: instance.id,
        choice: 'adopt' as const,
        dataMigration: { [part]: { action: 'cast' as const } },
      },
    ],
  };
  expect(
    (await previewComponentUpdate(args)).conflicts.some((c) => c.field.includes('record1')),
  ).toBe(true);
  const ready = await previewComponentUpdate({
    ...args,
    selections: [
      {
        ...args.selections[0],
        dataMigration: { [part]: { action: 'cast', values: { first: 'record2' } } },
      },
    ],
  });
  expect(ready.conflicts).toEqual([]);
  expect(
    (ready.prepared!.preview as StructuredData).rows[0].values[instance.nativeIds!.target],
  ).toBe('record2');
  await expect(
    prepareComponentInsertion({
      ...basis(target()),
      ...value,
      reuse: 'copy',
      target: { fieldMapping: { unknown: 'existing' } },
    }),
  ).rejects.toThrow(/Unknown source/);
  await expect(
    previewComponentUpdate({
      ...args,
      selections: [{ ...args.selections[0], partMapping: { unknown: part } }],
    }),
  ).rejects.toThrow(/Unknown mapping/);
});
