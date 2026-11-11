import {
  isDocument,
  type DocumentBlock,
  type DocumentContent,
} from '@editor-platform/document/model';
import { documentText } from '@editor-platform/document/text';
import type { CreativeSourceCard } from './types';

export const settingFields = [
  { id: 'description', label: '説明' },
  { id: 'history', label: '歴史' },
  { id: 'life', label: '生活' },
  { id: 'atmosphere', label: '雰囲気' },
] as const;
export type SettingFieldId = (typeof settingFields)[number]['id'];

export class SettingSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingSourceError';
  }
}
interface SettingSection {
  card: CreativeSourceCard;
  heading: DocumentBlock;
  paragraphs: Partial<Record<SettingFieldId, DocumentBlock>>;
  reason?: string;
}
export const blockText = (block: DocumentBlock) =>
  block.rich?.map((span) => span.text).join('') ?? block.text;
export const level = (block: DocumentBlock) => block.level ?? 1;
const plainTextBlock = (block: DocumentBlock) =>
  !block.hidden &&
  (!block.rich || block.rich.every((span) => Object.keys(span).every((key) => key === 'text')));
export function fail(message: string): never {
  throw new SettingSourceError(message);
}

/** A Host projection of native headings, never an additional location record. */
export function sections(content: DocumentContent): SettingSection[] {
  if (!isDocument(content)) fail('世界の覚え書きのDocumentが不正です。');
  const ids = content.blocks.map((block) => block.id);
  const text = documentText(content);
  if (
    new Set(ids).size !== ids.length ||
    new Set(text.segments.map((segment) => segment.id)).size !== text.segments.length
  )
    fail('Documentの要素IDが重複しています。元のDocumentで確認してください。');
  const textByBlock = new Map<string, string[]>();
  for (const segment of text.segments) {
    const values = textByBlock.get(segment.blockId) ?? [];
    values.push(text.text.slice(segment.start, segment.end));
    textByBlock.set(segment.blockId, values);
  }
  const found: { id: string; name: string; start: number; end: number }[] = [];
  const semanticIds = new Set<string>();
  content.blocks.forEach((heading, start) => {
    if (heading.type !== 'heading') return;
    const label = blockText(heading).trim();
    if (!label.startsWith('LO-')) return;
    const match = /^(LO-[0-9]{2,})(?:[\s:：]+([^\r\n]+))?$/u.exec(label);
    if (!match || !Number.isSafeInteger(Number(match[1].slice(3))))
      fail('LO見出しの識別子が曖昧です。元のDocumentで確認してください。');
    const id = match[1];
    if (semanticIds.has(id)) fail(`${id}の見出しが重複しています。`);
    semanticIds.add(id);
    let end = start + 1;
    while (
      end < content.blocks.length &&
      !(content.blocks[end].type === 'heading' && level(content.blocks[end]) <= level(heading))
    )
      end++;
    found.push({ id, name: match[2]?.trim() || id, start, end });
  });
  for (let i = 1; i < found.length; i++)
    if (found[i].start < found[i - 1].end)
      fail('LO見出しが入れ子になっています。元のDocumentで確認してください。');
  return found.map(({ id, name, start, end }) => {
    const heading = content.blocks[start];
    const fieldBlocks = new Map<SettingFieldId, DocumentBlock[]>();
    const fieldHeadings = new Set<SettingFieldId>();
    let active: SettingFieldId | undefined;
    let reason = heading.hidden ? '非表示のLO見出しです。' : '';
    for (const block of content.blocks.slice(start + 1, end)) {
      if (block.type === 'heading') {
        const field = settingFields.find(
          (candidate) => candidate.label === blockText(block).trim(),
        );
        if (!field || level(block) !== level(heading) + 1) {
          reason ||= '対応していない子見出しがあります。';
          active = undefined;
          continue;
        }
        if (fieldHeadings.has(field.id)) reason ||= '同じ項目の見出しが複数あります。';
        if (block.hidden) reason ||= '非表示の項目があります。';
        fieldHeadings.add(field.id);
        active = field.id;
      } else if (active) {
        const values = fieldBlocks.get(active) ?? [];
        values.push(block);
        fieldBlocks.set(active, values);
        if (block.type !== 'paragraph' || block.hidden)
          reason ||= '通常の段落以外または非表示の内容があります。';
      } else if (block.type !== 'paragraph' || blockText(block).trim()) {
        reason ||= '項目の外に内容があります。';
      }
    }
    const paragraphs: SettingSection['paragraphs'] = {};
    const fields = settingFields.map(({ id: fieldId, label }) => {
      const blocks = fieldBlocks.get(fieldId) ?? [];
      const editable =
        !reason &&
        fieldHeadings.has(fieldId) &&
        blocks.length === 1 &&
        blocks[0].type === 'paragraph' &&
        plainTextBlock(blocks[0]);
      if (editable) paragraphs[fieldId] = blocks[0];
      return {
        id: fieldId,
        label,
        value: blocks.flatMap((block) => textByBlock.get(block.id) ?? []).join('\n\n'),
        editable,
      };
    });
    const unsafe = fields.some((field) => !field.editable);
    const sectionText = content.blocks
      .slice(start + 1, end)
      .flatMap((block) => textByBlock.get(block.id) ?? [])
      .join('\n\n');
    const summary = unsafe ? sectionText : fields[0].value;
    return {
      card: {
        id,
        elementId: heading.id,
        name,
        summary,
        fields: [
          { id: 'name', label: '場所名', value: name, editable: plainTextBlock(heading) },
          ...fields.map((field) =>
            field.id === 'description' && !field.editable && !field.value
              ? { ...field, value: summary }
              : field,
          ),
        ],
      },
      heading,
      paragraphs,
      ...(unsafe
        ? {
            reason:
              reason ||
              '書式付き・複雑な項目はカードで編集できません。元のDocumentで編集してください。',
          }
        : {}),
    };
  });
}

export function settingSourceCards(content: DocumentContent): CreativeSourceCard[] {
  return sections(content).map((section) => section.card);
}

/** Source-Host validation only; the common Document model keeps its existing schema. */
export function isSettingSource(value: unknown): value is DocumentContent {
  if (!isDocument(value)) return false;
  try {
    sections(value);
    return true;
  } catch {
    return false;
  }
}
