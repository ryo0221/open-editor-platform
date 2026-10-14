import { describe, it, expect } from 'vitest';
import { indexedDB } from 'fake-indexeddb';
import {
  clone,
  MemoryStorage,
  IndexedDBStorage,
  type Artifact,
} from '@editor-platform/artifact-core';
import {
  builtinTemplates,
  prepareInstantiation,
  applyInstantiation,
  validateDefinition,
  sealDefinition,
  expandTemplate,
  exportTemplatePack,
  importTemplatePack,
  LocalCatalog,
  TemplateError,
  prepareInsertion,
  localTemplateSnapshot,
  templateCodec,
  type NativeContent,
} from './index';
import { initial, Authority, type Principal } from '@editor-platform/collaboration-core';
import { prepareEditorCommand } from '@editor-platform/collaboration-adapters';
import { createDeck } from '@editor-platform/slide/model';
import { command } from '@editor-platform/editor-core';
import { createData } from '@editor-platform/structured-data/model';
const get = (id: string) => builtinTemplates.find((d) => d.templateId === id)!;
const actor: Principal = {
  actorId: 'author',
  sessionId: 's',
  clientId: 'c',
  writable: true,
  scopes: ['*'],
};
describe('Template lifecycle boundaries', () => {
  it('concurrent creation with the same request never overwrites existing content', async () => {
    const d = get('slide-comparison'),
      storage = new MemoryStorage<Artifact<NativeContent>>();
    const a = await prepareInstantiation(d, { ...d.sample, title: '先の作成' }, 'concurrent');
    const b = await prepareInstantiation(d, { ...d.sample, title: '違う入力' }, 'concurrent');
    const results = await Promise.allSettled([
      applyInstantiation(a, storage),
      applyInstantiation(b, storage),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect((await storage.get(a.artifact.id))?.draft.content).toEqual(a.artifact.draft.content);
    await expect(applyInstantiation(a, storage)).resolves.toEqual(a.artifact);
    expect(await storage.list()).toHaveLength(1);
  });
  it('enforces the same create-if-absent rule across IndexedDB connections', async () => {
    Object.assign(globalThis, { indexedDB });
    const name = 'templates-concurrent-' + crypto.randomUUID();
    const a = new IndexedDBStorage<Artifact<NativeContent>>(name),
      b = new IndexedDBStorage<Artifact<NativeContent>>(name);
    const d = get('document-proposal'),
      p = await prepareInstantiation(d, d.sample, 'idb');
    const q = await prepareInstantiation(d, { ...d.sample, title: '別入力' }, 'idb');
    const outcomes = await Promise.allSettled([applyInstantiation(p, a), applyInstantiation(q, b)]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === 'rejected')).toHaveLength(1);
    expect(await a.list()).toHaveLength(1);
    await a.close();
    await b.close();
  });
  it('retains portable image versions in a local catalog after reload', async () => {
    Object.assign(globalThis, { indexedDB });
    const name = 'templates-catalog-' + crypto.randomUUID(),
      a = new LocalCatalog(name),
      d = get('slide-product');
    const pack = await exportTemplatePack([d]);
    await importTemplatePack(pack, a);
    await a.close();
    const b = new LocalCatalog(name),
      loaded = await b.getVersion(d.templateId, 1);
    expect(loaded).toEqual(d);
    expect(JSON.stringify(expandTemplate(loaded!, d.sample).content)).toContain(
      'data:image/svg+xml;base64,',
    );
    await b.archive(d.templateId, true);
    expect(await b.list()).toEqual([]);
    expect(await b.getVersion(d.templateId, 1)).toEqual(d);
    await b.close();
  });
  it('rejects malformed schema/binding structures with typed errors', async () => {
    const d = get('slide-comparison');
    for (const change of [
      { inputs: [null] },
      { assets: [null] },
      { bindings: [{}] },
      { repeats: [null] },
      { overflow: { policy: 'error', maxItems: 10, minFontSize: null } },
      { inputs: [{ key: 'rows', type: 'object', fields: 'bad', label: 'Rows', description: '' }] },
    ]) {
      const malformed = await sealDefinition({ ...d, ...change } as never);
      await expect(validateDefinition(malformed)).rejects.toBeInstanceOf(TemplateError);
    }
  });
  it('migrates supported old native schema without changing the immutable template version', async () => {
    const original = get('slide-comparison'),
      d = await sealDefinition({
        ...original,
        artifactSchema: 1,
        content: { ...original.content!, schemaVersion: 1 },
      });
    await validateDefinition(d);
    const p = await prepareInstantiation(d, d.sample, 'legacy');
    expect(p.artifact.draft.content.schemaVersion).toBe(2);
    expect(p.artifact.provenance.template?.version).toBe(1);
    expect(d.artifactSchema).toBe(1);
  });
  it('page insertion reads the target dimensions while allowing independent page styles', async () => {
    const codec = templateCodec('slide'),
      base = createDeck(),
      authority = new Authority(codec, initial('deck', codec, base));
    const p = await prepareInsertion(
      get('slide-comparison-page'),
      get('slide-comparison-page').sample,
      authority.snapshot(),
      actor,
    );
    authority.register(p.proposal);
    const preview = authority.preview(actor, p.id);
    const op = prepareEditorCommand(
      codec,
      authority.snapshot(),
      actor,
      command('resize', 'Resize', (content) => ({ ...content, width: 1200 }) as NativeContent),
    );
    expect(authority.submit(actor, op!).status).toBe('accepted');
    expect(authority.applyProposal(actor, p.id, preview.token).status).toBe('rejected');
  });
  it('Data view mappings read reused field identities and definitions', async () => {
    const codec = templateCodec('data'),
      data = createData(),
      state = localTemplateSnapshot('data', 'data', data),
      d = get('data-chart-view');
    const authority = new Authority(codec, state);
    const p = await prepareInsertion(d, {}, state, actor, {
      fieldMapping: { label: data.columns[0].id, amount: data.columns[2].id },
    });
    authority.register(p.proposal);
    const preview = authority.preview(actor, p.id);
    const op = prepareEditorCommand(
      codec,
      state,
      actor,
      command('data.rename', 'Rename mapped field', (content) => {
        const next = clone(content) as typeof data;
        next.columns[0].name = 'Changed title';
        return next;
      }),
    );
    expect(authority.submit(actor, op!).status).toBe('accepted');
    expect(authority.applyProposal(actor, p.id, preview.token).status).toBe('rejected');
  });
});
