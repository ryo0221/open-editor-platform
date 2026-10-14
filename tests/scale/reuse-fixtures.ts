import { strict as assert } from 'node:assert';
import { clone } from '@editor-platform/artifact-core';
import { Authority, initial, type Snapshot } from '@editor-platform/collaboration-core';
import { createDesign, makeDesignElement } from '@editor-platform/design/model';
import { createDeck } from '@editor-platform/slide/model';
import { definitionRef, type TokenSet } from '@editor-platform/reuse-core';
import {
  authorReusableComponent,
  authorReusableStyle,
  authorReusableTokens,
  prepareComponentInsertion,
  reusableParts,
  reusablePrototype,
  templateCodec,
  type ComponentDefinition,
  type ComponentSlotValue,
  type NativeContent,
} from '@editor-platform/templates';
import type { LockedClosure } from '@editor-platform/reuse-core';

export type ReuseScaleDomain = 'design' | 'slide' | 'document';
export const scaleIdentity = {
  actorId: 'scale-author',
  clientId: 'scale-client',
  sessionId: 'scale-session',
};
export const scalePrincipal = { ...scaleIdentity, writable: true, scopes: ['*'] };
export interface ReuseScaleFixture {
  domain: ReuseScaleDomain;
  nested: {
    definition: ComponentDefinition;
    closure: LockedClosure<unknown>;
    slots: Record<string, ComponentSlotValue[]>;
    state: Snapshot<NativeContent>;
  };
  update: {
    definition: ComponentDefinition;
    closure: LockedClosure<unknown>;
    state: Snapshot<NativeContent>;
    bodyAddresses: string[];
    textProperty: string;
  };
}
const bounds = (i: number) => ({
  x: (i % 20) * 420,
  y: Math.floor(i / 20) * 120,
  width: 400,
  height: 100,
});
function prototype(domain: ReuseScaleDomain, count: number): NativeContent {
  if (domain === 'document')
    return {
      schemaVersion: 2,
      blocks: Array.from({ length: count }, (_, i) => ({
        id: `paragraph-${i}`,
        type: 'paragraph' as const,
        text: `保持する案件本文 ${i}`,
      })),
    };
  if (domain === 'slide')
    return {
      ...createDeck(),
      width: 8400,
      height: 6200,
      slides: [
        {
          id: 'prototype-page',
          title: '',
          background: '#ffffff',
          objects: Array.from({ length: count }, (_, i) => ({
            id: `object-${i}`,
            type: i ? ('text' as const) : ('group' as const),
            ...(i ? { groupId: 'object-0' } : {}),
            fill: '#ffffff',
            text: i ? `保持する案件本文 ${i}` : '',
            bounds: bounds(i),
          })),
        },
      ],
    };
  // Native Design authoring adds its existing component instance wrapper.
  return {
    ...createDesign(),
    elements: Array.from({ length: count - 1 }, (_, i) => ({
      ...makeDesignElement(i ? 'text' : 'frame'),
      id: `element-${i}`,
      ...(i ? { parentId: 'element-0' } : {}),
      text: i ? `保持する案件本文 ${i}` : '',
      bounds: i ? bounds(i) : { x: 0, y: 0, width: 8400, height: Math.ceil(count / 20) * 120 },
    })),
  };
}
function destination(domain: ReuseScaleDomain): NativeContent {
  if (domain === 'document')
    return { schemaVersion: 2, blocks: [{ id: 'outside', type: 'paragraph', text: '既存の本文' }] };
  if (domain === 'design') return createDesign();
  return {
    ...createDeck(),
    width: 8400,
    height: 6200,
    slides: [
      {
        id: 'target-page',
        title: '案件の提案',
        background: '#ffffff',
        notes: '既存の発表者ノート',
        objects: [],
      },
    ],
  };
}
export const reuseScaleTarget = (domain: ReuseScaleDomain) =>
  domain === 'slide' ? { slidePageId: 'target-page' } : undefined;
export function largeTokenSet(): TokenSet {
  return {
    schemaVersion: 1,
    modes: ['light', 'dark'],
    defaultMode: 'light',
    tokens: Object.fromEntries(
      Array.from({ length: 2048 }, (_, i) => [
        `token.${i}`,
        {
          type: 'dimension' as const,
          value: i % 16 ? { alias: `token.${i - 1}` } : { value: i + 1, unit: 'px' as const },
          modes: {
            dark: i % 16 ? { alias: `token.${i - 1}` } : { value: i + 2, unit: 'px' as const },
          },
        },
      ]),
    ),
  };
}

