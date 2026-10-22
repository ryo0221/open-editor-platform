import { useEffect, useRef, useState } from 'react';
import { spanPlacement, utcDay, type AxisRange } from '@editor-platform/time-axis';
import type { ReferenceSource } from '@editor-platform/artifact-references';
import type { EditorCommand } from '@editor-platform/editor-core';
import { linkKey } from './view-model';
import {
  addLane,
  removeLane,
  setLaneReference,
  type ScheduleDocument,
  type ScheduleLane,
} from './model';
import {
  laneItemLimit,
  laneShown,
  type ScheduleLaneHost,
  type ScheduleLaneItem,
  type ScheduleLaneState,
} from './host';
import { newId } from '@editor-platform/artifact-core';

/** Stack overlapping spans into rows (first fit), so no bar hides another. */
export function packRows(items: ScheduleLaneItem[]) {
  const ends: number[] = [];
  return [...items]
    .sort((a, b) => a.startDate.localeCompare(b.startDate) || a.endDate.localeCompare(b.endDate))
    .map((item) => {
      const start = utcDay(item.startDate)!,
        end = utcDay(item.endDate)!;
      let row = ends.findIndex((e) => e < start);
      if (row < 0) row = ends.length;
      ends[row] = end;
      return { item, row };
    });
}

export const continuesBeforeText = 'Continues before this week';
export const continuesAfterText = 'Continues after this week';
/** Inclusive dates of a span, without the year when both share one. */
export const spanDates = (start: string, end: string) =>
  start.slice(0, 4) === end.slice(0, 4)
    ? `${start.slice(5)} – ${end.slice(5)}`
    : `${start} – ${end}`;

export const laneOfflineText = 'Offline: showing the last verified version';
const unavailable: ScheduleLaneState = { status: 'loading', items: [], hidden: 0 };

/** Lane states from the Host, refreshed when a referenced Data artifact changes. */
export function useLaneStates(host: ScheduleLaneHost | undefined, lanes: ScheduleLane[]) {
  const [, setTick] = useState(0);
  // The whole reference identity: another source or view under the same lane ID re-subscribes.
  const key = JSON.stringify(
    lanes.map((l) => [
      l.id,
      l.reference.mode,
      l.reference.source,
      l.reference.snapshot.artifactId,
      l.reference.snapshot.versionId,
      l.reference.snapshot.contentHash,
    ]),
  );
  useEffect(() => {
    if (!host || !lanes.length) return;
    return host.observe(
      lanes.map((l) => l.reference),
      () => setTick((t) => t + 1),
    );
    // key captures the references.
  }, [host, key]);
  const states = new Map<string, ScheduleLaneState>();
  for (const lane of lanes) states.set(lane.id, host ? host.state(lane.reference) : unavailable);
  return states;
}

export function LaneRows({
  lanes,
  states,
  range,
  host,
  execute,
  readOnly,
  linkedRows,
  onError,
}: {
  lanes: ScheduleLane[];
  states: Map<string, ScheduleLaneState>;
  range: AxisRange;
  host?: ScheduleLaneHost;
  execute: (cmd: EditorCommand<ScheduleDocument>) => boolean;
  readOnly: boolean;
  /** Rows related to the selected event, highlighted in their lane. */
  linkedRows: Set<string>;
  onError: (message: string) => void;
}) {
  const labels = useRef(new Map<string, string>());
  // Keep the last known name so an unavailable lane stays recognisable. Recorded after render.
  useEffect(() => {
    for (const [id, state] of states) if (state.label) labels.current.set(id, state.label);
  });
  if (!lanes.length) return null;
  // A command that waits for the lane Host; execute reports its own refusal.
  const runLater = async (task: () => Promise<EditorCommand<ScheduleDocument>>) => {
    let cmd: EditorCommand<ScheduleDocument>;
    try {
      cmd = await task();
    } catch (error) {
      return onError((error as Error).message);
    }
    execute(cmd);
  };
  return (
    <div className="ep-schedule-lanes" aria-label="Work lanes" role="group">
      {lanes.map((lane) => {
        const state = states.get(lane.id)!;
        const label = state.label ?? labels.current.get(lane.id) ?? 'Lane';
        const visible = packRows(
          state.items.filter((item) => {
            const s = utcDay(item.startDate),
              e = utcDay(item.endDate);
            return s !== null && e !== null && e >= range.start && s <= range.end;
          }),
        );
        const rows = Math.max(1, ...visible.map((v) => v.row + 1));
        return (
          <section key={lane.id} className="ep-schedule-lane" aria-label={`Lane ${label}`}>
            <header>
              <strong>{label}</strong>
              <span className="ep-schedule-muted">
                {lane.reference.mode === 'fixed' ? 'Pinned' : 'Following'}
                {state.version ? ` · ${state.version}` : ''}
              </span>
              {host && !readOnly && (
                <select
                  aria-label="Lane mode"
                  value={lane.reference.mode}
                  onChange={(e) =>
                    void runLater(async () =>
                      setLaneReference(
                        lane.id,
                        e.target.value === 'fixed'
                          ? host.pin(lane.reference)
                          : await host.create(lane.reference.source, 'follow'),
                      ),
                    )
                  }
                >
                  <option value="fixed">Pin this version</option>
                  <option value="follow">Follow new versions</option>
                </select>
              )}
              {!readOnly && (
                <button type="button" onClick={() => execute(removeLane(lane.id))}>
                  Remove lane
                </button>
              )}
            </header>
            {state.status === 'offline' && laneShown(state) && (
              <p className="ep-schedule-warning" role="status">
                {laneOfflineText} {state.version}
                {state.message ? ` (${state.message})` : ''}
              </p>
            )}
            {!laneShown(state) ? (
              <p className="ep-schedule-warning" role="status">
                {state.status === 'loading'
                  ? 'Loading lane…'
                  : `Lane unavailable: ${state.message ?? state.status}`}
              </p>
            ) : (
              <div className="ep-schedule-lane-track" style={{ height: `${rows * 24 + 4}px` }}>
                {visible.map(({ item, row }) => {
                  const start = utcDay(item.startDate)!,
                    end = utcDay(item.endDate)!;
                  const place = spanPlacement(range, start, end);
                  // A bar cut at the week's edge says so and carries its own dates.
                  const before = start < range.start,
                    after = end > range.end;
                  return (
                    <span
                      key={item.rowId}
                      className={`ep-schedule-bar${item.milestone ? ' ep-schedule-milestone' : ''}${before ? ' ep-schedule-bar-before' : ''}${after ? ' ep-schedule-bar-after' : ''}${linkedRows.has(linkKey(lane.id, item.rowId)) ? ' ep-schedule-linked' : ''}`}
                      style={{
                        left: `${place.offset * 100}%`,
                        width: `${place.width * 100}%`,
                        top: `${row * 24 + 3}px`,
                      }}
                      title={`${item.label}: ${item.startDate} – ${item.endDate}`}
                    >
                      {before && <span aria-hidden="true">◂ </span>}
                      {item.milestone ? '◆ ' : ''}
                      {item.label}
                      {(before || after) && (
                        <span className="ep-schedule-bar-dates">
                          {' '}
                          {spanDates(item.startDate, item.endDate)}
                        </span>
                      )}
                      {before && <span className="ep-schedule-sr"> {continuesBeforeText}</span>}
                      {after && <span className="ep-schedule-sr"> {continuesAfterText}</span>}
                      {after && (
                        <span aria-hidden="true" className="ep-schedule-bar-next">
                          {' '}
                          ▸
                        </span>
                      )}
                    </span>
                  );
                })}
                {!visible.length && <span className="ep-schedule-muted">No work this week</span>}
              </div>
            )}
            {state.hidden > 0 && (
              <p className="ep-schedule-muted">
                {state.hidden} more records are not shown (limit {laneItemLimit}).
              </p>
            )}
          </section>
        );
      })}
    </div>
  );
}

