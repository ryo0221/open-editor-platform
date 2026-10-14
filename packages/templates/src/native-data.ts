import { clone } from '@editor-platform/artifact-core';
import type { Cell, StructuredData } from '@editor-platform/structured-data/model';
import type { ChartConfig } from '@editor-platform/structured-data/views';

/** Data cells and date windows are values; only schema-defined bindings carry IDs. */
export function dataNativeIds(data: StructuredData): string[] {
  return [
    ...data.columns.map((column) => column.id),
    ...data.rows.map((row) => row.id),
    ...(data.views ?? []).flatMap((view) => [
      view.id,
      ...view.filters.map((filter) => filter.id),
      ...view.widgets.map((widget) => widget.id),
    ]),
  ];
}

export function remapDataNative(source: StructuredData, ids: Map<string, string>): StructuredData {
  const data = clone(source),
    ref = (id: string) => ids.get(id) ?? id,
    relationColumns = new Set(
      source.columns.filter((column) => column.type === 'relation').map((column) => column.id),
    ),
    relation = (value: Cell): Cell => (typeof value === 'string' ? ref(value) : value),
    chart = (config: ChartConfig): ChartConfig => ({
      ...config,
      x: ref(config.x),
      y: ref(config.y),
      ...(config.series !== undefined ? { series: ref(config.series) } : {}),
    });
  for (const column of data.columns) {
    if (column.type === 'formula' && column.formula)
      column.formula = column.formula.replace(
        /\[([^\]]+)\]/g,
        (_all, id: string) => `[${ref(id)}]`,
      );
    if (relationColumns.has(column.id) && typeof column.defaultValue === 'string')
      column.defaultValue = ref(column.defaultValue);
    column.id = ref(column.id);
  }
  for (const row of data.rows) {
    row.id = ref(row.id);
    row.values = Object.fromEntries(
      Object.entries(row.values).map(([id, value]) => [
        ref(id),
        relationColumns.has(id) ? relation(value) : value,
      ]),
    );
  }
  for (const view of data.views ?? []) {
    view.id = ref(view.id);
    view.groupBy = ref(view.groupBy);
    view.hidden = view.hidden.map(ref);
    view.cardFields = view.cardFields.map(ref);
    view.widths = Object.fromEntries(
      Object.entries(view.widths).map(([id, width]) => [ref(id), width]),
    );
    for (const sort of view.sorts) sort.columnId = ref(sort.columnId);
    for (const filter of view.filters) {
      filter.id = ref(filter.id);
      if (relationColumns.has(filter.columnId)) filter.value = ref(filter.value);
      filter.columnId = ref(filter.columnId);
    }
    view.chart = chart(view.chart);
    view.timeline = {
      ...view.timeline,
      start: ref(view.timeline.start),
      end: ref(view.timeline.end),
      group: ref(view.timeline.group),
    };
    view.summary.columnId = ref(view.summary.columnId);
    for (const widget of view.widgets) {
      widget.id = ref(widget.id);
      if (widget.columnId !== undefined) widget.columnId = ref(widget.columnId);
      if (widget.chart) widget.chart = chart(widget.chart);
    }
  }
  if (data.graphView) {
    if (data.graphView.labelColumnId !== null)
      data.graphView.labelColumnId = ref(data.graphView.labelColumnId);
    data.graphView.positions = Object.fromEntries(
      Object.entries(data.graphView.positions).map(([id, position]) => [ref(id), position]),
    );
  }
  return data;
}
