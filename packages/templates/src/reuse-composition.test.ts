import { expect, it } from 'vitest';
import { clone, MemoryStorage, type Artifact } from '@editor-platform/artifact-core';
import { Authority, initial, operation } from '@editor-platform/collaboration-core';
import { contentToNode } from '@editor-platform/document/engine';
import type { DocumentContent } from '@editor-platform/document/model';
import { Transform } from 'prosemirror-transform';
import { definitionRef } from '@editor-platform/reuse-core';
import { authorReusableTokens, authorReusableStyle } from './reuse-style';
import { authorReusableComponent } from './reuse-definition';
import { authorReusableComposition } from './reuse-composition';
import {
  prepareComponentInsertion,
  prepareComponentProperties,
  retainedComponent,
} from './reuse-apply';
import { prepareComponentSlot } from './reuse-slots';
import {
  applyLocalTemplate,
  applyInstantiation,
  localTemplateSnapshot,
  prepareInstantiation,
  prepareInsertion,
  templateCodec,
} from './apply';
import { previewArtifactMode, previewComponentUpdate } from './reuse-update';
import { createReusableVersion } from './reuse-catalog';
import { expandTemplate, sealDefinition, validateDefinition } from './engine';
import { saveAsTemplate, selectTemplateContent } from './author';
import { MemoryCatalog, TemplateCatalog, exportTemplatePack, importTemplatePack } from './catalog';
import { remapNative } from './native';
import type { NativeContent } from './types';
import { prepareAgentTemplate } from '../../../apps/playground/src/template-agent';

const identity = { actorId: 'A', clientId: 'a', sessionId: 'a' },
  principal = { ...identity, writable: true, scopes: ['*'] };
const image =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const empty: DocumentContent = {
  schemaVersion: 2,
  blocks: [{ id: 'case/body', type: 'paragraph', text: '自由な案件本文' }],
};
const basis = (content: NativeContent) => ({
  state: localTemplateSnapshot('artifact', 'document', content),
  identity,
});
async function fixture() {
  const brand = await authorReusableTokens({
    name: 'Brand',
    tokens: {
      schemaVersion: 1,
      modes: ['light', 'dark'],
      defaultMode: 'light',
      tokens: {
        brand: {
          type: 'color',
          value: { colorSpace: 'srgb', components: [0.2, 0.4, 0.6], alpha: 1 },
          modes: { dark: { colorSpace: 'srgb', components: [0.6, 0.8, 1], alpha: 1 } },
        },
      },
    },
  });
  const style = await authorReusableStyle({
    name: '本文',
    tokens: definitionRef(brand.definition),
    dependencies: brand.closure.definitions,
    style: { schemaVersion: 1, domain: 'document', bindings: { color: { token: 'brand' } } },
  });
  const native: DocumentContent = {
    schemaVersion: 2,
    blocks: [
      {
        id: 'notice/text',
        type: 'paragraph',
        text: '既定の本文',
        rich: [{ text: '既定の本文', bold: true }],
      },
      { id: 'notice/image', type: 'image', text: '', src: image, alt: 'ロゴ', width: 24 },
    ],
  };
  const base = await authorReusableComponent({
    name: '注意書き',
    domain: 'document',
    content: native,
    ids: [],
  });
  const contract = clone(base.definition.payload.contract);
  contract.properties.push({
    id: 'photo',
    label: '案件画像',
    type: 'asset',
    default: image,
    targets: [
      {
        partId: base.definition.payload.contract.parts.find((p) => p.nativeId === 'notice/image')!
          .id,
        field: 'src',
      },
    ],
  });
  const source = await authorReusableComponent({
    name: '注意書き',
    domain: 'document',
    content: native,
    ids: [],
    contract,
    styles: [
      {
        partId: base.definition.payload.contract.parts[0].id,
        ref: definitionRef(style.definition),
      },
    ],
    dependencies: style.closure.definitions,
  });
  const first = applyLocalTemplate(
    await prepareComponentInsertion({
      ...basis(empty),
      ...source,
      reuse: 'linked',
      requestId: 'one',
    }),
    empty,
  );
  const content = applyLocalTemplate(
    await prepareComponentInsertion({
      ...basis(first),
      ...source,
      reuse: 'linked',
      requestId: 'two',
    }),
    first,
  ) as DocumentContent;
  const text = source.definition.payload.contract.properties.find((p) => p.type === 'text')!.id;
  return { source, style, content, text };
}
function composition(content: DocumentContent, text: string) {
  const [a, b] = content.reuse!.instances;
  return {
    members: { [a.id]: 'linked' as const, [b.id]: 'copy' as const },
    inputs: [
      { key: 'linkedBody', label: 'リンク本文', instanceId: a.id, propertyId: text },
      { key: 'copyBody', label: 'コピー本文', instanceId: b.id, propertyId: text },
    ],
  };
}
const saveOptions = {
  name: '案件文書',
  purpose: '部品を組み合わせた案件文書',
  category: '提案',
  slots: [],
  domain: 'document' as const,
};

