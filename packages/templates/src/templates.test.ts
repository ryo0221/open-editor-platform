import { describe, it, expect } from 'vitest';
import {
  builtinTemplates,
  validateDefinition,
  expandTemplate,
  prepareInstantiation,
  applyInstantiation,
  cancelInstantiation,
  nativeIds,
  prepareInsertion,
  preparePreset,
  localTemplateSnapshot,
  templateCodec,
  prepareViewPreset,
  exportTemplatePack,
  importTemplatePack,
  MemoryCatalog,
  createTemplateVersion,
  saveAsTemplate,
  slotCandidates,
  validateInputs,
  sealDefinition,
  applyLocalTemplate,
} from './index';
import { MemoryStorage, clone, type Artifact } from '@editor-platform/artifact-core';
import {
  Authority,
  localAdapter,
  initial,
  type Principal,
} from '@editor-platform/collaboration-core';
import {
  SharedEditorSession,
  type EditorHostAdapter,
} from '@editor-platform/collaboration-adapters';
import { type Domain, type NativeContent } from './types';
import { createDeck, updateObject, insertObject } from '@editor-platform/slide/model';
import { contentToNode, nodeToContent } from '@editor-platform/document/engine';
import { createDocument } from '@editor-platform/document/model';
import { createWhiteboard } from '@editor-platform/whiteboard/model';
import { createDesign } from '@editor-platform/design/model';
import { createData } from '@editor-platform/structured-data/model';
import {
  prepareViewPreset as viewPreset,
  previewSharedTemplate,
  applySharedTemplate,
} from './apply';
const A: Principal = { actorId: 'A', clientId: 'A', sessionId: 'A', writable: true, scopes: ['*'] };
const B: Principal = { ...A, actorId: 'B', clientId: 'B', sessionId: 'B' };
const get = (id: string) => builtinTemplates.find((d) => d.templateId === id)!;
const empty = (domain: Domain): NativeContent =>
  domain === 'slide'
    ? createDeck()
    : domain === 'document'
      ? createDocument()
      : domain === 'whiteboard'
        ? createWhiteboard()
        : domain === 'design'
          ? createDesign()
          : createData();
