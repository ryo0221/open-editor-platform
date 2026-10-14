import { expect, it } from 'vitest';
import { clone } from '@editor-platform/artifact-core';
import { Authority, initial, operation, type Identity } from '@editor-platform/collaboration-core';
import { contentToNode } from '@editor-platform/document/engine';
import { type DocumentContent } from '@editor-platform/document/model';
import {
  createDesign,
  designDrawings,
  makeDesignElement,
  isDesign,
} from '@editor-platform/design/model';
import { Transform } from 'prosemirror-transform';
import {
  definitionRef,
  lockClosure,
  sealReusableDefinition,
  type ComponentContract,
} from '@editor-platform/reuse-core';
import {
  authorReusableComponent,
  materializeComponent,
  reusablePrototype,
  type ComponentDefinition,
} from './reuse-definition';
import { sealDefinition } from './engine';
import { applyLocalTemplate, localTemplateSnapshot, templateCodec } from './apply';
import {
  prepareComponentInsertion,
  prepareComponentProperties,
  retainedComponent,
} from './reuse-apply';
import { previewComponentUpdate } from './reuse-update';
import { patchReusablePart, reusableParts } from './reuse-native';
import { remapNative } from './native';
import type { NativeContent } from './types';

const identity: Identity = { actorId: 'A', clientId: 'a', sessionId: 'one' };
const principal = { ...identity, writable: true, scopes: ['*'] };
const empty: DocumentContent = {
  schemaVersion: 2,
  blocks: [{ id: 'outside', type: 'paragraph', text: '別の本文' }],
};
const basis = (content: NativeContent) => ({
  identity,
  state: localTemplateSnapshot('artifact', isDesign(content) ? 'design' : 'document', content),
});
async function documentComponent() {
  return authorReusableComponent({
    domain: 'document',
    name: '注意書き',
    ids: [],
    content: {
      schemaVersion: 2,
      blocks: [
        {
          id: 'body',
          type: 'paragraph',
          text: '本文',
          rich: [{ text: '本文', bold: true }],
          style: { color: '#112233', fontSize: 12 },
        },
      ],
    },
  });
}
async function revision(source: ComponentDefinition, edit: (d: ComponentDefinition) => void) {
  const value = clone(source);
  value.version++;
  edit(value);
  value.payload.template = await sealDefinition(value.payload.template);
  const definition = await sealReusableDefinition(value);
  return {
    definition,
    closure: await lockClosure<unknown>([definitionRef(definition)], [definition]),
  };
}
async function insert(
  value: Pick<Awaited<ReturnType<typeof documentComponent>>, 'definition' | 'closure'>,
  content: NativeContent = empty,
  id = 'first',
) {
  const prepared = await prepareComponentInsertion({
    ...basis(content),
    ...value,
    requestId: id,
    reuse: 'linked',
  });
  return applyLocalTemplate(prepared, content);
}

it('insertion and default-equal text edits preserve existing rich text; variant changes preserve local rich-only edits', async () => {
  const value = await documentComponent();
  const property = value.definition.payload.contract.properties.find((p) => p.type === 'text')!;
  const first = (await insert(value)) as DocumentContent;
  expect(first.blocks[1].rich).toEqual([{ text: '本文', bold: true }]);
  const unchanged = applyLocalTemplate(
    await prepareComponentProperties({
      ...basis(first),
      instanceId: 'reuse_first',
      inputs: { [property.id]: '本文' },
    }),
    first,
  ) as DocumentContent;
  expect(unchanged.blocks[1].rich).toEqual(first.blocks[1].rich);
  const changed = await revision(value.definition, (d) => {
    d.payload.contract.variants.push({
      id: 'short',
      label: '短い',
      values: { [property.id]: '短文' },
    });
  });
  const current = (await insert(changed)) as DocumentContent;
  current.blocks[1].rich = [{ text: '本文', italic: true }];
  const next = applyLocalTemplate(
    await prepareComponentProperties({
      ...basis(current),
      instanceId: 'reuse_first',
      variant: 'short',
    }),
    current,
  ) as DocumentContent;
  expect(next.blocks[1].rich).toEqual([{ text: '本文', italic: true }]);
});

