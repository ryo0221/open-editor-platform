import './styles.css';
import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Copy,
  Eye,
  List,
  Plus,
  Rows3,
  Send,
  Trash2,
} from 'lucide-react';
import { flushSync } from 'react-dom';
import { EditorInputsContext, IconButton, Toolbar } from '@editor-platform/editor-ui';
import type { EditorCommand } from '@editor-platform/editor-core';
import {
  dayString,
  dragDays,
  spanPlacement,
  utcDay,
  type AxisRange,
} from '@editor-platform/time-axis';
import {
  createEvent,
  duplicateEvent,
  removeEvent,
  setEventTime,
  shiftTime,
  type ScheduleDocument,
  type ScheduleEvent,
} from './model';
import {
  plainExternalText,
  readOnlyText,
  type ScheduleEffectPort,
  type ScheduleLaneHost,
  type ScheduleReadPort,
} from './host';
import { canonicalZone, timeLabel } from './zone';
import { ZoneInput } from './zone-input';
import {
  dayLabel,
  displayedTime,
  linkKey,
  placeEvents,
  placeOverlay,
  rangeLabel,
  unknownDays,
  weekDays,
  weekRange,
  type PlacedEvent,
  type PlacedOverlay,
  wallDate,
} from './view-model';
import { useOverlay } from './overlay';
import { AddLaneDialog, LaneRows, laneDialogPlace, useLaneStates } from './lanes';
import { EventDetails } from './details';
import { ApplyDialog } from './apply';
import { applyTransition, idleApply, type ApplyAction, type ApplyState } from './apply-state';
import { newId } from '@editor-platform/artifact-core';

export interface ScheduleSurfaceProps {
  content: ScheduleDocument;
  /** Runs a command through the Host's session; returns false when the Host refused it. */
  execute: (cmd: EditorCommand<ScheduleDocument>) => boolean;
  readOnly: boolean;
  select?: (ids: string[]) => void;
  selectedId?: string;
  /** A Host reveal request, such as a comment jump: each new object shows that event's week. */
  focusAddress?: { elementId?: string };
  /** Data lanes through Artifact References. Omit to hide lane controls. */
  lanes?: ScheduleLaneHost;
  /** Personal calendar overlay. Omit to hide it. */
  read?: ScheduleReadPort;
  /** External effects. Omit to hide "Apply to calendar". */
  effects?: ScheduleEffectPort;
  /** Host-owned links (projects, threads). Rendered as given; never saved in content. */
  renderRelated?: (eventId: string) => ReactNode;
  /** Any date in the first week to show. Private view state. */
  initialDate?: string;
  /** Initial display zone. Private view state; defaults to the Schedule's zone. */
  displayTimeZone?: string;
}

/** Today's date where the person is looking: the display zone, not UTC. */
const todayIso = (zone: string) => wallDate(Date.now(), zone);
const NARROW = 640;

function useNarrow() {
  const ref = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => setNarrow(element.getBoundingClientRect().width < NARROW);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, narrow] as const;
}

interface Drag {
  id: string;
  pointer: number;
  x: number;
  width: number;
  days: number;
}