it('composes copy/linked members and public inputs, moves an exact asset/token pack to an empty catalog, and creates independent human/agent IDs', async () => {
  const { source, content, text } = await fixture();
  const before = clone(content),
    hash = source.definition.hash;
  const value = await authorReusableComposition({
    ...saveOptions,
    content,
    kind: 'whole',
    composition: composition(content, text),
  });
  expect(value.definition.kind).toBe('template');
  expect(value.closure.definitions).toHaveLength(4);
  expect(value.template.assets).toHaveLength(1);
  expect(content).toEqual(before);
  expect(source.definition.hash).toBe(hash);
  const oldCatalog = new MemoryCatalog();
  await oldCatalog.put(value.template);
  expect((await oldCatalog.listReusable({ kind: 'template' }))[0].hash).toBe(value.definition.hash);
  const pack = await exportTemplatePack([value.template]);
  const clean = new MemoryCatalog();
  await importTemplatePack(pack, clean);
  const host = new TemplateCatalog([clean]);
  expect((await host.closure(definitionRef(value.definition))).hash).toBe(value.closure.hash);
  const imported = (await clean.list())[0];
  const inputs = { linkedBody: '案件Aの本文', copyBody: '固定する本文' };
  const human = await prepareInstantiation(imported, inputs, 'human'),
    agent = await prepareAgentTemplate(host, {
      templateId: imported.templateId,
      templateVersion: imported.templateVersion,
      inputs,
      requestId: 'agent',
    });
  const invalid = { ...inputs, linkedBody: 123 };
  const humanError = await prepareInstantiation(imported, invalid, 'invalid-human').catch((e) => e),
    agentError = await prepareAgentTemplate(host, {
      templateId: imported.templateId,
      templateVersion: imported.templateVersion,
      inputs: invalid,
      requestId: 'invalid-agent',
    }).catch((e) => e);
  expect(humanError.code).toBe('invalid-input');
  expect(agentError.code).toBe(humanError.code);
  expect(agentError.diagnostics).toEqual(humanError.diagnostics);
  const a = human.artifact.draft.content as DocumentContent,
    b = agent.artifact.draft.content as DocumentContent;
  expect(remapNative(a, new Map(), 'normalized').content).toEqual(
    remapNative(b, new Map(), 'normalized').content,
  );
  expect(a.blocks.some((block) => b.blocks.some((other) => other.id === block.id))).toBe(false);
  expect(a.reuse!.instances).toHaveLength(1);
  expect(a.reuse!.instances[0].inputs[text]).toBe('案件Aの本文');
  expect(a.reuse!.instances[0].ref.hash).toBe(hash);
  expect(a.blocks.filter((block) => block.type === 'image').map((block) => block.src)).toEqual([
    image,
    image,
  ]);
  expect(a.blocks.map((block) => block.text)).toContain('固定する本文');
  const store = new MemoryStorage<Artifact<NativeContent>>();
  await applyInstantiation(human, store);
  await applyInstantiation(human, store);
  await expect(applyInstantiation(agent, store, false)).rejects.toMatchObject({
    code: 'unauthorized',
  });
  expect(await store.list()).toHaveLength(1);
  const copy = await saveAsTemplate({ ...saveOptions, content, kind: 'whole' });
  expect('reuse' in copy.content!).toBe(false);
  expect(
    (await prepareInstantiation(copy, {}, 'legacy-copy')).artifact.draft.content,
  ).not.toHaveProperty('reuse');
  expect(copy.assets).toHaveLength(1);
});

