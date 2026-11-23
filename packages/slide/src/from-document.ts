import {
  canonicalEqual,
  canonicalJson,
  clone,
  deepFreeze,
  newId,
} from '@editor-platform/artifact-core';
import {
  formatLiveValue,
  hydrateLiveReference,
  type LiveReference,
} from '@editor-platform/artifact-references';
import {
  isDocument,
  nestedLists,
  type DocumentBlock,
  type DocumentContent,
  type DocumentListItem,
  type InlineSpan,
} from '@editor-platform/document/model';
import { immutableCommand, withCommandReads } from '@editor-platform/editor-core';
import {
  createDeck,
  normalizeSlideLiveSnapshots,
  validateSlideEdit,
  type Slide,
  type SlideContent,
  type SlideObject,
} from './model';

export const slideDocumentLimits = {
  bytes: 8 * 1024 * 1024,
  blocks: 2000,
  pages: 100,
  objects: 100,
} as const;

function invalid(location: string, reason: string): never {
  throw new Error(`${location}：${reason}`);
}

export function validateSlideDocument(value: unknown): DocumentContent {
  if (
    value &&
    typeof value === 'object' &&
    'blocks' in value &&
    Array.isArray(value.blocks) &&
    value.blocks.length > slideDocumentLimits.blocks
  )
    invalid('文書のブロック', '2,000 件を超えています。');
  try {
    if (new TextEncoder().encode(canonicalJson(value)).byteLength > slideDocumentLimits.bytes)
      invalid('文書の内容', '8 MiB を超えています。');
  } catch (error) {
    if (error instanceof RangeError) invalid('文書の内容', '文書の入れ子が深すぎます。');
    throw error;
  }
  let valid = false;
  try {
    valid = isDocument(value);
  } catch {
    /* A malformed native block can throw. */
  }
  if (!valid) invalid('文書の内容', 'Document の版 1 または 2 の有効な内容を選んでください。');
  return value as DocumentContent;
}

type Fragment = { text: string; quote?: LiveReference; heading: boolean; depth: number };
type Section = { title: string; fragments: Fragment[] };

function sectionBuilder(doc: DocumentContent) {
  const sections: Section[] = [];
  let section: Section | undefined;
  let location = '文書';
  function push(text: string, heading: boolean, depth: number, quote?: LiveReference) {
    if (!text && !quote) return;
    if (!section) invalid(location, '最初の見出しより前に表示される内容があります。');
    if (section.fragments.length >= slideDocumentLimits.objects)
      invalid(location, 'このページの生成オブジェクトが 100 件を超えています。');
    section.fragments.push({ text, heading, depth, ...(quote && { quote: clone(quote) }) });
  }
  function text(spans: InlineSpan[], heading = false, depth = 0, prefix = '') {
    let pending = prefix;
    for (const span of spans) {
      if (!span.liveQuote) {
        pending += span.text;
        continue;
      }
      push(pending, heading, depth);
      const quote = hydrateLiveReference(span.liveQuote.reference, doc.liveSnapshots);
      if (quote.presentation.kind !== 'value')
        invalid(location, '本文の固定値引用を保持できません。');
      push(formatLiveValue(quote.presentation), heading, depth, quote);
      pending = '';
    }
    push(pending, heading, depth);
  }
  function list(
    items: DocumentListItem[],
    kind: 'bullet' | 'ordered' | 'check',
    start: number,
    depth = 0,
  ) {
    for (const [i, item] of items.entries()) {
      const prefix =
        kind === 'ordered'
          ? `${start + i}. `
          : kind === 'check'
            ? item.checked
              ? '☑ '
              : '☐ '
            : '• ';
      text(item.rich, false, depth, prefix);
      for (const child of nestedLists(item))
        list(
          child.items,
          child.type === 'ordered_list' ? 'ordered' : child.check ? 'check' : 'bullet',
          child.start ?? 1,
          depth + 1,
        );
    }
  }
  const spans = (block: DocumentBlock) => block.rich ?? [{ text: block.text }];
  for (const [index, block] of doc.blocks.entries()) {
    if (block.hidden) continue;
    location = `${index + 1} 件目のブロック（${block.type}）`;
    if (block.type === 'heading') {
      if (sections.length >= slideDocumentLimits.pages)
        invalid(location, '生成ページが 100 枚を超えています。');
      const rich = spans(block);
      const title = rich
        .map(({ text, liveQuote }) => {
          const presentation = liveQuote?.reference.presentation;
          return presentation?.kind === 'value' ? formatLiveValue(presentation) : text;
        })
        .join('');
      section = { title: title || `Slide ${sections.length + 1}`, fragments: [] };
      sections.push(section);
      text(rich, true);
      continue;
    }
    if (!section) invalid(location, '最初の見出しより前に表示される内容があります。');
    if (block.type === 'paragraph') text(spans(block));
    else if (block.type === 'image' && block.liveFigure) {
      const quote = hydrateLiveReference(block.liveFigure, doc.liveSnapshots);
      if (quote.presentation.kind !== 'figure') invalid(location, '固定図引用を保持できません。');
      push('', false, 0, quote);
    } else if (
      block.type === 'bulleted-list' ||
      block.type === 'numbered-list' ||
      block.type === 'check-list'
    ) {
      const kind =
        block.type === 'numbered-list'
          ? 'ordered'
          : block.type === 'check-list'
            ? 'check'
            : 'bullet';
      const items =
        block.items ??
        block.text.split('\n').map((line, i) => ({
          id: `${i}`,
          rich: [{ text: line }],
        }));
      list(items, kind, block.start ?? 1);
    } else
      invalid(
        location,
        'この種類のブロックは変換できません。文書で内容を直して選び直してください。',
      );
  }
  if (!sections.length) invalid('文書', '表示対象の見出しがありません。');
  return sections;
}

