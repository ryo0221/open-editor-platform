import {
  evaluateExpression,
  parameterValues,
  parseExpression,
  type CadDocument,
  type CadExpression,
  type CadExprType,
} from '@editor-platform/cad-core';
import { describeCode } from './controller';

/** What an Inspector field holds: a plain number in the field's unit, or (schema 2) an expression. */
export type CadInputValue = { literal: number } | { expression: CadExpression };

const typeNames: Record<CadExprType, string> = {
  length: '長さ（mm・cm・m・in）',
  angle: '角度（deg・rad）',
  scalar: '単位のない数',
};
const plainNumber = /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;

/** Parameter IDs by name; `null` when two parameters share the name. */
export const parameterLookup = (doc: CadDocument) => (name: string) => {
  const hits = doc.parameters.filter((p) => p.name === name);
  return hits.length === 1 ? hits[0].id : hits.length ? null : undefined;
};

/**
 * Reads a committed field (never while an IME composes: CommitInput only commits after it).
 * A plain number stays a literal. Anything else must be an expression of `type` over the
 * document's parameters. Throws a message for the field, with the
 * character position of a parse error, and changes nothing.
 */
export function readCadInput(text: string, doc: CadDocument, type: CadExprType): CadInputValue {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('数か式を入力してください。');
  if (plainNumber.test(trimmed)) return { literal: Number(trimmed) };
  const parsed = parseExpression(text, parameterLookup(doc));
  if ('error' in parsed) {
    const { code, at } = parsed.error;
    const where = `${at + 1}文字目`;
    const reason =
      code === 'expression-name-unknown'
        ? 'その名前のparameterはありません'
        : code === 'expression-name-ambiguous'
          ? '同じ名前のparameterが複数あります。名前を変えてください'
          : '式として読めません';
    throw new Error(`${reason}（${where}）。`);
  }
  let result;
  try {
    result = evaluateExpression(parsed.expression, parameterValues(doc));
  } catch (e) {
    throw new Error(describeCode((e as Error).message));
  }
  if (result.type !== type) throw new Error(`この欄には${typeNames[type]}の式を入れてください。`);
  return { expression: parsed.expression };
}
