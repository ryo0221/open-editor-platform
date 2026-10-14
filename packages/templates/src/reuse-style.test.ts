import { expect, it } from 'vitest';
import { clone } from '@editor-platform/artifact-core';
import { Authority, initial, operation } from '@editor-platform/collaboration-core';
import { contentToNode } from '@editor-platform/document/engine';
import { exportHtml, type DocumentContent } from '@editor-platform/document/model';
import { createDesign, makeDesignElement, exportDesignSvg } from '@editor-platform/design/model';
import { createDeck } from '@editor-platform/slide/model';
import { Transform } from 'prosemirror-transform';
import { definitionRef, type TokenSet } from '@editor-platform/reuse-core';
import { authorReusableStyle, authorReusableTokens } from './reuse-style';
import {
  authorReusableComponent,
  reusablePrototype,
  materializeComponent,
} from './reuse-definition';
import {
  prepareComponentInsertion,
  prepareComponentDetach,
  retainedComponent,
} from './reuse-apply';
import { previewArtifactMode, previewComponentUpdate } from './reuse-update';
import { prepareComponentSettings } from './reuse-settings';
import { applyLocalTemplate, localTemplateSnapshot, templateCodec } from './apply';
import { lockReusableRoot } from './reuse-dependencies';
import { createReusableVersion } from './reuse-catalog';
import { reusableParts } from './reuse-native';
import { MemoryCatalog, TemplateCatalog } from './catalog';
import type { Domain, NativeContent } from './types';

const identity = { actorId: 'A', clientId: 'a', sessionId: 'a' };
const principal = { ...identity, writable: true, scopes: ['*'] };
const tokens: TokenSet = {
  schemaVersion: 1,
  modes: ['light', 'dark'],
  defaultMode: 'light',
  tokens: {
    'brand.primary': {
      type: 'color',
      value: { colorSpace: 'srgb', components: [0.2, 0.4, 0.6], alpha: 1 },
      modes: { dark: { colorSpace: 'srgb', components: [0.6, 0.8, 1], alpha: 1 } },
    },
    'brand.alias': { type: 'color', value: { alias: 'brand.primary' } },
    'font.size': { type: 'dimension', value: { value: 16, unit: 'px' } },
  },
};
const document = (): DocumentContent => ({
  schemaVersion: 2,
  blocks: [{ id: 'body', type: 'paragraph', text: '案件本文' }],
});
const basis = (content: NativeContent, domain: Domain = 'document') => ({
  state: localTemplateSnapshot('artifact', domain, content),
  identity,
});
async function styled(
  domain: 'design' | 'slide' | 'document' = 'document',
  sharedBrand?: Awaited<ReturnType<typeof authorReusableTokens>>,
) {
  const brand = sharedBrand ?? (await authorReusableTokens({ name: 'Brand', tokens }));
  const style = await authorReusableStyle({
    name: '本文スタイル',
    style: {
      schemaVersion: 1,
      domain,
      bindings: {
        [domain === 'document' ? 'color' : 'typography.color']: { token: 'brand.alias' },
        [domain === 'document' ? 'fontSize' : 'typography.fontSize']: { token: 'font.size' },
      },
    },
    tokens: definitionRef(brand.definition),
    dependencies: brand.closure.definitions,
  });
  const content =
    domain === 'document'
      ? document()
      : domain === 'design'
        ? {
            ...createDesign(),
            elements: [{ ...makeDesignElement('text'), id: 'label', text: '案件本文' }],
          }
        : {
            ...createDeck(),
            slides: [
              {
                id: 'page',
                title: '',
                background: '#ffffff',
                objects: [
                  {
                    id: 'label',
                    type: 'text' as const,
                    fill: '#ffffff',
                    text: '案件本文',
                    bounds: { x: 10, y: 10, width: 200, height: 80 },
                  },
                ],
              },
            ],
          };
  const base = await authorReusableComponent({ name: '共通部品', domain, content, ids: [] });
  const prototype = reusablePrototype(base.definition);
  const part = base.definition.payload.contract.parts.find(
    (p) =>
      reusableParts(prototype).get(p.nativeId)?.type ===
      (domain === 'document' ? 'paragraph' : 'text'),
  )!;
  const component = await authorReusableComponent({
    name: '共通部品',
    domain,
    content: prototype,
    ids: [],
    contract: base.definition.payload.contract,
    styles: [{ partId: part.id, ref: definitionRef(style.definition) }],
    dependencies: style.closure.definitions,
  });
  return { ...component, brand, style };
}
async function insert(
  source: Awaited<ReturnType<typeof styled>>,
  content: NativeContent,
  requestId: string,
  mode?: string,
) {
  return applyLocalTemplate(
    await prepareComponentInsertion({
      ...basis(content, source.definition.domain as Domain),
      definition: source.definition,
      closure: source.closure,
      requestId,
      reuse: 'linked',
      mode,
      ...(source.definition.domain === 'slide' ? { target: { slidePageId: 'target' } } : {}),
    }),
    content,
  ) as DocumentContent;
}

