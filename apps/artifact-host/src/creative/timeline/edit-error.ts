/** Story Timeline T2: the shared shape of a refused edit and of a row to write. */
import type { TimelineCell } from './table';

/** A refused timeline edit. The message is for the author; nothing was changed. */
export class TimelineEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimelineEditError';
  }
}

export type TimelineCells = Record<string, TimelineCell | null | undefined>;
export interface TimelineRowInput {
  id: string;
  /** tl1 cells. A null or missing value is an empty cell: its key is left out (§2.2). */
  values: TimelineCells;
}
