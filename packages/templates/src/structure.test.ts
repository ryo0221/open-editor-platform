import { expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { clone } from '@editor-platform/artifact-core';
import { Authority, initial, type Identity } from '@editor-platform/collaboration-core';
import { createDesign } from '@editor-platform/design/model';
import { createDocument, isDocument } from '@editor-platform/document/model';
import { isStructuredData } from '@editor-platform/structured-data/model';
import { createWhiteboard } from '@editor-platform/whiteboard/model';
import { createDeck, deleteObjects, isDeck } from '@editor-platform/slide/model';
import { structureTemplates } from './structure-builtins';
import { builtinTemplates } from './builtins';
import { expandTemplate, validateDefinition } from './engine';
import {
  applyLocalTemplate,
  localTemplateSnapshot,
  prepareInsertion,
  templateCodec,
  prepareViewPreset,
} from './apply';
import {
  readStructure,
  readStructureAppearance,
  itemPart,
  structureAppearanceAddress,
} from './structure';
import {
  prepareStructureChange,
  createStructureVersion,
  captureStructureVersion,
  publishStructureVersion,
} from './structure-apply';
import { reusableParts, patchReusablePart } from './reuse-native';
import { nativeValid, remapNative } from './native';
import { validateNativeReusableDefinitions } from './reuse-load';
import { MemoryCatalog, LocalCatalog, exportTemplatePack, importTemplatePack } from './catalog';
import type { Domain, NativeContent } from './types';
import {
  captureSlideExportSnapshot,
  prepareSlidePptx,
  encodeSlidePptx,
} from '@editor-platform/slide-export';
import {
  captureDocumentExportSnapshot,
  prepareDocumentDocx,
  encodeDocumentDocx,
} from '@editor-platform/document-export';
import { unzipSync, strFromU8 } from 'fflate';
const identity: Identity = { actorId: 'A', clientId: 'a', sessionId: 'one' },
  principal = { ...identity, writable: true, scopes: ['*'] };
const empty = (domain: Domain): NativeContent =>
  domain === 'slide'
    ? createDeck()
    : domain === 'whiteboard'
      ? createWhiteboard()
      : domain === 'design'
        ? createDesign()
        : domain === 'document'
          ? createDocument()
          : { schemaVersion: 2, columns: [], rows: [] };
const freshItem = { id: 'added', title: '追加した項目', body: '説明もその場で編集', image: '' };
const freshDocItem = { id: freshItem.id, title: freshItem.title, body: freshItem.body };
async function inserted(domain: Domain, steps = false) {
  const d = structureTemplates.find(
    (d) => d.domain === domain && d.templateId.endsWith(steps ? 'steps' : 'comparison'),
  )!;
  const base = empty(domain),
    p = await prepareInsertion(
      d,
      d.sample,
      localTemplateSnapshot('artifact', domain, base),
      identity,
      { position: { x: 1300, y: -600 } },
      'insert',
    );
  const content = applyLocalTemplate(p, base),
    id = ('reuse' in content && content.reuse!.instances[0].id) as string;
  return { d, content, id };
}
for (const domain of ['slide', 'whiteboard', 'design', 'document', 'data'] as Domain[]) {
  it(`${domain}: 2→3 and 3→4, reordering/deletion keep actual bodies, IDs, tweaks and native retained recipes`, async () => {
    for (const steps of [false, true]) {
      const { d, content, id } = await inserted(domain, steps),
        before = readStructure(content, id),
        first = before.items[0],
        parts = reusableParts(content),
        address = before.instance.parts[itemPart(first.id, d.structure!.labelRole)];
      if (domain === 'data') patchReusablePart(content, address, { name: '編集済みの項目' });
      else if (domain === 'design')
        patchReusablePart(content, address, {
          name: '編集済みの項目',
          overrides: { [before.instance.nativeIds!.cardTitle]: { text: 'native編集' } },
        });
      else
        patchReusablePart(content, address, {
          text: 'native編集',
          ...(domain === 'document' ? { rich: [{ text: 'native編集', bold: true }] } : {}),
        });
      const part = parts.get(address)!;
      if (part.bounds) (part.bounds as { x: number }).x += 7;
      const items = [
        ...before.items.map((i) => ({ id: i.id })),
        domain === 'data'
          ? { id: freshItem.id, title: freshItem.title, type: 'text' }
          : domain === 'document'
            ? freshDocItem
            : freshItem,
      ];
      const p = await prepareStructureChange({
        state: localTemplateSnapshot('artifact', domain, content),
        identity,
        instanceId: id,
        items,
        requestId: 'add',
      });
      const added = applyLocalTemplate(p, content),
        after = readStructure(added, id);
      expect(after.items).toHaveLength(before.items.length + 1);
      expect(after.items[0].nativeIds).toEqual(first.nativeIds);
      expect(reusableParts(added).get(address)).toEqual(part);
      const reordered = await prepareStructureChange({
        state: localTemplateSnapshot('artifact', domain, added),
        identity,
        instanceId: id,
        items: [...items].reverse().map((item) => ({ id: item.id })),
        requestId: 'reorder',
      });
      expect(readStructure(reordered.preview, id).items.map((i) => i.id)).toEqual(
        items.map((i) => i.id).reverse(),
      );
      expect(reusableParts(reordered.preview).get(address)?.text).toEqual(part.text);
      const removed = await prepareStructureChange({
        state: localTemplateSnapshot('artifact', domain, reordered.preview),
        identity,
        instanceId: id,
        items: before.items.map((i) => ({ id: i.id })),
        requestId: 'remove',
      });
      expect(removed.notices.join(' ')).toContain('added');
      expect(nativeValid(domain, JSON.parse(JSON.stringify(removed.preview)))).toBe(true);
      await validateNativeReusableDefinitions(domain, removed.preview);
      const remapped = remapNative(removed.preview).content;
      await validateNativeReusableDefinitions(domain, remapped);
      expect(
        readStructure(
          remapped,
          ('reuse' in remapped && remapped.reuse!.instances[0].id) as string,
        ).items.map((i) => i.id),
      ).toEqual(before.items.map((i) => i.id));
      if (isDocument(removed.preview))
        expect(removed.preview.blocks.some((b) => b.type === 'table')).toBe(true);
      if (isStructuredData(removed.preview))
        expect(removed.preview.columns.find((c) => c.name === 'Total')?.formula).toContain('[');
    }
  });
}
it('stable IDs, overflow and missing required fields reject with item/element diagnostics', async () => {
  const { d, content, id } = await inserted('slide');
  expect(() => expandTemplate(d, { ...d.sample, items: [freshItem, freshItem] })).toThrow(/重複/);
  expect(() =>
    expandTemplate(d, { ...d.sample, items: [{ id: 'missing', body: '説明' }] }),
  ).toThrow();
  expect(() =>
    expandTemplate(d, {
      ...d.sample,
      items: Array.from({ length: 7 }, (_, i) => ({ ...freshItem, id: `many-${i}` })),
    }),
  ).toThrow();
  await expect(
    prepareStructureChange({
      state: localTemplateSnapshot('artifact', 'slide', content),
      identity,
      instanceId: id,
      layout: 'horizontal',
      items: [
        ...readStructure(content, id).items.map((i) => ({ id: i.id })),
        freshItem,
        { ...freshItem, id: 'fourth' },
      ],
    }),
  ).rejects.toMatchObject({
    code: 'overflow',
    diagnostics: expect.arrayContaining([expect.objectContaining({ path: expect.any(String) })]),
  });
  expect(readStructure(content, id).items).toHaveLength(2);
});
it('Whiteboard refuses external links and Data refuses dependent schema deletion; originals survive', async () => {
  const board = await inserted('whiteboard', true),
    current = readStructure(board.content, board.id);
  if (!('nodes' in board.content)) throw new Error('board');
  board.content.nodes.push({
    id: 'foreign',
    kind: 'rectangle',
    text: '保持',
    color: '#ffffff',
    bounds: { x: 0, y: 0, width: 100, height: 100 },
  });
  board.content.connectors.push({
    id: 'foreign-link',
    from: 'foreign',
    to: current.items[0].nativeIds[0],
    label: '保持',
  });
  await expect(
    prepareStructureChange({
      state: localTemplateSnapshot('artifact', 'whiteboard', board.content),
      identity,
      instanceId: board.id,
      items: current.items.slice(1).map((i) => ({ id: i.id })),
    }),
  ).rejects.toMatchObject({ code: 'structure-reference' });
  const data = await inserted('data'),
    fields = readStructure(data.content, data.id);
  if (!isStructuredData(data.content)) throw new Error('data');
  data.content.columns.push({
    id: 'dependent',
    name: 'Dependent',
    type: 'formula',
    formula: `[${fields.items[0].nativeIds[0]}]`,
  });
  await expect(
    prepareStructureChange({
      state: localTemplateSnapshot('artifact', 'data', data.content),
      identity,
      instanceId: data.id,
      items: fields.items.slice(1).map((i) => ({ id: i.id })),
    }),
  ).rejects.toMatchObject({ code: 'structure-reference' });
});
it('exact linked source adoption is explicit, immutable and existing native edits survive', async () => {
  const { d, content, id } = await inserted('design');
  const copy = await prepareStructureChange({
    state: localTemplateSnapshot('artifact', 'design', content),
    identity,
    instanceId: id,
    items: readStructure(content, id).items.map((i) => ({ id: i.id })),
    relationship: 'linked',
  });
  const linked = copy.preview,
    recipe = clone(d),
    repeats = clone(recipe.repeats);
  repeats[0].stepX = 310;
  const updated = await createStructureVersion(d, { repeats }),
    catalog = new MemoryCatalog([d]);
  await catalog.put(updated);
  expect((await catalog.getVersion(d.templateId, 1))?.hash).toBe(d.hash);
  expect(readStructure(linked, id).definition.templateVersion).toBe(1);
  const adopted = await prepareStructureChange({
    state: localTemplateSnapshot('artifact', 'design', linked),
    identity,
    instanceId: id,
    items: readStructure(linked, id).items.map((i) => ({ id: i.id })),
    definition: updated,
  });
  expect(readStructure(adopted.preview, id).definition.templateVersion).toBe(2);
  await validateDefinition(updated);
});
it('Review/Viewer setting presets preserve the source and existing annotation path', async () => {
  for (const domain of ['review', 'file'] as const) {
    const d = builtinTemplates.find((d) => d.domain === domain && d.kind === 'preset')!,
      original = JSON.stringify(d);
    const settings = await prepareViewPreset(d, d.sample);
    expect(Object.keys(settings).length).toBeGreaterThan(0);
    expect(JSON.stringify(d)).toBe(original);
  }
});
for (const domain of ['slide', 'whiteboard', 'design', 'document', 'data'] as Domain[]) {
  it(`${domain}: peer edit, selective Undo/Redo, denied/stale/retried operation use existing authority`, async () => {
    const { content, id } = await inserted(domain),
      codec = templateCodec(domain),
      authority = new Authority(codec, initial('artifact', codec, content));
    const current = readStructure(content, id),
      add = await prepareStructureChange({
        state: authority.snapshot(),
        identity,
        instanceId: id,
        items: [
          ...current.items.map((i) => ({ id: i.id })),
          domain === 'data'
            ? { id: 'added', title: '新しい列', type: 'number' }
            : domain === 'document'
              ? freshDocItem
              : freshItem,
        ],
        requestId: 'shared-add',
      });
    expect(authority.commit({ ...principal, writable: false }, add.operation).status).not.toBe(
      'accepted',
    );
    expect(authority.commit(principal, add.operation).status).toBe('accepted');
    const revision = authority.snapshot().revision;
    expect(authority.commit(principal, add.operation).status).toBe('accepted');
    expect(authority.snapshot().revision).toBe(revision);
    const peer = { actorId: 'B', clientId: 'b', sessionId: 'two', writable: true, scopes: ['*'] };
    const peerState = authority.snapshot(),
      next = clone(peerState.content),
      address = current.items[0].nativeIds[0];
    if (domain === 'data') patchReusablePart(next, address, { name: 'peer-column' });
    else if (domain === 'document')
      patchReusablePart(next, address, { text: 'peer本文', rich: [{ text: 'peer本文' }] });
    else patchReusablePart(next, address, { text: 'peer本文' });
    const { reusableNativeActions } = await import('./reuse-apply');
    const { prepareNativeApplication } = await import('./apply');
    const edited = prepareNativeApplication({
      state: peerState,
      identity: peer,
      id: 'peer-edit',
      definition: { templateId: 'peer', templateVersion: 1, hash: 'peer' },
      summary: 'peer edit',
      actions: reusableNativeActions(peerState, peer, next),
    });
    expect(authority.commit(peer, edited.operation).status).toBe('accepted');
    const peerValue = clone(reusableParts(authority.snapshot().content).get(address));
    const undone = authority.undo(principal, add.operation.operationId);
    expect(undone.status).toBe('accepted');
    expect(readStructure(authority.snapshot().content, id).items).toHaveLength(2);
    expect(reusableParts(authority.snapshot().content).get(address)).toEqual(peerValue);
    if (undone.status !== 'accepted') throw new Error('undo');
    expect(authority.undo(principal, undone.operationId, true).status).toBe('accepted');
    const basis = authority.snapshot(),
      first = readStructure(basis.content, id);
    const one = await prepareStructureChange({
      state: basis,
      identity,
      instanceId: id,
      items: first.items.map((i) => ({ id: i.id })),
      relationship: 'linked',
      requestId: 'first-meta',
    });
    const stale = await prepareStructureChange({
      state: basis,
      identity,
      instanceId: id,
      items: first.items.map((i) => ({ id: i.id })),
      relationship: 'linked',
      requestId: 'stale-meta',
    });
    expect(authority.commit(principal, one.operation).status).toBe('accepted');
    expect(authority.commit(principal, stale.operation).status).not.toBe('accepted');
    expect(reusableParts(authority.snapshot().content).get(address)).toEqual(peerValue);
  });
}
it('native images, rich styles, complex overrides and the edited flow graph remain canonical during reflow', async () => {
  const pixel =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  for (const domain of ['slide', 'whiteboard', 'design'] as Domain[]) {
    const { content, id } = await inserted(domain, true),
      current = readStructure(content, id),
      first = current.items[0];
    const image =
      domain === 'design'
        ? `${current.instance.parts[itemPart(first.id, 'title')]}/${current.instance.nativeIds!.cardImage}`
        : current.instance.parts[itemPart(first.id, 'image')];
    patchReusablePart(content, image, { src: pixel });
    const title =
      domain === 'design'
        ? `${current.instance.parts[itemPart(first.id, 'title')]}/${current.instance.nativeIds!.cardTitle}`
        : current.instance.parts[itemPart(first.id, 'title')];
    patchReusablePart(content, title, {
      text: 'native',
      runs: [{ text: 'native', style: { bold: true, color: '#cc3300' } }],
    });
    if ('connectors' in content) {
      content.connectors[0].label = '保持する接続';
      content.connectors[0].stroke = '#cc3300';
    }
    const originalParts = reusableParts(content),
      body = clone(originalParts.get(image)),
      rich = clone(originalParts.get(title)),
      edges = 'connectors' in content ? clone(content.connectors) : undefined;
    const prepared = await prepareStructureChange({
      state: localTemplateSnapshot('artifact', domain, content),
      identity,
      instanceId: id,
      items: current.items.map((item) => ({ id: item.id })).reverse(),
    });
    expect(reusableParts(prepared.preview).get(image)?.src).toBe(body!.src);
    expect(reusableParts(prepared.preview).get(title)?.runs).toEqual(rich!.runs);
    if (edges && 'connectors' in prepared.preview)
      expect(prepared.preview.connectors).toEqual(edges);
    expect(readStructure(prepared.preview, id).items.find((i) => i.id === first.id)?.label).toBe(
      'native',
    );
  }
});
it('ordinary Delete remains importable without rewriting native content or historical management data', async () => {
  const { content, id } = await inserted('slide'),
    current = readStructure(content, id),
    title = current.instance.parts[itemPart(current.items[0].id, 'title')];
  if (!isDeck(content)) throw new Error('slide');
  const slide = content.slides.find((s) => s.objects.some((o) => o.id === title))!;
  const deleted = deleteObjects(slide.id, [title]).apply(content),
    saved = clone(deleted);
  expect(() => readStructure(deleted, id)).toThrow(/要修復/);
  await expect(validateNativeReusableDefinitions('slide', deleted)).resolves.toBeUndefined();
  expect(deleted).toEqual(saved);
  const detached = clone(deleted);
  detached.reuse!.instances = [];
  // Native artifact import validates both the detached draft and immutable saved versions.
  for (const value of [detached, saved])
    await expect(validateNativeReusableDefinitions('slide', value)).resolves.toBeUndefined();
  expect(saved.reuse!.instances[0].parts).toEqual(current.instance.parts);
  const invalid = clone(saved);
  invalid.slides = invalid.slides.filter((s) => s.id !== slide.id);
  delete invalid.reuse!.instances[0].parts[itemPart(current.items[0].id, 'body')];
  delete invalid.reuse!.instances[0].overrides[itemPart(current.items[0].id, 'body')];
  await expect(validateNativeReusableDefinitions('slide', invalid)).rejects.toMatchObject({
    code: 'structure-schema',
  });
});
it('unsupported count, forged roles/metadata and attempts to overwrite existing bodies are explicit diagnostics', async () => {
  const { content, id, d } = await inserted('slide'),
    current = readStructure(content, id);
  await expect(
    prepareStructureChange({
      state: localTemplateSnapshot('artifact', 'slide', content),
      identity,
      instanceId: id,
      items: current.items.map((i) => ({ id: i.id, title: 'wrong authority' })),
    }),
  ).rejects.toMatchObject({ code: 'native-edit-required' });
  const wrong = clone(content);
  if (!('reuse' in wrong) || !wrong.reuse) throw new Error('reuse');
  wrong.reuse.instances[0].inputs.layout = 'invalid';
  await expect(validateNativeReusableDefinitions('slide', wrong)).rejects.toMatchObject({
    code: 'structure-schema',
  });
  const missing = clone(content);
  if (!('reuse' in missing) || !missing.reuse) throw new Error('reuse');
  delete missing.reuse.instances[0].parts[itemPart(current.items[0].id, 'body')];
  delete missing.reuse.instances[0].overrides[itemPart(current.items[0].id, 'body')];
  await expect(validateNativeReusableDefinitions('slide', missing)).rejects.toMatchObject({
    code: 'structure-schema',
  });
  expect(() =>
    expandTemplate(d, { ...d.sample, items: [{ ...freshItem, body: '長'.repeat(2000) }] }),
  ).toThrow();
  expect(readStructure(content, id).items).toHaveLength(2);
});

for (const durable of [false, true])
  it(`${durable ? 'IndexedDB' : 'memory'} publication twice from adopted v1 creates immutable v2 and v3`, async () => {
    const { d, content, id } = await inserted('slide'),
      current = readStructure(content, id),
      title = current.instance.parts[itemPart(current.items[0].id, 'title')],
      catalog = durable
        ? new LocalCatalog(`repeat-publication-${crypto.randomUUID()}`)
        : new MemoryCatalog();
    await catalog.put(d);
    await catalog.archive(d.templateId, true);
    patchReusablePart(content, title, { text: '二版の内容' });
    const v2 = await publishStructureVersion(content, id, catalog);
    patchReusablePart(content, title, { text: '三版の内容' });
    const v3 = await publishStructureVersion(content, id, catalog);
    expect([v2.templateVersion, v3.templateVersion]).toEqual([2, 3]);
    expect(readStructure(content, id).definition).toEqual(d);
    expect(await catalog.getVersion(d.templateId, 1)).toEqual(d);
    expect(await catalog.getVersion(d.templateId, 2)).toEqual(v2);
    expect(await catalog.getVersion(d.templateId, 3)).toEqual(v3);
    expect((v2.sample.items as { title: string }[])[0].title).toBe('二版の内容');
    expect((v3.sample.items as { title: string }[])[0].title).toBe('三版の内容');
    if (catalog instanceof LocalCatalog) await catalog.close();
  });
it('concurrent different publications keep the winning version immutable and reject the loser', async () => {
  const { d, content, id } = await inserted('slide'),
    other = clone(content),
    title = readStructure(content, id).instance.parts[
      itemPart(readStructure(content, id).items[0].id, 'title')
    ],
    catalog = new MemoryCatalog();
  await catalog.put(d);
  patchReusablePart(content, title, { text: '公開 A' });
  patchReusablePart(other, title, { text: '公開 B' });
  const results = await Promise.allSettled([
    publishStructureVersion(content, id, catalog),
    publishStructureVersion(other, id, catalog),
  ]);
  const winner = results.find((r) => r.status === 'fulfilled')!;
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.find((r) => r.status === 'rejected')).toMatchObject({
    reason: { code: 'version-conflict' },
  });
  if (winner.status !== 'fulfilled') throw new Error('winner');
  expect(await catalog.getVersion(d.templateId, 2)).toEqual(winner.value);
  expect(await catalog.getVersion(d.templateId, 1)).toEqual(d);
});

