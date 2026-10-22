/** Host ports for Schedule (docs/schedule/editor-host-contract.md). Types and pure helpers only.
 * The Host resolves principals, permissions and providers; handles are not proof of permission. */
import { canonicalJson } from '@editor-platform/artifact-core';
import type {
  EmbeddedReference,
  ReferenceSource,
  ReferenceStatus,
} from '@editor-platform/artifact-references';
import type { ConferencePreference, EventTime, ScheduleEvent } from './model';

/** One Data record placed on the shared day axis. Dates are inclusive calendar days. */
export interface ScheduleLaneItem {
  rowId: string;
  label: string;
  startDate: string;
  endDate: string;
  group?: string;
  milestone?: boolean;
}
export interface ScheduleLaneState {
  status: ReferenceStatus;
  message?: string;
  label?: string;
  /** The saved Data version shown, e.g. "v3". */
  version?: string;
  items: ScheduleLaneItem[];
  /** Records left out by the lane limit; never silently dropped. */
  hidden: number;
  /** Names of the records left out by the limit. A link to one of them still resolves. */
  hiddenLabels?: Record<string, string>;
  /** Names from the version the Schedule captured, for linked records that the shown version
   * no longer has. Lets the Editor say what went missing without guessing a replacement. */
  previousLabels?: Record<string, string>;
}
/** A lane whose records can be shown: read now, or a verified copy kept while offline. The
 * offline copy is shown with a warning; no other failure shows a snapshot. */
export const laneShown = (state: ScheduleLaneState | undefined): boolean =>
  state?.status === 'ready' || (state?.status === 'offline' && state.version !== undefined);
/** Host side of lanes, usually backed by the Artifact References resolver. */
export interface ScheduleLaneHost {
  options(): Promise<{ label: string; source: ReferenceSource }[]>;
  create(source: ReferenceSource, mode: EmbeddedReference['mode']): Promise<EmbeddedReference>;
  /** Pins the version the lane shows now, without reading the source again. */
  pin(reference: EmbeddedReference): EmbeddedReference;
  observe(references: EmbeddedReference[], onChange: () => void): () => void;
  state(reference: EmbeddedReference): ScheduleLaneState;
}
export const laneItemLimit = 200;
/** Why a write is refused while the Schedule is read-only; the Surface and Hosts say the same. */
export const readOnlyText = 'This Schedule is read-only.';

export interface ScheduleSourceInfo {
  /** Opaque Host handle for one connected calendar of the current principal. */
  handle: string;
  label: string;
  provider: string;
  account: string;
  /** busy: the Host can read only free/busy intervals for this source. */
  access: 'details' | 'busy';
}
/** One external event as the current principal may see it. Never stored in Schedule content. */
export interface OverlayEvent {
  id: string;
  sourceHandle: string;
  start: number;
  end: number;
  /** Calendar dates of an all-day event, end exclusive. Placed as dates, never through a zone. */
  allDay?: { startDate: string; endDate: string };
  /** Absent for busy-only sources. Plain text from an untrusted provider. */
  title?: string;
  notes?: string;
}
export interface OverlayRange {
  from: number;
  to: number;
}
export interface OverlayRead {
  sourceHandle: string;
  /** Connection generation; a read from an older generation is never shown. */
  generation: string;
  range: OverlayRange;
  /** false when a page failed, a limit was hit or access could not be confirmed. */
  complete: boolean;
  /** Ranges that were not read. They are unknown, not free. */
  missing: OverlayRange[];
  fetchedAt: number;
  events: OverlayEvent[];
}
export interface OverlayNotice {
  kind: 'changed' | 'revoked';
  sourceHandle?: string;
}
export interface ScheduleReadPort {
  listSources(signal: AbortSignal): Promise<ScheduleSourceInfo[]>;
  readRange(
    request: { sourceHandle: string; range: OverlayRange },
    signal: AbortSignal,
  ): Promise<OverlayRead>;
  /** Change or revocation signals only; never content or commands. */
  watch?(notify: (notice: OverlayNotice) => void): () => void;
}

