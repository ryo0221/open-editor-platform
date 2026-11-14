/**
 * CS1 (docs/cad/construction-site.md): the 4D schedule of one building. A separate artifact that
 * fixes one BIM version (CS-U1) and says when each of its elements is built, removed or stands as
 * temporary works. Pure data: no React, no kernel.
 */

import type { ConstructionSite } from './site';

export const CONSTRUCTION_SCHEMA = 1;

/** What a task does to its elements. */
export type ConstructionAction =
  /** Absent before the task starts, being built while it runs, standing after it finishes. */
  | 'construct'
  /** Standing before the task starts, being removed while it runs, gone after it finishes. */
  | 'remove'
  /** Standing only while the task runs (scaffolding, shoring): absent before and after. */
  | 'temporary';
export const constructionActions: readonly ConstructionAction[] = Object.freeze([
  'construct',
  'remove',
  'temporary',
]);

/** Finish-to-start: the task starts `lagDays` working days after `taskId` finishes. */
export interface ConstructionLink {
  taskId: string;
  lagDays: number;
}

/** What happened on site, typed in by hand (CS-U7). Each part is optional. */
export interface ConstructionActual {
  /** YYYY-MM-DD. */
  start?: string;
  /** YYYY-MM-DD, not before `start`. */
  finish?: string;
  /** 0–100. */
  percent?: number;
}

export interface ConstructionTask {
  id: string;
  name: string;
  /** Working days; 0 is a milestone. */
  durationDays: number;
  predecessors: ConstructionLink[];
  action: ConstructionAction;
  /** IDs of elements of the source BIM version. */
  elementIds: string[];
  actual?: ConstructionActual;
}

/** Which days are worked. */
export interface ConstructionCalendar {
  /** Days of the week worked, 0 = Sunday … 6 = Saturday, ascending, at least one. */
  workWeekdays: number[];
  /** Days off (YYYY-MM-DD, ascending, no repeats). */
  holidays: string[];
}

export interface ConstructionDocument {
  schemaVersion: typeof CONSTRUCTION_SCHEMA;
  name: string;
  /** One BIM version, fixed by version and content hash. */
  source: { artifactId: string; versionId: string; contentHash: string };
  /** The first day work may start (YYYY-MM-DD). */
  startDate: string;
  calendar: ConstructionCalendar;
  tasks: ConstructionTask[];
  /** IDs of removed tasks: never given to a new task of this document. */
  retiredIds?: string[];
  /** CS2: the site around the building (boundary, ground, earthworks, temporary works). */
  site?: ConstructionSite;
}

export const constructionLimits = Object.freeze({
  tasks: 2000,
  elementsPerTask: 1000,
  predecessors: 50,
  holidays: 1000,
  durationDays: 3650,
  lagDays: 3650,
  idCodePoints: 128,
  nameCodePoints: 256,
  retiredIds: 10000,
  jsonDepth: 16,
  /** Dates are kept between these years. */
  minYear: 1900,
  maxYear: 2200,
  /** CSV import: bytes and rows. */
  csvBytes: 2 * 1024 * 1024,
});

export interface ConstructionDiagnostic {
  code: string;
  path: string;
  message: string;
}

export class ConstructionValidationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly diagnostics: ConstructionDiagnostic[] = [],
  ) {
    super(message);
    this.name = 'ConstructionValidationError';
  }
}

/** Monday to Saturday, no holidays: a common Japanese site week. */
export const defaultConstructionCalendar = (): ConstructionCalendar => ({
  workWeekdays: [1, 2, 3, 4, 5, 6],
  holidays: [],
});

export function newConstruction(
  name: string,
  source: ConstructionDocument['source'],
  startDate: string,
): ConstructionDocument {
  return {
    schemaVersion: CONSTRUCTION_SCHEMA,
    name,
    source: { ...source },
    startDate,
    calendar: defaultConstructionCalendar(),
    tasks: [],
  };
}
