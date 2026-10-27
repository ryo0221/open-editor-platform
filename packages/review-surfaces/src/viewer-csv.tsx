import type { CSSProperties } from 'react';
import type { Region } from '@editor-platform/editor-core';
import { csvColumnWidths, type CsvRecord } from './csv';
import { SearchMarks } from './viewer-stage';
import { VirtualRows } from './virtual';

function rowSelection(region: Region | undefined, row: CsvRecord, extend: boolean): Region {
  const extending = extend && region?.type === 'lines';
  return {
    type: 'lines',
    start: extending ? Math.min(region.start, row.start) : row.start,
    end: extending ? Math.max(region.end, row.end) : row.end,
  };
}

/** CSV rows as a table; each row selects its source lines so annotations match the text view. */
export function CsvTableView({
  records,
  columns,
  query,
  targetLine,
  region,
  onChoose,
}: {
  records: CsvRecord[];
  columns: number;
  query: string;
  /** 0-based source line, as the text view and search use. */
  targetLine: number | undefined;
  region: Region | undefined;
  onChoose(region: Region): void;
}) {
  const focus =
    targetLine === undefined
      ? -1
      : records.findIndex((r) => r.start - 1 <= targetLine && targetLine <= r.end - 1);
  const style = {
    '--ep-csv-columns': `52px ${csvColumnWidths(records, columns)
      .map((w) => `${w}ch`)
      .join(' ')}`,
  } as CSSProperties;
  return (
    <div className="ep-text-view ep-csv-view" style={style}>
      <VirtualRows
        rows={records}
        rowKey={(r) => String(r.start)}
        focusIndex={focus < 0 ? undefined : focus}
        label="CSV table"
        render={(row, index) => {
          const selected =
            region?.type === 'lines' && row.start <= region.end && row.end >= region.start;
          return (
            <button
              className={`ep-csv-row ${index === 0 ? 'header' : ''} ${selected ? 'selected' : ''}`}
              aria-label={`CSV row ${index + 1}`}
              onClick={(e) => onChoose(rowSelection(region, row, e.shiftKey))}
            >
              <span className="ep-line-number">{row.start}</span>
              {Array.from({ length: columns }, (_, column) => (
                <span key={column} className="ep-csv-cell">
                  <SearchMarks text={row.cells[column] ?? ''} query={query} />
                </span>
              ))}
            </button>
          );
        }}
      />
    </div>
  );
}