it('Design component updates preserve old cards while later additions render the adopted component version', async () => {
  const { d, content, id } = await inserted('design'),
    current = readStructure(content, id);
  const link = await prepareStructureChange({
    state: localTemplateSnapshot('artifact', 'design', content),
    identity,
    instanceId: id,
    items: current.items.map((i) => ({ id: i.id })),
    relationship: 'linked',
  });
  const linked = applyLocalTemplate(link, content),
    source = clone(d.content!);
  if (!('components' in source) || !('components' in linked)) throw new Error('design');
  source.components[0].elements!.find((e) => e.id === 'cardTitle')!.fill = '#cf2358';
  const v2 = await createStructureVersion(d, { content: source }),
    adopt = await prepareStructureChange({
      state: localTemplateSnapshot('artifact', 'design', linked),
      identity,
      instanceId: id,
      items: current.items.map((i) => ({ id: i.id })),
      definition: v2,
    }),
    adopted = applyLocalTemplate(adopt, linked);
  if (!('components' in adopted)) throw new Error('design');
  expect(adopted.components.slice(0, linked.components.length)).toEqual(linked.components);
  expect(adopted.components).toHaveLength(linked.components.length + 1);
  expect(readStructure(adopted, id).definition.templateVersion).toBe(2);
  const add = await prepareStructureChange({
      state: localTemplateSnapshot('artifact', 'design', adopted),
      identity,
      instanceId: id,
      requestId: 'component-add',
      items: [...current.items.map((i) => ({ id: i.id })), freshItem],
    }),
    added = applyLocalTemplate(add, adopted),
    after = readStructure(added, id),
    color = (itemId: string) =>
      reusableParts(added).get(structureAppearanceAddress(after, itemId, 'title/cardTitle'))!.fill;
  expect(color(current.items[0].id)).toBe('#263c48');
  expect(color('added')).toBe('#cf2358');
  expect(readStructureAppearance(added, id)).toHaveLength(3);
  if (!('components' in added)) throw new Error('design');
  expect(added.components).toEqual(adopted.components);
  await expect(validateNativeReusableDefinitions('design', clone(added))).resolves.toBeUndefined();
  // Publishing a mixed-version composition must capture the first native card's actual definition.
  const captured = await captureStructureVersion(added, id),
    expanded = expandTemplate(captured, captured.sample, { remap: false }).content!,
    capturedStructure = readStructure(expanded, 'structure');
  expect(
    reusableParts(expanded).get(
      structureAppearanceAddress(
        capturedStructure,
        capturedStructure.items[0].id,
        'title/cardTitle',
      ),
    )!.fill,
  ).toBe('#263c48');
  const codec = templateCodec('design'),
    authority = new Authority(codec, initial('artifact', codec, linked));
  expect(authority.commit(principal, adopt.operation).status).toBe('accepted');
  const sharedAdd = await prepareStructureChange({
    state: authority.snapshot(),
    identity,
    instanceId: id,
    requestId: 'component-add',
    items: [...current.items.map((i) => ({ id: i.id })), freshItem],
  });
  expect(authority.commit(principal, sharedAdd.operation).status).toBe('accepted');
  expect(authority.snapshot().content).toEqual(added);
  const peer = { actorId: 'B', clientId: 'b', sessionId: 'two', writable: true, scopes: ['*'] },
    peerState = authority.snapshot(),
    peerContent = clone(peerState.content),
    oldCard = current.items[0].nativeIds[0];
  patchReusablePart(peerContent, oldCard, { name: 'peer編集を保持' });
  const { reusableNativeActions } = await import('./reuse-apply');
  const { prepareNativeApplication } = await import('./apply');
  const peerEdit = prepareNativeApplication({
    state: peerState,
    identity: peer,
    id: 'peer-edit',
    definition: { templateId: 'peer', templateVersion: 1, hash: 'peer' },
    summary: 'peer edit',
    actions: reusableNativeActions(peerState, peer, peerContent),
  });
  expect(authority.commit(peer, peerEdit.operation).status).toBe('accepted');
  for (const expected of [added, adopted, linked])
    patchReusablePart(expected, oldCard, { name: 'peer編集を保持' });
  const undoAdd = authority.undo(principal, sharedAdd.operation.operationId);
  expect(undoAdd.status).toBe('accepted');
  expect(authority.snapshot().content).toEqual(adopted);
  const undoAdopt = authority.undo(principal, adopt.operation.operationId);
  expect(undoAdopt.status).toBe('accepted');
  expect(authority.snapshot().content).toEqual(linked);
  expect(authority.undo(principal, undoAdopt.operationId, true).status).toBe('accepted');
  expect(authority.undo(principal, undoAdd.operationId, true).status).toBe('accepted');
  expect(authority.snapshot().content).toEqual(added);
});

