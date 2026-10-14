import { clone } from '@editor-platform/artifact-core';
import { readFileSync } from 'node:fs';
import type { DocumentContent } from '@editor-platform/document/model';
import { definitionRef } from '@editor-platform/reuse-core';
import {
  authorReusableTokens,
  authorReusableStyle,
  authorReusableComponent,
  prepareComponentInsertion,
  prepareComponentSlot,
  prepareComponentProperties,
  previewArtifactMode,
  localTemplateSnapshot,
  applyLocalTemplate,
  authorReusableComposition,
  exportTemplatePack,
} from '@editor-platform/templates';
import { brandTokens, brandStyles } from './brand';

export const compositionImage =
  'data:image/png;base64,' +
  readFileSync(new URL('../office/images/quadrants.png', import.meta.url)).toString('base64');
/** Host fixture built exclusively from public APIs, portable into an empty catalog. */
export async function portableComposition() {
  const identity = { actorId: 'fixture-author', clientId: 'fixture', sessionId: 'fixture' };
  const tokens = await authorReusableTokens({ name: '共通ブランド', tokens: brandTokens });
  const style = await authorReusableStyle({
    name: '注意書きの外観',
    tokens: definitionRef(tokens.definition),
    dependencies: tokens.closure.definitions,
    style: brandStyles[2],
  });
  const source: DocumentContent = {
    schemaVersion: 2,
    blocks: [
      {
        id: 'notice/body',
        type: 'paragraph',
        text: '標準の注意書き',
        rich: [{ text: '標準の注意書き', bold: true }],
      },
      {
        id: 'notice/image',
        type: 'image',
        text: '',
        src: compositionImage,
        alt: '案件画像',
        width: 48,
      },
    ],
  };
  const base = await authorReusableComponent({
    domain: 'document',
    name: '共通注意書き',
    content: source,
    ids: [],
  });
  const contract = clone(base.definition.payload.contract);
  contract.properties.push({
    id: 'photo',
    label: '案件画像',
    type: 'asset',
    default: compositionImage,
    targets: [
      { partId: contract.parts.find((p) => p.nativeId === 'notice/image')!.id, field: 'src' },
    ],
  });
  const component = await authorReusableComponent({
    domain: 'document',
    name: '共通注意書き',
    content: source,
    ids: [],
    contract,
    styles: [{ partId: contract.parts[0].id, ref: definitionRef(style.definition) }],
    dependencies: style.closure.definitions,
  });
  const child = await authorReusableComponent({
    domain: 'document',
    name: '補足の注意書き',
    content: source,
    ids: [],
    contract,
    styles: [{ partId: contract.parts[0].id, ref: definitionRef(style.definition) }],
    dependencies: style.closure.definitions,
  });
  const basis = (content: DocumentContent) => ({
    identity,
    state: localTemplateSnapshot('fixture', 'document', content),
  });
  let content: DocumentContent = {
    schemaVersion: 2,
    blocks: [{ id: 'case/body', type: 'paragraph', text: '自由な案件本文' }],
  };
  for (const requestId of ['parent', 'copy'])
    content = applyLocalTemplate(
      await prepareComponentInsertion({
        ...basis(content),
        ...component,
        requestId,
        reuse: 'linked',
      }),
      content,
    ) as DocumentContent;
  const parent = content.reuse!.instances[0],
    copy = content.reuse!.instances[1];
  content = applyLocalTemplate(
    await prepareComponentSlot({
      ...basis(content),
      instanceId: parent.id,
      slotId: contract.slots[0].id,
      values: [{ kind: 'component', ...child }],
      requestId: 'nested',
    }),
    content,
  ) as DocumentContent;
  const text = contract.properties.find((p) => p.type === 'text')!.id;
  content = applyLocalTemplate(
    await prepareComponentProperties({
      ...basis(content),
      instanceId: parent.id,
      inputs: { [text]: '案件Aの保持する本文' },
    }),
    content,
  ) as DocumentContent;
  content = applyLocalTemplate(
    (await previewArtifactMode({ ...basis(content), mode: 'dark' })).prepared!,
    content,
  ) as DocumentContent;
  const composition = await authorReusableComposition({
    name: '持ち運べる案件文書',
    purpose: 'ネストと画像、token、入力を保持する',
    category: '提案',
    domain: 'document',
    kind: 'whole',
    content,
    slots: [],
    composition: {
      members: Object.fromEntries(
        content.reuse!.instances.map((i) => [i.id, i.id === copy.id ? 'copy' : 'linked']),
      ),
      inputs: [
        { key: 'body', label: '案件の本文', instanceId: parent.id, propertyId: text },
        { key: 'photo', label: '案件の画像', instanceId: parent.id, propertyId: 'photo' },
        { key: 'copyBody', label: 'コピーの本文', instanceId: copy.id, propertyId: text },
      ],
    },
  });
  return { ...composition, pack: await exportTemplatePack([composition.template]), text };
}
