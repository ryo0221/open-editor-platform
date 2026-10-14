import { expect, it } from 'vitest';
import { clone } from '@editor-platform/artifact-core';
import { Authority, initial } from '@editor-platform/collaboration-core';
import { createDesign, makeDesignElement, type DesignContent } from '@editor-platform/design/model';
import type { SlideContent } from '@editor-platform/slide/model';
import type { WhiteboardContent } from '@editor-platform/whiteboard/model';
import { cellValue, type StructuredData } from '@editor-platform/structured-data/model';
import { defaultView } from '@editor-platform/structured-data/views';
import { authorReusableComponent } from './reuse-definition';
import { prepareComponentInsertion, retainedComponent } from './reuse-apply';
import { authorReusableComposition } from './reuse-composition';
import {
  applyLocalTemplate,
  localTemplateSnapshot,
  prepareInsertion,
  prepareInstantiation,
  templateCodec,
} from './apply';
import { reusableParts } from './reuse-native';
import { assertNative } from './native';
import type { Domain, NativeContent } from './types';

const identity = { actorId: 'A', clientId: 'a', sessionId: 'a' },
  principal = { ...identity, writable: true, scopes: ['*'] };
const basis = (domain: Domain, content: NativeContent) => ({
  identity,
  state: localTemplateSnapshot('artifact', domain, content),
});
const recipe = {
  name: '業務パターン',
  purpose: '部品を組み合わせて再利用',
  category: '個人',
  slots: [],
};

it('Design composition retains scoped native instance overrides and translates a fragment only once', async () => {
  const source = createDesign();
  source.elements = [
    {
      ...makeDesignElement('text'),
      id: 'label',
      text: '既定',
      bounds: { x: 30, y: 40, width: 240, height: 100 },
    },
  ];
  const part = await authorReusableComponent({
    domain: 'design',
    name: 'カード',
    ids: ['label'],
    content: source,
  });
  const content = (
    await prepareComponentInsertion({
      ...basis('design', createDesign()),
      ...part,
      reuse: 'linked',
      requestId: 'card',
    })
  ).preview as DesignContent;
  const member = content.reuse!.instances[0],
    text = part.definition.payload.contract.properties.find((p) => p.type === 'text')!;
  const saved = await authorReusableComposition({
    ...recipe,
    domain: 'design',
    content,
    kind: 'fragment',
    composition: {
      members: { [member.id]: 'linked' },
      inputs: [{ key: 'title', label: '案件名', instanceId: member.id, propertyId: text.id }],
    },
  });
  const target = createDesign(),
    prepared = await prepareInsertion(
      saved.template,
      { title: '案件A' },
      basis('design', target).state,
      identity,
      { position: { x: 90, y: 70 } },
      'placed',
    ),
    next = applyLocalTemplate(prepared, target) as DesignContent,
    adopted = next.reuse!.instances[0];
  assertNative('design', next);
  expect(prepared.command.apply(target)).toEqual(next);
  expect(next.elements[0].bounds.x).toBe(content.elements[0].bounds.x + 90);
  expect(next.elements[0].bounds.y).toBe(content.elements[0].bounds.y + 70);
  expect(next.components[0].elements![0].bounds).toEqual(content.components[0].elements![0].bounds);
  expect(reusableParts(next).get(adopted.parts[text.targets[0].partId])?.text).toBe('案件A');
  expect(retainedComponent(next, adopted.id).definition.hash).toBe(part.definition.hash);
  const authority = new Authority(templateCodec('design'), basis('design', target).state);
  expect(authority.commit(principal, prepared.operation).status).toBe('accepted');
  expect(authority.undo(principal, prepared.operation.operationId).status).toBe('accepted');
  expect(authority.snapshot().content).toEqual(target);
});