it('one exact shared brand resolves media-specific styles, aliases and all native mode renderings', async () => {
  const brand = await authorReusableTokens({ name: 'Brand', tokens });
  for (const domain of ['design', 'slide', 'document'] as const) {
    const source = await styled(domain, brand);
    const light = await materializeComponent(source.definition, source.closure);
    const dark = await materializeComponent(
      source.definition,
      source.closure,
      {},
      undefined,
      'dark',
    );
    expect(JSON.stringify(light.content)).toContain('#336699');
    expect(JSON.stringify(dark.content)).toContain('#99ccff');
    expect(JSON.stringify(light.content)).toContain(
      `"fontSize":${domain === 'document' ? 12 : 16}`,
    );
    if (domain === 'document')
      expect(exportHtml(light.content as DocumentContent)).toContain('color:#336699');
    if (domain === 'design')
      expect(exportDesignSvg(light.content as ReturnType<typeof createDesign>)).toContain(
        '#336699',
      );
    if (domain === 'design') {
      const prototype = reusablePrototype(source.definition);
      const container = source.definition.payload.contract.parts.find(
        (p) => reusableParts(prototype).get(p.nativeId)?.type === 'instance',
      )!;
      await expect(
        authorReusableComponent({
          name: '容器',
          domain,
          content: prototype,
          ids: [],
          contract: source.definition.payload.contract,
          styles: [{ partId: container.id, ref: definitionRef(source.style.definition) }],
          dependencies: source.style.closure.definitions,
        }),
      ).rejects.toThrow(/rendered native child/);
    }
    expect(source.closure.definitions).toHaveLength(3);
    await expect(
      materializeComponent(source.definition, source.closure, {}, undefined, 'missing'),
    ).rejects.toThrow(/mode/);
  }
});

it('publishes token/style revisions atomically, retaining old exact closures and diagnosing every mode', async () => {
  const source = await styled();
  const storage = new MemoryCatalog(),
    catalog = new TemplateCatalog([storage]);
  await storage.putBundle({ templates: [], reusable: [source.closure] });
  const revisedTokens = clone(tokens);
  revisedTokens.tokens['brand.primary'].value = {
    colorSpace: 'srgb',
    components: [0.8, 0, 0],
    alpha: 1,
  };
  const brand = await authorReusableTokens({
    name: 'Brand',
    tokens: revisedTokens,
    definitionId: source.brand.definition.definitionId,
    version: 2,
  });
  const style = await authorReusableStyle({
    ...source.style.definition,
    version: 2,
    style: source.style.definition.payload.style,
    tokens: definitionRef(brand.definition),
    dependencies: [...source.closure.definitions, ...brand.closure.definitions],
  });
  const component = await authorReusableComponent({
    ...source.definition,
    version: 2,
    domain: 'document',
    content: reusablePrototype(source.definition),
    ids: [],
    contract: source.definition.payload.contract,
    styles: source.definition.payload.styles!.map((b) => ({
      ...b,
      ref: definitionRef(style.definition),
    })),
    dependencies: [...source.closure.definitions, ...style.closure.definitions],
  });
  await storage.putBundle({ templates: [], reusable: [component.closure] });
  expect(component.closure.definitions.map((d) => d.version)).toEqual([2, 2, 2]);
  expect(await catalog.closure(definitionRef(source.definition))).toEqual(source.closure);
  expect(
    JSON.stringify((await materializeComponent(source.definition, source.closure)).content),
  ).toContain('#336699');
  expect(
    JSON.stringify((await materializeComponent(component.definition, component.closure)).content),
  ).toContain('#cc0000');
  const invalid = clone(tokens);
  invalid.tokens['brand.primary'].modes!.dark = { alias: 'missing' };
  await expect(authorReusableTokens({ name: 'bad', tokens: invalid })).rejects.toThrow(/missing/);
  await expect(
    authorReusableStyle({
      name: 'bad',
      style: {
        schemaVersion: 1,
        domain: 'data',
        bindings: { 'view.accent': { token: 'font.size' } },
      },
      tokens: definitionRef(brand.definition),
      dependencies: brand.closure.definitions,
    }),
  ).rejects.toThrow(/type/);
  const mismatched = clone(source.brand.definition);
  mismatched.hash = '0'.repeat(64);
  await expect(
    lockReusableRoot(source.definition, [...source.closure.definitions, mismatched]),
  ).rejects.toThrow(/disagree/);
});