for (const domain of ['slide', 'whiteboard', 'design'] as Domain[])
  it(`${domain}: emphasis and visibility are native edits that survive reflow and Undo`, async () => {
    const { content, id } = await inserted(domain),
      current = readStructure(content, id),
      first = current.items[0].id;
    const p = await prepareStructureChange({
      state: localTemplateSnapshot('artifact', domain, content),
      identity,
      instanceId: id,
      items: current.items.map((i) => ({ id: i.id })),
      appearance: [{ id: first, emphasized: true, descriptionVisible: false, imageVisible: false }],
    });
    const changed = applyLocalTemplate(p, content);
    expect(readStructureAppearance(changed, id)[0]).toEqual({
      id: first,
      emphasized: true,
      descriptionVisible: false,
      imageVisible: false,
    });
    const reflow = await prepareStructureChange({
      state: localTemplateSnapshot('artifact', domain, changed),
      identity,
      instanceId: id,
      items: [...current.items.map((i) => ({ id: i.id })), freshItem],
    });
    expect(readStructureAppearance(reflow.preview, id)[0]).toEqual(
      readStructureAppearance(changed, id)[0],
    );
    const codec = templateCodec(domain),
      authority = new Authority(codec, initial('artifact', codec, content));
    expect(authority.commit(principal, p.operation).status).toBe('accepted');
    const undone = authority.undo(principal, p.operation.operationId);
    expect(undone.status).toBe('accepted');
    expect(authority.snapshot().content).toEqual(content);
    expect(authority.undo(principal, undone.operationId, true).status).toBe('accepted');
    expect(authority.snapshot().content).toEqual(changed);
  });

