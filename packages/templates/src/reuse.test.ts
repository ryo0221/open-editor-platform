import { expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { clone } from '@editor-platform/artifact-core';
import { Authority, initial, operation, type Identity } from '@editor-platform/collaboration-core';
import { isDocument, type DocumentContent } from '@editor-platform/document/model';
import { contentToNode } from '@editor-platform/document/engine';
import { Transform } from 'prosemirror-transform';
import {
  createDesign,
  makeDesignElement,
  exportDesignSvg,
  isDesign,
} from '@editor-platform/design/model';
import {
  definitionRef,
  sealReusableDefinition,
  lockClosure,
  type ComponentContract,
} from '@editor-platform/reuse-core';
import { authorReusableComponent, type ReusablePayload } from './reuse-definition';
import { applyLocalTemplate, localTemplateSnapshot, templateCodec } from './apply';
import {
  prepareComponentInsertion,
  prepareComponentProperties,
  prepareComponentDetach,
  retainedComponent,
} from './reuse-apply';
import { LocalCatalog, MemoryCatalog, TemplateCatalog } from './catalog';
import type { NativeContent } from './types';
import { prepareComponentSlot } from './reuse-slots';
import { materializePartStyle } from './reuse-native';
import { resolveStyle } from '@editor-platform/reuse-core';
import { brandStyles, brandTokens } from '../../../tests/fixtures/reuse/brand';
import { exportHtml } from '@editor-platform/document/model';
const identity: Identity = { actorId: 'A', clientId: 'a', sessionId: 'one' };
const principal = { ...identity, writable: true, scopes: ['*'] };
it('brand styles materialize media units and font/color consistently in native HTML/SVG', () => {
  const doc = document();
  materializePartStyle(doc, 'body', resolveStyle(brandStyles[2], brandTokens), 'ブランド本文');
  expect(doc.blocks[0].style).toEqual({
    color: '#336699',
    fontSize: 12,
    fontFamily: 'Noto Sans CJK JP',
    spaceAfter: 12,
  });
  expect(exportHtml(doc)).toContain('font-size:12pt');
  expect(exportHtml(doc)).toContain('color:#336699');
  const canvas = {
    ...createDesign(),
    elements: [{ ...makeDesignElement('text'), id: 'text', text: 'ブランド' }],
  };
  const style = clone(brandStyles[0]);
  delete style.bindings['layout.gap'];
  materializePartStyle(
    canvas,
    'text',
    resolveStyle(style, brandTokens, { instanceMode: 'dark' }),
    'ブランド',
  );
  const svg = exportDesignSvg(canvas);
  expect(svg).toContain('#99ccff');
  expect(svg).toContain('font-size="16"');
  expect(svg).toContain('Noto Sans CJK JP');
});
const document = (): DocumentContent => ({
  schemaVersion: 2,
  blocks: [{ id: 'body', type: 'paragraph', text: '注意書きの本文' }],
});
async function authored(domain: 'design' | 'document' = 'document') {
  const content =
    domain === 'document'
      ? document()
      : {
          ...createDesign(),
          elements: [{ ...makeDesignElement('text'), id: 'label', text: '日本語カード' }],
        };
  return authorReusableComponent({ domain, content, ids: [], name: '注意書き' });
}
async function inserted(
  domain: 'design' | 'document' = 'document',
  reuse: 'linked' | 'copy' = 'linked',
) {
  const value = await authored(domain),
    content = domain === 'document' ? document() : createDesign();
  const prepared = await prepareComponentInsertion({
    ...value,
    state: localTemplateSnapshot('artifact', domain, content),
    identity,
    reuse,
    requestId: 'insert',
  });
  return { ...value, prepared, content: applyLocalTemplate(prepared, content) };
}
it('copy stays independent; linked Design/Document retain exact definitions and scope remaps', async () => {
  for (const domain of ['design', 'document'] as const) {
    const copy = await inserted(domain, 'copy');
    expect(copy.content).not.toHaveProperty('reuse');
    const linked = await inserted(domain);
    expect('reuse' in linked.content && linked.content.reuse?.instances).toHaveLength(1);
    const { instance, definition } = retainedComponent(linked.content, 'reuse_insert');
    expect(instance.ref).toEqual(definitionRef(definition));
    expect(definition.hash).toBe(linked.definition.hash);
    expect(templateCodec(domain).validate(JSON.parse(JSON.stringify(linked.content)))).toBe(true);
    if (isDesign(linked.content)) {
      expect(Object.values(instance.parts).some((address) => address.includes('/'))).toBe(true);
      expect(exportDesignSvg(linked.content)).toContain('日本語カード');
    }
  }
});
it('public input, visibility, variant, reset and unlink retain unrelated native body and IDs', async () => {
  const { content, definition } = await inserted();
  const prop = definition.payload.contract.properties.find((p) => p.type === 'text')!;
  const visible = definition.payload.contract.properties.find((p) => p.type === 'boolean')!;
  const startIds = isDocument(content) && content.blocks.map((b) => b.id);
  const edit = await prepareComponentProperties({
    state: localTemplateSnapshot('artifact', 'document', content),
    identity,
    instanceId: 'reuse_insert',
    inputs: { [prop.id]: '入力済みの日本語', [visible.id]: false },
  });
  const changed = applyLocalTemplate(edit, content);
  expect(isDocument(changed) && changed.blocks[1]).toMatchObject({
    text: '入力済みの日本語',
    hidden: true,
  });
  const show = await prepareComponentProperties({
    state: localTemplateSnapshot('artifact', 'document', changed),
    identity,
    instanceId: 'reuse_insert',
    reset: [visible.id],
    variant: 'default',
  });
  const shown = applyLocalTemplate(show, changed);
  expect(isDocument(shown) && shown.blocks[1].text).toBe('入力済みの日本語');
  expect(isDocument(shown) && shown.blocks.map((b) => b.id)).toEqual(startIds);
  const detached = applyLocalTemplate(
    prepareComponentDetach(
      localTemplateSnapshot('artifact', 'document', shown),
      identity,
      'reuse_insert',
    ),
    shown,
  );
  expect(detached).not.toHaveProperty('reuse');
  expect(isDocument(detached) && detached.blocks).toEqual(isDocument(shown) && shown.blocks);
});
it('default-equal public input is explicit and survives JSON reload', async () => {
  const { content, definition } = await inserted();
  const p = definition.payload.contract.properties.find((p) => p.type === 'text')!;
  const prepared = await prepareComponentProperties({
    state: localTemplateSnapshot('artifact', 'document', content),
    identity,
    instanceId: 'reuse_insert',
    inputs: { [p.id]: p.default! },
  });
  const value = JSON.parse(JSON.stringify(applyLocalTemplate(prepared, content))) as NativeContent;
  expect(retainedComponent(value, 'reuse_insert').instance.inputs).toHaveProperty(p.id, p.default);
});
it('semantic body and linked components append to a typed Document slot without changing existing input', async () => {
  const { content, definition } = await inserted(),
    child = await authored();
  const slotId = definition.payload.contract.slots[0].id;
  const prepared = await prepareComponentSlot({
    state: localTemplateSnapshot('artifact', 'document', content),
    identity,
    instanceId: 'reuse_insert',
    slotId,
    values: [
      {
        kind: 'body',
        content: {
          schemaVersion: 2,
          blocks: [{ id: 'more', type: 'paragraph', text: '追記する日本語本文' }],
        },
      },
      { kind: 'component', ...child },
    ],
    requestId: 'slot',
  });
  const result = applyLocalTemplate(prepared, content) as DocumentContent;
  expect(result.blocks.map((b) => b.text)).toEqual([
    '注意書きの本文',
    '注意書きの本文',
    '追記する日本語本文',
    '注意書きの本文',
  ]);
  expect(result.reuse?.instances).toHaveLength(2);
  expect(retainedComponent(result, 'reuse_insert').instance.slots[slotId]).toHaveLength(2);
  const codec = templateCodec('document'),
    authority = new Authority(codec, initial('artifact', codec, content));
  expect(authority.commit(principal, prepared.operation).status).toBe('accepted');
  expect(authority.undo(principal, prepared.operation.operationId)).toMatchObject({
    status: 'accepted',
  });
  expect(authority.snapshot().content).toEqual(content);
});
it('Design slot nesting uses Frame local coordinates, and hidden instances hide their children', async () => {
  const frame = {
    ...makeDesignElement('frame'),
    id: 'frame',
    bounds: { x: 100, y: 150, width: 500, height: 300 },
    layout: {
      direction: 'column' as const,
      gap: 10,
      padding: 20,
      align: 'start' as const,
      sizing: 'fixed' as const,
    },
  };
  const parent = await authorReusableComponent({
    domain: 'design',
    content: { ...createDesign(), elements: [frame] },
    ids: [],
    name: 'Frame',
  });
  const child = await authored('design'),
    base = createDesign();
  const placed = applyLocalTemplate(
    await prepareComponentInsertion({
      ...parent,
      state: localTemplateSnapshot('artifact', 'design', base),
      identity,
      reuse: 'linked',
      requestId: 'frame',
    }),
    base,
  );
  const next = applyLocalTemplate(
    await prepareComponentSlot({
      state: localTemplateSnapshot('artifact', 'design', placed),
      identity,
      instanceId: 'reuse_frame',
      slotId: parent.definition.payload.contract.slots[0].id,
      values: [{ kind: 'component', ...child }],
      requestId: 'child',
    }),
    placed,
  );
  expect(isDesign(next) && next.reuse?.instances).toHaveLength(2);
  expect(isDesign(next) && exportDesignSvg(next)).toContain('日本語カード');
  if (!isDesign(next)) throw Error('Design required');
  const parentComponent = next.components.find((c) => c.id === next.elements[0].componentId)!;
  expect(parentComponent.elements?.find((e) => e.type === 'instance')?.bounds).toMatchObject({
    x: 20,
    y: 20,
  });
  const visibility = parent.definition.payload.contract.properties.find(
    (p) => p.targets[0].partId === parent.definition.payload.contract.parts[0].id,
  )!;
  const hidden = applyLocalTemplate(
    await prepareComponentProperties({
      state: localTemplateSnapshot('artifact', 'design', next),
      identity,
      instanceId: 'reuse_frame',
      inputs: { [visibility.id]: false },
    }),
    next,
  );
  expect(isDesign(hidden) && exportDesignSvg(hidden)).not.toContain('日本語カード');
  expect(isDesign(hidden) && hidden.components).toEqual(next.components);
});
it('shared visibility Undo preserves remote Japanese input in the same linked block', async () => {
  const { content, definition } = await inserted(),
    codec = templateCodec('document');
  const authority = new Authority(codec, initial('artifact', codec, content));
  const p = definition.payload.contract.properties.find((p) => p.type === 'boolean')!;
  const edit = await prepareComponentProperties({
    state: authority.snapshot(),
    identity,
    instanceId: 'reuse_insert',
    inputs: { [p.id]: false },
  });
  expect(authority.commit(principal, edit.operation).status).toBe('accepted');
  const current = authority.snapshot(),
    doc = contentToNode(current.content as DocumentContent);
  const tr = new Transform(doc).insert(
    doc.child(0).nodeSize + 1,
    doc.type.schema.text('他の人の追記'),
  );
  const remote = { ...principal, actorId: 'B', clientId: 'b', sessionId: 'two' };
  expect(
    authority.commit(
      remote,
      operation(codec, current, remote, [
        {
          type: 'document.steps',
          target: 'text',
          payload: { version: current.engineVersion, steps: tr.steps.map((s) => s.toJSON()) },
        },
      ]),
    ).status,
  ).toBe('accepted');
  expect(authority.undo(principal, edit.operation.operationId).status).toBe('accepted');
  const result = authority.snapshot().content as DocumentContent;
  expect(result.blocks[1].text).toContain('他の人の追記');
  expect(result.blocks[1].hidden).not.toBe(true);
  expect(result.reuse?.instances[0].inputs).toEqual({});
});
it('invalid typed inputs, variants and missing native targets fail before apply', async () => {
  const { content, definition } = await inserted();
  const p = definition.payload.contract.properties.find((p) => p.type === 'boolean')!;
  const base = {
    state: localTemplateSnapshot('artifact', 'document', content),
    identity,
    instanceId: 'reuse_insert',
  };
  await expect(
    prepareComponentProperties({ ...base, inputs: { [p.id]: 'false' } }),
  ).rejects.toThrow('Invalid public boolean');
  await expect(prepareComponentProperties({ ...base, variant: 'missing' })).rejects.toThrow(
    'variant',
  );
  const damaged = clone(content) as DocumentContent;
  damaged.blocks.pop();
  await expect(
    prepareComponentProperties({
      ...base,
      state: localTemplateSnapshot('artifact', 'document', damaged),
      inputs: { [p.id]: false },
    }),
  ).rejects.toThrow('missing');
});
it('existing Memory/IndexedDB catalogs publish closures atomically and retain archived exact versions', async () => {
  const first = await authored();
  for (const catalog of [new MemoryCatalog(), new LocalCatalog('reuse-' + crypto.randomUUID())]) {
    await catalog.putBundle({ templates: [], reusable: [first.closure] });
    const all = new TemplateCatalog([catalog]);
    expect(await catalog.list()).toEqual([]);
    expect(await all.listReusable({ domain: 'document' })).toHaveLength(1);
    expect((await all.closure(definitionRef(first.definition))).hash).toBe(first.closure.hash);
    const altered = await sealReusableDefinition<ReusablePayload>({
      ...first.definition,
      name: '衝突',
    });
    const other = await authored();
    await expect(
      catalog.putBundle({
        templates: [],
        reusable: [other.closure, await lockClosure<unknown>([definitionRef(altered)], [altered])],
      }),
    ).rejects.toThrow();
    expect(await all.listReusable()).toHaveLength(1);
    await catalog.archiveReusable(first.definition.libraryId, first.definition.definitionId, true);
    expect(await all.listReusable()).toEqual([]);
    expect((await all.closure(definitionRef(first.definition))).hash).toBe(first.closure.hash);
    if (catalog instanceof LocalCatalog) await catalog.close();
  }
});
it('reusable contract is independent of native part names and rejects unsupported native property targets', async () => {
  const contract: ComponentContract = {
    schemaVersion: 1,
    parts: [{ id: 'stable', nativeId: 'body' }],
    slots: [],
    variants: [],
    properties: [
      {
        id: 'width',
        label: '幅',
        type: 'number',
        default: 20,
        targets: [{ partId: 'stable', field: 'width' }],
      },
    ],
  };
  await expect(
    authorReusableComponent({
      domain: 'document',
      content: document(),
      ids: [],
      name: 'Bad',
      contract,
    }),
  ).rejects.toThrow('Unsupported typed native');
});
