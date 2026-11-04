import { canonicalJson, newId } from '@editor-platform/artifact-core';
import type { EditorCommand, ElementAddress } from '@editor-platform/editor-core';
import type { EditorHostAdapter } from '@editor-platform/editor-host';
import { DataSurface } from '@editor-platform/structured-data';
import {
  displayCell,
  isStructuredData,
  makeRow,
  type Column,
  type StructuredData,
} from '@editor-platform/structured-data/model';
import { guardDataCommand, pinDataCommand } from '@editor-platform/structured-data/session';
import { setCells } from '@editor-platform/structured-data/views';
import type { CreativeMode, CreativeSourceCard } from './types';

const characterFields = [
  ['id', 'ID'],
  ['name', '名前'],
  ['description', '説明'],
  ['desire', '欲求'],
  ['wound', '傷'],
  ['voice', '口調'],
  ['relationships', '関係'],
  ['firstAppearance', '初登場'],
] as const;
export type CharacterField = (typeof characterFields)[number][0];
/** Consuming Hosts supply stable native column IDs; labels never infer this mapping. */
export type CharacterColumnMapping = Readonly<Record<CharacterField, string>>;
export const defaultCharacterColumns: CharacterColumnMapping = Object.freeze({
  id: 'character-id',
  name: 'character-name',
  description: 'character-description',
  desire: 'character-desire',
  wound: 'character-wound',
  voice: 'character-voice',
  relationships: 'character-relationships',
  firstAppearance: 'character-first-appearance',
});

function mappedColumns(data: StructuredData, mapping: CharacterColumnMapping) {
  if (!isStructuredData(data)) throw new Error('人物表のnative Dataが不正です。');
  const columns = new Map<string, Column>();
  for (const [field] of characterFields) {
    const id = mapping[field],
      column = data.columns.find((c) => c.id === id);
    if (!id || !column) throw new Error(`人物表の列が見つかりません: ${field}`);
    if (columns.has(id)) throw new Error('人物表の列対応が重複しています。');
    columns.set(id, column);
  }
  if (columns.get(mapping.id)!.type !== 'text')
    throw new Error('人物IDの列はtextで指定してください。');
  return columns;
}

function characterNumber(id: unknown): number {
  if (typeof id !== 'string' || !/^CH-\d{2,}$/.test(id))
    throw new Error('人物IDはCH-01の形式で指定してください。');
  const number = Number(id.slice(3));
  if (!Number.isSafeInteger(number) || number < 1 || id !== `CH-${String(number).padStart(2, '0')}`)
    throw new Error('人物IDはCH-01の形式で指定してください。');
  return number;
}

/** Read-through cards only: the native Data rows remain the only character records. */
export function projectCharacterCards(
  data: StructuredData,
  mapping: CharacterColumnMapping = defaultCharacterColumns,
): CreativeSourceCard[] {
  const columns = mappedColumns(data, mapping),
    seen = new Set<string>();
  return data.rows.map((row) => {
    const id = row.values[mapping.id];
    characterNumber(id);
    const itemId = String(id);
    if (seen.has(itemId)) throw new Error(`人物IDが重複しています: ${itemId}`);
    seen.add(itemId);
    const read = (field: CharacterField) => displayCell(data, row, columns.get(mapping[field])!);
    return {
      id: itemId,
      elementId: row.id,
      name: read('name'),
      summary: read('description'),
      fields: characterFields.map(([field, label]) => ({
        id: mapping[field],
        label,
        value: read(field),
        editable:
          field !== 'id' &&
          columns.get(mapping[field])!.type === 'text' &&
          !columns.get(mapping[field])!.readOnly,
      })),
    };
  });
}

/** Reference-Host seed of the ordinary fiction-novel character-sheet table. */
export function createCharacterSeed(
  mapping: CharacterColumnMapping = defaultCharacterColumns,
): StructuredData {
  const values = [
    [
      'CH-01',
      '美緒',
      '港町に暮らす少女。灯台の消えた夜に手紙を見つける。',
      '灯台守の消息を知る',
      '祖母を失った寂しさ',
      '短く率直に話す',
      '灯台守から手紙を受け取る',
      '港の坂道',
    ],
    [
      'CH-02',
      '灯台守',
      '手紙を残した、岬の灯台の守り手。',
      '次の守り手に灯りを託す',
      '届かなかった返事',
      '静かで丁寧な言葉',
      '美緒に灯台の役目を伝える',
      '最初の手紙',
    ],
  ];
  const data: StructuredData = {
    schemaVersion: 2,
    columns: characterFields.map(([field, name]) => ({
      id: mapping[field],
      name,
      type: 'text',
      ...(field === 'id' || field === 'name' ? { required: true } : {}),
    })),
    rows: values.map((row) => ({
      id: `character-row-${row[0]}`,
      values: Object.fromEntries(characterFields.map(([field], i) => [mapping[field], row[i]])),
    })),
  };
  projectCharacterCards(data, mapping);
  return data;
}

/** Preserve each CH/native-row identity at every source-view and card command boundary. */
export function guardCharacterSourceCommand(
  native: EditorCommand<StructuredData>,
  mapping: CharacterColumnMapping = defaultCharacterColumns,
  mayEdit: () => boolean = () => true,
): EditorCommand<StructuredData> {
  const owned = Object.freeze({ ...mapping });
  return guardDataCommand(
    {
      ...native,
      apply(current) {
        const before = projectCharacterCards(current, owned);
        const next = native.apply(current);
        const after = projectCharacterCards(next, owned);
        for (const card of before) {
          const retained = after.find((c) => c.elementId === card.elementId);
          if (!retained || retained.id !== card.id)
            throw new Error('人物IDと元の行は変更・削除できません。');
        }
        return next;
      },
    },
    mayEdit,
  );
}