export async function reuseScaleFixture(domain: ReuseScaleDomain): Promise<ReuseScaleFixture> {
  const rootParts = domain === 'design' ? 982 : 991;
  const childParts = domain === 'design' ? 2 : 1;
  const root = await authorReusableComponent({
    domain,
    content: prototype(domain, rootParts),
    ids: [],
    name: '1000 parts root',
    definitionId: `scale-${domain}-root`,
  });
  assert.equal(root.definition.payload.contract.parts.length, rootParts);
  let nestedChild: ComponentSlotValue | undefined;
  // Distinct exact definitions at each of ten instance levels; no synthetic bypass.
  for (let level = 9; level >= 1; level--) {
    const child = await authorReusableComponent({
      domain,
      content: prototype(domain, childParts),
      ids: [],
      name: `Nested level ${level}`,
      definitionId: `scale-${domain}-level-${level}`,
    });
    assert.equal(child.definition.payload.contract.parts.length, childParts);
    const slot = child.definition.payload.contract.slots[0];
    assert.ok(slot);
    nestedChild = {
      kind: 'component',
      ...child,
      slots: nestedChild ? { [slot.id]: [nestedChild] } : {},
    };
  }
  const base = await authorReusableComponent({
    domain,
    content: prototype(domain, 20),
    ids: [],
    name: '20 native parts',
    definitionId: `scale-${domain}-component`,
  });
  assert.equal(base.definition.payload.contract.parts.length, 20);
  const native = reusablePrototype(base.definition);
  const nativeParts = reusableParts(native);
  const textParts = base.definition.payload.contract.parts.filter((p) =>
    ['paragraph', 'text'].includes(String(nativeParts.get(p.nativeId)?.type)),
  );
  const property = base.definition.payload.contract.properties.find((p) => p.type === 'text')!;
  const versions = [];
  for (const version of [1, 2]) {
    const tokens = await authorReusableTokens({
      name: 'Scale brand',
      libraryId: 'scale-brand',
      definitionId: 'brand',
      version,
      tokens: {
        schemaVersion: 1,
        modes: ['light', 'dark'],
        defaultMode: 'light',
        tokens: {
          brand: {
            type: 'color',
            value: {
              colorSpace: 'srgb',
              components: version === 1 ? [0.2, 0.4, 0.6] : [0.6, 0.2, 0.1],
              alpha: 1,
            },
            modes: { dark: { colorSpace: 'srgb', components: [0.6, 0.8, 1], alpha: 1 } },
          },
        },
      },
    });
    const style = await authorReusableStyle({
      name: 'Shared body style',
      libraryId: 'scale-brand',
      definitionId: `style-${domain}`,
      version,
      style: {
        schemaVersion: 1,
        domain,
        bindings: { [domain === 'document' ? 'color' : 'typography.color']: { token: 'brand' } },
      },
      tokens: definitionRef(tokens.definition),
      dependencies: tokens.closure.definitions,
    });
    versions.push(
      await authorReusableComponent({
        domain,
        ids: [],
        content: native,
        name: base.definition.name,
        definitionId: base.definition.definitionId,
        version,
        contract: base.definition.payload.contract,
        styles: textParts.map((p) => ({ partId: p.id, ref: definitionRef(style.definition) })),
        dependencies: style.closure.definitions,
      }),
    );
  }
  const codec = templateCodec(domain);
  const authority = new Authority(codec, initial(`scale-${domain}`, codec, destination(domain)));
  const bodyAddresses = [];
  for (let i = 0; i < 50; i++) {
    const state = authority.snapshot();
    const prepared = await prepareComponentInsertion({
      ...versions[0],
      state,
      identity: scaleIdentity,
      reuse: 'linked',
      inputs: { [property.id]: `案件 ${i} の局所入力` },
      target: reuseScaleTarget(domain),
      requestId: `fanout-${domain}-${i}`,
    });
    assert.equal(authority.commit(scalePrincipal, prepared.operation).status, 'accepted');
    const content = authority.snapshot().content;
    assert.ok('reuse' in content && content.reuse);
    bodyAddresses.push(content.reuse.instances.at(-1)!.parts[property.targets[0].partId]);
    if ((i + 1) % 10 === 0) console.log(JSON.stringify({ fixture: domain, inserted: i + 1 }));
  }
  const state = authority.snapshot();
  assert.ok('reuse' in state.content && state.content.reuse);
  assert.equal(state.content.reuse.instances.length, 50);
  assert.equal(
    state.content.reuse.instances.reduce((n, i) => n + Object.keys(i.parts).length, 0),
    1000,
  );
  return {
    domain,
    nested: {
      ...root,
      slots: { [root.definition.payload.contract.slots[0].id]: [nestedChild!] },
      state: initial(`nested-${domain}`, codec, destination(domain)),
    },
    update: { ...versions[1], state: clone(state), bodyAddresses, textProperty: property.id },
  };
}
