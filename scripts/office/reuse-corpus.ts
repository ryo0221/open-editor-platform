import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { canonicalJson, type Artifact } from '@editor-platform/artifact-core';
import { isDeck } from '@editor-platform/slide/model';
import { isDocument } from '@editor-platform/document/model';
import {
  saveAsTemplate,
  slotCandidates,
  prepareInstantiation,
  exportTemplatePack,
  importTemplatePack,
  MemoryCatalog,
  TemplateCatalog,
  remapNative,
  type NativeContent,
  type AuthoredSlot,
} from '@editor-platform/templates';
import { prepareAgentTemplate } from '../../apps/playground/src/template-agent';
import { nodePptx } from '../../tests/fixtures/office/node';
import { nodeDocx } from '../../tests/fixtures/office/docx-node';
const [slideRoot, wordRoot, root] = process.argv.slice(2);
if (!slideRoot || !wordRoot || !root)
  throw Error('Pass fresh Slide import corpus, Word import corpus and output directories');
await mkdir(root, { recursive: true });
for (const [domain, source] of [
  ['slide', `${slideRoot}/external-slide.native.json`],
  ['document', `${wordRoot}/external-word.artifact.json`],
] as const) {
  const original = JSON.parse(await readFile(source, 'utf8')) as Artifact<NativeContent>,
    candidates = slotCandidates(original.draft.content),
    title = candidates.find((c) => c.type === 'text' && String(c.value).startsWith('外部作成'))!,
    picture = candidates.find((c) => c.type === 'asset')!,
    list =
      candidates.find((c) => c.type === 'list') ??
      candidates.find((c) => c.type === 'text' && c.value === '受付')!;
  const slots: AuthoredSlot[] = [
    { ...title, key: 'title', label: '案件名', defaultValue: '架空の提案' },
    { ...picture, key: 'picture', label: '説明画像' },
    { ...list, type: 'list', key: 'items', label: '確認項目', defaultValue: ['確認'] },
  ];
  const definition = await saveAsTemplate({
      domain,
      content: original.draft.content,
      kind: 'whole',
      slots,
      name: '社内提案の再利用',
      category: 'verification',
      purpose: '別案件に再利用',
    }),
    pack = await exportTemplatePack([definition]),
    moved = new MemoryCatalog();
  await importTemplatePack(pack, moved);
  const inputs = { ...definition.sample, title: '別案件の提案', items: ['新受付'] },
    human = await prepareInstantiation(
      (await moved.getVersion(definition.templateId, 1))!,
      inputs,
      `corpus-human-${domain}`,
    ),
    agent = await prepareAgentTemplate(new TemplateCatalog([moved]), {
      templateId: definition.templateId,
      templateVersion: 1,
      inputs,
      requestId: `corpus-agent-${domain}`,
    });
  const normalized = (c: NativeContent) =>
    canonicalJson(remapNative(c, new Map(), 'normalized').content);
  if (normalized(human.artifact.draft.content) !== normalized(agent.artifact.draft.content))
    throw Error('Human/agent mismatch');
  const content = human.artifact.draft.content,
    basis = { kind: 'saved-version' as const, artifactId: human.artifact.id, versionId: 'reused' };
  const exported = isDeck(content)
    ? await nodePptx(content, basis, {
        pageIds: 'all',
        includeHiddenSlides: true,
        includeNotes: true,
        fontProfileId: 'noto-cjk-jp-2.004',
        fallback: 'element-png',
      })
    : isDocument(content)
      ? await nodeDocx(content, basis)
      : undefined;
  if (!exported) throw Error('Unexpected domain');
  await writeFile(
    `${root}/reused-${domain}.${domain === 'slide' ? 'pptx' : 'docx'}`,
    exported.bytes,
  );
  await writeFile(`${root}/reused-${domain}.native.json`, JSON.stringify(content, null, 2));
  await writeFile(
    `${root}/reused-${domain}.artifact.json`,
    JSON.stringify(human.artifact, null, 2),
  );
  await writeFile(`${root}/reused-${domain}.report.json`, JSON.stringify(exported.report, null, 2));
  await writeFile(`${root}/reused-${domain}.template.json`, pack);
  console.log(
    JSON.stringify({
      domain,
      templateHash: definition.hash,
      humanAgentEqual: true,
      bytes: exported.bytes.length,
    }),
  );
}
