import { type ReactNode } from 'react';
import { ArrowUp, ChevronLeft, ChevronRight, Trash2 } from 'lucide-react';
import { type EditorCommand, type Region } from '@editor-platform/editor-core';
import { IconButton } from '@editor-platform/editor-ui';
import { makeRow, type Column, type DataRow, type StructuredData } from './model';
import {
  formatCell,
  insertRows,
  reorderRow,
  setCells,
  summarize,
  type DataProjection,
  type DataView,
} from './views';
import { DataGrid, type CellAddress } from './grid';
import { RecordForm, type RecordDraft } from './record';
import { Timeline } from './timeline';
import { DataChart } from './chart-view';
import { groupValue, swapWidget, type DataGroups } from './view-model';
import type { DataSurfaceProps } from './view';

type Apply = (cmd: EditorCommand<StructuredData>) => boolean;

export interface DataProjectionProps {
  data: StructuredData;
  view: DataView;
  patch: (patch: Partial<DataView>) => void;
  rows: DataRow[];
  columns: Column[];
  apply: Apply;
  select: (id: string, region?: Region) => void;
  readOnly: boolean;
  active: CellAddress | null;
  onActive: (address: CellAddress) => void;
  onError: (error: string) => void;
  onField: (id: string) => void;
  onFieldDialog: (id: string) => void;
  onRecordDialog: (id: string) => void;
  renderGraph: DataSurfaceProps['renderGraph'];
  changeProjection: (projection: DataProjection) => boolean;
  focusRow: (id: string) => void;
  drafts: Map<string, RecordDraft>;
  record: DataRow | undefined;
  recordIndex: number;
  groups: DataGroups;
  widgetId: string;
  onWidget: (id: string) => void;
}

function KanbanCard({
  p,
  name,
  row,
  i,
}: {
  p: DataProjectionProps;
  name: string;
  row: DataRow;
  i: number;
}) {
  const { data, view, readOnly, apply, groups } = p;
  const { groupColumn, groupNames, groupRows } = groups;
  const title = String(row.values[data.columns[0]?.id] ?? 'Record');
  return (
    <article
      className="ep-kanban-card"
      draggable={!readOnly}
      onDragStart={(e) => e.dataTransfer.setData('application/x-data-row', row.id)}
    >
      <button
        className="ep-card-title"
        onClick={() => {
          p.focusRow(row.id);
          p.onRecordDialog(row.id);
        }}
      >
        {title}
      </button>
      {view.cardFields
        .filter((id) => id !== data.columns[0]?.id)
        .map((id) => {
          const c = data.columns.find((c) => c.id === id);
          return c ? (
            <p key={id}>
              <span>{c.name}</span>
              {formatCell(data, row, c)}
            </p>
          ) : null;
        })}
      <div className="ep-card-actions">
        <label>
          Move to
          <select
            aria-label={`Move ${title} to`}
            disabled={readOnly || !groupColumn}
            value={name}
            onChange={(e) => {
              if (groupColumn)
                apply(
                  setCells(
                    [
                      {
                        rowId: row.id,
                        columnId: groupColumn.id,
                        value: groupValue(e.target.value),
                      },
                    ],
                    'Move card',
                  ),
                );
            }}
          >
            {groupNames.map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
        <IconButton
          icon={ArrowUp}
          label={`Move ${title} up`}
          disabled={readOnly || i === 0}
          onClick={() => apply(reorderRow(row.id, groupRows(name)[i - 1].id))}
        />
      </div>
    </article>
  );
}

function KanbanColumn({ p, name }: { p: DataProjectionProps; name: string }) {
  const { data, readOnly, apply, groups } = p;
  const { groupColumn, groupRows } = groups;
  return (
    <section
      className="ep-kanban-column"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const id = e.dataTransfer.getData('application/x-data-row');
        if (id && groupColumn)
          apply(
            setCells(
              [
                {
                  rowId: id,
                  columnId: groupColumn.id,
                  value: groupValue(name),
                },
              ],
              'Move card',
            ),
          );
      }}
    >
      <h3>
        {name}
        <span>{groupRows(name).length}</span>
      </h3>
      {groupRows(name).map((row, i) => (
        <KanbanCard key={row.id} p={p} name={name} row={row} i={i} />
      ))}
      <button
        disabled={readOnly}
        onClick={() => {
          const row = makeRow(data);
          if (groupColumn) row.values[groupColumn.id] = groupValue(name);
          if (apply(insertRows([row]))) p.onRecordDialog(row.id);
        }}
      >
        Add card
      </button>
    </section>
  );
}

