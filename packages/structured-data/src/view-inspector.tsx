import { CommitInput, Section } from '@editor-platform/editor-ui';
import { type EditorCommand } from '@editor-platform/editor-core';
import { removeColumn, type Column, type StructuredData } from './model';
import { updateColumn, type AggregateFunction, type DataView } from './views';
import { ChartSettings, FieldSettings, Pick } from './view-fields';
import { QuerySection } from './view-query';
import { aggregates, dashboardWidget, timelineFields, toggled } from './view-model';

type Apply = (cmd: EditorCommand<StructuredData>) => boolean;
type Patch = (patch: Partial<DataView>) => void;
type Widget = DataView['widgets'][number];
interface ViewProps {
  data: StructuredData;
  view: DataView;
  patch: Patch;
}

function WidgetSettings({
  data,
  view,
  patch,
  widget,
  numeric,
}: ViewProps & { widget: Widget; numeric: Column[] }) {
  const update = (next: Partial<Widget>) =>
    patch({ widgets: view.widgets.map((w) => (w.id === widget.id ? { ...w, ...next } : w)) });
  return (
    <>
      <label className="ep-field">
        Widget title
        <input
          aria-label="Widget title"
          value={widget.title}
          onChange={(event) => update({ title: event.target.value })}
        />
      </label>
      {widget.type === 'chart' ? (
        <ChartSettings
          data={data}
          value={widget.chart ?? view.chart}
          onChange={(chart) => update({ chart })}
        />
      ) : widget.type === 'metric' ? (
        <>
          <Pick
            label="Metric field"
            columns={numeric}
            value={widget.columnId ?? ''}
            onChange={(columnId) => update({ columnId })}
          />
          <label className="ep-field">
            Metric function
            <select
              aria-label="Metric function"
              value={widget.aggregate ?? 'sum'}
              onChange={(e) => update({ aggregate: e.target.value as AggregateFunction })}
            >
              {aggregates.map((a) => (
                <option key={a}>{a}</option>
              ))}
            </select>
          </label>
        </>
      ) : null}
    </>
  );
}

function DashboardInspector({
  data,
  view,
  patch,
  widget,
  numeric,
  onWidget,
}: ViewProps & { widget: Widget | undefined; numeric: Column[]; onWidget: (id: string) => void }) {
  return (
    <Section title="Dashboard">
      {(['metric', 'chart', 'table'] as const).map((type) => (
        <button
          key={type}
          onClick={() => {
            const next = dashboardWidget(type, numeric, view.chart);
            patch({ widgets: [...view.widgets, next] });
            onWidget(next.id);
          }}
        >
          Add {type} widget
        </button>
      ))}
      {widget && (
        <WidgetSettings data={data} view={view} patch={patch} widget={widget} numeric={numeric} />
      )}
    </Section>
  );
}

