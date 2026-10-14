import { canonicalJson, clone } from '@editor-platform/artifact-core';
import { isGraphJson, type Attributes, type JsonValue } from './model';
import { mergeGraphAttribute, validateAttributes, type AttributeSchema } from './profile';
import { type GraphIntent } from './commands';
export interface GraphAttributeDraft {
  id: string;
  scope: 'graph' | 'node' | 'edge';
  original: Attributes;
  schema: Record<string, AttributeSchema>;
  values: Record<string, string>;
  composing?: boolean;
}
export function emptyAttributeValue(schema: AttributeSchema): string {
  if (schema.type !== 'enum') return '';
  let empty = '__ep_unset__';
  while (schema.enum?.some((value) => String(value) === empty)) empty += '_';
  return empty;
}
export function formatAttribute(value: JsonValue | undefined, schema: AttributeSchema): string {
  if (value === null || value === undefined) return emptyAttributeValue(schema);
  return ['array', 'object'].includes(schema.type) ? JSON.stringify(value, null, 2) : String(value);
}
export function parseAttribute(value: string, schema: AttributeSchema): JsonValue {
  if (schema.type === 'enum') {
    if (value === emptyAttributeValue(schema)) return null;
    const option = schema.enum?.find((option) => String(option) === value);
    if (option === undefined) throw new Error('一覧から値を選択してください。');
    return option;
  }
  if (!value.trim()) return null;
  if (schema.type === 'array' || schema.type === 'object') {
    const result: unknown = JSON.parse(value);
    if (!isGraphJson(result)) throw new Error('JSONの形式、容量または深さを確認してください。');
    return result;
  }
  if (schema.type === 'number') {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error('有効な数値を入力してください。');
    return number;
  }
  if (schema.type === 'boolean') {
    if (value !== 'true' && value !== 'false')
      throw new Error('true または false を選択してください。');
    return value === 'true';
  }
  return value;
}
export function prepareGraphAttributeDraft(
  draft: GraphAttributeDraft,
  attributes: Attributes,
  schema: Record<string, AttributeSchema>,
): GraphIntent[] {
  if (draft.composing) throw new Error('入力変換を確定してください。');
  if (
    canonicalJson(attributes) !== canonicalJson(draft.original) ||
    canonicalJson(schema) !== canonicalJson(draft.schema)
  )
    throw new Error('属性または定義が変更されました。入力をコピーして現在値を確認してください。');
  const next = clone(attributes);
  const intents: GraphIntent[] = [];
  for (const [key, field] of Object.entries(schema)) {
    if (field.readOnly || draft.values[key] === formatAttribute(attributes[key], field)) continue;
    const value = parseAttribute(draft.values[key] ?? emptyAttributeValue(field), field);
    next[key] = mergeGraphAttribute(attributes[key], value, field);
    intents.push({
      type: 'set-attribute',
      scope: draft.scope,
      id: draft.id,
      path: [key],
      value: next[key],
    });
  }
  const invalid = validateAttributes(next, schema, {
    scope: draft.scope,
    elementId: draft.id,
  }).find((diagnostic) => diagnostic.blocking);
  if (invalid) throw new Error(`${invalid.path.join('.')}: ${invalid.message}`);
  return intents;
}