it('holds stale positional insertion, then inserts a linked pattern in the destination mode while preserving peer body and one Undo', async () => {
  const { content, text } = await fixture();
  const darker = applyLocalTemplate(
    (await previewArtifactMode({ ...basis(content), mode: 'dark' })).prepared!,
    content,
  ) as DocumentContent;
  const value = await authorReusableComposition({
    ...saveOptions,
    content: darker,
    ids: Object.values(darker.reuse!.instances[0].parts),
    kind: 'fragment',
    composition: {
      members: { [darker.reuse!.instances[0].id]: 'linked' },
      inputs: [
        {
          key: 'body',
          label: '案件本文',
          instanceId: darker.reuse!.instances[0].id,
          propertyId: text,
        },
      ],
    },
  });
  expect(value.definition.kind).toBe('pattern');
  const codec = templateCodec('document'),
    authority = new Authority(codec, initial('target', codec, empty));
  const prepared = await prepareInsertion(
    value.template,
    { body: '新しい案件本文' },
    authority.snapshot(),
    identity,
    {},
    'pattern',
  );
  expect(prepared.notices).toHaveLength(1);
  authority.register(prepared.proposal);
  const token = authority.preview(principal, prepared.id).token;
  const peer = { actorId: 'B', clientId: 'b', sessionId: 'b', writable: true, scopes: ['*'] };
  const state = authority.snapshot(),
    tr = new Transform(contentToNode(state.content as DocumentContent));
  tr.insert(1, tr.doc.type.schema.text('他者の追記'));
  expect(
    authority.submit(
      peer,
      operation(codec, state, peer, [
        {
          type: 'document.steps',
          target: 'text',
          payload: { version: state.engineVersion, steps: tr.steps.map((s) => s.toJSON()) },
        },
      ]),
    ).status,
  ).toBe('accepted');
  expect(authority.applyProposal(principal, prepared.id, token)).toMatchObject({
    status: 'rejected',
    code: 'resync-required',
  });
  expect((authority.snapshot().content as DocumentContent).blocks).toHaveLength(1);
  const fresh = await prepareInsertion(
    value.template,
    { body: '新しい案件本文' },
    authority.snapshot(),
    identity,
    {},
    'pattern_retry',
  );
  authority.register(fresh.proposal);
  expect(
    authority.applyProposal(principal, fresh.id, authority.preview(principal, fresh.id).token)
      .status,
  ).toBe('accepted');
  const adopted = authority.snapshot().content as DocumentContent;
  expect(adopted.blocks.find((block) => block.text === '新しい案件本文')!.style!.color).toBe(
    '#336699',
  );
  expect(adopted.reuse!.instances[0].inputs[text]).toBe('新しい案件本文');
  expect(adopted.reuse!.instances[0].mode).toBeUndefined();
  expect(adopted.reuse!.artifactMode).toBeUndefined();
  expect(authority.undo(principal, 'proposal:' + fresh.id).status).toBe('accepted');
  const undone = authority.snapshot().content as DocumentContent;
  expect(undone.blocks).toHaveLength(1);
  expect(undone.blocks[0].text).toBe('他者の追記自由な案件本文');
  expect(undone.reuse).toBeUndefined();
});

it('retains complete native and nested slot ownership, rejects partial linkage, and adopts later member styles without changing copied content', async () => {
  const { source, style, content, text } = await fixture();
  const parent = content.reuse!.instances[0],
    slot = source.definition.payload.contract.slots[0].id;
  const nested = applyLocalTemplate(
    await prepareComponentSlot({
      ...basis(content),
      instanceId: parent.id,
      slotId: slot,
      values: [{ kind: 'component', ...source }],
      requestId: 'nested',
    }),
    content,
  ) as DocumentContent;
  const child = nested.reuse!.instances[2];
  expect(selectTemplateContent('document', nested, Object.values(parent.parts))).not.toHaveProperty(
    'reuse.instances.0.id',
    parent.id,
  );
  await expect(
    authorReusableComposition({
      ...saveOptions,
      content: nested,
      ids: Object.values(parent.parts),
      kind: 'fragment',
      composition: { members: { [parent.id]: 'linked' }, inputs: [] },
    }),
  ).rejects.toThrow(/complete|member/i);
  const all = await authorReusableComposition({
    ...saveOptions,
    content: nested,
    kind: 'whole',
    composition: {
      ...composition(nested, text),
      members: {
        [parent.id]: 'linked',
        [nested.reuse!.instances[1].id]: 'copy',
        [child.id]: 'linked',
      },
    },
  });
  const result = (
    await prepareInstantiation(
      all.template,
      { linkedBody: '保持する案件本文', copyBody: 'コピーの本文' },
      'nested-target',
    )
  ).artifact.draft.content as DocumentContent;
  expect(result.reuse!.instances).toHaveLength(2);
  const adoptedParent = result.reuse!.instances[0],
    adoptedChild = result.reuse!.instances[1];
  expect(Object.values(adoptedParent.slots).flat()).toEqual([
    Object.values(adoptedChild.parts)[0],
    Object.values(adoptedChild.parts)[1],
  ]);
  const payload = clone(source.definition.payload);
  (payload.template.content as DocumentContent).blocks[0].style = { fontSize: 22 };
  const revised = await createReusableVersion(
    source.definition,
    { payload },
    style.closure.definitions,
  );
  const diff = await previewComponentUpdate({
    ...basis(result),
    ...revised,
    selections: [{ instanceId: adoptedParent.id, choice: 'adopt' }],
  });
  const updated = applyLocalTemplate(diff.prepared!, result) as DocumentContent;
  expect(updated.blocks.find((block) => block.text === '保持する案件本文')!.style!.fontSize).toBe(
    22,
  );
  expect(
    updated.blocks.find((block) => block.text === 'コピーの本文')!.style?.fontSize,
  ).toBeUndefined();
  expect(retainedComponent(updated, adoptedChild.id).definition.version).toBe(1);
});