function TimelineInspector({
  data,
  view,
  patch,
  dates,
  readOnly,
  apply,
}: ViewProps & { dates: Column[]; readOnly: boolean; apply: Apply }) {
  const timeline = (next: Partial<DataView['timeline']>) =>
    patch({ timeline: { ...view.timeline, ...next } });
  return (
    <Section title="Timeline">
      {dates.length < 2 && (
        <>
          <p>
            開始日・終了日にはdate型の列が必要です。列を追加し、各レコードの日付を入力してください。
          </p>
          <button
            disabled={readOnly}
            onClick={() => {
              const { start, end, command } = timelineFields(data);
              if (apply(command)) timeline({ start: start.id, end: end.id });
            }}
          >
            Add start and end date fields
          </button>
        </>
      )}
      {view.timeline.start && view.timeline.end && (
        <p>
          バー横のレコード名から開始日・終了日を入力できます。同じ列はGrid/Formにも表示されます。
        </p>
      )}
      <Pick
        label="Start field"
        columns={dates}
        value={view.timeline.start}
        onChange={(start) => timeline({ start })}
      />
      <Pick
        label="End field"
        columns={dates}
        value={view.timeline.end}
        onChange={(end) => timeline({ end })}
      />
      <Pick
        label="Timeline group"
        columns={data.columns}
        value={view.timeline.group}
        onChange={(group) => timeline({ group })}
      />
      <label className="ep-field">
        Time scale
        <select
          aria-label="Time scale"
          value={view.timeline.scale}
          onChange={(e) => timeline({ scale: e.target.value as 'day' | 'week' | 'month' })}
        >
          {['day', 'week', 'month'].map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </label>
      <CommitInput
        label="Range start"
        type="date"
        value={view.timeline.from}
        onCommit={(from) => timeline({ from })}
      />
      <CommitInput
        label="Range end"
        type="date"
        value={view.timeline.to}
        onCommit={(to) => timeline({ to })}
      />
    </Section>
  );
}

function SummaryInspector({
  view,
  patch,
  numeric,
}: Omit<ViewProps, 'data'> & { numeric: Column[] }) {
  return (
    <Section title="Summary">
      <Pick
        label="Summary field"
        columns={numeric}
        value={view.summary.columnId}
        onChange={(columnId) => patch({ summary: { ...view.summary, columnId } })}
      />
      <label className="ep-field">
        Summary function
        <select
          aria-label="Summary function"
          value={view.summary.aggregate}
          onChange={(e) =>
            patch({
              summary: { ...view.summary, aggregate: e.target.value as AggregateFunction },
            })
          }
        >
          {aggregates.map((a) => (
            <option key={a}>{a}</option>
          ))}
        </select>
      </label>
    </Section>
  );
}

function KanbanInspector({
  data,
  view,
  patch,
  groupColumn,
}: ViewProps & { groupColumn: Column | undefined }) {
  return (
    <Section title="Kanban">
      <Pick
        label="Kanban group"
        value={view.groupBy || groupColumn?.id || ''}
        columns={data.columns.filter((c) => c.type === 'select' || c.type === 'text')}
        onChange={(groupBy) => patch({ groupBy })}
      />
      {data.columns.map((c) => (
        <label key={c.id}>
          <input
            type="checkbox"
            checked={view.cardFields.includes(c.id)}
            onChange={(e) =>
              patch({
                cardFields: toggled(view.cardFields, c.id, e.target.checked),
              })
            }
          />{' '}
          {c.name}
        </label>
      ))}
    </Section>
  );
}

export interface DataInspectorProps extends ViewProps {
  readOnly: boolean;
  apply: Apply;
  field: Column | undefined;
  onField: (id: string) => void;
  widget: Widget | undefined;
  onWidget: (id: string) => void;
  numeric: Column[];
  dates: Column[];
  groupColumn: Column | undefined;
  visibleColumns: number;
}

function FieldInspector({
  data,
  field,
  readOnly,
  apply,
  onField,
}: {
  data: StructuredData;
  field: Column;
  readOnly: boolean;
  apply: Apply;
  onField: (id: string) => void;
}) {
  return (
    <Section title="Field settings">
      <FieldSettings
        key={field.id + field.type + field.name}
        data={data}
        field={field}
        readOnly={readOnly}
        onSave={(next) => apply(updateColumn(field.id, next))}
        onDelete={() => {
          if (apply(removeColumn(field.id))) onField('');
        }}
      />
      <button onClick={() => onField('')}>Back to view settings</button>
    </Section>
  );
}

export function DataInspector(props: DataInspectorProps) {
  const { data, view, patch, field, numeric } = props;
  if (field) return <FieldInspector {...props} field={field} />;
  return (
    <>
      {view.projection === 'Chart' && (
        <Section title="Chart">
          <ChartSettings data={data} value={view.chart} onChange={(chart) => patch({ chart })} />
        </Section>
      )}
      {view.projection === 'Dashboard' && <DashboardInspector {...props} />}
      {['Timeline', 'Roadmap'].includes(view.projection) && <TimelineInspector {...props} />}
      {view.projection === 'Summary' && (
        <SummaryInspector view={view} patch={patch} numeric={numeric} />
      )}
      {view.projection === 'Kanban' && <KanbanInspector {...props} />}
      <QuerySection data={data} view={view} patch={patch} />
      <Section title="Grid">
        <CommitInput
          label="Frozen columns"
          value={view.frozen}
          type="number"
          min={0}
          max={Math.max(0, props.visibleColumns)}
          onCommit={(v) => patch({ frozen: Number(v) })}
        />
      </Section>
    </>
  );
}
