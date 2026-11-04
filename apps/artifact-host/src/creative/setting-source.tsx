import { useMemo } from 'react';
import { newId, canonicalJson, clone } from '@editor-platform/artifact-core';
import { DocumentSurface, documentProposalDiff } from '@editor-platform/document';
import {
  blockNode,
  captureDocumentUpdate,
  contentToNode,
  documentUpdateCommand,
  nodeToContent,
} from '@editor-platform/document/engine';
import {
  isDocument,
  type DocumentBlock,
  type DocumentContent,
} from '@editor-platform/document/model';
import {
  documentText,
  documentTextAccess,
  documentTextEditCommand,
} from '@editor-platform/document/text';
import type { EditorCommand, ElementAddress } from '@editor-platform/editor-core';
import { changedElementsFromDiff, type EditorHostAdapter } from '@editor-platform/editor-host';
import { EditorState } from 'prosemirror-state';
import type { CreativeMode, CreativeSourceCard } from './types';

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
const blockText = (block: DocumentBlock) =>
  block.rich?.map((span) => span.text).join('') ?? block.text;
const level = (block: DocumentBlock) => block.level ?? 1;
const plainTextBlock = (block: DocumentBlock) =>
  !block.hidden &&
  (!block.rich || block.rich.every((span) => Object.keys(span).every((key) => key === 'text')));
function fail(message: string): never {
  throw new SettingSourceError(message);
}

