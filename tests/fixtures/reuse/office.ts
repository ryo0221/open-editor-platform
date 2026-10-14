import { clone } from '@editor-platform/artifact-core';
import { createDesign, makeDesignElement, type DesignContent } from '@editor-platform/design/model';
import { createDeck, type SlideContent } from '@editor-platform/slide/model';
import type { DocumentContent } from '@editor-platform/document/model';
import { definitionRef } from '@editor-platform/reuse-core';
import {
  authorReusableTokens,
  authorReusableStyle,
  authorReusableComponent,
  reusableParts,
  reusablePrototype,
  prepareComponentInsertion,
  applyLocalTemplate,
  localTemplateSnapshot,
  previewComponentUpdate,
  type NativeContent,
} from '@editor-platform/templates';
import { brandTokens } from './brand';

const identity = { actorId: 'A', clientId: 'a', sessionId: 'office' };
/** One exact brand across three native media; each retains independently entered text and image. */
export async function officeReuseCases(image: string) {
  const oldTokens = await authorReusableTokens({
    name: '共通ブランド',
    tokens: brandTokens,
    libraryId: 'office-brand',
    definitionId: 'brand',
  });
  const changed = clone(brandTokens);
  changed.tokens['palette.brand'].value = {
    colorSpace: 'srgb',
    components: [0.6, 0.2, 0.1],
    alpha: 1,
  };
  const nextTokens = await authorReusableTokens({
    name: '共通ブランド',
    tokens: changed,
    libraryId: 'office-brand',
    definitionId: 'brand',
    version: 2,
  });
  const result: {
    domain: 'document' | 'slide' | 'design';
    pinned: NativeContent;
    adopted: NativeContent;
    oldHash: string;
    newHash: string;
  }[] = [];
  for (const domain of ['document', 'slide', 'design'] as const) {
    const label = '採用済みブランドのご案内',
      body = '案件Aの本文を保持します。';
    const native: NativeContent =
      domain === 'document'
        ? {
            schemaVersion: 2,
            page: { size: 'A4', margin: 64 },
            blocks: [
              { id: 'title', type: 'heading', level: 1, text: label },
              { id: 'notice', type: 'paragraph', text: '注意書きの既定本文' },
              {
                id: 'picture',
                type: 'image',
                text: '',
                src: image,
                alt: '案件の確認画像',
                width: 180,
              },
            ],
          }
        : domain === 'slide'
          ? {
              ...createDeck(),
              slides: [
                {
                  id: 'page',
                  title: '',
                  background: '#ffffff',
                  objects: [
                    {
                      id: 'title',
                      type: 'text',
                      text: label,
                      fill: '#253044',
                      bounds: { x: 50, y: 40, width: 850, height: 80 },
                      typography: { fontFamily: 'Noto Sans CJK JP', fontSize: 32, padding: 0 },
                    },
                    {
                      id: 'notice',
                      type: 'text',
                      text: '注意書きの既定本文',
                      fill: '#253044',
                      bounds: { x: 50, y: 140, width: 850, height: 80 },
                      typography: { fontFamily: 'Noto Sans CJK JP', fontSize: 24, padding: 0 },
                    },
                    {
                      id: 'picture',
                      type: 'image',
                      text: '',
                      fill: 'none',
                      src: image,
                      alt: '案件の確認画像',
                      bounds: { x: 50, y: 250, width: 180, height: 180 },
                    },
                  ],
                },
              ],
            }
          : {
              ...createDesign(),
              elements: [
                {
                  ...makeDesignElement('text'),
                  id: 'title',
                  text: label,
                  bounds: { x: 40, y: 40, width: 650, height: 70 },
                },
                {
                  ...makeDesignElement('text'),
                  id: 'notice',
                  text: '注意書きの既定本文',
                  bounds: { x: 40, y: 140, width: 650, height: 70 },
                },
                {
                  ...makeDesignElement('image'),
                  id: 'picture',
                  src: image,
                  alt: '案件の確認画像',
                  bounds: { x: 40, y: 250, width: 180, height: 180 },
                },
              ],
            };
    const base = await authorReusableComponent({
      domain,
      content: native,
      name: '共通の注意書き',
      ids: [],
      libraryId: 'office-brand',
      definitionId: `${domain}-notice`,
    });
    const prototype = reusablePrototype(base.definition),
      parts = reusableParts(prototype);
    const styled = base.definition.payload.contract.parts.filter((p) =>
      ['text', 'heading', 'paragraph'].includes(String(parts.get(p.nativeId)?.type)),
    );
    const make = async (tokens: typeof oldTokens, version: number) => {
      const style = await authorReusableStyle({
        name: 'ブランド文字',
        libraryId: 'office-brand',
        definitionId: `${domain}-style`,
        version,
        tokens: definitionRef(tokens.definition),
        dependencies: tokens.closure.definitions,
        style: {
          schemaVersion: 1,
          domain,
          bindings: {
            [domain === 'document' ? 'color' : 'typography.color']: { token: 'brand.primary' },
          },
        },
      });
      return authorReusableComponent({
        domain,
        content: prototype,
        name: '共通の注意書き',
        ids: [],
        libraryId: 'office-brand',
        definitionId: `${domain}-notice`,
        version,
        contract: base.definition.payload.contract,
        styles: styled.map((p) => ({ partId: p.id, ref: definitionRef(style.definition) })),
        dependencies: style.closure.definitions,
      });
    };
    const source = await make(oldTokens, 1),
      next = await make(nextTokens, 2);
    const empty: NativeContent =
      domain === 'document'
        ? {
            schemaVersion: 2,
            blocks: [{ id: 'case', type: 'paragraph', text: '案件固有の前書き' }],
          }
        : domain === 'slide'
          ? {
              ...createDeck(),
              slides: [
                {
                  id: 'target',
                  title: '案件A',
                  background: '#ffffff',
                  notes: '発表者ノートは部品の改訂と独立です。',
                  objects: [],
                },
              ],
            }
          : { ...createDesign(), elements: [] };
    const property = source.definition.payload.contract.properties.find(
      (p) => p.type === 'text' && p.default === '注意書きの既定本文',
    )!;
    const inserted = applyLocalTemplate(
      await prepareComponentInsertion({
        ...source,
        identity,
        state: localTemplateSnapshot('office', domain, empty),
        inputs: { [property.id]: body },
        reuse: 'linked',
        requestId: `${domain}-case`,
        ...(domain === 'slide' ? { target: { slidePageId: 'target' } } : {}),
      }),
      empty,
    );
    const pinned = clone(inserted);
    const preview = await previewComponentUpdate({
      ...next,
      identity,
      state: localTemplateSnapshot('office', domain, inserted),
      selections: [
        {
          instanceId: (inserted as DocumentContent | SlideContent | DesignContent).reuse!
            .instances[0].id,
          choice: 'adopt',
        },
      ],
    });
    if (!preview.prepared || preview.conflicts.length)
      throw Error(JSON.stringify(preview.conflicts));
    const adopted = applyLocalTemplate(preview.prepared, inserted);
    if (!JSON.stringify(adopted).includes(body)) throw Error('Public body was not retained');
    result.push({
      domain,
      pinned,
      adopted,
      oldHash: source.definition.hash,
      newHash: next.definition.hash,
    });
  }
  return result;
}