it('artifact mode and explicit instance mode preserve body/local typography with one selective Undo', async () => {
  const source = await styled();
  let content = await insert(source, document(), 'first');
  content = clone(await insert(source, content, 'second', 'light'));
  const first = retainedComponent(content, 'reuse_first').instance;
  const firstId = Object.values(first.parts)[0];
  const block = content.blocks.find((b) => b.id === firstId)!;
  block.text = '手書きの本文';
  block.rich = [{ text: block.text, bold: true }];
  block.style!.fontSize = 22;
  const codec = templateCodec('document'),
    authority = new Authority(codec, initial('artifact', codec, content));
  const diff = await previewArtifactMode({
    state: authority.snapshot(),
    identity,
    mode: 'dark',
    requestId: 'dark',
  });
  expect(diff.conflicts).toEqual([]);
  expect(
    diff.prepared!.operation.actions.some(
      (a) => a.type === 'document.steps' || a.type === 'domain.restore',
    ),
  ).toBe(false);
  expect(authority.commit(principal, diff.prepared!.operation).status).toBe('accepted');
  const changed = authority.snapshot().content as DocumentContent;
  expect(changed.blocks.find((b) => b.id === firstId)).toMatchObject({
    text: '手書きの本文',
    style: { color: '#99ccff', fontSize: 22 },
  });
  expect(changed.reuse!.artifactMode).toBe('dark');
  const second = retainedComponent(changed, 'reuse_second').instance;
  expect(changed.blocks.find((b) => b.id === Object.values(second.parts)[0])!.style!.color).toBe(
    '#336699',
  );
  const editor = contentToNode(changed);
  let position = 0;
  editor.forEach((node, offset) => {
    if (node.attrs.id === firstId) position = offset + 1;
  });
  const tr = new Transform(editor).insert(position, editor.type.schema.text('peer '));
  const peer = { ...principal, actorId: 'B', clientId: 'b', sessionId: 'b' };
  expect(
    authority.commit(
      peer,
      operation(codec, authority.snapshot(), peer, [
        {
          type: 'document.steps',
          target: 'text',
          payload: {
            steps: tr.steps.map((s) => s.toJSON()),
            version: authority.snapshot().engineVersion,
          },
        },
      ]),
    ).status,
  ).toBe('accepted');
  expect(authority.undo(principal, diff.prepared!.operation.operationId).status).toBe('accepted');
  const undone = authority.snapshot().content as DocumentContent;
  expect(undone.reuse!.artifactMode).toBeUndefined();
  expect(undone.blocks[0].text).toBe('案件本文');
  expect(undone.blocks.find((b) => b.id === firstId)!.text).toBe('peer 手書きの本文');
  expect(undone.blocks.find((b) => b.id === firstId)!.style).toEqual(block.style);
  await expect(previewArtifactMode({ ...basis(content), mode: 'missing' })).rejects.toThrow(/mode/);
});

