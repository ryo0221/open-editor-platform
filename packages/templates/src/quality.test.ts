import { it, expect } from 'vitest';
import {
  builtinTemplates,
  expandTemplate,
  prepareInstantiation,
  applyInstantiation,
  saveAsTemplate,
  slotCandidates,
  nativeIds,
  preparePreset,
  applyLocalTemplate,
  localTemplateSnapshot,
  prepareViewPreset,
  sealDefinition,
  TemplateError,
} from './index';
import { MemoryStorage, type Artifact } from '@editor-platform/artifact-core';
import { type NativeContent } from './types';
import { contentToNode, nodeToContent } from '@editor-platform/document/engine';
import { isDocument } from '@editor-platform/document/model';
const get = (id: string) => builtinTemplates.find((d) => d.templateId === id)!;
const actor = { actorId: 'local', sessionId: 'local', clientId: 'local' };
it('Document marks preserve engine IDs, text, and unselected blocks', async () => {
  const d = get('document-minutes'),
    raw = expandTemplate(d, d.sample).content!;
  if (!isDocument(raw)) throw Error();
  const content = nodeToContent(contentToNode(raw), raw),
    id = content.blocks[0].id;
  const p = await preparePreset(
    get('document-readable-style'),
    {},
    localTemplateSnapshot('doc', 'document', content),
    actor,
    { ids: [id] },
  );
  const after = applyLocalTemplate(p, content);
  expect(nativeIds(after)).toEqual(nativeIds(content));
  expect(new Set(nativeIds(after)).size).toBe(nativeIds(after).length);
  if (!isDocument(after)) throw Error();
  expect(after.blocks.slice(1)).toEqual(content.blocks.slice(1));
  expect(contentToNode(after).textContent).toBe(contentToNode(content).textContent);
  expect(after.page).toEqual(content.page);
  expect(p.notices.length).toBeGreaterThan(0);
});
it('image authoring accepts a portable image larger than a text field and remaps it into a manifest', async () => {
  const d = get('slide-product'),
    content = expandTemplate(d, d.sample).content!;
  const slot = slotCandidates(content).find((s) => s.type === 'asset')!;
  const asset =
    'data:image/svg+xml;base64,' +
    btoa(
      '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="400"><!--' +
        'image'.repeat(400) +
        '--><rect width="80" height="400" fill="blue"/></svg>',
    );
  const saved = await saveAsTemplate({
    domain: 'slide',
    content,
    name: '縦長画像',
    purpose: '画像差替え',
    category: 'test',
    kind: 'whole',
    slots: [{ path: slot.path, key: 'photo', label: '画像', type: 'asset', defaultValue: asset }],
  });
  expect(JSON.stringify(expandTemplate(saved, saved.sample).content)).toContain(asset);
  expect(saved.assets.length).toBeGreaterThan(0);
  expect(JSON.stringify(expandTemplate(saved, { photo: '' }).content)).not.toContain('data:image');
});
it('empty optional lists/images and English input leave no sample payload behind', () => {
  for (const d of builtinTemplates.filter((d) => d.kind === 'whole')) {
    const input = structuredClone(d.sample);
    for (const field of d.inputs) {
      if (field.type === 'asset') input[field.key] = '';
      if (field.type === 'list' && field.min === 0) input[field.key] = [];
      if (field.key === 'title') input.title = 'Example in English';
    }
    const output = expandTemplate(d, input);
    expect(output.diagnostics).toEqual([]);
    expect(JSON.stringify(output.content)).not.toContain('asset://');
    if (d.inputs.some((f) => f.type === 'asset'))
      expect(JSON.stringify(output.content)).not.toContain('data:image');
  }
});
it('all Data templates can create empty typed records without losing their formula/view schema', async () => {
  for (const d of builtinTemplates.filter((d) => d.kind === 'whole' && d.domain === 'data')) {
    const p = await prepareInstantiation(d, d.sample, 'empty-' + d.templateId, {
      includeSampleRows: false,
    });
    expect('rows' in p.artifact.draft.content && p.artifact.draft.content.rows).toEqual([]);
  }
});
it('invalid preset types are rejected for direct headless calls', async () => {
  const d = get('file-readable-style');
  const changed = await sealDefinition({
    ...d,
    inputs: [],
    bindings: [],
    sample: {},
    preset: { scope: 'view', fields: { fit: 'bogus', annotations: 'false' } },
  });
  await expect(prepareViewPreset(changed, {})).rejects.toBeInstanceOf(TemplateError);
});
it('failed and denied creation leave storage unchanged; retry uses the prepared ID', async () => {
  const d = get('slide-comparison'),
    p = await prepareInstantiation(d, d.sample, 'failure'),
    storage = new MemoryStorage<Artifact<NativeContent>>();
  await expect(applyInstantiation(p, storage, false)).rejects.toMatchObject({
    code: 'unauthorized',
  });
  await expect(
    applyInstantiation(p, {
      ...storage,
      putIfAbsent: async () => {
        throw new Error('offline');
      },
    } as never),
  ).rejects.toThrow('offline');
  expect(await storage.list()).toEqual([]);
  expect(p.state).toBe('prepared');
  expect((await applyInstantiation(p, storage)).id).toBe(p.artifact.id);
});
it('repeated cards and notes enlarge native containers while long Japanese reports its input path', () => {
  const board = get('whiteboard-kpt'),
    expanded = expandTemplate(board, {
      ...board.sample,
      stage0: Array(10).fill('複数行の記録\n次の一歩'),
    }).content!;
  if (!('nodes' in expanded)) throw Error();
  const section = expanded.sections![0];
  expect(section.bounds.height).toBeGreaterThan(580);
  for (const node of expanded.nodes.filter((n) => n.sectionId === section.id))
    expect(node.bounds.y + node.bounds.height).toBeLessThanOrEqual(
      section.bounds.y + section.bounds.height,
    );
  const design = get('design-form'),
    result = expandTemplate(design, {
      ...design.sample,
      items: Array(12).fill('長めの入力項目名'),
    }).content!;
  expect(
    'elements' in result && result.elements.filter((e) => e.type === 'frame').length,
  ).toBeGreaterThan(10);
  const slide = get('slide-comparison');
  try {
    expandTemplate(slide, { ...slide.sample, title: 'あ'.repeat(80) });
    throw new Error('Expected overflow');
  } catch (error) {
    expect(error).toBeInstanceOf(TemplateError);
    expect((error as TemplateError).diagnostics.some((d) => d.path === 'title')).toBe(true);
  }
});
