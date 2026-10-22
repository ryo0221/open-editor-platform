import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CommitInput, useEditorInput } from '@editor-platform/editor-ui';
import { addDays, utcDay } from '@editor-platform/time-axis';
import type { EditorCommand } from '@editor-platform/editor-core';
import { linkKey } from './view-model';
import {
  conferences,
  setConference,
  setEventTime,
  setRecordLinks,
  timedInstants,
  toggleAllDay,
  updateEventText,
  ScheduleError,
  type ConferencePreference,
  type EventTime,
  type RecordLink,
  type ScheduleDocument,
  type ScheduleEvent,
  type ScheduleLane,
} from './model';
import { knownZones, type Fold } from './zone';
import { laneShown, type ScheduleLaneState } from './host';

export const conferenceLabel: Record<ConferencePreference, string> = {
  none: 'None',
  meet: 'Google Meet',
  teams: 'Microsoft Teams',
  zoom: 'Zoom',
};
/** The Surface run: shows a refusal itself and returns false, so input guards keep text dirty. */
type Execute = (cmd: EditorCommand<ScheduleDocument>) => boolean;

function TimeForm({
  event,
  execute,
  readOnly,
  onError,
}: {
  event: ScheduleEvent;
  execute: Execute;
  readOnly: boolean;
  onError: (message: string) => void;
}) {
  const time = event.time;
  const initial =
    time.kind === 'allDay'
      ? { start: time.startDate, end: addDays(time.endDateExclusive, -1), zone: '' }
      : { start: time.startLocal, end: time.endLocal, zone: time.timeZone };
  const [start, setStart] = useState(initial.start);
  const [end, setEnd] = useState(initial.end);
  const [zone, setZone] = useState(initial.zone);
  // A saved disambiguation stays with its wall time; editing that time or the zone drops it.
  const stored: { start?: Fold | null; end?: Fold | null } =
    time.kind === 'timed'
      ? {
          ...(time.startFold ? { start: time.startFold } : {}),
          ...(time.endFold ? { end: time.endFold } : {}),
        }
      : {};
  const [folds, setFolds] = useState(stored);
  const key = JSON.stringify(time);
  useEffect(() => {
    setStart(initial.start);
    setEnd(initial.end);
    setZone(initial.zone);
    setFolds(stored);
    // Reset the private inputs only when the stored time changes.
    // initial is derived from key.
  }, [key]);
  function submit() {
    let next: EventTime;
    if (time.kind === 'allDay') {
      if (utcDay(start) === null || utcDay(end) === null) return onError('Choose valid dates');
      next = { kind: 'allDay', startDate: start, endDateExclusive: addDays(end, 1) };
    } else {
      next = {
        kind: 'timed',
        startLocal: start,
        endLocal: end,
        timeZone: zone,
        ...(folds.start ? { startFold: folds.start } : {}),
        ...(folds.end ? { endFold: folds.end } : {}),
      };
      try {
        timedInstants(next);
      } catch (error) {
        const message = (error as Error).message;
        if (error instanceof ScheduleError && error.code === 'ambiguous-time' && error.field) {
          const which = error.field;
          setFolds((f) => ({ ...f, [which]: f[which] ?? null }));
        }
        return onError(message);
      }
    }
    execute(setEventTime(event.id, next));
  }
  const fold = (which: 'start' | 'end') =>
    folds[which] !== undefined && (
      <fieldset className="ep-schedule-fold">
        <legend>The {which} time occurs twice. Which one?</legend>
        {(['earlier', 'later'] as const).map((value) => (
          <label key={value}>
            <input
              type="radio"
              name={`fold-${which}`}
              checked={folds[which] === value}
              onChange={() => setFolds((f) => ({ ...f, [which]: value }))}
            />
            {value === 'earlier'
              ? 'Earlier (before the clock change)'
              : 'Later (after the clock change)'}
          </label>
        ))}
      </fieldset>
    );
  return (
    <form
      className="ep-schedule-time"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label>
        {time.kind === 'allDay' ? 'Start date' : 'Start'}
        <input
          type={time.kind === 'allDay' ? 'date' : 'datetime-local'}
          aria-label={time.kind === 'allDay' ? 'Start date' : 'Start time'}
          value={start}
          disabled={readOnly}
          onChange={(e) => {
            setStart(e.target.value);
            // A fold chosen for the old wall time does not carry over to a new one.
            setFolds((f) => ({ ...f, start: undefined }));
          }}
        />
      </label>
      {fold('start')}
      <label>
        {time.kind === 'allDay' ? 'Last day' : 'End'}
        <input
          type={time.kind === 'allDay' ? 'date' : 'datetime-local'}
          aria-label={time.kind === 'allDay' ? 'Last day' : 'End time'}
          value={end}
          disabled={readOnly}
          onChange={(e) => {
            setEnd(e.target.value);
            setFolds((f) => ({ ...f, end: undefined }));
          }}
        />
      </label>
      {fold('end')}
      {time.kind === 'timed' && (
        <label>
          Time zone
          <select
            aria-label="Event time zone"
            value={zone}
            disabled={readOnly}
            onChange={(e) => {
              setZone(e.target.value);
              setFolds({});
            }}
          >
            {[...new Set([zone, ...knownZones()])].map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
        </label>
      )}
      <button disabled={readOnly}>Apply time</button>
    </form>
  );
}

function NotesInput({
  value,
  readOnly,
  onCommit,
}: {
  value: string;
  readOnly: boolean;
  /** false when the command was refused; the draft stays dirty so save and switch stay blocked. */
  onCommit: (value: string) => boolean;
}) {
  const [draft, setDraft] = useState(value);
  const [composing, setComposing] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  // Follow a new stored value (Undo, a remote change) only while nothing is pending here: a refused
  // or composing draft stays until it is committed or replaced by the person.
  const [observed, setObserved] = useState(value);
  if (observed !== value) {
    setObserved(value);
    if (draft === observed && !composing) setDraft(value);
  }
  // Save, export and shortcuts flush this buffer first; composition blocks them instead.
  useEditorInput({
    label: 'Event notes',
    read: () => ({ dirty: draft !== value, composing }),
    prepare: () => () => (draft !== value ? onCommit(draft) : undefined),
    focus: () => area.current?.focus(),
  });
  return (
    <label>
      Notes
      <textarea
        ref={area}
        aria-label="Event notes"
        value={draft}
        readOnly={readOnly}
        rows={3}
        onChange={(e) => setDraft(e.target.value)}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
        onBlur={() => {
          if (!composing && draft !== value) onCommit(draft);
        }}
      />
    </label>
  );
}

/** Lanes with more records than this start folded; search or open a lane to find the rest. */
const openLaneLimit = 12;
export function RelatedWork({
  event,
  lanes,
  states,
  execute,
  readOnly,
}: {
  event: ScheduleEvent;
  lanes: ScheduleLane[];
  states: Map<string, ScheduleLaneState>;
  execute: Execute;
  readOnly: boolean;
}) {
  const [query, setQuery] = useState('');
  const same = (a: RecordLink, b: RecordLink) => a.laneId === b.laneId && a.rowId === b.rowId;
  const linked = (link: RecordLink) => event.links.some((l) => same(l, link));
  const set = (links: RecordLink[]) => execute(setRecordLinks(event.id, links));
  const toggle = (link: RecordLink, on: boolean) =>
    set(on ? [...event.links, link] : event.links.filter((l) => !same(l, link)));
  if (!lanes.length) return <p className="ep-schedule-muted">Add a lane to relate work.</p>;
  const laneName = (laneId: string) => states.get(laneId)?.label ?? 'Lane';
  const total = lanes.reduce((n, lane) => n + (states.get(lane.id)?.items.length ?? 0), 0);
  const needle = query.trim().toLocaleLowerCase();
  const check = (link: RecordLink, label: string, extra?: string) => (
    <label key={linkKey(link.laneId, link.rowId)} className="ep-schedule-check">
      <input
        type="checkbox"
        disabled={readOnly}
        checked={linked(link)}
        onChange={(e) => toggle(link, e.target.checked)}
      />
      <span>
        {label}
        {extra && <span className="ep-schedule-lane-name">{extra}</span>}
      </span>
    </label>
  );
  return (
    <>
      {event.links.length > 0 && (
        <div className="ep-schedule-linked-list" aria-label="Linked work">
          {event.links.map((link) => {
            const state = states.get(link.laneId);
            const item = state?.items.find((i) => i.rowId === link.rowId);
            if (item) return check(link, item.label, laneName(link.laneId));
            // Beyond the lane limit is still in this version: linked, just not drawn as a bar.
            const beyond = state?.hiddenLabels?.[link.rowId];
            if (beyond !== undefined)
              return check(link, beyond, `${laneName(link.laneId)} (not shown in the lane)`);
            // `!state` narrows the type; laneShown itself already treats undefined as not shown.
            if (!state || !laneShown(state))
              return (
                <p key={linkKey(link.laneId, link.rowId)} className="ep-schedule-muted">
                  {state?.previousLabels?.[link.rowId] ?? link.rowId} · {laneName(link.laneId)}{' '}
                  (lane unavailable)
                </p>
              );
            const name = state.previousLabels?.[link.rowId];
            return (
              <p key={linkKey(link.laneId, link.rowId)} className="ep-schedule-warning">
                Related record not found: {name ? `“${name}”` : link.rowId} is not in{' '}
                {laneName(link.laneId)} {state.version ?? ''}.{' '}
                <button type="button" disabled={readOnly} onClick={() => toggle(link, false)}>
                  Remove link
                </button>
              </p>
            );
          })}
        </div>
      )}
      {total > openLaneLimit && (
        <input
          type="search"
          className="ep-schedule-search"
          aria-label="Find related work"
          placeholder="Find related work"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}
      {needle ? (
        <div className="ep-schedule-related">
          {lanes
            .flatMap((lane) =>
              (states.get(lane.id)?.items ?? [])
                .filter(
                  (item) =>
                    !linked({ laneId: lane.id, rowId: item.rowId }) &&
                    item.label.toLocaleLowerCase().includes(needle),
                )
                .map((item) =>
                  check({ laneId: lane.id, rowId: item.rowId }, item.label, laneName(lane.id)),
                ),
            )
            .slice(0, 50)}
        </div>
      ) : (
        lanes.map((lane) => {
          const state = states.get(lane.id);
          return (
            <details
              key={lane.id}
              className="ep-schedule-related"
              open={total <= openLaneLimit || undefined}
            >
              <summary>
                {laneName(lane.id)}
                {state && laneShown(state) && (
                  <span className="ep-schedule-muted"> · {state.items.length}</span>
                )}
              </summary>
              {!state || !laneShown(state) ? (
                <p className="ep-schedule-muted">
                  Lane unavailable{state?.message ? `: ${state.message}` : ''}
                </p>
              ) : (
                state.items
                  .filter((item) => !linked({ laneId: lane.id, rowId: item.rowId }))
                  .map((item) => check({ laneId: lane.id, rowId: item.rowId }, item.label))
              )}
            </details>
          );
        })
      )}
    </>
  );
}

export function EventDetails({
  event,
  content,
  execute,
  readOnly,
  laneStates,
  renderRelated,
  actions,
  footer,
  onClose,
  onError,
}: {
  event: ScheduleEvent;
  content: ScheduleDocument;
  execute: Execute;
  readOnly: boolean;
  laneStates: Map<string, ScheduleLaneState>;
  renderRelated?: (eventId: string) => ReactNode;
  actions: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const panel = useRef<HTMLElement>(null);
  // Move focus into the details when they open; Escape returns it to the event.
  useEffect(() => {
    panel.current?.scrollIntoView?.({ block: 'nearest' });
    panel.current?.querySelector<HTMLInputElement>('input')?.focus();
  }, []);
  return (
    <aside
      ref={panel}
      className="ep-schedule-details"
      aria-label="Event details"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <header>
        <h2>Event details</h2>
        <button type="button" onClick={onClose}>
          Close details
        </button>
      </header>
      {readOnly ? (
        // Read-only shows the title without a buffer that could never be committed.
        <label className="ep-field">
          Event title
          <input aria-label="Event title" value={event.title} readOnly />
        </label>
      ) : (
        <CommitInput
          label="Event title"
          value={event.title}
          onCommit={(value) => execute(updateEventText(event.id, { title: value }))}
        />
      )}
      <NotesInput
        value={event.notes}
        readOnly={readOnly}
        onCommit={(notes) => execute(updateEventText(event.id, { notes }))}
      />
      <label className="ep-schedule-check">
        <input
          type="checkbox"
          checked={event.time.kind === 'allDay'}
          disabled={readOnly}
          onChange={() =>
            execute(setEventTime(event.id, toggleAllDay(event.time, content.timeZone)))
          }
        />
        All day
      </label>
      <TimeForm event={event} execute={execute} readOnly={readOnly} onError={onError} />
      {event.time.kind === 'timed' && (
        <p className="ep-schedule-muted">
          Stored as {event.time.timeZone} wall time. Changing the display zone does not move it.
        </p>
      )}
      <label>
        Meeting
        <select
          aria-label="Meeting"
          value={event.conference}
          disabled={readOnly}
          onChange={(e) => execute(setConference(event.id, e.target.value as ConferencePreference))}
        >
          {conferences.map((c) => (
            <option key={c} value={c}>
              {conferenceLabel[c]}
            </option>
          ))}
        </select>
      </label>
      <section aria-label="Related work">
        <h3>Related work</h3>
        <RelatedWork
          event={event}
          lanes={content.lanes}
          states={laneStates}
          execute={execute}
          readOnly={readOnly}
        />
      </section>
      {renderRelated && (
        <section aria-label="Project links" className="ep-schedule-host-slot">
          <h3>Project links</h3>
          <p className="ep-schedule-muted">Kept by the Host, not saved in this Schedule.</p>
          {renderRelated(event.id)}
        </section>
      )}
      <div className="ep-schedule-actions">{actions}</div>
      {footer}
    </aside>
  );
}
