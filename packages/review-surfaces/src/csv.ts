export interface CsvRecord {
  cells: string[];
  /** 1-based source lines, so a row selection anchors the same lines as the text view. */
  start: number;
  end: number;
}

/** RFC 4180 records: quoted cells may hold commas, line breaks and doubled quotes. */
export function parseCsv(text: string): { records: CsvRecord[]; columns: number } {
  const records: CsvRecord[] = [];
  let cells: string[] = [],
    cell = '',
    quoted = false,
    line = 1,
    start = 1,
    started = false,
    columns = 0;
  const endRecord = () => {
    cells.push(cell.endsWith('\r') ? cell.slice(0, -1) : cell);
    records.push({ cells, start, end: line });
    columns = Math.max(columns, cells.length);
    cells = [];
    cell = '';
    started = false;
  };
  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < text.length; i++) {
    const c = text[i];
    // A record exists once any of its characters is read, even if every cell decodes empty.
    if (c !== '\n') started = true;
    if (quoted) {
      if (c !== '"') {
        if (c === '\n') line++;
        cell += c;
      } else if (text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = false;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === ',') {
      cells.push(cell);
      cell = '';
    } else if (c === '\n') {
      endRecord();
      start = ++line;
    } else cell += c;
  }
  if (started) endRecord();
  return { records, columns };
}

/** 0-based source lines of the records whose decoded cells contain the search, as shown. */
export function csvMatches(records: CsvRecord[], query: string) {
  const needle = query.toLocaleLowerCase();
  return needle
    ? records
        .filter((r) => r.cells.some((c) => c.toLocaleLowerCase().includes(needle)))
        .map((r) => r.start - 1)
    : [];
}

/** One width per column for every row, so long values wrap instead of shifting the columns. */
export function csvColumnWidths(records: CsvRecord[], columns: number) {
  const widths = Array.from({ length: columns }, () => 6);
  for (const record of records)
    record.cells.forEach((cell, i) => {
      for (const line of cell.split('\n')) widths[i] = Math.max(widths[i], line.length + 2);
    });
  return widths.map((w) => Math.min(w, 48));
}

export function isCsv(mime: string, name: string) {
  return mime === 'text/csv' || /\.csv$/i.test(name);
}