it('adopts only selected instances, keeping Japanese body, local style and immutable old closure', async () => {
  const value = await documentComponent();
  const first = await insert(value),
    current = (await insert(value, first, 'second')) as DocumentContent;
  const retained = retainedComponent(current, 'reuse_first'),
    address = Object.values(retained.instance.parts)[0];
  const block = current.blocks.find((b) => b.id === address)!;
  block.text = '編集中の日本語';
  block.rich = [{ text: block.text, underline: true }];
  block.style!.color = '#cc0000';
  const oldHash = value.definition.hash,
    second = clone(retainedComponent(current, 'reuse_second'));
  const update = await revision(value.definition, (d) => {
    const doc = d.payload.template.content as DocumentContent;
    doc.blocks[0].style = { color: '#0033cc', fontSize: 18, spaceAfter: 6 };
    d.payload.contract.properties.find((p) => p.type === 'text')!.default = '上流の本文';
    d.payload.contract.slots.push({
      id: 'extra',
      partId: d.payload.contract.parts[0].id,
      label: '追加本文',
      domain: 'document',
      accepts: ['body'],
      min: 0,
      max: 2,
    });
  });
  const diff = await previewComponentUpdate({
    ...basis(current),
    ...update,
    selections: [{ instanceId: 'reuse_first', choice: 'adopt' }],
  });
  expect(diff.conflicts).toEqual([]);
  expect(diff.prepared).toBeDefined();
  expect(
    diff.prepared!.operation.actions.some(
      (a) => a.type === 'document.steps' || a.type === 'domain.restore',
    ),
  ).toBe(false);
  const next = applyLocalTemplate(diff.prepared!, current) as DocumentContent;
  expect(next.blocks.find((b) => b.id === address)).toMatchObject({
    text: '編集中の日本語',
    rich: [{ text: '編集中の日本語', underline: true }],
    style: { color: '#cc0000', fontSize: 18, spaceAfter: 6 },
  });
  expect(retainedComponent(next, 'reuse_second')).toEqual(second);
  expect(next.reuse?.instances.map((i) => i.id)).toEqual(current.reuse?.instances.map((i) => i.id));
  expect(value.definition.hash).toBe(oldHash);
  expect(diff.changes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: 'preserve', field: 'style.color' }),
      expect.objectContaining({ kind: 'preserve', field: 'body' }),
    ]),
  );
});

it('shared attribute adoption and Undo preserve same-block remote text; stale style ABA is rejected', async () => {
  const value = await documentComponent(),
    content = await insert(value),
    codec = templateCodec('document');
  const authority = new Authority(codec, initial('artifact', codec, content));
  const update = await revision(value.definition, (d) => {
    (d.payload.template.content as DocumentContent).blocks[0].style!.fontSize = 20;
  });
  const prepare = () =>
    previewComponentUpdate({
      state: authority.snapshot(),
      identity,
      ...update,
      selections: [{ instanceId: 'reuse_first', choice: 'adopt' }],
    });
  const diff = await prepare();
  const remote = { ...principal, actorId: 'B', clientId: 'b', sessionId: 'two' };
  const snapshot = authority.snapshot(),
    doc = contentToNode(snapshot.content as DocumentContent);
  const tr = new Transform(doc).insert(
    doc.child(0).nodeSize + 1,
    doc.type.schema.text('遠隔の追記'),
  );
  expect(
    authority.commit(
      remote,
      operation(codec, snapshot, remote, [
        {
          type: 'document.steps',
          target: 'text',
          payload: { version: snapshot.engineVersion, steps: tr.steps.map((s) => s.toJSON()) },
        },
      ]),
    ).status,
  ).toBe('accepted');
  expect(authority.commit(principal, diff.prepared!.operation).status).toBe('accepted');
  expect((authority.snapshot().content as DocumentContent).blocks[1].text).toContain('遠隔の追記');
  expect(authority.undo(principal, diff.prepared!.operation.operationId).status).toBe('accepted');
  expect((authority.snapshot().content as DocumentContent).blocks[1]).toMatchObject({
    text: '遠隔の追記本文',
    style: { fontSize: 12 },
  });
  const stale = (await prepare()).prepared!,
    id = Object.values(retainedComponent(content, 'reuse_first').instance.parts)[0];
  for (const fontSize of [17, 12]) {
    const current = authority.snapshot();
    expect(
      authority.commit(
        remote,
        operation(codec, current, remote, [
          {
            type: 'document.attributes',
            target: 'text',
            payload: { patches: [{ id, values: { style: { color: '#112233', fontSize } } }] },
          },
        ]),
      ).status,
    ).toBe('accepted');
  }
  expect(authority.commit(principal, stale.operation).status).not.toBe('accepted');
});

