import { readFile } from 'node:fs/promises';
import { beforeAll, it, expect } from 'vitest';
import { clone, canonicalJson, MemoryStorage, type Artifact } from '@editor-platform/artifact-core';
import { prepareSlideImport } from '@editor-platform/slide-import';
import { prepareDocumentImport } from '@editor-platform/document-import';
import { materializeOfficeImport, sourceKey } from '@editor-platform/office-import-core';
import { decodeNodeOfficeImage } from '@editor-platform/office-adapters/node';
import { isDocument } from '@editor-platform/document/model';
import { isDeck } from '@editor-platform/slide/model';
import { contentToNode, nodeToContent } from '@editor-platform/document/engine';
import {
  Authority,
  initial,
  localAdapter,
  type Principal,
} from '@editor-platform/collaboration-core';
import {
  SharedEditorSession,
  type EditorHostAdapter,
  type AssetEditorCodec,
} from '@editor-platform/collaboration-adapters';
import { command } from '@editor-platform/editor-core';
import {
  saveAsTemplate,
  slotCandidates,
  prepareInstantiation,
  applyInstantiation,
  expandTemplate,
  remapNative,
  nativeIds,
  MemoryCatalog,
  TemplateCatalog,
  createTemplateVersion,
  exportTemplatePack,
  importTemplatePack,
  builtinTemplates,
  preparePreset,
  localTemplateSnapshot,
  applyLocalTemplate,
  templateLimits,
  type NativeContent,
  type AuthoredSlot,
  templateCodec,
  prepareInsertion,
  previewSharedTemplate,
  applySharedTemplate,
  sealDefinition,
} from './index';
import { prepareAgentTemplate } from '../../../apps/playground/src/template-agent';

const imported = new Map<'slide' | 'document', Artifact<NativeContent>>();
const options = {
  unsupported: 'review-conversions' as const,
  fontProfileId: 'noto-cjk-jp-2.004' as const,
};
const adapters = { version: 'office-image-validator-1', decodeImage: decodeNodeOfficeImage };
const actor = { actorId: 'A', sessionId: 'A', clientId: 'A' };
const normalized = (c: NativeContent) =>
  canonicalJson(remapNative(c, new Map(), 'normalized').content);