function makePage(section: Section, size: Pick<SlideContent, 'width' | 'height'>): Slide {
  const { width, height } = size;
  const marginX = width * 0.07;
  const marginY = height * 0.07;
  const fragments = section.fragments.map((fragment) => {
    const image = fragment.quote?.presentation.kind === 'figure';
    const indent = Math.min(fragment.depth * width * 0.025, width * 0.32);
    const objectWidth = width - marginX * 2 - indent;
    const font = Math.min(width / (fragment.heading ? 26 : 44), height * 0.08);
    const columns = Math.max(1, Math.floor(objectWidth / font));
    const lines = fragment.text
      .split('\n')
      .reduce((n, line) => n + Math.max(1, Math.ceil(line.length / columns)), 0);
    const desiredHeight = image ? height * 0.4 : font * (1.25 * lines + 0.4);
    return { fragment, image, indent, objectWidth, font, desiredHeight };
  });
  const available = height - marginY * 2;
  const total = fragments.reduce((sum, row) => sum + row.desiredHeight, 0);
  const scale = Math.min(1, (available - fragments.length) / Math.max(total, 1));
  let y = marginY;
  const objects: SlideObject[] = fragments.map(
    ({ fragment, image, indent, objectWidth, font, desiredHeight }) => {
      const objectHeight = Math.max(1, 1 + desiredHeight * scale);
      const bounds = { x: marginX + indent, y, width: objectWidth, height: objectHeight };
      y += objectHeight;
      return {
        id: newId('object'),
        type: image ? 'image' : 'text',
        text: fragment.text,
        bounds,
        fill: fragment.quote ? '#174d37' : '#253446',
        ...(fragment.quote && { liveQuote: fragment.quote }),
        ...(image
          ? { imageFit: 'fit' }
          : {
              typography: {
                fontSize: Math.max(1, font * scale),
                padding: 0,
                lineHeight: 1.2,
                ...(fragment.heading && { bold: true }),
              },
            }),
      };
    },
  );
  return { id: newId('slide'), title: section.title, background: '#ffffff', objects };
}

/** Uses the same immutable candidate for preview and apply. The Host pins the source and revision. */
export function prepareSlideDocument(doc: unknown, destination?: SlideContent) {
  const base = destination ? deepFreeze(clone(destination)) : createDeck();
  const pages = deepFreeze(
    sectionBuilder(validateSlideDocument(doc)).map((section) => makePage(section, base)),
  );
  const taken = new Set(
    base.slides.flatMap((page) => [
      page.id,
      ...page.objects.map(({ id }) => id),
      ...(page.steps ?? []).flatMap(({ id, effects }) => [
        id,
        ...effects.map((effect) => effect.id),
      ]),
    ]),
  );
  for (const page of pages) {
    for (const id of [page.id, ...page.objects.map((object) => object.id)]) {
      if (taken.has(id)) invalid(page.title, 'ページまたはオブジェクトの ID が重複しました。');
      taken.add(id);
    }
  }
  const combine = (deck: SlideContent) =>
    validateSlideEdit(
      normalizeSlideLiveSnapshots({
        ...deck,
        slides: destination ? [...deck.slides, ...pages] : pages,
      }),
    );
  let content: SlideContent;
  try {
    content = combine(base);
  } catch (error) {
    invalid(
      destination ? '追加後のデッキ' : '生成するデッキ',
      `形式または保持容量の上限を満たせません。 ${(error as Error).message}`,
    );
  }
  const append = destination
    ? withCommandReads(
        immutableCommand('slide.document.append', '文書から末尾に追加', (current: SlideContent) => {
          if (!canonicalEqual(current, base))
            invalid('追加先', '内容が変わりました。もう一度プレビューしてください。');
          return combine(current);
        }),
        { content: ['*'] },
      )
    : undefined;
  return { pages, content, append };
}
