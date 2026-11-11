import type { EditorHostAdapter } from '@editor-platform/editor-host';
import { isStructuredData, validateData, cellValue, type StructuredData } from './model';

/** Row evaluation belongs to Data; no generic text-writing capability is declared. */
export const dataHostAdapter: EditorHostAdapter<StructuredData> = {
  kind: 'data',
  validate: isStructuredData,
  capabilities: {
    proposals: false,
    undo: true,
    nativeJson: true,
    formats: [],
    preview: 'none',
    shared: false,
  },
  native: {
    read(content, selector) {
      const matches = content.rows.filter((row) => row.id === selector);
      if (!matches.length) return null;
      if (matches.length !== 1) throw new Error('Ambiguous Data row');
      const row = matches[0];
      if (validateData(content, [row]).length) throw new Error('Data row evaluation failed');
      return {
        row,
        columns: content.columns,
        values: Object.fromEntries(
          content.columns.map((column) => [column.id, cellValue(content, row, column)]),
        ),
      };
    },
  },
};