function adapter(authority: Authority<NativeContent>, actor = A) {
  return Object.assign(localAdapter(authority, actor), {
    versions: async () => [],
    undo: async (id: string, redo?: boolean) => authority.undo(actor, id, redo),
    registerProposal: async (p: Parameters<typeof authority.register>[0]) => authority.register(p),
    previewProposal: async (id: string) => authority.preview(actor, id),
    applyProposal: async (id: string, token: string) => authority.applyProposal(actor, id, token),
  }) as unknown as EditorHostAdapter<NativeContent>;
}
function normalized(content: unknown) {
  const result = clone(content);
  const map = new Map<string, string>();
  const walk = (v: unknown) => {
    if (v && typeof v === 'object') {
      if ('id' in v && typeof v.id === 'string') map.set(v.id, `id${map.size}`);
      for (const x of Object.values(v)) walk(x);
    }
  };
  walk(result);
  return (JSON.stringify(result) ?? 'undefined').replace(
    /(?:tpl|t|listitem|paragraph)_[A-Za-z0-9_-]+/g,
    (id) => map.get(id) ?? 'nested-id',
  );
}
describe('TP-Q01/02/04: every versioned native template', () => {
  it('contains exactly five distinct whole artifacts per major domain', () => {
    for (const d of ['slide', 'whiteboard', 'design', 'document', 'data'])
      expect(builtinTemplates.filter((t) => t.kind === 'whole' && t.domain === d)).toHaveLength(5);
  });
  for (const d of builtinTemplates)
    it(`validates and expands ${d.templateId}`, async () => {
      await validateDefinition(d);
      const a = expandTemplate(d, d.sample),
        b = expandTemplate(d, JSON.parse(JSON.stringify(d.sample)));
      expect(a.diagnostics).toEqual([]);
      expect(normalized(a.content)).toEqual(normalized(b.content));
      if (a.content) expect(new Set(nativeIds(a.content)).size).toBe(nativeIds(a.content).length);
    });
  it('rejects unknown fields and malformed dates without throwing an untyped exception', () => {
    expect(
      validateInputs([{ key: 'date', label: 'Date', description: '', type: 'date' }], {
        date: '2026-99-99',
        unknown: 1,
      }).diagnostics,
    ).toHaveLength(2);
  });
  it('paginates a growing slide list and rejects overlong Japanese headings', () => {
    const d = get('slide-progress');
    const r = expandTemplate(d, { ...d.sample, findings: Array(12).fill('次の対応') });
    expect('slides' in r.content! && r.content.slides.length).toBe(5);
    expect(() => expandTemplate(d, { ...d.sample, title: 'あ'.repeat(80) })).toThrow();
  });
});
describe('TP-Q05/06/07: normal checked proposals', () => {
  for (const id of [
    'slide-comparison-page',
    'whiteboard-agenda-section',
    'design-card-group',
    'document-summary-section',
    'data-common-fields',
  ])
    it(`inserts ${id} once, undoes/redoes atomically`, async () => {
      const d = get(id),
        raw = empty(d.domain),
        content =
          d.domain === 'document'
            ? nodeToContent(
                contentToNode(raw as ReturnType<typeof createDocument>),
                raw as ReturnType<typeof createDocument>,
              )
            : raw,
        codec = templateCodec(d.domain),
        authority = new Authority(codec, initial('target', codec, content));
      const session = new SharedEditorSession(codec, adapter(authority));
      await session.open();
      const p = await prepareInsertion(d, d.sample, session.confirmed, A, {}, 'same-request');
      const preview = await previewSharedTemplate(p, session);
      expect(authority.snapshot().revision).toBe(0);
      await applySharedTemplate(p, session, preview.token);
      const accepted = clone(authority.snapshot().content);
      await applySharedTemplate(p, session, preview.token);
      expect(authority.snapshot().revision).toBe(1);
      expect(authority.snapshot().content).toEqual(accepted);
      await session.history('undo');
      expect(authority.snapshot().content).toEqual(content);
      await session.history('redo');
      expect(authority.snapshot().content).toEqual(accepted);
    });
  it('keeps an independent remote style and rejects changed insertion order', async () => {
    const d = get('slide-comparison-page'),
      base = createDeck(),
      content = insertObject(base.slides[0].id, 'shape').apply(base),
      codec = templateCodec('slide'),
      authority = new Authority(codec, initial('deck', codec, content));
    const a = new SharedEditorSession(codec, adapter(authority)),
      b = new SharedEditorSession(codec, adapter(authority, B));
    await a.open();
    await b.open();
    const p = await prepareInsertion(d, d.sample, a.confirmed, A, {
      afterId: content.slides[0].id,
    });
    const preview = await previewSharedTemplate(p, a);
    b.execute(
      updateObject(content.slides[0].id, content.slides[0].objects[0].id, {
        fill: '#112233',
      }) as unknown as Parameters<typeof b.execute>[0],
    );
    await b.flush();
    await applySharedTemplate(p, a, preview.token);
    expect('slides' in a.content && a.content.slides[0].objects[0].fill).toBe('#112233');
    const stale = await prepareInsertion(d, d.sample, a.confirmed, A);
    const old = await previewSharedTemplate(stale, a);
    const other = await prepareInsertion(d, d.sample, a.confirmed, A);
    const fresh = await previewSharedTemplate(other, a);
    await applySharedTemplate(other, a, fresh.token);
    await expect(applySharedTemplate(stale, a, old.token)).rejects.toThrow();
  });
  it('rejects read-only commit even when preparation was valid', async () => {
    const d = get('slide-chart-page'),
      codec = templateCodec('slide'),
      authority = new Authority(codec, initial('deck', codec, createDeck()));
    const p = await prepareInsertion(d, d.sample, authority.snapshot(), A);
    authority.register(p.proposal);
    expect(() => authority.preview({ ...A, writable: false }, p.id)).toThrow();
  });
});
describe('TP-Q07/08/09/10/13: independent creation and portable immutable versions', () => {
  it('creation retries and repeated preparation with one request preserve IDs, including nested rich content', async () => {
    const d = get('document-proposal'),
      a = await prepareInstantiation(d, d.sample, 'same'),
      b = await prepareInstantiation(d, d.sample, 'same');
    expect(a.artifact.id).toEqual(b.artifact.id);
    expect(a.artifact.draft.content).toEqual(b.artifact.draft.content);
    const storage = new MemoryStorage<Artifact<NativeContent>>();
    expect(await applyInstantiation(a, storage)).toEqual(await applyInstantiation(b, storage));
    expect(await storage.list()).toHaveLength(1);
    const next = await prepareInstantiation(d, d.sample, 'other');
    expect(next.artifact.id).not.toBe(a.artifact.id);
    cancelInstantiation(next);
    await expect(applyInstantiation(next, storage)).rejects.toThrow('cancelled');
  });
  it('remaps Data formulas/views and native roundtrips keep their meaning', async () => {
    const d = get('data-inventory'),
      p = await prepareInstantiation(d, d.sample, 'inventory');
    const native = p.artifact.draft.content;
    expect(JSON.parse(JSON.stringify(native))).toEqual(native);
    expect(
      'columns' in native && native.columns.find((c) => c.type === 'formula')!.formula,
    ).toContain('t_inventory_');
    const emptyRows = await prepareInstantiation(d, d.sample, 'empty', {
      includeSampleRows: false,
    });
    expect(
      'rows' in emptyRows.artifact.draft.content && emptyRows.artifact.draft.content.rows,
    ).toEqual([]);
  });
  it('preserves old versions and created artifacts after a catalog edit/archive', async () => {
    const old = get('slide-comparison'),
      catalog = new MemoryCatalog([old]),
      artifact = await prepareInstantiation(old, old.sample, 'original');
    const next = await createTemplateVersion(old, { name: '別の版' });
    await catalog.put(next);
    await catalog.archive(old.templateId, true);
    expect(await catalog.list()).toEqual([]);
    expect(await catalog.getVersion(old.templateId, 1)).toEqual(old);
    expect(artifact.artifact.provenance.template?.version).toBe(1);
    const pack = await exportTemplatePack([old, next]),
      target = new MemoryCatalog();
    await importTemplatePack(pack, target);
    expect(await target.getVersion(old.templateId, 1)).toEqual(old);
    await expect(
      target.put(await sealDefinition({ ...old, name: 'silent overwrite' })),
    ).rejects.toThrow();
  });
  it('authors a text/list template without copying artifact history', async () => {
    const d = get('document-proposal'),
      content = expandTemplate(d, d.sample).content!,
      candidates = slotCandidates(content);
    const chosen = candidates.filter((c) => c.type === 'list' || c.label === '企画書').slice(0, 2);
    const saved = await saveAsTemplate({
      domain: 'document',
      content,
      name: '再利用',
      purpose: 'チームの説明文',
      category: '個人',
      kind: 'whole',
      slots: chosen.map((c, i) => ({
        path: c.path,
        key: `slot${i}`,
        label: `入力${i}`,
        type: c.type,
      })),
    });
    expect(saved.inputs).toHaveLength(2);
    expect(saved).not.toHaveProperty('versions');
    await validateDefinition(saved);
  });
  it('rejects missing assets, unsupported schema and pack collisions atomically', async () => {
    const d = get('slide-product'),
      bad = clone(d);
    bad.schemaVersion = 99 as 1;
    await expect(validateDefinition(bad)).rejects.toThrow();
    const asset = await sealDefinition({
      ...d,
      assets: [],
      sample: { ...d.sample, image: 'asset://missing' },
    });
    await expect(validateDefinition(asset)).rejects.toThrow();
    const catalog = new MemoryCatalog([d]);
    const conflicting = await sealDefinition({ ...d, name: 'changed' });
    const unrelated = get('slide-progress');
    await expect(
      importTemplatePack(
        JSON.stringify({
          format: 'editor-template-pack',
          schemaVersion: 1,
          definitions: [unrelated, conflicting],
        }),
        catalog,
      ),
    ).rejects.toThrow();
    expect(await catalog.getVersion(unrelated.templateId, 1)).toBeUndefined();
  });
});
describe('TP-Q11/12/14: scoped presets and field identity', () => {
  it('changes only selected slide styles, keeping IDs and text', async () => {
    const d = get('slide-comparison'),
      content = expandTemplate(d, d.sample).content!,
      preset = get('slide-readable-style');
    if (!('slides' in content)) throw Error();
    const id = content.slides[0].objects[0].id,
      p = await preparePreset(preset, {}, localTemplateSnapshot('a', 'slide', content), A, {
        ids: [id],
      });
    const after = applyLocalTemplate(p, content);
    expect('slides' in after && after.slides[0].objects[0].text).toBe(
      content.slides[0].objects[0].text,
    );
    expect('slides' in after && after.slides[1]).toEqual(content.slides[1]);
    expect(nativeIds(after)).toEqual(nativeIds(content));
  });
  it('requires explicit Data view mappings and rejects incompatible types', async () => {
    const d = get('data-chart-view'),
      content = createData(),
      state = localTemplateSnapshot('a', 'data', content);
    await expect(prepareInsertion(d, {}, state, A)).rejects.toThrow('target field');
    await expect(
      prepareInsertion(d, {}, state, A, {
        fieldMapping: { label: content.columns[2].id, amount: content.columns[0].id },
      }),
    ).rejects.toThrow('compatible');
    const p = await prepareInsertion(d, {}, state, A, {
      fieldMapping: { label: content.columns[0].id, amount: content.columns[2].id },
    });
    expect(p.mapping.every((m) => m.action === 'reuse')).toBe(true);
    expect('columns' in p.preview && p.preview.columns).toEqual(content.columns);
  });
  it('returns private view settings without a fake content artifact', async () => {
    expect(await viewPreset(get('review-readable-style'), {})).toEqual({
      split: true,
      wrap: true,
      annotations: true,
    });
    expect(await prepareViewPreset(get('file-readable-style'), {})).toEqual({
      fit: 'page',
      annotations: true,
    });
  });
});
