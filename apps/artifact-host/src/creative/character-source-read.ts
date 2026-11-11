import {
  displayCell,
  isStructuredData,
  type Column,
  type StructuredData,
} from '@editor-platform/structured-data/model';
import type { CreativeSourceCard } from './types';

export const characterFields = [
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

export function mappedColumns(data: StructuredData, mapping: CharacterColumnMapping) {
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

export function characterNumber(id: unknown): number {
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