for (const domain of ['slide', 'whiteboard', 'design', 'document', 'data'] as Domain[])
  it(`${domain}: edited recipe publication survives durable catalog reload and pack import without changing v1`, async () => {
    const { content, id, d } = await inserted(domain),
      current = readStructure(content, id),
      staticEntry = Object.entries(current.instance.parts).find(
        ([key]) =>
          key.startsWith('anchor.') &&
          ['heading', 'quantity', 'section', 'frame'].includes(key.slice(7)),
      )!;
    patchReusablePart(
      content,
      staticEntry[1],
      domain === 'data'
        ? { name: '公開版の列' }
        : domain === 'whiteboard'
          ? { title: '公開版の領域' }
          : domain === 'design'
            ? { name: '公開版の枠' }
            : { text: '公開版の見出し' },
    );
    const first = current.items[0].id,
      address =
        domain === 'design'
          ? structureAppearanceAddress(current, first, d.structure!.appearance!.emphasis)
          : current.instance.parts[itemPart(first, d.structure!.labelRole)];
    patchReusablePart(
      content,
      address,
      domain === 'data'
        ? { name: '公開項目', type: 'number', defaultValue: 0 }
        : {
            text: '公開項目',
            ...(domain === 'document'
              ? { rich: [{ text: '公開項目', bold: true }] }
              : { runs: [{ text: '公開項目', style: { bold: true } }] }),
          },
    );
    const published = await captureStructureVersion(content, id),
      expanded = expandTemplate(published, published.sample);
    expect(JSON.stringify(expanded.content)).toContain('公開項目');
    expect(JSON.stringify(expanded.content)).toContain('公開版');
    if (domain === 'data')
      expect(
        [...reusableParts(expanded.content!).values()].find((p) => p.name === '公開項目')?.type,
      ).toBe('number');
    if (domain !== 'data') expect(JSON.stringify(expanded.content)).toContain('"bold":true');
    const dbName = `structure-${crypto.randomUUID()}`,
      storage = new LocalCatalog(dbName);
    await storage.put(d);
    await storage.put(published);
    await storage.close();
    const reloaded = new LocalCatalog(dbName);
    expect(await reloaded.getVersion(d.templateId, 1)).toEqual(d);
    expect(await reloaded.getVersion(d.templateId, 2)).toEqual(published);
    const copy = new MemoryCatalog();
    await importTemplatePack(await exportTemplatePack([published]), copy);
    expect(await copy.getVersion(d.templateId, 2)).toEqual(published);
    await reloaded.close();
    await validateNativeReusableDefinitions(domain, expanded.content!);
  });

