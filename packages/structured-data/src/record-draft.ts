import { canonicalJson, clone } from '@editor-platform/artifact-core';
import { withCommandReads, type EditorCommand } from '@editor-platform/editor-core';
import { displayCell, parseCell, validateData, type StructuredData } from './model';
import { setCells } from './views';
export interface RecordDraft {
  base: string;
  values: Record<string, string>;
  columns?: string;
  baseline?: Record<string, string>;
  composing?: boolean;
}
export class RecordDraftError extends Error {
  constructor(
    public rowId: string,
    message: string,
  ) {
    super(message);
  }
}
/** Preflight every retained Form draft and submit the batch as one Data command. */
export function prepareRecordDrafts(
  data: StructuredData,
  drafts: ReadonlyMap<string, RecordDraft>,
): EditorCommand<StructuredData> {
  const columns = canonicalJson(data.columns);
  const fixed = new Map([...drafts].map(([id, draft]) => [id, clone(draft)]));
  const cells: Parameters<typeof setCells>[0] = [];
  for (const [id, draft] of fixed) {
    const row = data.rows.find((row) => row.id === id);
    if (draft.composing) throw new RecordDraftError(id, '入力変換を確定してください。');
    if (!row || canonicalJson(row) !== draft.base || (draft.columns && draft.columns !== columns))
      throw new RecordDraftError(
        id,
        'レコードまたは定義が変更されています。入力を保持して現在値を確認してください。',
      );
    for (const column of data.columns) {
      if (column.type === 'formula' || column.readOnly) continue;
      const value = parseCell(draft.values[column.id] ?? displayCell(data, row, column), column);
      if (canonicalJson(value) !== canonicalJson(row.values[column.id] ?? null))
        cells.push({ rowId: id, columnId: column.id, value });
    }
  }
  const edit = setCells(cells, 'Save pending records');
  const next = {
    ...data,
    rows: data.rows.map((row) => ({
      ...row,
      values: {
        ...row.values,
        ...Object.fromEntries(
          cells.filter((cell) => cell.rowId === row.id).map((cell) => [cell.columnId, cell.value]),
        ),
      },
    })),
  };
  const invalid = validateData(next).find((error) => fixed.has(error.rowId));
  if (invalid)
    throw new RecordDraftError(
      invalid.rowId,
      `${data.columns.find((column) => column.id === invalid.columnId)?.name}: ${invalid.message}`,
    );
  return withCommandReads(
    {
      ...edit,
      apply(current) {
        if (
          canonicalJson(current.columns) !== columns ||
          [...fixed].some(
            ([id, draft]) =>
              canonicalJson(current.rows.find((row) => row.id === id)) !== draft.base,
          )
        )
          throw new Error('レコードまたは定義が変更されました。保存を再試行してください。');
        return edit.apply(current);
      },
    },
    { content: [...fixed.keys()] },
  );
}
