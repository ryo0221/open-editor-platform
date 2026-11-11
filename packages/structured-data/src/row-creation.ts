import { canonicalJson, clone } from '@editor-platform/artifact-core';
import { command, type EditorCommand } from '@editor-platform/editor-core';
import { isStructuredData, validateData, type DataRow, type StructuredData } from './model';

/** Trusted Host state, not an authorization payload accepted from imported content. */
export interface DataRowCreationSource {
  datasetId: string;
  revision: string;
  content: StructuredData;
  readOnly: boolean;
  initialReadOnlyColumns: readonly string[];
}

const creations = new WeakMap<
  EditorCommand<StructuredData>,
  {
    checkTarget: (target: DataRowCreationSource | undefined) => void;
    check: (current: StructuredData, next?: StructuredData) => void;
    permits: (rowId: string, columnId: string) => boolean;
  }
>();

/** Create exactly these new records; no schema, existing-record or formula privilege. */
export function createDataRows(
  rows: readonly DataRow[],
  read: () => DataRowCreationSource,
): EditorCommand<StructuredData> {
  const source = clone(read()),
    base = canonicalJson(source),
    added = clone([...rows]);
  if (source.readOnly) throw new Error('Data is read only');
  if (!source.datasetId || !source.revision || !isStructuredData(source.content))
    throw new Error('Expected a revision-bound Data dataset');
  const allowed = new Set(source.initialReadOnlyColumns);
  for (const id of allowed) {
    const column = source.content.columns.find((c) => c.id === id);
    if (!column?.readOnly || column.type === 'formula')
      throw new Error('Creation may initialize only declared read-only fields');
  }
  const ids = new Set(source.content.rows.map((r) => r.id));
  if (!added.length) throw new Error('Choose at least one new record');
  for (const row of added) {
    if (!row.id || ids.has(row.id)) throw new Error('New record IDs must be unique');
    ids.add(row.id);
    for (const id of Object.keys(row.values)) {
      const column = source.content.columns.find((c) => c.id === id);
      if (!column || column.type === 'formula') throw new Error('Unknown or computed field');
    }
  }
  const result = { ...source.content, rows: [...source.content.rows, ...added] };
  if (!isStructuredData(result)) throw new Error('Invalid Data records');
  const errors = validateData(result, added);
  if (errors.length) throw new Error(errors[0].message);
  const check = (current: StructuredData, next?: StructuredData) => {
    const latest = read();
    if (latest.readOnly) throw new Error('Data is read only');
    if (canonicalJson(latest) !== base || canonicalJson(current) !== canonicalJson(source.content))
      throw new Error('Record creation is stale; dataset, schema, revision or policy changed');
    if (next !== undefined && canonicalJson(next) !== canonicalJson(result))
      throw new Error('Creation must insert exactly the verified records');
  };
  const cmd = Object.freeze(
    command<StructuredData>('data.create-records', 'Create records', (current) => {
      check(current);
      return clone(result);
    }),
  );
  creations.set(cmd, {
    check,
    checkTarget: (target) => {
      if (!target || canonicalJson(target) !== base)
        throw new Error('Record creation is stale; execution target does not match');
    },
    permits: (row, column) => added.some((r) => r.id === row) && allowed.has(column),
  });
  return cmd;
}

export const rowCreationIntent = (cmd: EditorCommand<StructuredData>) => creations.get(cmd);
export function retainRowCreation(
  source: EditorCommand<StructuredData>,
  target: EditorCommand<StructuredData>,
) {
  const intent = creations.get(source);
  if (intent) creations.set(target, intent);
}