it('native edits beyond the insertion form schema, including external image references, remain authoritative during reflow', async () => {
  const { content, id } = await inserted('whiteboard'),
    current = readStructure(content, id),
    first = current.items[0].id,
    body = current.instance.parts[itemPart(first, 'body')],
    image = current.instance.parts[itemPart(first, 'image')];
  const part = reusableParts(content).get(body)!;
  patchReusablePart(content, body, {
    text: '長い本文'.repeat(55),
    bounds: { ...(part.bounds as object), width: 600, height: 800 },
  });
  patchReusablePart(content, image, { src: 'https://example.test/native.png' });
  const p = await prepareStructureChange({
    state: localTemplateSnapshot('artifact', 'whiteboard', content),
    identity,
    instanceId: id,
    items: [...current.items.map((i) => ({ id: i.id })), freshItem],
  });
  expect(reusableParts(p.preview).get(body)).toEqual(reusableParts(content).get(body));
  expect(reusableParts(p.preview).get(image)?.src).toBe('https://example.test/native.png');
});

for (const domain of ['slide', 'document'] as const)
  it(`${domain}: variable native templates export editable Office content with explicit reuse loss and unbound images excluded`, async () => {
    const { content } = await inserted(domain),
      before = clone(content),
      basis = { kind: 'confirmed' as const, artifactId: 'artifact', revision: 0 },
      font = {
        id: 'contract',
        family: 'Noto Sans CJK JP',
        version: 'test',
        license: 'OFL',
        verified: true,
        faces: [
          { weight: 'regular' as const, sha256: 'a'.repeat(64) },
          { weight: 'bold' as const, sha256: 'b'.repeat(64) },
        ],
        glyphRanges: [[0, 0x10ffff] as [number, number]],
      },
      adapters = { resolveFont: async () => font };
    const plan =
      'slides' in content
        ? await prepareSlidePptx(
            await captureSlideExportSnapshot(content, basis),
            {
              pageIds: 'all',
              includeHiddenSlides: false,
              includeNotes: true,
              fontProfileId: 'contract',
              fallback: 'reject',
            },
            adapters,
          )
        : await prepareDocumentDocx(
            await captureDocumentExportSnapshot(
              content as ReturnType<typeof createDocument>,
              basis,
            ),
            {
              fontProfileId: 'contract',
              styleProfileId: 'document-ja-1',
              mermaid: 'reject',
              previewBlocks: 'reject',
            },
            adapters,
          );
    expect(plan.report.diagnostics.some((d) => d.severity === 'error')).toBe(false);
    expect(
      plan.report.diagnostics.some(
        (d) => d.code === 'REUSABLE_LINKS_RESOLVED' && d.requiresAcceptance,
      ),
    ).toBe(true);
    const consent = {
        planHash: plan.report.planHash,
        acceptedDiagnosticIds: plan.report.diagnostics
          .filter((d) => d.requiresAcceptance)
          .map((d) => d.id),
      },
      output =
        domain === 'slide'
          ? await encodeSlidePptx(plan as Parameters<typeof encodeSlidePptx>[0], consent)
          : await encodeDocumentDocx(plan as Parameters<typeof encodeDocumentDocx>[0], consent);
    expect(output.status).toBe('ok');
    if (output.status !== 'ok') throw new Error('Office export blocked');
    const xml = Object.entries(unzipSync(output.bytes))
      .filter(([path]) => /^(ppt\/slides\/slide\d+|word\/document)\.xml$/.test(path))
      .map(([, value]) => strFromU8(value))
      .join('\n');
    expect(xml).toContain('比較対象 1');
    expect(content).toEqual(before);
  });

