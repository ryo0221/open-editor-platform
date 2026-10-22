import { useState } from 'react';
import { type EditorCommand } from '@editor-platform/editor-core';
import { type StructuredData, type DataRow, displayCell } from './model';
import { axisTicks, rangeLength } from '@editor-platform/time-axis';
import { utcDay, dayString, moveDates, type TimelineConfig } from './views';
export function Timeline({
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
  const [drag, setDrag] = useState<{
      id: string;
      mode: 'move' | 'start' | 'end';
      x: number;
      width: number;
      start: number;
      end: number;
      delta: number;
    } | null>(null),
    [editing, setEditing] = useState<string | null>(null),
    [startInput, setStartInput] = useState(''),
    [endInput, setEndInput] = useState(''),
    [error, setError] = useState('');
  const entries = rows.map((row) => ({
      row,
      start: utcDay(String(row.values[config.start] ?? '')),
      end: utcDay(String(row.values[config.end] ?? '')),
    })),
    valid = entries.filter((e) => e.start !== null && e.end !== null && e.end >= e.start),
    start =
      utcDay(config.from) ??
      (valid.length ? Math.min(...valid.map((e) => e.start!)) - 2 : utcDay('2026-01-01')!),
    end =
      utcDay(config.to) ?? (valid.length ? Math.max(...valid.map((e) => e.end!)) + 2 : start + 30),
    axis = { start, end },
    range = rangeLength(axis),
    group = data.columns.find((c) => c.id === config.group),
    groups = [
      ...new Set(
        entries.map((e) => (group ? displayCell(data, e.row, group) || '(empty)' : 'All records')),
      ),
    ];
  if (!config.start || !config.end)
    return <p className="ep-data-empty">Choose start and end date fields in the inspector.</p>;
  function begin(
    e: React.PointerEvent,
    id: string,
    mode: 'move' | 'start' | 'end',
    s: number,
    t: number,
  ) {
    if (readOnly) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget.closest('.ep-timeline-bar') as HTMLElement)?.focus();
    onSelect(id);
    e.currentTarget.setPointerCapture(e.pointerId);
    const width = e.currentTarget.closest('.ep-timeline-track')!.getBoundingClientRect().width;
    setDrag({ id, mode, x: e.clientX, width, start: s, end: t, delta: 0 });
  }
  const handler = {
    onPointerMove: (e: React.PointerEvent) => {
      if (drag && e.currentTarget.hasPointerCapture(e.pointerId))
        setDrag({ ...drag, delta: Math.round(((e.clientX - drag.x) / drag.width) * range) });
    },
    onPointerUp: (e: React.PointerEvent) => {
      if (!drag || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
      e.currentTarget.releasePointerCapture(e.pointerId);
      const s = drag.start + (drag.mode === 'end' ? 0 : drag.delta),
        t = drag.end + (drag.mode === 'start' ? 0 : drag.delta);
      try {
        if (drag.delta !== 0) apply(moveDates(data, drag.id, config, s, t));
        setError('');
      } catch (e) {
        setError((e as Error).message);
      }
      setDrag(null);
    },
    onPointerCancel: () => setDrag(null),
  };
  return (
    <div className="ep-timeline">
      <div className="ep-timeline-heading">
        <strong>UTC dates · {config.scale}</strong>
        <span>
          {dayString(start)} — {dayString(end)}
        </span>
      </div>
      <div className="ep-timeline-axis">
        <div />
        {axisTicks(axis, config.scale).map((tick) => (
          <span key={tick.day} style={{ left: `calc(180px + (100% - 180px) * ${tick.offset})` }}>
            {tick.label}
          </span>
        ))}
      </div>
      {groups.map((groupName) => (
        <section key={groupName}>
          <h3>{groupName}</h3>
          {entries
            .filter(
              (e) =>
                (group ? displayCell(data, e.row, group) || '(empty)' : 'All records') ===
                groupName,
            )
            .map((entry) => {
              const current = drag?.id === entry.row.id ? drag : null,
                s =
                  (entry.start ?? start) + (current && current.mode !== 'end' ? current.delta : 0),
                t = (entry.end ?? s) + (current && current.mode !== 'start' ? current.delta : 0),
                valid = entry.start !== null && entry.end !== null && t >= s;
              return (
                <div className="ep-timeline-row" key={entry.row.id}>
                  <button
                    onClick={() => {
                      onSelect(entry.row.id);
                      setEditing(entry.row.id);
                      setStartInput(String(entry.row.values[config.start] ?? ''));
                      setEndInput(String(entry.row.values[config.end] ?? ''));
                    }}
                  >
                    {String(entry.row.values[data.columns[0]?.id] ?? 'Record')}
                  </button>
                  <div className="ep-timeline-track">
                    {valid ? (
                      <div
                        role="button"
                        tabIndex={0}
                        aria-label={`Dates for ${String(entry.row.values[data.columns[0]?.id])}`}
                        title={`${dayString(s)} — ${dayString(t)}`}
                        className="ep-timeline-bar"
                        style={{
                          left: `${Math.max(0, ((s - start) / range) * 100)}%`,
                          width: `${(Math.max(0.5, Math.min(end, t) - Math.max(start, s) + 1) / range) * 100}%`,
                          visibility: t < start || s > end ? 'hidden' : undefined,
                        }}
                        onPointerDown={(e) => begin(e, entry.row.id, 'move', s, t)}
                        {...handler}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            setEditing(entry.row.id);
                            setStartInput(dayString(s));
                            setEndInput(dayString(t));
                          }
                          if (!readOnly && ['ArrowLeft', 'ArrowRight'].includes(e.key)) {
                            e.preventDefault();
                            apply(
                              moveDates(
                                data,
                                entry.row.id,
                                config,
                                s + (e.key === 'ArrowRight' ? 1 : -1),
                                t + (e.key === 'ArrowRight' ? 1 : -1),
                              ),
                            );
                          }
                        }}
                      >
                        <span
                          role="button"
                          aria-label="Resize start date"
                          onPointerDown={(e) => begin(e, entry.row.id, 'start', s, t)}
                          {...handler}
                        />
                        <span className="ep-timeline-label">
                          {dayString(s).slice(5)} — {dayString(t).slice(5)}
                        </span>
                        <span
                          role="button"
                          aria-label="Resize end date"
                          onPointerDown={(e) => begin(e, entry.row.id, 'end', s, t)}
                          {...handler}
                        />
                      </div>
                    ) : (
                      <span className="ep-field-error">
                        {entry.start === null || entry.end === null
                          ? 'Date missing or invalid'
                          : 'End precedes start'}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
        </section>
      ))}
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
              if (apply(moveDates(data, editing, config, s, t))) setEditing(null);
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          <label>
            Start date
            <input
              aria-label="Timeline start date"
              type="date"
              value={startInput}
              onChange={(e) => setStartInput(e.target.value)}
              disabled={readOnly}
            />
          </label>
          <label>
            End date
            <input
              aria-label="Timeline end date"
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
