import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { type EditorCommand } from '@editor-platform/editor-core';
import { IconButton } from '@editor-platform/editor-ui';
import {
  DAY_MS,
  addMonths,
  monthLabel,
  monthStart,
  monthWeeks,
  stackSegments,
  weekSegment,
} from '@editor-platform/time-axis';
import { type StructuredData, type DataRow } from './model';
import { utcDay, dayString, moveDates, type TimelineConfig } from './views';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Read-mostly month view of the Timeline date fields. Meetings and events stay in Schedule. */
export function Calendar({
  data,
  rows,
  config,
  apply,
  readOnly,
  onSelect,
}: {
  data: StructuredData;
  rows: DataRow[];
  config: TimelineConfig;
  apply: (command: EditorCommand<StructuredData>) => boolean;
  readOnly: boolean;
  onSelect: (id: string) => void;
}) {
  const entries = rows.map((row) => ({
      row,
      title: String(row.values[data.columns[0]?.id] ?? 'Record'),
      start: utcDay(String(row.values[config.start] ?? '')),
      end: utcDay(String(row.values[config.end] ?? '')),
    })),
    valid = entries.filter((e) => e.start !== null && e.end !== null && e.end >= e.start),
    first = valid.length
      ? Math.min(...valid.map((e) => e.start!))
      : Math.floor(Date.now() / DAY_MS);
  // The shown month is private view state: moving it changes neither content nor history.
  const [month, setMonth] = useState<number | null>(null),
    // The edit keeps the date fields it was opened with, even if the inspector changes them.
    [editing, setEditing] = useState<{ id: string; start: string; end: string } | null>(null),
    [startInput, setStartInput] = useState(''),
    [endInput, setEndInput] = useState(''),
    [error, setError] = useState('');
  if (!config.start || !config.end)
    return <p className="ep-data-empty">Choose start and end date fields in the inspector.</p>;
  const shown = month ?? monthStart(first),
    missing = entries.length - valid.length;
  return (
    <div className="ep-calendar">
      <div className="ep-calendar-heading">
        <IconButton
          icon={ChevronLeft}
          label="Previous month"
          onClick={() => setMonth(addMonths(shown, -1))}
        />
        <strong>{monthLabel(shown)}</strong>
        <IconButton
          icon={ChevronRight}
          label="Next month"
          onClick={() => setMonth(addMonths(shown, 1))}
        />
        <span className="ep-calendar-zone">UTC dates</span>
        {missing > 0 && (
          <span className="ep-field-error">
            {missing} {missing === 1 ? 'record' : 'records'} without valid dates
          </span>
        )}
      </div>
      <div className="ep-calendar-weekdays" aria-hidden="true">
        {WEEKDAYS.map((day) => (
          <span key={day}>{day}</span>
        ))}
      </div>
      {monthWeeks(shown).map((week) => {
        const bars = stackSegments(
          valid.flatMap((entry) => {
            const segment = weekSegment(week, entry.start!, entry.end!);
            return segment ? [{ ...segment, entry }] : [];
          }),
        );
        return (
          <div className="ep-calendar-week" key={week.start}>
            {WEEKDAYS.map((_, column) => {
              const day = week.start + column;
              return (
                <span
                  key={day}
                  className={
                    monthStart(day) === shown ? 'ep-calendar-day' : 'ep-calendar-day outside'
                  }
                  style={{ gridColumn: column + 1 }}
                >
                  {Number(dayString(day).slice(8))}
                </span>
              );
            })}
            {bars.map(({ entry, column, span, lane, before, after }) => (
              <button
                key={entry.row.id}
                className={`ep-calendar-bar${before ? ' before' : ''}${after ? ' after' : ''}`}
                style={{ gridColumn: `${column + 1} / span ${span}`, gridRow: lane + 2 }}
                aria-label={`Dates for ${entry.title}`}
                title={`${dayString(entry.start!)} — ${dayString(entry.end!)}`}
                onClick={() => {
                  onSelect(entry.row.id);
                  setEditing({ id: entry.row.id, start: config.start, end: config.end });
                  setStartInput(dayString(entry.start!));
                  setEndInput(dayString(entry.end!));
                  setError('');
                }}
              >
                {entry.title}
              </button>
            ))}
          </div>
        );
      })}
      {editing && (
        <form
          className="ep-timeline-edit"
          onSubmit={(e) => {
            e.preventDefault();
            const s = utcDay(startInput),
              t = utcDay(endInput);
            if (s === null || t === null || t < s) {
              setError('Choose valid dates with end on or after start');
              return;
            }
            try {
              const fields = { ...config, start: editing.start, end: editing.end };
              if (apply(moveDates(data, editing.id, fields, s, t))) setEditing(null);
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          <label>
            Start date
            <input
              aria-label="Calendar start date"
              type="date"
              value={startInput}
              onChange={(e) => setStartInput(e.target.value)}
              disabled={readOnly}
            />
          </label>
          <label>
            End date
            <input
              aria-label="Calendar end date"
              type="date"
              value={endInput}
              onChange={(e) => setEndInput(e.target.value)}
              disabled={readOnly}
            />
          </label>
          <button disabled={readOnly}>Apply dates</button>
          <button type="button" onClick={() => setEditing(null)}>
            Cancel dates
          </button>
        </form>
      )}
      {error && (
        <p role="alert" className="ep-error">
          {error}
        </p>
      )}
    </div>
  );
}
