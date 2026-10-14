import { expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { clone } from '@editor-platform/artifact-core';
import { definitionRef, lockClosure, sealReusableDefinition } from '@editor-platform/reuse-core';
import { authorReusableComponent } from './reuse-definition';
import { createReusableVersion } from './reuse-catalog';
import {
  exportTemplatePack,
  importTemplatePack,
  LocalCatalog,
  MemoryCatalog,
  TemplateCatalog,
} from './catalog';
import type { ReusableDraft } from './types';
import type { DocumentContent } from '@editor-platform/document/model';
import { brandTokens } from '../../../tests/fixtures/reuse/brand';
const authored = () =>
  authorReusableComponent({
    domain: 'document',
    ids: [],
    name: '注意書き',
    content: {
      schemaVersion: 2,
      blocks: [{ id: 'body', type: 'paragraph', text: '共有する部品', style: { fontSize: 12 } }],
    },
  });

it.each(['memory', 'indexeddb'])(
  'mutable %s draft uses revision checks; publication atomically consumes only the reviewed draft',
  async (kind) => {
    const catalog =
      kind === 'memory' ? new MemoryCatalog() : new LocalCatalog('draft-' + crypto.randomUUID());
    const value = await authored(),
      ref = definitionRef(value.definition);
    const draft: ReusableDraft = { id: 'draft', revision: 1, ref, closure: value.closure };
    await catalog.saveReusableDraft(draft, null);
    expect(await catalog.listReusable()).toEqual([]);
    expect(await catalog.listReusableDrafts()).toEqual([draft]);
    const changed = clone(draft);
    changed.revision = 2;
    await catalog.saveReusableDraft(changed, 1);
    await expect(catalog.saveReusableDraft(changed, 1)).rejects.toThrow('draft changed');
    await expect(
      catalog.putBundle({
        templates: [],
        reusable: [value.closure],
        publishDraft: { id: draft.id, revision: 1 },
      }),
    ).rejects.toThrow('draft changed');
    expect(await catalog.listReusable()).toEqual([]);
    expect(await catalog.listReusableDrafts()).toHaveLength(1);
    const other = await authored();
    await expect(
      catalog.putBundle({
        templates: [],
        reusable: [other.closure],
        publishDraft: { id: draft.id, revision: 2 },
      }),
    ).rejects.toThrow('reviewed draft');
    await catalog.putBundle({
      templates: [],
      reusable: [value.closure],
      publishDraft: { id: draft.id, revision: 2 },
    });
    expect(await catalog.listReusableDrafts()).toEqual([]);
    // The authority/adapter may have committed even when the caller loses the receipt.
    await catalog.putBundle({
      templates: [],
      reusable: [value.closure],
      publishDraft: { id: draft.id, revision: 2 },
    });
    await expect(
      catalog.putBundle({
        templates: [],
        reusable: [other.closure],
        publishDraft: { id: draft.id, revision: 2 },
      }),
    ).rejects.toThrow('different content');
    const payload = clone(value.definition.payload);
    (payload.template.content as DocumentContent).blocks[0].style!.fontSize = 20;
    const v2 = await createReusableVersion(value.definition, { payload, name: '新版' });
    await catalog.saveReusableDraft(
      { id: 'v2', revision: 1, base: ref, ref: definitionRef(v2.definition), closure: v2.closure },
      null,
    );
    await catalog.putBundle({
      templates: [],
      reusable: [v2.closure],
      publishDraft: { id: 'v2', revision: 1 },
    });
    expect(await catalog.getReusable(ref)).toEqual(value.definition);
    expect((await catalog.listReusable())[0].version).toBe(2);
    if (catalog instanceof LocalCatalog) await catalog.close();
  },
);

it.each(['memory', 'indexeddb'])(
  '%s pack publication conflicts expose no partial versions and leave a retryable draft',
  async (kind) => {
    const catalog =
      kind === 'memory' ? new MemoryCatalog() : new LocalCatalog('pack-' + crypto.randomUUID());
    const value = await authored(),
      ref = definitionRef(value.definition);
    await catalog.putBundle({ templates: [], reusable: [value.closure] });
    const altered = await sealReusableDefinition({ ...value.definition, name: '同じ版の改ざん' });
    const conflict = await lockClosure<unknown>([definitionRef(altered)], [altered]);
    const other = await authored();
    const draft: ReusableDraft = {
      id: 'other',
      revision: 1,
      ref: definitionRef(other.definition),
      closure: other.closure,
    };
    await catalog.saveReusableDraft(draft, null);
    await expect(
      catalog.putBundle({
        templates: [],
        reusable: [other.closure, conflict],
        publishDraft: { id: 'other', revision: 1 },
      }),
    ).rejects.toThrow('Immutable');
    expect(await catalog.listReusable()).toEqual([value.definition]);
    expect(await catalog.listReusableDrafts()).toEqual([draft]);
    await catalog.putBundle({
      templates: [],
      reusable: [other.closure],
      publishDraft: { id: 'other', revision: 1 },
    });
    const exported = await exportTemplatePack([], [value.closure, other.closure]);
    const offline = new MemoryCatalog();
    await importTemplatePack(exported, offline);
    expect((await new TemplateCatalog([offline]).closure(ref)).hash).toBe(value.closure.hash);
    const pack = JSON.parse(exported);
    pack.reusable[0].definitions[0].name = 'Broken';
    const clean = new MemoryCatalog();
    await expect(importTemplatePack(JSON.stringify(pack), clean)).rejects.toThrow();
    expect(await clean.listReusable()).toEqual([]);
    if (catalog instanceof LocalCatalog) await catalog.close();
  },
);

it('rejects a malformed token mode/style dependency before publishing any valid bundle member', async () => {
  const value = await authored(),
    catalog = new MemoryCatalog(),
    tokens = clone(brandTokens);
  const id = Object.keys(tokens.tokens)[0];
  tokens.tokens[id].modes = { [tokens.modes.at(-1)!]: { alias: 'missing' } };
  const bad = await sealReusableDefinition({
    schemaVersion: 1,
    libraryId: 'personal',
    definitionId: 'tokens',
    version: 1,
    name: '不正なtoken',
    kind: 'tokens',
    domain: 'shared',
    dependencies: [],
    payload: tokens,
  });
  await expect(
    catalog.putBundle({
      templates: [],
      reusable: [value.closure, await lockClosure<unknown>([definitionRef(bad)], [bad])],
    }),
  ).rejects.toThrow();
  expect(await catalog.listReusable()).toEqual([]);
});