// Memoized: a drag or selection change re-renders only the cards it touches, not every event.
const EventCard = memo(function EventCard({
  placed,
  selected,
  readOnly,
  range,
  onOpen,
  onShift,
  drag,
  setDrag,
}: {
  placed: PlacedEvent;
  selected: boolean;
  readOnly: boolean;
  range: AxisRange;
  onOpen: (id: string) => void;
  onShift: (event: ScheduleEvent, days: number, minutes: number) => void;
  /** The drag in progress, given only to the card being dragged. */
  drag: Drag | null;
  setDrag: (drag: Drag | null) => void;
}) {
  const { event } = placed;
  const moving = drag?.id === event.id ? drag.days : 0;
  // One day is one column of the week, whatever the card's own width (a multi-day card is wider).
  const dayWidth = drag ? drag.width / (range.end - range.start + 1) : 0;
  return (
    <button
      type="button"
      data-event-id={event.id}
      className={`ep-schedule-event${selected ? ' ep-schedule-selected' : ''}${placed.problem ? ' ep-schedule-problem' : ''}`}
      aria-label={`${event.title}, ${placed.label}`}
      aria-pressed={selected}
      title={placed.problem}
      style={moving ? { transform: `translateX(${moving * dayWidth}px)` } : undefined}
      onClick={() => onOpen(event.id)}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && drag) {
          e.preventDefault();
          setDrag(null);
          return;
        }
        if (readOnly) return;
        const step = {
          ArrowLeft: [-1, 0],
          ArrowRight: [1, 0],
          ArrowUp: [0, -15],
          ArrowDown: [0, 15],
        }[e.key];
        if (!step || (step[1] && event.time.kind === 'allDay')) return;
        e.preventDefault();
        onShift(event, step[0], step[1]);
      }}
      onPointerDown={(e) => {
        if (readOnly || e.button !== 0) return;
        const grid = e.currentTarget.closest('.ep-schedule-week');
        if (!grid) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        setDrag({
          id: event.id,
          pointer: e.pointerId,
          x: e.clientX,
          width: grid.getBoundingClientRect().width,
          days: 0,
        });
      }}
      onPointerMove={(e) => {
        if (drag?.id !== event.id || drag.pointer !== e.pointerId) return;
        // Render again only when the drop day changes, not on every pointer move.
        const days = dragDays(e.clientX - drag.x, drag.width, range);
        if (days !== drag.days) setDrag({ ...drag, days });
      }}
      onPointerUp={(e) => {
        if (drag?.id !== event.id || drag.pointer !== e.pointerId) return;
        e.currentTarget.releasePointerCapture(e.pointerId);
        setDrag(null);
        // A drag that ends where it started is a click.
        if (drag.days) {
          e.preventDefault();
          onShift(event, drag.days, 0);
        }
      }}
      onPointerCancel={() => setDrag(null)}
    >
      <span className="ep-schedule-event-time">
        {placed.startMinutes === undefined ? 'All day' : timeLabel(placed.startMinutes)}
      </span>
      <span className="ep-schedule-event-title">{event.title || 'Untitled event'}</span>
      {event.links.length > 0 && (
        <span className="ep-schedule-chip">→ {event.links.length} related</span>
      )}
    </button>
  );
});

function OverlayCard({ placed }: { placed: PlacedOverlay }) {
  return (
    <div
      className="ep-schedule-overlay"
      aria-label={`Only you can see this: ${placed.sourceLabel}`}
    >
      <span className="ep-schedule-event-time">{placed.label}</span>
      <span className="ep-schedule-event-title">
        {placed.busyOnly ? 'Busy' : plainExternalText(placed.item.title, 200)}
      </span>
      {!placed.busyOnly && placed.item.notes && (
        <span className="ep-schedule-overlay-notes">
          {plainExternalText(placed.item.notes, 300)}
        </span>
      )}
      <span className="ep-schedule-muted">Only you · {placed.sourceLabel}</span>
    </div>
  );
}