it('Slide composition distinguishes in-page object membership from complete page layouts, retaining notes and dimensions', async () => {
  const source: SlideContent = {
    schemaVersion: 2,
    width: 960,
    height: 540,
    slides: [
      {
        id: 'page',
        title: '提案',
        notes: '説明\n二段落目',
        background: '#ffffff',
        objects: [
          {
            id: 'title',
            type: 'text',
            text: '見出し',
            fill: '#eef4ff',
            bounds: { x: 20, y: 30, width: 400, height: 90 },
          },
        ],
      },
    ],
  };
  for (const slide of ['objects', 'pages'] as const) {
    const component = await authorReusableComponent({
      domain: 'slide',
      name: '見出し',
      content: source,
      ids: [],
      slide,
    });
    const target = clone(source);
    target.slides[0].id = 'destination';
    target.slides[0].objects = [];
    target.slides[0].notes = '既存のノート';
    const content = (
      await prepareComponentInsertion({
        ...basis('slide', target),
        ...component,
        reuse: 'linked',
        requestId: slide,
        target: slide === 'objects' ? { slidePageId: 'destination' } : {},
      })
    ).preview as SlideContent;
    const member = content.reuse!.instances[0];
    const saved = await authorReusableComposition({
      ...recipe,
      domain: 'slide',
      content,
      kind: 'fragment',
      ids: Object.values(member.parts),
      composition: { members: { [member.id]: 'linked' }, inputs: [] },
    });
    if (slide === 'pages')
      await expect(
        prepareInsertion(
          saved.template,
          {},
          basis('slide', target).state,
          identity,
          { slidePageId: 'destination' },
          'bad-page',
        ),
      ).rejects.toMatchObject({ code: 'composition-target' });
    const inserted = await prepareInsertion(
      saved.template,
      {},
      basis('slide', target).state,
      identity,
      slide === 'objects' ? { slidePageId: 'destination' } : {},
      'new-' + slide,
    );
    const next = inserted.preview as SlideContent;
    assertNative('slide', next);
    expect([next.width, next.height]).toEqual([960, 540]);
    expect(next.slides[0].notes).toBe('既存のノート');
    expect(next.slides).toHaveLength(slide === 'objects' ? 1 : 2);
    if (slide === 'pages') expect(next.slides[1].notes).toBe('説明\n二段落目');
    else expect(next.reuse!.instances[0].nativeIds!.page).toBe('destination');
    for (const id of Object.values(next.reuse!.instances[0].parts))
      expect(reusableParts(next).has(id)).toBe(true);
  }
});

it('Whiteboard composition remaps Section ownership, connector IDs and ports without changing world geometry', async () => {
  const source: WhiteboardContent = {
    schemaVersion: 3,
    sections: [
      {
        id: 'section',
        title: '受付',
        bounds: { x: -1500, y: -500, width: 600, height: 300 },
        background: '#eef4ff',
      },
    ],
    nodes: [
      {
        id: 'start',
        sectionId: 'section',
        kind: 'rectangle',
        text: '受付',
        color: '#ffffff',
        bounds: { x: -1450, y: -460, width: 160, height: 90 },
        ports: [{ key: 'result', label: '結果', side: 'right', offset: 0.5 }],
      },
      {
        id: 'end',
        sectionId: 'section',
        kind: 'rectangle',
        text: '処理',
        color: '#ffffff',
        bounds: { x: -1200, y: -460, width: 160, height: 90 },
      },
    ],
    connectors: [
      {
        id: 'edge',
        from: 'start',
        to: 'end',
        fromPort: 'result',
        toPort: 'left',
        label: '次へ',
        routing: 'elbow',
      },
    ],
  };
  const target: WhiteboardContent = { schemaVersion: 3, nodes: [], connectors: [], sections: [] },
    component = await authorReusableComponent({
      domain: 'whiteboard',
      name: '受付フロー',
      ids: [],
      content: source,
    }),
    content = (
      await prepareComponentInsertion({
        ...basis('whiteboard', target),
        ...component,
        reuse: 'linked',
        requestId: 'flow',
      })
    ).preview as WhiteboardContent,
    member = content.reuse!.instances[0];
  const saved = await authorReusableComposition({
    ...recipe,
    domain: 'whiteboard',
    content,
    kind: 'fragment',
    ids: [content.sections![0].id],
    composition: { members: { [member.id]: 'linked' }, inputs: [] },
  });
  const next = (
    await prepareInsertion(
      saved.template,
      {},
      basis('whiteboard', target).state,
      identity,
      { position: { x: 50, y: 80 } },
      'flow-copy',
    )
  ).preview as WhiteboardContent;
  assertNative('whiteboard', next);
  expect(next.nodes[0].bounds).toMatchObject({ x: -1400, y: -380 });
  expect(next.nodes[0].sectionId).toBe(next.sections![0].id);
  expect(next.connectors[0]).toMatchObject({
    from: next.nodes[0].id,
    to: next.nodes[1].id,
    fromPort: 'result',
  });
  expect(next.reuse!.instances[0].id).not.toBe(member.id);
});