beforeAll(async () => {
  for (const domain of ['slide', 'document'] as const) {
    const file = domain === 'slide' ? 'external.pptx' : 'document/external.docx';
    const bytes = new Uint8Array(await readFile(`tests/fixtures/office/import/${file}`));
    const first =
      domain === 'slide'
        ? await prepareSlideImport(
            { bytes, format: 'pptx' },
            { ...options, pages: 'all', notes: 'exclude', includeHidden: false },
            'reuse-slide',
            adapters,
          )
        : await prepareDocumentImport(
            { bytes, format: 'docx' },
            options,
            'reuse-document',
            adapters,
          );
    const blocked = first.report.diagnostics.filter((d) => d.disposition === 'blocked');
    const plan =
      domain === 'slide' && blocked.length
        ? await prepareSlideImport(
            { bytes, format: 'pptx' },
            {
              ...options,
              pages: 'all',
              notes: 'exclude',
              includeHidden: false,
              exclude: blocked.map((d) => sourceKey(d.address)),
            },
            'reuse-slide',
            adapters,
          )
        : first;
    imported.set(
      domain,
      materializeOfficeImport<NativeContent>(plan, {
        planHash: plan.report.planHash,
        acceptedDiagnosticIds: plan.report.diagnostics
          .filter((d) => d.requiresConsent)
          .map((d) => d.id),
      }),
    );
  }
}, 30000);
function slots(content: NativeContent): AuthoredSlot[] {
  const candidates = slotCandidates(content),
    title = candidates.find((c) => c.type === 'text' && String(c.value).startsWith('外部作成'))!,
    image = candidates.find((c) => c.type === 'asset')!,
    list =
      candidates.find((c) => c.type === 'list') ??
      candidates.find((c) => c.type === 'text' && c.value === '受付')!;
  return [
    { ...title, key: 'title', label: '案件名', defaultValue: '架空の提案', example: '架空の提案' },
    { ...image, key: 'picture', label: '説明画像' },
    {
      ...list,
      key: 'items',
      label: '確認項目',
      type: 'list',
      defaultValue: ['確認'],
      example: ['確認'],
    },
  ];
}
async function definition(domain: 'slide' | 'document', kind: 'whole' | 'fragment' = 'whole') {
  const content = imported.get(domain)!.draft.content;
  return saveAsTemplate({
    domain,
    content,
    kind,
    name: `${domain}再利用`,
    purpose: '社内提案書',
    category: '検証',
    slots: slots(content),
  });
}
for (const domain of ['slide', 'document'] as const) {
  it(`T01/T02/T05 ${domain}: reviewed samples remove hidden originals; human/Host agent share definitions and independent IDs`, async () => {
    const original = clone(imported.get(domain)!),
      d = await definition(domain);
    const serialized = JSON.stringify(d);
    const imageSlot = slotCandidates(original.draft.content).find((c) => c.type === 'asset')!;
    await expect(
      saveAsTemplate({
        domain,
        content: original.draft.content,
        kind: 'whole',
        name: 'invalid image slot',
        purpose: 'test',
        category: 'test',
        slots: [{ ...imageSlot, key: 'text', label: 'text', type: 'text' }],
      }),
    ).rejects.toMatchObject({ code: 'invalid-binding' });
    expect(serialized).not.toContain('外部作成の受付改善');
    expect(serialized).not.toContain('PRIVATE_OFFICE_AUTHOR_SENTINEL');
    expect(serialized).not.toContain('officeImport');
    expect(serialized).not.toContain('versions');
    const input = { ...d.sample, title: '別案件の提案', items: ['確認A'] };
    const human = await prepareInstantiation(d, input, `${domain}-human`),
      agent = await prepareAgentTemplate(new TemplateCatalog([new MemoryCatalog([d])]), {
        templateId: d.templateId,
        templateVersion: d.templateVersion,
        inputs: input,
        requestId: `${domain}-agent`,
      });
    expect(normalized(human.artifact.draft.content)).toBe(normalized(agent.artifact.draft.content));
    const humanIds = new Set(nativeIds(human.artifact.draft.content));
    expect(nativeIds(agent.artifact.draft.content).some((id) => humanIds.has(id))).toBe(false);
    expect(human.artifact.provenance.officeImport).toBeUndefined();
    expect(imported.get(domain)).toEqual(original);
    if (isDocument(human.artifact.draft.content)) {
      expect(human.artifact.draft.content.blocks.find((b) => b.start === 7)).toBeDefined();
      expect(
        human.artifact.draft.content.blocks.find((b) => b.type === 'table')?.merges,
      ).toHaveLength(2);
    }
    const storage = new MemoryStorage<Artifact<NativeContent>>();
    await Promise.all([applyInstantiation(human, storage), applyInstantiation(human, storage)]);
    expect(await storage.list()).toHaveLength(1);
    expect(() => expandTemplate(d, { ...input, title: '' })).toThrow();
    expect(() => expandTemplate(d, { ...input, title: 'あ'.repeat(1001) })).toThrow();
    const empty = expandTemplate(d, { ...input, picture: '', items: [] }).content!;
    expect(JSON.stringify(empty)).not.toContain('data:image');
    const replacement =
      'data:image/jpeg;base64,' +
      (await readFile('tests/fixtures/office/images/quadrants.jpeg')).toString('base64');
    expect(JSON.stringify(expandTemplate(d, { ...input, picture: replacement }).content)).toContain(
      replacement,
    );
    if (domain === 'slide')
      expect(() => expandTemplate(d, { ...input, title: 'あ'.repeat(90) })).toThrow(/fit/);
    else expect(() => expandTemplate(d, { ...input, title: 'あ'.repeat(900) })).not.toThrow();
  });
  it(`T01/T03 ${domain}: immutable versions and portable packs remain independent; fragments/presets keep distinct effects`, async () => {
    const d = await definition(domain),
      catalog = new MemoryCatalog();
    await catalog.put(d);
    const p = await prepareInstantiation(d, d.sample, `${domain}-old`),
      before = clone(p.artifact);
    const next = await createTemplateVersion(d, {
      name: '新版',
      sample: { ...d.sample, title: '新版の例' },
    });
    await catalog.put(next);
    await catalog.archive(d.templateId, true);
    expect(await catalog.list()).toEqual([]);
    expect(await catalog.getVersion(d.templateId, 1)).toEqual(d);
    expect(p.artifact).toEqual(before);
    const pack = await exportTemplatePack([d, next]),
      moved = new MemoryCatalog();
    await importTemplatePack(pack, moved);
    const independent = await prepareInstantiation(
      (await moved.getVersion(d.templateId, 1))!,
      d.sample,
      `${domain}-moved`,
    );
    expect(normalized(independent.artifact.draft.content)).toBe(normalized(before.draft.content));
    expect(JSON.stringify(independent.artifact.draft.content)).not.toContain('asset://');
    await expect(
      importTemplatePack(pack.replace(d.hash, 'damaged'), new MemoryCatalog()),
    ).rejects.toThrow(/hash/);
    const fragment = await definition(domain, 'fragment');
    expect(fragment.kind).toBe('fragment');
    const preset = await sealDefinition({
      ...builtinTemplates.find((t) => t.domain === domain && t.kind === 'preset')!,
      templateId: `reuse-${domain}-style`,
      name: '再利用する設定',
    });
    await catalog.put(preset);
    expect(preset.content).toBeUndefined();
    expect((await catalog.getVersion(preset.templateId, 1))?.kind).toBe('preset');
    const content = p.artifact.draft.content;
    const prepared = await preparePreset(
      preset,
      preset.sample,
      localTemplateSnapshot('preset-target', domain, content),
      actor,
      { scope: 'artifact' },
    );
    const after = applyLocalTemplate(prepared, content);
    expect(nativeIds(after)).toEqual(nativeIds(content));
    if (isDeck(content) && isDeck(after))
      expect(after.slides.flatMap((s) => s.objects.map((o) => o.text))).toEqual(
        content.slides.flatMap((s) => s.objects.map((o) => o.text)),
      );
    if (isDocument(content) && isDocument(after))
      expect(after.blocks.map((b) => b.text)).toEqual(content.blocks.map((b) => b.text));
  });
  it(`T05 ${domain}: fixed portable images obey the smaller template budget`, async () => {
    const content = clone(imported.get(domain)!.draft.content),
      big = 'data:image/png;base64,' + 'A'.repeat(templateLimits.assetCharacters);
    if (isDeck(content))
      Object.assign(content.slides[0].objects.find((o) => o.type === 'image')!, {
        src: big,
        text: 'Raster-only text',
      });
    if (isDocument(content))
      Object.assign(content.blocks.find((b) => b.type === 'image')!, {
        src: big,
        text: 'Raster-only text',
      });
    await expect(
      saveAsTemplate({
        domain,
        content,
        kind: 'whole',
        name: 'limit',
        purpose: 'limit',
        category: 'test',
        slots: [],
      }),
    ).rejects.toMatchObject({ code: 'template-limit' });
    expect(
      slotCandidates(content)
        .filter((c) => c.type === 'text')
        .some((c) => c.value === 'Raster-only text'),
    ).toBe(false);
  });
}
it('T05 pack byte/depth limits fail before an atomic catalog write', async () => {
  const catalog = new MemoryCatalog();
  const empty = JSON.stringify({
    format: 'editor-template-pack',
    schemaVersion: 1,
    definitions: [],
  });
  await expect(
    importTemplatePack(empty.padEnd(templateLimits.packBytes, ' '), catalog),
  ).resolves.toEqual([]);
  await expect(
    importTemplatePack(' '.repeat(templateLimits.packBytes + 1), catalog),
  ).rejects.toMatchObject({ code: 'template-limit' });
  const d = await definition('document');
  let deep: unknown = 'text';
  for (let i = 0; i < 70; i++) deep = { deep };
  await expect(
    importTemplatePack(
      JSON.stringify({
        format: 'editor-template-pack',
        schemaVersion: 1,
        definitions: [{ ...d, extra: deep }],
      }),
      catalog,
    ),
  ).rejects.toMatchObject({ code: 'template-limit' });
  expect(await catalog.list()).toEqual([]);
});
for (const domain of ['slide', 'document'] as const) {
  it(`T04 ${domain}: shared insertion rejects stale previews, retries lost receipts and selectively undoes while preserving a peer`, async () => {
    const raw = clone(imported.get(domain)!.draft.content),
      content = isDocument(raw) ? nodeToContent(contentToNode(raw), raw) : raw,
      codec = templateCodec(domain),
      authority = new Authority(codec, initial('reuse-shared', codec, content));
    const principal = (id: string): Principal => ({
      actorId: id,
      sessionId: id,
      clientId: id,
      writable: true,
      scopes: ['*'],
    });
    let lose = true;
    const open = async (id: string) => {
      const who = principal(id),
        host = Object.assign(localAdapter(authority, who), {
          registerAsset: async (
            ref: Parameters<NonNullable<EditorHostAdapter<NativeContent>['registerAsset']>>[0],
            data: string,
          ) => {
            (codec as AssetEditorCodec<NativeContent>).assets?.register(ref, data);
          },
          versions: async () => [],
          undo: async (op: string, redo?: boolean) => authority.undo(who, op, redo),
          registerProposal: async (p: Parameters<typeof authority.register>[1]) =>
            authority.register(who, p),
          previewProposal: async (p: string) => authority.preview(who, p),
          applyProposal: async (p: string, token: string) => {
            const result = authority.applyProposal(who, p, token);
            if (id === 'A' && result.status === 'accepted' && lose) {
              lose = false;
              throw Error('lost receipt');
            }
            return result;
          },
        }) as unknown as EditorHostAdapter<NativeContent>;
      const session = new SharedEditorSession(codec, host);
      await session.open();
      return session;
    };
    const a = await open('A'),
      b = await open('B'),
      d = await definition(domain, 'fragment');
    const prepare = () =>
      prepareInsertion(d, d.sample, a.confirmed, principal('A'), {}, crypto.randomUUID());
    const first = await prepare(),
      token = await previewSharedTemplate(first, a);
    b.execute(
      command('peer.style', 'Peer style', (c) => {
        const next = clone(c);
        if (isDeck(next)) next.slides[0].background = '#ddeecc';
        if (isDocument(next)) next.page = { ...next.page!, margin: 64 };
        return next;
      }),
    );
    await b.flush();
    await expect(applySharedTemplate(first, a, token.token)).rejects.toThrow('lost receipt');
    await applySharedTemplate(first, a, token.token);
    const once = clone(authority.snapshot().content);
    await applySharedTemplate(first, a, token.token);
    expect(authority.snapshot().content).toEqual(once);
    await a.history('undo');
    const undone = authority.snapshot().content;
    if (isDeck(undone) && isDeck(content)) {
      expect(undone.slides).toHaveLength(content.slides.length);
      expect(undone.slides[0].background).toBe('#ddeecc');
    }
    if (isDocument(undone) && isDocument(content)) {
      expect(undone.blocks).toEqual(content.blocks);
      expect(undone.page?.margin).toBe(64);
    }
    await a.history('redo');
    expect(authority.snapshot().content).toEqual(once);
    const stale = await prepare(),
      preview = await previewSharedTemplate(stale, a);
    if (domain === 'document') {
      const engine = b.text('text');
      engine.dispatch(engine.state.tr.insertText('共同編集', 1));
    } else
      b.execute(
        command('peer.page', 'Peer page', (c) => {
          const next = clone(c);
          if (isDeck(next)) {
            const page = remapNative(next.slides[0]).content;
            next.slides.push(page);
          }
          return next;
        }),
      );
    await b.flush();
    const before = clone(authority.snapshot().content);
    expect(b.error).toBe('');
    expect(b.pendingCount).toBe(0);
    await expect(applySharedTemplate(stale, a, preview.token)).rejects.toThrow();
    expect(authority.snapshot().content).toEqual(before);
    a.close();
    b.close();
  });
}
