/**
 * CS6b (docs/cad/construction-site.md): the checks of a schedule as one table (CSV), for a record
 * of what was found: the schedule and its building, the site, the cranes, the frame and the
 * traffic of a day.
 */
import type { ConstructionDiagnostic } from './model';
import type { Approach, LiftOverflow } from './traffic';

export type CheckArea = 'schedule' | 'site' | 'crane' | 'frame' | 'traffic';

export interface CheckRow {
  area: CheckArea;
  code: string;
  /** What it is about (a task, element, route or JSON path). */
  where: string;
  /** The day it is for (YYYY-MM-DD), or empty for the whole plan. */
  day: string;
  message: string;
}

export const checkCsvColumns = ['area', 'code', 'where', 'day', 'message'] as const;

/** Diagnostics as rows of one area. */
export const diagnosticRows = (
  area: CheckArea,
  diagnostics: readonly ConstructionDiagnostic[],
  day = '',
): CheckRow[] =>
  diagnostics.map((d) => ({ area, code: d.code, where: d.path, day, message: d.message }));

const hazardWords = {
  zone: 'the zone',
  load: 'under the load',
  slew: 'the slewing circle',
  edge: 'the edge',
} as const;

/** A day's approaches to danger as rows (`approach-<kind>`). */
export const approachRows = (approaches: readonly Approach[]): CheckRow[] =>
  approaches.map((a) => ({
    area: 'traffic',
    code: `approach-${a.hazardKind}`,
    where: a.routeId,
    day: a.day,
    message: `${a.from}–${a.to}: the trip from ${a.departure} comes ${
      a.closest ? `within ${(a.closest / 1000).toFixed(1)} m of` : 'into'
    } ${hazardWords[a.hazardKind]} (${a.hazardName})`,
  }));

/** Lifts that do not fit in their working day, one row each (`lift-past-day-end`). */
export const liftOverflowRows = (overflow: readonly LiftOverflow[]): CheckRow[] =>
  overflow.flatMap((o) =>
    o.liftIds.map((id) => ({
      area: 'traffic' as const,
      code: 'lift-past-day-end',
      where: id,
      day: o.day,
      message: 'the lift does not fit in the working day: its danger is not drawn',
    })),
  );

/**
 * The rows as RFC 4180 CSV with a header. A field that a spreadsheet would read as a formula
 * (starting with =, +, -, @, tab or CR) is written with a leading apostrophe.
 */
export function writeChecksCsv(rows: readonly CheckRow[]): string {
  const cell = (v: string) => {
    const s = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
    return /[",\r\n]/.test(s) || s.trim() !== s ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return (
    [
      checkCsvColumns.join(','),
      ...rows.map((r) => checkCsvColumns.map((c) => cell(r[c])).join(',')),
    ].join('\r\n') + '\r\n'
  );
}