/** Allocate IDs once when preparing the native command, preserving the same IDs on Redo. */
export function createCharacterCommand(
  data: StructuredData,
  name: string,
  summary: string,
  mapping: CharacterColumnMapping = defaultCharacterColumns,
  mayEdit: () => boolean = () => true,
): EditorCommand<StructuredData> {
  const owned = Object.freeze({ ...mapping }),
    cards = projectCharacterCards(data, owned);
  if (!name.trim()) throw new Error('人物名を入力してください。');
  const number = cards.reduce((max, card) => Math.max(max, characterNumber(card.id)), 0) + 1;
  const id = `CH-${String(number).padStart(2, '0')}`;
  characterNumber(id);
  // Allocate native identity once per prepared command. Recreating an undone CH number
  // must not silently bind a different person to the previous person's artwork.
  const row = makeRow(data, newId('character-row'));
  const native = setCells(
    [
      { rowId: row.id, columnId: owned.id, value: id },
      { rowId: row.id, columnId: owned.name, value: name.trim() },
      { rowId: row.id, columnId: owned.description, value: summary },
    ],
    '人物を追加',
    [row],
  );
  const columns = canonicalJson(data.columns);
  const identity = (value: StructuredData) =>
    canonicalJson(value.rows.map((r) => [r.id, r.values[owned.id]]));
  const baseIdentity = identity(data);
  return guardCharacterSourceCommand(
    {
      ...native,
      apply(current) {
        if (canonicalJson(current.columns) !== columns || identity(current) !== baseIdentity)
          throw new Error('人物表が変更されています。再読込して追加してください。');
        return native.apply(current);
      },
    },
    owned,
    mayEdit,
  );
}

export function editCharacterCommand(
  data: StructuredData,
  card: CreativeSourceCard,
  fieldId: string,
  value: string,
  mapping: CharacterColumnMapping = defaultCharacterColumns,
  mayEdit: () => boolean = () => true,
): EditorCommand<StructuredData> {
  const owned = Object.freeze({ ...mapping });
  const current = projectCharacterCards(data, owned).find(
    (c) => c.elementId === card.elementId && c.id === card.id,
  );
  const field = current?.fields.find((f) => f.id === fieldId);
  if (!current || !field) throw new Error('人物または編集対象の列が見つかりません。');
  if (!field.editable) throw new Error('この項目は読み取り専用です。');
  if (card.fields.find((f) => f.id === fieldId)?.value !== field.value)
    throw new Error('人物の値が変更されています。再読込してください。');
  if (fieldId === owned.name && !value.trim()) throw new Error('人物名を入力してください。');
  const row = data.rows.find((r) => r.id === card.elementId)!;
  const native = setCells([{ rowId: row.id, columnId: fieldId, value }], '人物を編集');
  return guardCharacterSourceCommand(
    pinDataCommand(native, {
      rowId: row.id,
      row: canonicalJson(row),
      columns: canonicalJson(data.columns),
    }),
    owned,
    mayEdit,
  );
}

export interface CharacterSourceViewProps {
  content: StructuredData;
  execute(command: EditorCommand<StructuredData>): boolean;
  readOnly: boolean;
  focus?: ElementAddress;
  mapping?: CharacterColumnMapping;
}
/** DataSurface has no incoming row-focus API. The address is shown as a reference cue. */
export function CharacterSourceView({
  content,
  execute,
  readOnly,
  focus,
  mapping = defaultCharacterColumns,
}: CharacterSourceViewProps) {
  const card =
    focus && projectCharacterCards(content, mapping).find((c) => c.elementId === focus.elementId);
  return (
    <>
      {card && (
        <p>
          参照元：{card.id} {card.name}。表の行を選んで編集してください。
        </p>
      )}
      <DataSurface
        content={content}
        execute={(native) => execute(guardCharacterSourceCommand(native, mapping, () => !readOnly))}
        select={() => {}}
        readOnly={readOnly}
      />
    </>
  );
}

export type CharacterSourceConfig = Pick<
  CreativeMode<StructuredData>,
  | 'id'
  | 'title'
  | 'itemLabel'
  | 'sourceLabel'
  | 'adapter'
  | 'seed'
  | 'cards'
  | 'create'
  | 'edit'
  | 'sourceView'
>;
/** Bind an existing native table through explicit column IDs without copying its records. */
export function createCharacterSourceConfig(
  mapping: CharacterColumnMapping = defaultCharacterColumns,
): CharacterSourceConfig {
  const owned = Object.freeze({ ...mapping });
  const adapter: EditorHostAdapter<StructuredData> = {
    kind: 'data',
    validate(value): value is StructuredData {
      if (!isStructuredData(value)) return false;
      try {
        projectCharacterCards(value, owned);
        return true;
      } catch {
        return false;
      }
    },
    capabilities: { undo: true, nativeJson: true, formats: [], preview: 'none', shared: false },
  };
  return {
    id: 'character',
    title: 'Character Mode',
    itemLabel: '人物',
    sourceLabel: '人物表',
    adapter,
    seed: () => createCharacterSeed(owned),
    cards: (content) => projectCharacterCards(content, owned),
    create: (content, name, summary) => createCharacterCommand(content, name, summary, owned),
    edit: (content, card, fieldId, value) =>
      editCharacterCommand(content, card, fieldId, value, owned),
    sourceView: (props) => <CharacterSourceView {...props} mapping={owned} />,
  };
}
export const characterSourceConfig = createCharacterSourceConfig();