it('type/deletion conflicts are addressed; explicit stable-part mapping enables swap without changing IDs/body', async () => {
  const value = await documentComponent(),
    current = await insert(value);
  const update = await revision(value.definition, (d) => {
    d.definitionId = 'different';
    const old = d.payload.contract.parts[0].id;
    d.payload.contract.parts[0].id = 'new-part';
    d.payload.contract.properties.forEach((p) =>
      p.targets.forEach((t) => {
        if (t.partId === old) t.partId = 'new-part';
      }),
    );
    d.payload.contract.slots.forEach((s) => {
      s.partId = 'new-part';
    });
    (d.payload.template.content as DocumentContent).blocks[0].style!.fontSize = 22;
  });
  const options = { ...basis(current), ...update, swap: true };
  const rejected = await previewComponentUpdate({
    ...options,
    selections: [{ instanceId: 'reuse_first', choice: 'adopt' }],
  });
  expect(rejected.conflicts).not.toHaveLength(0);
  expect(rejected.prepared).toBeUndefined();
  const result = await previewComponentUpdate({
    ...options,
    selections: [
      {
        instanceId: 'reuse_first',
        choice: 'adopt',
        partMapping: { [value.definition.payload.contract.parts[0].id]: 'new-part' },
      },
    ],
  });
  expect(result.conflicts).toEqual([]);
  const next = applyLocalTemplate(result.prepared!, current) as DocumentContent;
  expect(next.blocks.map((b) => [b.id, b.text, b.rich])).toEqual(
    (current as DocumentContent).blocks.map((b) => [b.id, b.text, b.rich]),
  );
  expect(retainedComponent(next, 'reuse_first').instance.ref.definitionId).toBe('different');
  const pin = await previewComponentUpdate({
    ...options,
    selections: [{ instanceId: 'reuse_first', choice: 'pin' }],
  });
  expect(pin.prepared).toBeUndefined();
  expect(pin.conflicts).toEqual([]);
  const detach = await previewComponentUpdate({
    ...options,
    selections: [{ instanceId: 'reuse_first', choice: 'detach' }],
  });
  expect(applyLocalTemplate(detach.prepared!, current)).not.toHaveProperty('reuse');
});

async function designComponent() {
  const frame = {
    ...makeDesignElement('frame'),
    id: 'frame',
    bounds: { x: 0, y: 0, width: 400, height: 200 },
    layout: {
      direction: 'row' as const,
      gap: 10,
      padding: 0,
      align: 'start' as const,
      sizing: 'fixed' as const,
    },
  };
  const text = {
    ...makeDesignElement('text'),
    id: 'text',
    parentId: 'frame',
    text: 'ラベル',
    bounds: { x: 0, y: 0, width: 80, height: 40 },
    typography: { fontSize: 16, color: '#223344', fontFamily: 'Noto Sans CJK JP' },
  };
  const second = {
    ...makeDesignElement('rectangle'),
    id: 'other',
    parentId: 'frame',
    bounds: { x: 90, y: 0, width: 60, height: 40 },
  };
  const authored = await authorReusableComponent({
    domain: 'design',
    content: { ...createDesign(), elements: [frame, text, second] },
    name: 'カード',
    ids: [],
  });
  const contract: ComponentContract = clone(authored.definition.payload.contract);
  const parts = reusableParts(authored.definition.payload.template.content!);
  const label = contract.parts.find((p) => parts.get(p.nativeId)?.id === 'text')!.id;
  const rootFrame = contract.parts.find((p) => parts.get(p.nativeId)?.type === 'frame')!.id;
  contract.properties.push(
    {
      id: 'size',
      label: '文字サイズ',
      type: 'number',
      min: 1,
      max: 200,
      default: 16,
      targets: [{ partId: label, field: 'typography.fontSize' }],
    },
    {
      id: 'gap',
      label: '間隔',
      type: 'number',
      min: 0,
      max: 100,
      default: 10,
      targets: [{ partId: rootFrame, field: 'layout.gap' }],
    },
  );
  return revision(authored.definition, (d) => {
    d.version = 1;
    d.payload.contract = contract;
  });
}