export function ScheduleSurface({
  content,
  execute,
  readOnly,
  select,
  selectedId,
  focusAddress,
  lanes: laneHost,
  read,
  effects,
  renderRelated,
  initialDate,
  displayTimeZone,
}: ScheduleSurfaceProps) {
  const [root, narrow] = useNarrow();
  const [anchor, setAnchor] = useState(
    () => utcDay(initialDate ?? '') ?? utcDay(todayIso(displayTimeZone ?? content.timeZone))!,
  );
  const [mode, setMode] = useState<'week' | 'list'>('week');
  const [zone, setZone] = useState(() => {
    const given = displayTimeZone ?? content.timeZone;
    return canonicalZone(given) ?? given;
  });
  const [selected, setSelected] = useState<string | undefined>(selectedId);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [applying, setApplying] = useState(false);
  // Each event's send, kept across closing the dialog. Moved on at once (not on the next render),
  // so a double click or a late answer sees where the send is.
  const applyStates = useRef(new Map<string, ApplyState>());
  const [, applyChanged] = useReducer((n: number) => n + 1, 0);
  const moveApply = (id: string, action: ApplyAction) => {
    const before = applyStates.current.get(id) ?? idleApply;
    const next = applyTransition(before, action);
    if (next === before) return undefined;
    applyStates.current.set(id, next);
    applyChanged();
    return next;
  };
  // Where the Add lane window opens: under its button, inside the Schedule's own box.
  const [addingLane, setAddingLane] = useState<{ top: number; left: number } | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [error, setError] = useState('');
  const range = useMemo(() => weekRange(anchor), [anchor]);
  const view = narrow ? 'list' : mode;
  const overlay = useOverlay(read, range);
  const laneStates = useLaneStates(laneHost, content.lanes);
  const placed = useMemo(() => placeEvents(content, zone), [content, zone]);
  const event = content.events.find((e) => e.id === selected);
  // A Host-driven selection (for example a comment jump) also leaves the details: when their
  // text cannot be committed, keep the current event and hand its selection back to the Host.
  useEffect(() => {
    if (selectedId === undefined || selectedId === selected) return;
    if (leaveDetails()) setSelected(selectedId);
    else if (selected) select?.([selected]);
    // Only a new Host selection decides; the rest is read at that moment.
  }, [selectedId]);
  // A deleted or undone event closes its details instead of showing stale fields.
  useEffect(() => {
    if (selected && !event) {
      setDetailsOpen(false);
      setApplying(false);
    }
  }, [selected, event]);
  // A lane reference can resolve after the Host changed permissions: always submit through the
  // Host's current callback and read-only state, not the ones from when the request started.
  const current = useRef({ execute, readOnly });
  current.current = { execute, readOnly };
  const run = (cmd: EditorCommand<ScheduleDocument>) => {
    if (current.current.readOnly) {
      setError(readOnlyText);
      return false;
    }
    try {
      const ok = current.current.execute(cmd);
      if (ok) setError('');
      return ok;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };
  const focusEvent = (id: string) =>
    requestAnimationFrame(() =>
      root.current?.querySelector<HTMLElement>(`[data-event-id="${CSS.escape(id)}"]`)?.focus(),
    );
  useEffect(() => {
    const target = placed.find((p) => p.event.id === focusAddress?.elementId);
    if (!target) return;
    if (target.endDay < range.start || target.startDay > range.end) setAnchor(target.startDay);
    focusEvent(target.event.id);
    // Only a new reveal request moves the week; later browsing is the person's own.
  }, [focusAddress]);
  const inputs = useContext(EditorInputsContext);
  // Closing or switching the details unmounts their text buffers: commit them first, and stay
  // put when one is refused or still composing so the typed text is not lost.
  const leaveDetails = () => {
    if (!detailsOpen) return true;
    try {
      inputs?.flush();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };
  // A plan is made from committed text only: pending text is committed first, and refused or
  // composing text stops the plan. The commit renders at once so the plan reads the new event.
  const prepareInputs = () => flushSync(() => inputs?.flush());
  const open = (id: string) => {
    if (id !== selected && !leaveDetails()) return;
    setSelected(id);
    select?.([id]);
    setDetailsOpen(true);
  };
  const close = () => {
    if (!leaveDetails()) return;
    setDetailsOpen(false);
    setApplying(false);
    if (selected) focusEvent(selected);
  };
  const shift = (target: ScheduleEvent, days: number, minutes: number) => {
    if (target.id !== selected) {
      if (!leaveDetails()) return;
      setSelected(target.id);
      select?.([target.id]);
    }
    if (run(setEventTime(target.id, shiftTime(target.time, days, minutes)))) focusEvent(target.id);
  };
  // Stable callbacks for the memoized cards; they call the handlers of the latest render.
  const handlers = useRef({ open, shift });
  handlers.current = { open, shift };
  const onOpen = useCallback((id: string) => handlers.current.open(id), []);
  const onShift = useCallback(
    (target: ScheduleEvent, days: number, minutes: number) =>
      handlers.current.shift(target, days, minutes),
    [],
  );
  const create = () => {
    if (!leaveDetails()) return;
    const id = newId('event');
    const day = dayString(
      range.start + Math.min(Math.max(0, utcDay(todayIso(zone))! - range.start), 6),
    );
    // 10:00 on that day where the person is looking, stored in the Schedule's zone.
    const time = displayedTime(`${day}T10:00`, `${day}T11:00`, zone, content.timeZone);
    if (run(createEvent({ id, time }))) open(id);
  };
  const days = weekDays(range);
  const visible = useMemo(
    () => placed.filter((p) => p.endDay >= range.start && p.startDay <= range.end),
    [placed, range],
  );
  const { reads, sources } = overlay.state;
  const overlayItems = useMemo(
    () =>
      placeOverlay(reads, new Map(sources.map((s) => [s.handle, s])), zone, range).filter(
        (p) => p.day >= range.start && p.day <= range.end,
      ),
    [reads, sources, zone, range],
  );
  const unknown = useMemo(() => unknownDays(reads, range, zone), [reads, range, zone]);
  const incomplete = overlay.state.reads.some((r) => !r.complete);
  const linkedRows = new Set(event?.links.map((l) => linkKey(l.laneId, l.rowId)) ?? []);
  // A timed event that crosses midnight shows on every day it occupies, as in the list view.
  const timed = (day: number) =>
    visible.filter((p) => p.startMinutes !== undefined && p.startDay <= day && p.endDay >= day);
  const allDay = visible.filter((p) => p.startMinutes === undefined);
  const card = (p: PlacedEvent) => (
    <EventCard
      key={p.event.id}
      placed={p}
      selected={p.event.id === selected}
      readOnly={readOnly}
      range={range}
      onOpen={onOpen}
      onShift={onShift}
      drag={drag?.id === p.event.id ? drag : null}
      setDrag={setDrag}
    />
  );
  const overlayCard = (o: (typeof overlayItems)[number]) => (
    <OverlayCard key={linkKey(o.item.sourceHandle, o.item.id)} placed={o} />
  );
  // Week and list show the same lanes.
  const laneRows = (
    <LaneRows
      lanes={content.lanes}
      states={laneStates}
      range={range}
      host={laneHost}
      execute={run}
      readOnly={readOnly}
      linkedRows={linkedRows}
      onError={setError}
    />
  );
  return (
    <div ref={root} className={`ep-schedule${narrow ? ' ep-schedule-narrow' : ''}`}>
      <Toolbar label="Schedule toolbar">
        <IconButton
          icon={Plus}
          label="New event"
          disabled={readOnly}
          reason="Read-only"
          onClick={create}
        />
        <IconButton
          icon={ChevronLeft}
          label="Previous week"
          onClick={() => setAnchor(range.start - 7)}
        />
        <button type="button" onClick={() => setAnchor(utcDay(todayIso(zone))!)}>
          This week
        </button>
        <IconButton
          icon={ChevronRight}
          label="Next week"
          onClick={() => setAnchor(range.start + 7)}
        />
        {!narrow && (
          <>
            <IconButton
              icon={CalendarDays}
              label="Week view"
              aria-pressed={view === 'week'}
              onClick={() => setMode('week')}
            />
            <IconButton
              icon={List}
              label="List view"
              aria-pressed={view === 'list'}
              onClick={() => setMode('list')}
            />
          </>
        )}
        <label className="ep-schedule-zone">
          <span>Display time zone</span>
          <ZoneInput label="Display time zone" value={zone} onChange={setZone} />
        </label>
        {laneHost && !readOnly && (
          <IconButton
            icon={Rows3}
            label="Add lane"
            data-add-lane-trigger=""
            onClick={(e) => setAddingLane(laneDialogPlace(root.current!, e.currentTarget))}
          />
        )}
        {read && (
          <IconButton
            icon={Eye}
            label="Show my calendars"
            aria-pressed={overlay.state.enabled}
            onClick={overlay.toggle}
          />
        )}
      </Toolbar>
      <div className="ep-schedule-heading">
        <h2>{rangeLabel(range)}</h2>
        <span className="ep-schedule-muted">{zone}</span>
      </div>
      {error && (
        <p role="alert" className="ep-schedule-error">
          {error}
        </p>
      )}
      {overlay.state.enabled && (
        <section className="ep-schedule-sources" aria-label="My calendars">
          <p className="ep-schedule-muted">
            Only you can see your calendars. They are not saved in this Schedule.
          </p>
          {overlay.state.sources.map((s) => (
            <label key={s.handle} className="ep-schedule-check">
              <input
                type="checkbox"
                checked={overlay.state.selected.includes(s.handle)}
                onChange={(e) => overlay.choose(s.handle, e.target.checked)}
              />
              {s.label} · {s.account}
              {s.access === 'busy' ? ' · busy only' : ''}
            </label>
          ))}
          {overlay.state.loading && <p role="status">Reading your calendars…</p>}
          {incomplete && (
            <p role="status" className="ep-schedule-warning">
              Incomplete: some of your calendar could not be read. Those times are unknown, not
              free.
            </p>
          )}
          {overlay.state.error && (
            <p role="alert" className="ep-schedule-error">
              {overlay.state.error}
            </p>
          )}
        </section>
      )}
      <div className="ep-schedule-body">
        <main className="ep-schedule-main" aria-label="Schedule">
          {view === 'week' ? (
            <div className="ep-schedule-week" role="grid" aria-label="Week">
              <div className="ep-schedule-days" role="row">
                {days.map((d) => (
                  <div key={d} role="columnheader" className="ep-schedule-dayhead">
                    {dayLabel(d)}
                    {unknown.has(d) && <span className="ep-schedule-unknown">Unknown</span>}
                  </div>
                ))}
              </div>
              {laneRows}
              {allDay.length > 0 && (
                <div className="ep-schedule-allday" aria-label="All-day events" role="row">
                  {allDay.map((p) => {
                    const place = spanPlacement(range, p.startDay, p.endDay);
                    return (
                      <div
                        key={p.event.id}
                        className="ep-schedule-allday-item"
                        style={{
                          marginLeft: `${place.offset * 100}%`,
                          width: `${place.width * 100}%`,
                        }}
                      >
                        {card(p)}
                      </div>
                    );
                  })}
                </div>
              )}
              <div className="ep-schedule-columns" role="row">
                {days.map((d) => (
                  <div
                    key={d}
                    role="gridcell"
                    aria-label={dayLabel(d)}
                    className={`ep-schedule-column${unknown.has(d) ? ' ep-schedule-column-unknown' : ''}`}
                  >
                    {timed(d).map(card)}
                    {overlayItems.filter((o) => o.day === d).map(overlayCard)}
                  </div>
                ))}
              </div>
              {!content.events.length && (
                <p className="ep-schedule-empty">No events yet. Use New event to add one.</p>
              )}
            </div>
          ) : (
            <div className="ep-schedule-list" aria-label="Event list">
              {laneRows}
              {days.map((d) => {
                const items = visible.filter((p) => p.startDay <= d && p.endDay >= d);
                const mine = overlayItems.filter((o) => o.day === d);
                if (!items.length && !mine.length && !unknown.has(d)) return null;
                return (
                  <section key={d} aria-label={dayLabel(d)}>
                    <h3>
                      {dayLabel(d)}
                      {unknown.has(d) && <span className="ep-schedule-unknown">Unknown</span>}
                    </h3>
                    {items.map(card)}
                    {mine.map(overlayCard)}
                  </section>
                );
              })}
              {!visible.length && (
                <p className="ep-schedule-empty">
                  {content.events.length
                    ? 'No events this week.'
                    : 'No events yet. Use New event to add one.'}
                </p>
              )}
            </div>
          )}
        </main>
        {detailsOpen && event && (
          <EventDetails
            key={event.id}
            event={event}
            content={content}
            execute={run}
            readOnly={readOnly}
            laneStates={laneStates}
            renderRelated={renderRelated}
            onClose={close}
            onError={setError}
            footer={
              applying &&
              effects && (
                <ApplyDialog
                  event={event}
                  effects={effects}
                  prepareInputs={prepareInputs}
                  state={applyStates.current.get(event.id) ?? idleApply}
                  onApply={(action) => moveApply(event.id, action)}
                  onClose={() => {
                    setApplying(false);
                    // Focus moved into the dialog; give it back to the button that opened it.
                    requestAnimationFrame(() =>
                      root.current?.querySelector<HTMLElement>('[data-apply-trigger]')?.focus(),
                    );
                  }}
                />
              )
            }
            actions={
              <>
                <IconButton
                  icon={Copy}
                  label="Duplicate event"
                  disabled={readOnly}
                  onClick={() => {
                    // The copy takes committed text only: refused or composing text creates nothing.
                    if (!leaveDetails()) return;
                    const id = newId('event');
                    if (run(duplicateEvent(event.id, id))) open(id);
                  }}
                />
                <IconButton
                  icon={Trash2}
                  label="Delete event"
                  disabled={readOnly}
                  onClick={() => run(removeEvent(event.id))}
                />
                {effects && (
                  <IconButton
                    icon={Send}
                    label="Apply to calendar"
                    data-apply-trigger=""
                    onClick={() => {
                      try {
                        prepareInputs();
                        if (!applying) moveApply(event.id, { type: 'open' });
                        setApplying(true);
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    }}
                  >
                    <span>Apply to calendar</span>
                  </IconButton>
                )}
              </>
            }
          />
        )}
      </div>
      {addingLane && laneHost && (
        <AddLaneDialog
          host={laneHost}
          execute={run}
          place={addingLane}
          onClose={() => {
            setAddingLane(null);
            requestAnimationFrame(() =>
              root.current?.querySelector<HTMLElement>('[data-add-lane-trigger]')?.focus(),
            );
          }}
        />
      )}
      <p className="ep-schedule-sr" aria-live="polite">
        {drag?.days ? `Move ${drag.days > 0 ? '+' : ''}${drag.days} days` : ''}
      </p>
    </div>
  );
}