it('Document reflow preserves an existing native image body and rejects an undeclared image parameter', async () => {
  const { content, id } = await inserted('document'),
    current = readStructure(content, id),
    body = current.instance.parts[itemPart(current.items[0].id, 'body')],
    image =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ3kAAAAASUVORK5CYII=';
  patchReusablePart(content, body, { type: 'image', text: '', src: image, alt: '保持する画像' });
  const p = await prepareStructureChange({
    state: localTemplateSnapshot('artifact', 'document', content),
    identity,
    instanceId: id,
    items: [...current.items.map((i) => ({ id: i.id })), freshDocItem],
  });
  expect(reusableParts(p.preview).get(body)).toEqual(reusableParts(content).get(body));
  await validateNativeReusableDefinitions('document', p.preview);
  await expect(
    prepareStructureChange({
      state: localTemplateSnapshot('artifact', 'document', content),
      identity,
      instanceId: id,
      items: [...current.items.map((i) => ({ id: i.id })), { ...freshDocItem, image }],
    }),
  ).rejects.toMatchObject({ code: 'invalid-input' });
});

it('Document keeps newly inserted paragraphs/images with their native heading; deletion previews and Undo include those blocks', async () => {
  const { content, id } = await inserted('document');
  if (!isDocument(content)) throw new Error('Document');
  const current = readStructure(content, id),
    first = current.items[0],
    body = current.instance.parts[itemPart(first.id, 'body')],
    at = content.blocks.findIndex((b) => b.id === body);
  content.blocks.splice(
    at + 1,
    0,
    {
      id: 'extra-image',
      type: 'image',
      text: '',
      src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ3kAAAAASUVORK5CYII=',
      alt: '追加した画像',
    },
    { id: 'extra-paragraph', type: 'paragraph', text: '追記した本文' },
  );
  const p = await prepareStructureChange({
    state: localTemplateSnapshot('artifact', 'document', content),
    identity,
    instanceId: id,
    items: [...current.items].reverse().map((i) => ({ id: i.id })),
  });
  if (!isDocument(p.preview)) throw new Error('Document');
  expect(p.preview.blocks.findIndex((b) => b.id === 'extra-image')).toBe(
    p.preview.blocks.findIndex((b) => b.id === body) + 1,
  );
  const codec = templateCodec('document'),
    authority = new Authority(codec, initial('artifact', codec, content));
  const removal = await prepareStructureChange({
    state: authority.snapshot(),
    identity,
    instanceId: id,
    items: current.items.slice(1).map((i) => ({ id: i.id })),
  });
  expect(removal.notices.join(' ')).toContain('extra-image');
  expect(removal.notices.join(' ')).toContain('extra-paragraph');
  expect(authority.commit(principal, removal.operation).status).toBe('accepted');
  expect(reusableParts(authority.snapshot().content).has('extra-image')).toBe(false);
  expect(authority.undo(principal, removal.operation.operationId).status).toBe('accepted');
  expect(reusableParts(authority.snapshot().content).get('extra-image')?.src).toBe(
    reusableParts(content).get('extra-image')?.src,
  );
  const mixed = clone(content);
  mixed.blocks.splice(at + 1, 0, {
    id: 'foreign-heading',
    type: 'heading',
    level: 1,
    text: '別の文書構造',
  });
  await expect(
    prepareStructureChange({
      state: localTemplateSnapshot('artifact', 'document', mixed),
      identity,
      instanceId: id,
      items: [...current.items.map((i) => ({ id: i.id })), freshDocItem],
    }),
  ).rejects.toMatchObject({ code: 'structure-reference' });
});