it('Design gap layout projects local coordinates once, and font reset preserves unrelated override color', async () => {
  const value = await designComponent(),
    content = await insert(value, createDesign());
  if (!isDesign(content)) throw Error('Design');
  const next = applyLocalTemplate(
    await prepareComponentProperties({
      ...basis(content),
      instanceId: 'reuse_first',
      inputs: { gap: 30, size: 24 },
    }),
    content,
  );
  if (!isDesign(next)) throw Error('Design');
  const instance = retainedComponent(next, 'reuse_first').instance,
    label = value.definition.payload.contract.properties.find((p) => p.id === 'size')!.targets[0]
      .partId;
  const address = instance.parts[label];
  expect(reusableParts(next).get(address)?.typography).toMatchObject({
    fontSize: 24,
    color: '#223344',
    fontFamily: 'Noto Sans CJK JP',
  });
  const drawings = designDrawings(next, next.elements[0]),
    drawnText = drawings.find((d) => d.text === 'ラベル')!,
    drawnOther = drawings.find((d) => d.bounds.width === 60)!;
  expect(drawnOther.bounds.x - (drawnText.bounds.x + drawnText.bounds.width)).toBe(30);
  patchReusablePart(next, address, { typography: { color: '#cc0000' } }, true);
  const reset = applyLocalTemplate(
    await prepareComponentProperties({
      ...basis(next),
      instanceId: 'reuse_first',
      reset: ['size'],
    }),
    next,
  );
  expect(reusableParts(reset).get(address)?.typography).toMatchObject({
    fontSize: 16,
    color: '#cc0000',
  });
  await expect(
    prepareComponentProperties({
      ...basis(content),
      instanceId: 'reuse_first',
      inputs: { size: -10 },
    }),
  ).rejects.toThrow();
});