export const laneDialogWidth = 360;
/** Below the trigger, kept inside the Schedule (which scrolls) so the window never sits off to one side. */
export function laneDialogPlace(root: HTMLElement, trigger: HTMLElement) {
  const box = root.getBoundingClientRect(),
    at = trigger.getBoundingClientRect();
  const width = Math.min(laneDialogWidth, root.clientWidth - 24);
  return {
    top: at.bottom - box.top + root.scrollTop + 4,
    left:
      Math.max(12, Math.min(at.left - box.left, root.clientWidth - width - 12)) + root.scrollLeft,
  };
}

export function AddLaneDialog({
  host,
  execute,
  place,
  onClose,
}: {
  host: ScheduleLaneHost;
  execute: (cmd: EditorCommand<ScheduleDocument>) => boolean;
  /** Position inside the Schedule, from laneDialogPlace. */
  place: { top: number; left: number };
  onClose: () => void;
}) {
  const [options, setOptions] = useState<{ label: string; source: ReferenceSource }[]>();
  const [choice, setChoice] = useState(0);
  const [mode, setMode] = useState<'fixed' | 'follow'>('fixed');
  const [error, setError] = useState('');
  // One creation at a time: a double click must not add the same lane twice.
  const adding = useRef(false);
  const [busy, setBusy] = useState(false);
  // Cancel or Escape unmounts the dialog; a reference that resolves afterwards adds nothing.
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);
  useEffect(() => {
    host.options().then(setOptions, (e) => setError((e as Error).message));
  }, [host]);
  // Keyboard users land in the dialog, so Escape and Tab work from the start.
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    dialog.current?.focus();
  }, []);
  useEffect(() => {
    if (options?.length) dialog.current?.querySelector<HTMLElement>('select')?.focus();
  }, [options]);
  return (
    <div
      ref={dialog}
      tabIndex={-1}
      className="ep-schedule-apply ep-schedule-lane-dialog"
      style={place}
      role="dialog"
      aria-label="Add lane"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <h2>Add lane</h2>
      <p className="ep-schedule-muted">Shows a saved Data Timeline view next to the events.</p>
      {options && !options.length && <p>No saved Data Timeline views.</p>}
      {options && options.length > 0 && (
        <>
          <label>
            Data view
            <select
              aria-label="Data view"
              value={choice}
              onChange={(e) => setChoice(Number(e.target.value))}
            >
              {options.map((o, i) => (
                <option key={i} value={i}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Version
            <select
              aria-label="Lane version"
              value={mode}
              onChange={(e) => setMode(e.target.value as 'fixed' | 'follow')}
            >
              <option value="fixed">Pin this version</option>
              <option value="follow">Follow new versions</option>
            </select>
          </label>
          <button
            type="button"
            className="ep-schedule-primary"
            disabled={busy}
            onClick={async () => {
              if (adding.current) return;
              adding.current = true;
              setBusy(true);
              try {
                const reference = await host.create(options[choice].source, mode);
                if (!open.current) return;
                if (execute(addLane({ id: newId('lane'), reference }))) onClose();
              } catch (e) {
                if (open.current) setError((e as Error).message);
              } finally {
                adding.current = false;
                if (open.current) setBusy(false);
              }
            }}
          >
            Add lane
          </button>
        </>
      )}
      {error && (
        <p role="alert" className="ep-schedule-error">
          {error}
        </p>
      )}
      <button type="button" onClick={onClose}>
        Cancel
      </button>
    </div>
  );
}