function formContent(p: DataProjectionProps, record: DataRow) {
  const { data, rows, recordIndex, focusRow } = p;
  return (
    <>
      <div className="ep-record-nav">
        <IconButton
          icon={ChevronLeft}
          label="Previous record"
          disabled={recordIndex <= 0}
          onClick={() => focusRow(rows[recordIndex - 1].id)}
        />
        <span>
          {recordIndex + 1} / {rows.length}
        </span>
        <IconButton
          icon={ChevronRight}
          label="Next record"
          disabled={recordIndex >= rows.length - 1}
          onClick={() => focusRow(rows[recordIndex + 1].id)}
        />
      </div>
      <RecordForm
        key={record.id}
        data={data}
        row={record}
        drafts={p.drafts}
        readOnly={p.readOnly}
        apply={p.apply}
        select={(columnId) => p.select(record.id, { type: 'cell', columnId })}
      />
    </>
  );
}

const summaryValue = (
  data: StructuredData,
  rows: DataRow[],
  columnId: string,
  aggregate: DataView['summary']['aggregate'],
) => summarize(data, rows, columnId, aggregate)?.toLocaleString() ?? '—';

function summaryContent(p: DataProjectionProps) {
  const { data, view, rows, groups } = p;
  const names = view.groupBy ? groups.groupNames : ['All records'];
  return (
    <>
      <h2>Summary</h2>
      <p>
        {rows.length} of {data.rows.length} records · {view.filters.length} filter conditions ·
        empty numeric values excluded
      </p>
      <table className="ep-summary">
        <thead>
          <tr>
            <th>Group</th>
            <th>Records</th>
            <th>{view.summary.aggregate}</th>
          </tr>
        </thead>
        <tbody>
          {names.map((name) => {
            const items = view.groupBy ? groups.groupRows(name) : rows;
            return (
              <tr key={name}>
                <td>{name}</td>
                <td>{items.length}</td>
                <td>{summaryValue(data, items, view.summary.columnId, view.summary.aggregate)}</td>
              </tr>
            );
          })}
          <tr>
            <th>Total</th>
            <td>{rows.length}</td>
            <td>{summaryValue(data, rows, view.summary.columnId, view.summary.aggregate)}</td>
          </tr>
        </tbody>
      </table>
    </>
  );
}