it('default-equal Design overrides survive adoption while unowned font fields update and native maps remap', async () => {
  const value = await designComponent(),
    content = await insert(value, createDesign());
  const explicit = applyLocalTemplate(
    await prepareComponentProperties({
      ...basis(content),
      instanceId: 'reuse_first',
      inputs: { size: 16 },
    }),
    content,
  );
  const update = await revision(value.definition, (d) => {
    d.payload.contract.properties.find((p) => p.id === 'size')!.default = 28;
    const part = d.payload.contract.parts.find(
      (p) => p.id === d.payload.contract.properties.find((p) => p.id === 'size')!.targets[0].partId,
    )!;
    patchReusablePart(d.payload.template.content!, part.nativeId, {
      typography: { color: '#339944' },
    });
  });
  const preview = await previewComponentUpdate({
    ...basis(explicit),
    ...update,
    selections: [{ instanceId: 'reuse_first', choice: 'adopt' }],
  });
  expect(preview.conflicts).toEqual([]);
  const next = applyLocalTemplate(preview.prepared!, explicit),
    instance = retainedComponent(next, 'reuse_first').instance;
  const partId = value.definition.payload.contract.properties.find((p) => p.id === 'size')!
    .targets[0].partId;
  expect(reusableParts(next).get(instance.parts[partId])?.typography).toMatchObject({
    fontSize: 16,
    color: '#339944',
  });
  expect(instance.inputs).toEqual({ size: 16 });
  const mapped = remapNative(next, new Map(), 'again');
  const changed = 'reuse' in mapped.content && mapped.content.reuse!.instances[0];
  expect(changed && Object.keys(changed.nativeIds!)).toEqual(Object.keys(instance.nativeIds!));
  expect(changed && Object.values(changed.nativeIds!)).not.toEqual(
    Object.values(instance.nativeIds!),
  );
  expect(templateCodec('design').validate(mapped.content)).toBe(true);
  expect(await materializeComponent(value.definition, value.closure)).toBeDefined();
});
it('Design adopts component basis dimensions once, preserves placement and refuses hidden fan-out to unselected native instances', async () => {
  const value = await designComponent(),
    content = await insert(value, createDesign());
  if (!isDesign(content)) throw Error('Design');
  const update = await revision(value.definition, (d) => {
    const native = d.payload.template.content;
    if (!native || !isDesign(native)) throw Error('Design');
    native.elements[0].bounds.width = 600;
    native.components[0].width = 600;
    native.components[0].elements!.find((e) => e.type === 'frame')!.bounds.width = 600;
  });
  const diff = await previewComponentUpdate({
    ...basis(content),
    ...update,
    selections: [{ instanceId: 'reuse_first', choice: 'adopt' }],
  });
  expect(diff.conflicts).toEqual([]);
  const next = applyLocalTemplate(diff.prepared!, content);
  if (!isDesign(next)) throw Error('Design');
  expect(next.elements[0].bounds).toMatchObject({
    x: content.elements[0].bounds.x,
    y: content.elements[0].bounds.y,
    width: 600,
  });
  expect(next.components[0].width).toBe(600);
  expect(
    designDrawings(next, next.elements[0]).find((d) => d.text === 'ラベル')?.bounds.width,
  ).toBe(80);
  const shared = clone(content);
  shared.elements.push({ ...clone(shared.elements[0]), id: 'unselected' });
  const rejected = await previewComponentUpdate({
    ...basis(shared),
    ...update,
    selections: [{ instanceId: 'reuse_first', choice: 'adopt' }],
  });
  expect(rejected.prepared).toBeUndefined();
  expect(rejected.conflicts.some((c) => c.field.startsWith('component:'))).toBe(true);
});
it('portable image prototypes and public asset references resolve before native validation; empty images retain stable parts', async () => {
  const image =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  const authored = await authorReusableComponent({
    domain: 'design',
    ids: [],
    name: '画像カード',
    content: {
      ...createDesign(),
      elements: [{ ...makeDesignElement('image'), id: 'photo', src: image }],
    },
  });
  expect(authored.definition.payload.template.assets).toHaveLength(1);
  const prototype = reusableParts(reusablePrototype(authored.definition));
  const imagePart = authored.definition.payload.contract.parts.find(
    (p) => prototype.get(p.nativeId)?.type === 'image',
  )!;
  const value = await revision(authored.definition, (d) => {
    d.payload.contract.properties.push({
      id: 'photo',
      label: '写真',
      type: 'asset',
      default: 'asset://' + d.payload.template.assets[0].id,
      targets: [{ partId: imagePart.id, field: 'src' }],
    });
  });
  const base = createDesign();
  const prepared = await prepareComponentInsertion({
    ...basis(base),
    ...value,
    reuse: 'linked',
    requestId: 'image',
    inputs: { photo: null },
  });
  const empty = applyLocalTemplate(prepared, base),
    instance = retainedComponent(empty, 'reuse_image').instance;
  expect(reusableParts(empty).get(instance.parts[imagePart.id])?.src).toBe('');
  expect(reusableParts(empty).size).toBe(value.definition.payload.contract.parts.length);
  const reset = applyLocalTemplate(
    await prepareComponentProperties({
      ...basis(empty),
      instanceId: instance.id,
      reset: ['photo'],
    }),
    empty,
  );
  expect(reusableParts(reset).get(instance.parts[imagePart.id])?.src).toBe(image);
  await expect(
    prepareComponentProperties({
      ...basis(reset),
      instanceId: instance.id,
      inputs: { photo: 'asset://missing' },
    }),
  ).rejects.toThrow('owned asset');
  const local = JSON.parse(JSON.stringify(reset));
  expect(templateCodec('design').validate(local)).toBe(true);
  expect(retainedComponent(local, instance.id).closure.hash).toBe(value.closure.hash);
});

it('native named typography is inherited before a partial Design instance override', () => {
  const part = { ...makeDesignElement('text'), id: 'part', styleId: 'brand', text: 'ブランド' };
  const content = {
    ...createDesign(),
    styles: [
      {
        id: 'brand',
        name: 'ブランド',
        appearance: { typography: { fontSize: 20, color: '#aa2233' } },
      },
    ],
    components: [
      {
        id: 'component',
        name: 'Card',
        width: 300,
        height: 70,
        template: { type: 'text' as const, text: '', fill: '#ffffff' },
        elements: [part],
      },
    ],
    elements: [
      {
        ...makeDesignElement('instance'),
        id: 'instance',
        componentId: 'component',
        bounds: { x: 0, y: 0, width: 300, height: 70 },
        overrides: { part: { typography: { fontSize: 30 } } },
      },
    ],
  };
  expect(designDrawings(content, content.elements[0])[0].typography).toMatchObject({
    fontSize: 30,
    color: '#aa2233',
  });
});
