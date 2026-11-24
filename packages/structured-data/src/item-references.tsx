import {
  ItemReferenceField,
  type ItemReferenceSurfaceProps,
} from '@editor-platform/artifact-references/item-react';
import type { EditorCommand } from '@editor-platform/editor-core';
import { setRowRefs, type DataRow, type StructuredData } from './model';
import { refField, rowReferenceEntries, rowReferenceIds } from './items';
import { setCells } from './views';

type Apply = (cmd: EditorCommand<StructuredData>) => boolean;

/** The reference fields of the selected record, with the Host's candidates, states and opening. */
export function DataItemReferences({
  data,
  row,
  readOnly,
  apply,
  itemReferences: ir,
}: {
  data: StructuredData;
  row: DataRow;
  readOnly: boolean;
  /** Applies a command from these fields (it keeps the selection evidence). */
  apply: Apply;
} & ItemReferenceSurfaceProps) {
  if (!ir) return null;
  const entries = rowReferenceEntries(data, row);
  if (!entries.length) return null;
  return (
    <>
      {entries.map((entry) => {
        const f = refField(entry);
        const column = f === undefined ? data.columns.find((c) => c.id === entry) : undefined;
        return (
          <ItemReferenceField
            key={`${row.id}:${entry}`}
            host={ir.host}
            ledger={ir.ledger}
            from={{ artifactId: ir.artifactId, elementId: row.id, field: entry }}
            label={column?.name ?? entry}
            ids={rowReferenceIds(row, entry)}
            multiple={f !== undefined}
            readOnly={readOnly || !!column?.readOnly}
            change={(next) =>
              apply(
                f !== undefined
                  ? setRowRefs(row.id, f, next)
                  : setCells(
                      [{ rowId: row.id, columnId: entry, value: next[0] ?? null }],
                      'Edit reference',
                    ),
              )
            }
          />
        );
      })}
    </>
  );
}