function WidgetTable({ p }: { p: DataProjectionProps }) {
  const { data, rows, columns } = p;
  return (
    <div className="ep-widget-table">
      <table>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.id}>{c.name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 20).map((r) => (
            <tr key={r.id}>
              {columns.map((c) => (
                <td key={c.id}>{formatCell(data, r, c)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        First {Math.min(20, rows.length)} of {rows.length} records
      </p>
    </div>
  );
}

function DashboardWidget({
  p,
  w,
  i,
}: {
  p: DataProjectionProps;
  w: DataView['widgets'][number];
  i: number;
}) {
  const { data, view, rows, patch } = p;
  return (
    <section
      className={`ep-widget ${p.widgetId === w.id ? 'selected' : ''}`}
      onClick={() => p.onWidget(w.id)}
    >
      <header>
        <h3>{w.title}</h3>
        <IconButton
          icon={ArrowUp}
          label={`Move widget ${i + 1} up`}
          disabled={i === 0}
          onClick={() => patch({ widgets: swapWidget(view.widgets, i) })}
        />
        <IconButton
          icon={Trash2}
          label={`Delete widget ${i + 1}`}
          onClick={() => patch({ widgets: view.widgets.filter((v) => v.id !== w.id) })}
        />
      </header>
      {w.type === 'metric' ? (
        <>
          <output aria-label={w.title}>
            {summaryValue(data, rows, w.columnId ?? '', w.aggregate ?? 'sum')}
          </output>
          <p>
            {w.aggregate} · {rows.length} records
          </p>
        </>
      ) : w.type === 'chart' ? (
        <DataChart
          data={data}
          rows={rows}
          config={w.chart ?? view.chart}
          width={600}
          height={340}
          accent={view.accent}
        />
      ) : (
        <WidgetTable p={p} />
      )}
    </section>
  );
}

function dashboardContent(p: DataProjectionProps) {
  const { view } = p;
  return (
    <>
      <div className="ep-dashboard">
        {view.widgets.map((w, i) => (
          <DashboardWidget key={w.id} p={p} w={w} i={i} />
        ))}
      </div>
      {!view.widgets.length && (
        <p className="ep-data-empty">
          Add a metric, chart or table from the inspector. Widgets read this dataset.
        </p>
      )}
    </>
  );
}

function graphProjection(p: DataProjectionProps): ReactNode {
  const { data, rows, columns, renderGraph } = p;
  return renderGraph ? (
    renderGraph({
      content: data,
      execute: (cmd) => p.apply(cmd),
      select: (id, region) => {
        p.onActive({
          rowId: id,
          columnId:
            region?.type === 'cell'
              ? region.columnId
              : (p.active?.columnId ?? columns[0]?.id ?? ''),
        });
        p.select(id, region);
      },
      readOnly: p.readOnly,
      visibleRowIds: rows.map((r) => r.id),
      openSource: (rowId) => {
        if (!p.changeProjection('Form')) return;
        if (rowId) p.focusRow(rowId);
      },
      openDefinition: (columnId) => {
        if (!p.changeProjection('Grid')) return;
        p.onFieldDialog(columnId ?? data.columns[0]?.id ?? '');
      },
    })
  ) : (
    <p role="alert">
      This Host has not registered a Graph projection. The original Data is retained.
    </p>
  );
}

/** Renders the active projection. Content helpers return fragments so the shared scroll
 * container reconciles its children directly. */
export function dataProjection(p: DataProjectionProps): ReactNode {
  const { data, view, rows } = p;
  switch (view.projection) {
    case 'Grid':
      return (
        <DataGrid
          data={data}
          rows={rows}
          columns={p.columns}
          view={view}
          onView={p.patch}
          apply={p.apply}
          select={p.select}
          onField={p.onField}
          readOnly={p.readOnly}
          active={p.active}
          onActive={p.onActive}
          onError={p.onError}
        />
      );
    case 'Graph':
      return graphProjection(p);
    case 'Form':
      return p.record ? (
        <div className="ep-data-scroll">{formContent(p, p.record)}</div>
      ) : (
        <div className="ep-data-empty">Add a record to open the form.</div>
      );
    case 'Chart':
      return (
        <div className="ep-data-scroll">
          <DataChart data={data} rows={rows} config={view.chart} accent={view.accent} />
        </div>
      );
    case 'Kanban':
      return (
        <div className="ep-kanban">
          {p.groups.groupNames.map((name) => (
            <KanbanColumn key={name} p={p} name={name} />
          ))}
        </div>
      );
    case 'Timeline':
    case 'Roadmap':
      return (
        <div className="ep-data-scroll">
          <Timeline
            data={data}
            rows={rows}
            config={view.timeline}
            apply={p.apply}
            readOnly={p.readOnly}
            onSelect={p.focusRow}
          />
        </div>
      );
    case 'Summary':
      return <div className="ep-data-scroll">{summaryContent(p)}</div>;
    default:
      return <div className="ep-data-scroll">{dashboardContent(p)}</div>;
  }
}