/** A Host projection of native headings, never an additional location record. */
function sections(content: DocumentContent): SettingSection[] {
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

/** Preserve every existing LO/native-heading identity at the source command boundary. */
export function guardSettingSourceCommand(
  native: EditorCommand<DocumentContent>,
  mayEdit: () => boolean = () => true,
): EditorCommand<DocumentContent> {
  return {
    ...native,
    apply(current) {
      if (!mayEdit()) fail('舞台の正本はread-onlyです。');
      const before = sections(current);
      const next = native.apply(native.readonlyInput ? current : clone(current));
      const after = sections(next);
      for (const { card } of before) {
        const retained = after.find((section) => section.card.elementId === card.elementId);
        if (!retained || retained.card.id !== card.id)
          fail('場所IDと元の見出しは変更・削除できません。');
      }
      if (!mayEdit()) fail('舞台の正本はread-onlyです。');
      return next;
    },
  };
}

function sourceValue(value: string, label: string, limit: number, required = false): string {
  if (typeof value !== 'string' || value.length > limit || (required && !value.trim()))
    fail(`${label}を${limit}文字以内で入力してください。`);
  if (required && /[\r\n]/u.test(value)) fail(`${label}に改行は使えません。`);
  return value;
}

/** One exact-base native engine transaction. Existing source IDs/content stay unchanged. */
export function createSettingSectionCommand(
  content: DocumentContent,
  name: string,
  description: string,
  mayEdit: () => boolean = () => true,
): EditorCommand<DocumentContent> {
  const current = sections(content);
  sourceValue(name, '場所名', 160, true);
  sourceValue(description, '説明', 20000);
  const number = Math.max(0, ...current.map((section) => Number(section.card.id.slice(3)))) + 1;
  if (!Number.isSafeInteger(number)) fail('新しいLO識別子を作れません。');
  const id = `LO-${String(number).padStart(2, '0')}`;
  // An appended LO must be a sibling or ancestor of every existing LO, including H1
  // sources. Cap the preset at H2 so its field headings always fit the native H1–H6 range.
  const headingLevel = Math.min(2, ...current.map((section) => level(section.heading)));
  const blocks = locationBlocks(id, name.trim(), description, headingLevel);
  const state = EditorState.create({ doc: contentToNode(content) });
  const transaction = state.tr.insert(state.doc.content.size, blocks.map(blockNode));
  const native = documentUpdateCommand(content, captureDocumentUpdate([transaction]), {
    origin: 'local',
    transactionId: newId('transaction'),
  });
  return guardSettingSourceCommand(
    {
      ...native,
      apply(current) {
        const next = native.apply(current);
        // This engine transaction only appends. Keep the existing native representation,
        // including legacy omitted defaults, rather than normalizing untouched source blocks.
        return {
          ...next,
          blocks: [...clone(current.blocks), ...next.blocks.slice(current.blocks.length)],
        };
      },
    },
    mayEdit,
  );
}

/** Edits only an unambiguous native paragraph; its captured base rejects later changes. */
export function editSettingFieldCommand(
  content: DocumentContent,
  card: CreativeSourceCard,
  fieldId: string,
  value: string,
  mayEdit: () => boolean = () => true,
): EditorCommand<DocumentContent> {
  const section = sections(content).find(
    (candidate) => candidate.card.id === card.id && candidate.card.elementId === card.elementId,
  );
  if (!section) fail('場所の元の見出しがありません。元のDocumentで確認してください。');
  if (canonicalJson(section.card) !== canonicalJson(card))
    fail('場所の正本が変わりました。カードを読み直してください。');
  let target: DocumentBlock;
  let replacement: string;
  if (fieldId === 'name') {
    sourceValue(value, '場所名', 160, true);
    if (!section.card.fields.find((field) => field.id === 'name')!.editable)
      fail('書式付きまたは非表示の場所名は元のDocumentで編集してください。');
    target = section.heading;
    const original = blockText(target);
    const prefixEnd = original.indexOf(card.id) + card.id.length;
    const separator = /^[\s:：]+/u.exec(original.slice(prefixEnd))?.[0] ?? ' ';
    replacement = original.slice(0, prefixEnd) + separator + value.trim();
  } else {
    const field = settingFields.find((candidate) => candidate.id === fieldId);
    if (!field) fail('対応していない場所の項目です。');
    const paragraph = section.paragraphs[field.id];
    if (!paragraph)
      fail('この項目は安全に部分編集できません。元のLO見出しへ移動して編集してください。');
    sourceValue(value, field.label, 20000);
    target = paragraph;
    replacement = value;
  }
  const expected = blockText(target);
  return guardSettingSourceCommand(
    documentTextEditCommand(content, [
      {
        segmentId: target.id,
        start: 0,
        end: expected.length,
        expected,
        text: replacement,
      },
    ]),
    mayEdit,
  );
}

function locationBlocks(
  id: string,
  name: string,
  description: string,
  headingLevel = 2,
): DocumentBlock[] {
  return [
    { id: newId('block'), type: 'heading', level: headingLevel, text: `${id} ${name}` },
    ...settingFields.flatMap(({ id: fieldId, label }) => [
      { id: newId('block'), type: 'heading' as const, level: headingLevel + 1, text: label },
      {
        id: newId('block'),
        type: 'paragraph' as const,
        text: fieldId === 'description' ? description : '',
      },
    ]),
  ];
}

export function settingDocumentSeed(): DocumentContent {
  const content: DocumentContent = {
    schemaVersion: 2,
    blocks: [
      {
        id: 'world-notes-title',
        type: 'heading',
        level: 1,
        text: '世界の覚え書き',
      },
      ...locationBlocks('LO-01', '風見の家', '丘の上から港を見渡す、小さな木造の家。'),
    ],
  };
  return nodeToContent(contentToNode(content), content);
}

export const settingSourceAdapter: EditorHostAdapter<DocumentContent> = {
  kind: 'document',
  validate: isSettingSource,
  text: documentTextAccess,
  changedElements: changedElementsFromDiff(documentProposalDiff),
  capabilities: {
    undo: true,
    nativeJson: true,
    formats: [],
    preview: 'none',
    shared: false,
    proposals: true,
  },
};

export function SettingSourceView({
  content,
  execute,
  readOnly,
  focus,
}: Parameters<CreativeMode<DocumentContent>['sourceView']>[0]) {
  // DocumentSurface refocuses whenever address identity changes. Preserve it while typing
  // through ordinary Host rerenders that recreate an equivalent address object.
  const focusKey = focus ? canonicalJson(focus) : '';
  const focusAddress = useMemo<ElementAddress | undefined>(
    () => (focusKey ? (JSON.parse(focusKey) as ElementAddress) : undefined),
    [focusKey],
  );
  let problems: string[];
  try {
    problems = sections(content).flatMap(({ card, reason }) =>
      reason ? [`${card.id}：${reason}`] : [],
    );
  } catch (error) {
    problems = [error instanceof Error ? error.message : String(error)];
  }
  return (
    <section aria-label="舞台の正本">
      <p>
        場所カードの正本は、このDocumentのLO見出しです。カードで編集できない項目は、元のLO見出しへ移動して編集してください。
      </p>
      {problems.length > 0 && <p role="status">{problems.join(' ')}</p>}
      <DocumentSurface
        content={content}
        readOnly={readOnly}
        execute={(command) => execute(guardSettingSourceCommand(command, () => !readOnly))}
        select={() => {}}
        focusAddress={focusAddress}
      />
    </section>
  );
}

/** Root supplies the Design preset, component and groups; this module owns no Design state. */
export const settingSourceConfig = {
  id: 'setting',
  title: '舞台設計',
  itemLabel: '場所',
  sourceLabel: '世界の覚え書き',
  adapter: settingSourceAdapter,
  seed: settingDocumentSeed,
  cards: settingSourceCards,
  create: createSettingSectionCommand,
  edit: editSettingFieldCommand,
  sourceView: (props) => <SettingSourceView {...props} />,
} satisfies Omit<CreativeMode<DocumentContent>, 'design' | 'componentId' | 'groups'>;