/** What the Editor asks the Host to plan. Internal links are never part of an intent. */
export interface EffectIntent {
  kind: 'create-event';
  eventId: string;
  title: string;
  time: EventTime;
  conference: ConferencePreference;
  /** Only when the person chose to include the notes in the invitation. */
  notes?: string;
}
export interface PreparedPlan {
  handle: string;
  /** The Editor basis the Host froze into the plan. */
  basis: string;
  calendar: string;
  organizer: string;
  conference: string;
  /** Exactly what the Host will send, from the Host's stored plan. */
  sends: { label: string; value: string }[];
  notifies: string;
}
export type StepState =
  | 'prepared'
  | 'dispatching'
  | 'accepted'
  | 'failed-after-acceptance'
  | 'unknown'
  | 'verified'
  | 'rejected'
  | 'conflict'
  | 'cancelled-before-dispatch';
export interface OperationStep {
  id: string;
  label: string;
  state: StepState;
  detail?: string;
}
export interface OperationStatus {
  operation: string;
  steps: OperationStep[];
  /** Execution availability, separate from step states. */
  blocked?: 'revoked';
}
export interface ScheduleEffectPort {
  prepare(intent: EffectIntent, basis: string, signal: AbortSignal): Promise<PreparedPlan>;
  requestExecution(planHandle: string): Promise<OperationStatus>;
  getStatus(operation: string): Promise<OperationStatus>;
  cancelPending(operation: string): Promise<OperationStatus>;
}

/** Allowlisted fields only: no links, lanes, Host references or ids of other artifacts. */
export function effectIntent(event: ScheduleEvent, options: { includeNotes: boolean }) {
  const intent: EffectIntent = {
    kind: 'create-event',
    eventId: event.id,
    title: event.title,
    time: event.time,
    conference: event.conference,
  };
  if (options.includeNotes && event.notes) intent.notes = event.notes;
  return intent;
}
/** A plan is stale as soon as the planned fields of the event change. */
export const planBasis = (intent: EffectIntent) => canonicalJson(intent);

export type OperationSummary =
  | 'pending'
  | 'verified'
  | 'partial'
  | 'unknown'
  | 'rejected'
  | 'failed-after-acceptance'
  | 'cancelled'
  | 'conflict';
/** One word for the whole operation that never hides an unknown or partial step. */
export function summarizeOperation(steps: OperationStep[]): OperationSummary {
  const states = steps.map((s) => s.state);
  const done = states.filter((s) => s === 'verified' || s === 'accepted').length;
  if (states.includes('unknown')) return 'unknown';
  // A step still waiting or being sent means the operation is not over, whatever else failed.
  if (states.some((s) => s === 'prepared' || s === 'dispatching'))
    return done > 0 ? 'partial' : 'pending';
  if (states.length && states.every((s) => s === 'cancelled-before-dispatch')) return 'cancelled';
  if (states.length && states.every((s) => s === 'verified')) return 'verified';
  if (done > 0 && states.some((s) => s !== 'verified' && s !== 'accepted')) return 'partial';
  // The calendar accepted before failing, so something may remain: never report it as refused
  // or as a conflict that only needs a new plan.
  if (states.includes('failed-after-acceptance')) return 'failed-after-acceptance';
  // Nothing was applied: the calendar changed under the plan, so a new plan is the way on.
  if (states.includes('conflict')) return 'conflict';
  if (states.includes('rejected')) return 'rejected';
  return 'pending';
}
/** A step may be cancelled only if the Host can prove it was never sent. */
export const dispatched = (steps: OperationStep[]) =>
  steps.some((s) => !['prepared', 'cancelled-before-dispatch'].includes(s.state));

/** Untrusted provider text as plain, bounded text. Never rendered as HTML. */
export function plainExternalText(value: unknown, max = 2000): string {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
  return [...text].length > max ? [...text].slice(0, max).join('') + '…' : text;
}