it('holds malformed composition/closure/input and pack conflicts without exposing partial publication', async () => {
  const { content, text } = await fixture();
  const value = await authorReusableComposition({
    ...saveOptions,
    content,
    kind: 'whole',
    composition: composition(content, text),
  });
  for (const mutate of [
    (d: typeof value.template) => {
      d.composition!.schemaVersion = 99 as 1;
    },
    (d: typeof value.template) => {
      d.composition!.members[0].instanceId = 'missing';
    },
    (d: typeof value.template) => {
      d.composition!.bindings[0].propertyId = 'missing';
    },
    (d: typeof value.template) => {
      (d.content as DocumentContent).reuse!.closures[0].definitions[0].hash = '0'.repeat(64);
    },
  ]) {
    const bad = clone(value.template);
    mutate(bad);
    await expect(validateDefinition(await sealDefinition(bad))).rejects.toThrow();
  }
  expect(() => expandTemplate(value.template, { linkedBody: 3, copyBody: '本文' })).toThrow();
  const old = await saveAsTemplate({
    ...saveOptions,
    content: empty,
    kind: 'whole',
    templateId: value.template.templateId,
  });
  const catalog = new MemoryCatalog([old]);
  await expect(
    importTemplatePack(await exportTemplatePack([value.template]), catalog),
  ).rejects.toThrow(/version|immutable/i);
  expect(await catalog.list()).toEqual([old]);
  expect(await catalog.listReusable()).toEqual([]);
  // Existing immutable definitions retain their own original hash and copy semantics.
  const legacy = await sealDefinition({ ...old, content, artifactSchema: 2 });
  await validateDefinition(legacy);
  expect(expandTemplate(legacy, {}).content).not.toHaveProperty('reuse');
  expect(legacy.content).toHaveProperty('reuse');
});

it('keeps an empty public image part address and can fill it after independent creation', async () => {
  const { source, content } = await fixture();
  const instance = content.reuse!.instances[0],
    asset = source.definition.payload.contract.properties.find((p) => p.type === 'asset')!;
  const cleared = applyLocalTemplate(
    await prepareComponentProperties({
      ...basis(content),
      instanceId: instance.id,
      inputs: { [asset.id]: null },
    }),
    content,
  ) as DocumentContent;
  // Native image placeholders may use an empty string; the optional public asset
  // input uses null. Both representations must keep this stable part address.
  cleared.blocks.find((b) => b.id === instance.parts[asset.targets[0].partId])!.src = '';
  const saved = await authorReusableComposition({
    ...saveOptions,
    content: cleared,
    kind: 'whole',
    composition: {
      members: { [instance.id]: 'linked' },
      inputs: [{ key: 'photo', label: '案件画像', instanceId: instance.id, propertyId: asset.id }],
    },
  });
  const created = (await prepareInstantiation(saved.template, { photo: null }, 'empty-image'))
    .artifact.draft.content as DocumentContent;
  const adopted = created.reuse!.instances[0],
    imageId = adopted.parts[asset.targets[0].partId];
  expect(created.blocks.find((b) => b.id === imageId)?.type).toBe('image');
  expect(created.blocks.find((b) => b.id === imageId)?.src).toBeUndefined();
  const filled = applyLocalTemplate(
    await prepareComponentProperties({
      ...basis(created),
      instanceId: adopted.id,
      inputs: { [asset.id]: image },
    }),
    created,
  ) as DocumentContent;
  expect(filled.blocks.find((b) => b.id === imageId)?.src).toBe(image);
});