it('Data composition preserves whole record relations and treats mapped fragment fields as externally owned schema', async () => {
  const source: StructuredData = {
    schemaVersion: 2,
    columns: [
      { id: 'quantity', name: 'Quantity', type: 'number', defaultValue: 2 },
      { id: 'price', name: 'Price', type: 'number', defaultValue: 3 },
      { id: 'total', name: 'Total', type: 'formula', formula: 'Quantity * Price' },
      { id: 'relation', name: 'Related', type: 'relation', defaultValue: 'record' },
    ],
    rows: [{ id: 'record', values: { quantity: 2, price: 3, relation: 'record' } }],
  };
  source.views = [{ ...defaultView(source), id: 'view', name: '集計' }];
  const component = await authorReusableComponent({
    domain: 'data',
    name: '計算項目',
    ids: [],
    content: source,
    data: 'fields',
  });
  const base: StructuredData = {
    schemaVersion: 2,
    columns: [{ id: 'body', name: 'Case', type: 'text' }],
    rows: [{ id: 'target-row', values: { body: '案件本文' } }],
  };
  const content = (
      await prepareComponentInsertion({
        ...basis('data', base),
        ...component,
        reuse: 'linked',
        requestId: 'fields',
        target: { rowMapping: { record: 'target-row' } },
      })
    ).preview as StructuredData,
    member = content.reuse!.instances[0];
  const whole = await authorReusableComposition({
    ...recipe,
    domain: 'data',
    content,
    kind: 'whole',
    composition: { members: { [member.id]: 'linked' }, inputs: [] },
  });
  const created = (await prepareInstantiation(whole.template, {}, 'records')).artifact.draft
    .content as StructuredData;
  const ids = created.reuse!.instances[0].nativeIds!;
  expect(created.rows[0].values[ids.relation]).toBe(created.rows[0].id);
  expect(
    cellValue(created, created.rows[0], created.columns.find((c) => c.id === ids.total)!),
  ).toBe(6);
  const fragment = await authorReusableComposition({
    ...recipe,
    domain: 'data',
    content,
    kind: 'fragment',
    ids: Object.values(member.parts),
    composition: { members: { [member.id]: 'linked' }, inputs: [] },
  });
  const target = clone(base);
  target.columns.push({ id: 'existing-quantity', name: 'Units', type: 'number' });
  target.rows[0].values['existing-quantity'] = 7;
  await expect(
    prepareInsertion(fragment.template, {}, basis('data', target).state, identity),
  ).rejects.toMatchObject({ code: 'row-mapping' });
  const prepared = await prepareInsertion(
    fragment.template,
    {},
    basis('data', target).state,
    identity,
    {
      fieldMapping: { [member.nativeIds!.quantity]: 'existing-quantity' },
      rowMapping: { 'target-row': 'target-row' },
    },
    'mapped-fields',
  );
  const next = prepared.preview as StructuredData,
    adopted = next.reuse!.instances[0],
    quantity = component.definition.payload.contract.parts.find((p) => p.nativeId === 'quantity')!;
  expect(next.rows.map((r) => r.id)).toEqual(['target-row']);
  expect(prepared.command.apply(target)).toEqual(next);
  expect(next.rows[0].values.body).toBe('案件本文');
  expect(next.rows[0].values['existing-quantity']).toBe(7);
  expect(adopted.parts[quantity.id]).toBe('existing-quantity');
  expect(adopted.overrides[quantity.id]).toMatchObject({ schema: true });
  expect(
    cellValue(next, next.rows[0], next.columns.find((c) => c.id === adopted.nativeIds!.total)!),
  ).toBe(21);
  const authority = new Authority(
    templateCodec('data'),
    initial('artifact', templateCodec('data'), target),
  );
  expect(authority.commit(principal, prepared.operation).status).toBe('accepted');
  expect(authority.undo(principal, prepared.operation.operationId).status).toBe('accepted');
  expect(authority.snapshot().content).toEqual(target);
});
