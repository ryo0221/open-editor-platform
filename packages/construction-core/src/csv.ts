import {
  constructionActions,
  constructionLimits,
  type ConstructionAction,
  type ConstructionActual,
  type ConstructionDiagnostic,
  type ConstructionTask,
} from './model';

/** RFC 4180 rows: quoted fields may hold commas, quotes ("") and line breaks. */
export function parseCsvRows(text: string): string[][] | { error: string; line: number } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  /** A quoted field just closed: only a separator or the end may follow. */
  let closed = false;
  let line = 1;
  let opened = 1;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else {
        if (ch === '\n') line++;
        field += ch;
      }
      continue;
    }
    if (closed && ch !== ',' && ch !== '\n' && ch !== '\r')
      return { error: 'characters after a quoted field', line };
    closed = false;
    if (ch === '"') {
      if (field !== '') return { error: 'a quote inside an unquoted field', line };
      quoted = true;
      opened = line;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      line++;
    } else field += ch;
  }
  if (quoted) return { error: 'a quoted field is not closed', line: opened };
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0]!.trim() === ''));
}

/** The columns of a task CSV; `id`, `name` and `duration` are required. */
export const constructionCsvColumns = [
  'id',
  'name',
  'duration',
  'predecessors',
  'action',
  'elements',
  'actual_start',
  'actual_finish',
  'percent',
] as const;

export interface ConstructionCsvResult {
  tasks: ConstructionTask[];
  /** Problems by line (path `line N`); with any, the import is refused as a whole. */
  diagnostics: ConstructionDiagnostic[];
}

/**
 * Reads tasks from CSV text with a header row (column order free, names as in
 * `constructionCsvColumns`, case ignored):
 * - `predecessors`: task IDs separated by `;`, each optionally with a lag in working days in brackets, `t1;t2(3);t4(-1)`
 * - `action`: `construct` (default), `remove` or `temporary`
 * - `elements`: BIM element IDs separated by `;`
 * - `actual_start`, `actual_finish` (YYYY-MM-DD) and `percent` (0–100): progress typed in on site
 * The tasks are checked as a document would check them only when they replace a document's tasks.
 */
export function readConstructionCsv(text: string): ConstructionCsvResult {
  const diagnostics: ConstructionDiagnostic[] = [];
  const bad = (line: number, code: string, message: string) =>
    diagnostics.push({ code, path: `line ${line}`, message });
  if (new TextEncoder().encode(text).length > constructionLimits.csvBytes) {
    bad(1, 'limit-exceeded', `at most ${constructionLimits.csvBytes} bytes`);
    return { tasks: [], diagnostics };
  }
  const rows = parseCsvRows(text);
  if (!Array.isArray(rows)) {
    bad(rows.line, 'csv', rows.error);
    return { tasks: [], diagnostics };
  }
  const [header, ...body] = rows;
  if (!header) {
    bad(1, 'csv-header', 'no header row');
    return { tasks: [], diagnostics };
  }
  const col = new Map<string, number>();
  header.forEach((h, i) => {
    const name = h.trim().toLowerCase();
    if (!(constructionCsvColumns as readonly string[]).includes(name))
      bad(1, 'csv-header', `unknown column "${h}"`);
    else if (col.has(name)) bad(1, 'csv-header', `column "${h}" twice`);
    else col.set(name, i);
  });
  for (const req of ['id', 'name', 'duration'])
    if (!col.has(req)) bad(1, 'csv-header', `no "${req}" column`);
  if (diagnostics.length) return { tasks: [], diagnostics };
  if (body.length > constructionLimits.tasks) {
    bad(2, 'limit-exceeded', `at most ${constructionLimits.tasks} tasks`);
    return { tasks: [], diagnostics };
  }
  const list = (s: string) =>
    s
      .split(';')
      .map((x) => x.trim())
      .filter((x) => x !== '');
  const tasks = body.map((r, k): ConstructionTask => {
    const line = k + 2;
    const get = (name: string) => (col.has(name) ? (r[col.get(name)!] ?? '').trim() : '');
    if (r.length > header.length) bad(line, 'csv', 'more fields than columns');
    const duration = get('duration');
    if (!/^\d+$/.test(duration)) bad(line, 'duration', `duration "${duration}" is not whole days`);
    const action = (get('action') || 'construct') as ConstructionAction;
    if (!constructionActions.includes(action)) bad(line, 'action', `unknown action "${action}"`);
    const predecessors = list(get('predecessors')).map((p) => {
      const m = /^(.*?)\s*\(\s*([+-]?\d+)\s*\)$/.exec(p);
      const taskId = (m ? m[1]! : p).trim();
      if (!taskId) bad(line, 'link', `predecessor "${p}" has no task`);
      return { taskId, lagDays: m ? Number(m[2]) : 0 };
    });
    const actual: ConstructionActual = {};
    for (const [key, column] of [
      ['start', 'actual_start'],
      ['finish', 'actual_finish'],
    ] as const) {
      const v = get(column);
      if (!v) continue;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) bad(line, 'date', `${column} "${v}" is not YYYY-MM-DD`);
      actual[key] = v;
    }
    const percent = get('percent');
    if (percent) {
      if (!/^\d+(\.\d+)?$/.test(percent))
        bad(line, 'percent', `percent "${percent}" is not a number`);
      actual.percent = Number(percent);
    }
    return {
      id: get('id'),
      name: get('name'),
      durationDays: Number(duration),
      predecessors,
      action,
      elementIds: list(get('elements')),
      ...(Object.keys(actual).length ? { actual } : {}),
    };
  });
  return { tasks, diagnostics };
}

/**
 * The tasks as CSV, the same columns `readConstructionCsv` reads. Throws `csv-id` for an ID the
 * lists cannot hold (one with `;`, or a task ID ending in `)`).
 */
export function writeConstructionCsv(tasks: readonly ConstructionTask[]): string {
  for (const t of tasks)
    if (t.id.includes(';') || t.id.endsWith(')') || t.elementIds.some((e) => e.includes(';')))
      throw new Error('csv-id');
  const q = (s: string) =>
    /[",\r\n]/.test(s) || s.trim() !== s ? `"${s.replace(/"/g, '""')}"` : s;
  const lines = [constructionCsvColumns.join(',')];
  for (const t of tasks)
    lines.push(
      [
        t.id,
        t.name,
        String(t.durationDays),
        t.predecessors.map((l) => (l.lagDays ? `${l.taskId}(${l.lagDays})` : l.taskId)).join(';'),
        t.action,
        t.elementIds.join(';'),
        t.actual?.start ?? '',
        t.actual?.finish ?? '',
        t.actual?.percent === undefined ? '' : String(t.actual.percent),
      ]
        .map(q)
        .join(','),
    );
  return lines.join('\r\n') + '\r\n';
}