it('combined input/mode reset inherits the artifact, and later insertions read mode/membership preconditions', async () => {
  const source = await styled();
  let content = await insert(source, document(), 'first', 'light');
  content = applyLocalTemplate(
    (await previewArtifactMode({ ...basis(content), mode: 'dark' })).prepared!,
    content,
  ) as DocumentContent;
  const property = source.definition.payload.contract.properties.find((p) => p.type === 'text')!;
  const combined = await prepareComponentSettings({
    ...basis(content),
    instanceId: 'reuse_first',
    inputs: { [property.id]: '新しい本文' },
    mode: null,
  });
  const changed = applyLocalTemplate(combined, content) as DocumentContent;
  const adopted = retainedComponent(changed, 'reuse_first').instance;
  expect(adopted.mode).toBeUndefined();
  const detached = applyLocalTemplate(
    prepareComponentDetach(basis(changed).state, identity, 'reuse_first'),
    changed,
  ) as DocumentContent;
  expect(detached.reuse).toMatchObject({ artifactMode: 'dark', instances: [], closures: [] });
  const cleared = applyLocalTemplate(
    (await previewArtifactMode({ ...basis(detached), mode: null })).prepared!,
    detached,
  ) as DocumentContent;
  expect(cleared.reuse).toBeUndefined();
  expect(cleared.blocks).toEqual(detached.blocks);
  expect(changed.blocks.find((b) => b.id === Object.values(adopted.parts)[0])).toMatchObject({
    text: '新しい本文',
    style: { color: '#99ccff' },
  });
  const third = await insert(source, changed, 'third');
  expect(third.blocks.at(-1)!.style!.color).toBe('#99ccff');
  const reset = (await previewArtifactMode({ ...basis(third), mode: null })).prepared!;
  expect((applyLocalTemplate(reset, third) as DocumentContent).reuse!.artifactMode).toBeUndefined();
  const stale = (await previewArtifactMode({ ...basis(changed), mode: 'light' })).prepared!;
  expect(() => applyLocalTemplate(stale, third)).toThrow();
  const copy = await prepareComponentInsertion({
    ...basis(changed),
    ...source,
    requestId: 'copy',
    reuse: 'copy',
  });
  const resetBefore = applyLocalTemplate(
    (await previewArtifactMode({ ...basis(changed), mode: null })).prepared!,
    changed,
  );
  expect(() => applyLocalTemplate(copy, resetBefore)).toThrow();
  const denied = new Authority(
    templateCodec('document'),
    initial('artifact', templateCodec('document'), changed),
  );
  const request = (
    await previewComponentUpdate({
      state: denied.snapshot(),
      identity,
      ...source,
      selections: [{ instanceId: 'reuse_first', choice: 'adopt', mode: 'light' }],
    })
  ).prepared!;
  expect(denied.commit({ ...principal, writable: false }, request.operation).status).toBe(
    'rejected',
  );
});

it('an inherited variant follows the new default while an explicit default-equal selection remains owned until reset', async () => {
  const source = await styled();
  const first = await insert(source, document(), 'implicit');
  const second = applyLocalTemplate(
    await prepareComponentInsertion({
      ...basis(first),
      ...source,
      requestId: 'explicit',
      reuse: 'linked',
      variant: 'default',
    }),
    first,
  ) as DocumentContent;
  expect(second.reuse!.instances[0].variant).toBeUndefined();
  expect(second.reuse!.instances[1].variant).toBe('default');
  const contract = clone(source.definition.payload.contract);
  const visible = contract.properties.find((p) => p.type === 'boolean')!;
  contract.variants.push({ id: 'compact', label: '簡略', values: { [visible.id]: false } });
  contract.defaultVariant = 'compact';
  const revision = await createReusableVersion(
    source.definition,
    { payload: { ...source.definition.payload, contract } },
    source.style.closure.definitions,
  );
  const diff = await previewComponentUpdate({
    ...basis(second),
    ...revision,
    selections: second.reuse!.instances.map((i) => ({ instanceId: i.id, choice: 'adopt' })),
  });
  const adopted = applyLocalTemplate(diff.prepared!, second) as DocumentContent;
  const [implicit, explicit] = adopted.reuse!.instances;
  expect(adopted.blocks.find((b) => b.id === Object.values(implicit.parts)[0])!.hidden).toBe(true);
  expect(
    Boolean(adopted.blocks.find((b) => b.id === Object.values(explicit.parts)[0])!.hidden),
  ).toBe(false);
  const reset = applyLocalTemplate(
    await prepareComponentSettings({ ...basis(adopted), instanceId: explicit.id, variant: null }),
    adopted,
  ) as DocumentContent;
  expect(reset.reuse!.instances[1].variant).toBeUndefined();
  expect(reset.blocks.find((b) => b.id === Object.values(explicit.parts)[0])!.hidden).toBe(true);
  expect(reset.blocks.map((b) => b.text)).toEqual(adopted.blocks.map((b) => b.text));
});
